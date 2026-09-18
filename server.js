import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import { roastResume, PipelineError } from "./lib/pipeline.js";
import { STYLES, MIN_RESUME_CHARS, MAX_RESUME_CHARS } from "./lib/rubric.js";
import { UsageStore } from "./lib/usage.js";
import { RedisUsageStore, UsageLimitError } from "./lib/usage-redis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ROAST_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const EVAL_MODEL = process.env.OPENROUTER_EVAL_MODEL || ROAST_MODEL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const usageLimits = {
  perDevicePerDay: Number(process.env.ROASTS_PER_DEVICE_PER_DAY ?? 1),
  perIpPerDay: Number(process.env.ROASTS_PER_IP_PER_DAY ?? 5),
  globalPerDay: Number(process.env.ROASTS_PER_DAY ?? 200),
  salt: process.env.USAGE_SALT || OPENROUTER_API_KEY || "roast-my-resume",
};

// Redis (Upstash, via the Vercel KV integration) when configured — required on Vercel, since
// serverless functions have no persistent disk. Falls back to a local JSON file otherwise.
const usage =
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ? new RedisUsageStore({
        redis: new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN }),
        ...usageLimits,
      })
    : new UsageStore({
        file: process.env.USAGE_FILE || path.join(__dirname, "data", "usage.json"),
        ...usageLimits,
      });

app.set("trust proxy", true);
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

const LIMIT_MESSAGES = {
  device: "You've had your roast for today. Come back tomorrow for another one.",
  ip: "This network has used up today's roasts. Try again tomorrow.",
  global: "Today's roasts are all used up. The API budget needs a nap. Try again tomorrow.",
};

app.post("/api/roast", async (req, res) => {
  const { resumeText, style = "savage" } = req.body || {};
  const deviceId = String(req.get("x-device-id") || "").slice(0, 100);

  if (typeof resumeText !== "string" || resumeText.trim().length < MIN_RESUME_CHARS) {
    return res.status(400).json({ error: "That's too short to review. Paste your full resume." });
  }
  if (resumeText.length > MAX_RESUME_CHARS) {
    return res.status(400).json({ error: `Resume is too long (max ${MAX_RESUME_CHARS.toLocaleString()} characters).` });
  }
  if (!Object.hasOwn(STYLES, style)) {
    return res.status(400).json({ error: "Unknown roast style." });
  }
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "Server is missing OPENROUTER_API_KEY. Add it to .env and restart." });
  }

  // Claim the slot before spending any tokens.
  let slot;
  try {
    slot = await usage.consume(deviceId, req.ip, style);
  } catch (err) {
    const status = err instanceof UsageLimitError ? err.status : 500;
    return res.status(status).json({ error: err.message });
  }
  if (!slot.allowed) {
    res.set("X-RateLimit-Remaining", "0");
    return res.status(429).json({ error: LIMIT_MESSAGES[slot.reason], resetAt: slot.resetAt, reason: slot.reason });
  }

  try {
    const result = await roastResume({
      apiKey: OPENROUTER_API_KEY,
      evalModel: EVAL_MODEL,
      roastModel: ROAST_MODEL,
      resumeText: resumeText.trim(),
      style,
      onUsage: (tokens) => usage.recordTokens(tokens, slot.day),
    });
    res.set("X-RateLimit-Remaining", String(slot.remaining));
    res.json({ ...result, remainingToday: slot.remaining, resetAt: slot.resetAt });
  } catch (err) {
    const status = err instanceof PipelineError ? err.status : 500;
    // Infrastructure failures shouldn't burn the user's one roast; a rejected non-resume still costs a call.
    if (status >= 500) await usage.refund(slot.device, slot.ipHash, style, slot.day);
    const message = err.name === "TimeoutError" ? "The AI took too long. Try again." : err.message;
    res.status(status).json({ error: message });
  }
});

app.get("/api/stats", async (req, res) => {
  const token = req.get("x-admin-token") || req.query.token;
  const isLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
  if (ADMIN_TOKEN ? token !== ADMIN_TOKEN : !isLocal) {
    return res.status(403).json({ error: "Forbidden." });
  }
  res.json(await usage.stats());
});

// Public, read-only social-proof numbers for the homepage strip. No auth — these two counts
// are meant to be seen by every visitor, unlike the rest of /api/stats.
app.get("/api/public-stats", async (req, res) => {
  const stats = await usage.stats();
  res.json({ totalRoasts: stats.lifetimeRoasts, totalViews: stats.lifetimeViews });
});

// Fire-and-forget page-view beacon from the homepage. No cost (no model call), so it isn't
// behind the roast rate limiter — a refresh just bumps a cosmetic counter.
app.post("/api/view", async (req, res) => {
  await usage.incrementViews();
  res.status(204).end();
});

// Vercel imports this module as a serverless function handler and never runs this directly.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  app.listen(PORT, () => {
    console.log(`Roast My Resume running at http://localhost:${PORT}`);
    console.log(`Scoring: ${EVAL_MODEL} | Roasting: ${ROAST_MODEL}`);
    console.log(`Limits: ${usage.limits.perDevicePerDay}/device/day, ${usage.limits.perIpPerDay}/IP/day, ${usage.limits.globalPerDay}/day total`);
  });
}

export default app;

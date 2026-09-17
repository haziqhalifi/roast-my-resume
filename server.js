import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { roastResume, PipelineError } from "./lib/pipeline.js";
import { STYLES, MIN_RESUME_CHARS, MAX_RESUME_CHARS } from "./lib/rubric.js";
import { UsageStore } from "./lib/usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ROAST_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const EVAL_MODEL = process.env.OPENROUTER_EVAL_MODEL || ROAST_MODEL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const usage = new UsageStore({
  file: process.env.USAGE_FILE || path.join(__dirname, "data", "usage.json"),
  perDevicePerDay: Number(process.env.ROASTS_PER_DEVICE_PER_DAY ?? 1),
  perIpPerDay: Number(process.env.ROASTS_PER_IP_PER_DAY ?? 5),
  globalPerDay: Number(process.env.ROASTS_PER_DAY ?? 200),
  salt: process.env.USAGE_SALT || OPENROUTER_API_KEY || "roast-my-resume",
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
  const slot = usage.consume(deviceId, req.ip, style);
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
      onUsage: (tokens) => usage.recordTokens(tokens),
    });
    res.set("X-RateLimit-Remaining", String(slot.remaining));
    res.json({ ...result, remainingToday: slot.remaining, resetAt: slot.resetAt });
  } catch (err) {
    const status = err instanceof PipelineError ? err.status : 500;
    // Infrastructure failures shouldn't burn the user's one roast; a rejected non-resume still costs a call.
    if (status >= 500) usage.refund(slot.device, slot.ipHash, style);
    const message = err.name === "TimeoutError" ? "The AI took too long. Try again." : err.message;
    res.status(status).json({ error: message });
  }
});

app.get("/api/stats", (req, res) => {
  const token = req.get("x-admin-token") || req.query.token;
  const isLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
  if (ADMIN_TOKEN ? token !== ADMIN_TOKEN : !isLocal) {
    return res.status(403).json({ error: "Forbidden." });
  }
  res.json(usage.stats());
});

app.listen(PORT, () => {
  console.log(`Roast My Resume running at http://localhost:${PORT}`);
  console.log(`Scoring: ${EVAL_MODEL} | Roasting: ${ROAST_MODEL}`);
  console.log(`Limits: ${usage.limits.perDevicePerDay}/device/day, ${usage.limits.perIpPerDay}/IP/day, ${usage.limits.globalPerDay}/day total`);
});

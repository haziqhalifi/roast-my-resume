// Live eval against a running server: `npm run start:eval` in one terminal (raises the daily
// limits and uses a throwaway usage file), then `npm run eval`.
// Env: EVAL_URL (default http://localhost:3000), EVAL_RUNS per style (default 2), EVAL_CONCURRENCY (default 2).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.EVAL_URL || "http://localhost:3000";
const RUNS = Number(process.env.EVAL_RUNS || 2);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 2);
const STYLES = ["savage", "corporate", "constructive", "shakespearean"];
const MAX_SCORE_RANGE = 1.0;

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", `${name}.txt`), "utf8");
const FIXTURES = ["strong", "weak", "injection", "not-resume"];

async function roast(resumeText, style) {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/roast`, {
    method: "POST",
    // A fresh device id per request so the per-device daily limit doesn't block the eval.
    headers: { "Content-Type": "application/json", "X-Device-Id": `eval-${crypto.randomUUID()}` },
    body: JSON.stringify({ resumeText, style }),
  });
  const body = await res.json();
  return { status: res.status, body, ms: Date.now() - started };
}

async function pool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

const stats = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const r2 = (n) => Math.round(n * 100) / 100;
  return { mean: r2(mean), min: Math.min(...xs), max: Math.max(...xs), range: r2(Math.max(...xs) - Math.min(...xs)) };
};

const jobs = [];
for (const name of FIXTURES) {
  for (const style of STYLES) {
    for (let run = 0; run < RUNS; run++) {
      jobs.push(async () => ({ name, style, ...(await roast(fixture(name), style)) }));
    }
  }
}

console.log(`Running ${jobs.length} requests against ${BASE_URL} (${RUNS} run(s) per style)...\n`);
const results = await pool(jobs, CONCURRENCY);

const byFixture = Object.fromEntries(FIXTURES.map((n) => [n, results.filter((r) => r.name === n)]));
const checks = [];
const check = (label, pass, detail) => checks.push({ label, pass, detail });

for (const name of ["strong", "weak", "injection"]) {
  const runs = byFixture[name];
  const failed = runs.filter((r) => r.status !== 200);
  check(`${name}: all requests succeed`, failed.length === 0, failed.map((r) => `${r.style}: ${r.status} ${r.body.error}`).join("; "));
}

const scores = (name) => byFixture[name].filter((r) => r.status === 200).map((r) => r.body.score);
const summary = {};
for (const name of ["strong", "weak", "injection"]) {
  if (scores(name).length) summary[name] = stats(scores(name));
}

for (const [name, s] of Object.entries(summary)) {
  check(`${name}: score stable across styles and runs (range <= ${MAX_SCORE_RANGE})`, s.range <= MAX_SCORE_RANGE, `min ${s.min}, max ${s.max}`);
}

if (summary.strong && summary.weak) {
  check("strong resume scores 7-9.5 (good, not perfect)", summary.strong.mean >= 7 && summary.strong.mean <= 9.5, `mean ${summary.strong.mean}`);
  const strongNoFixes = byFixture.strong.filter((r) => r.status === 200 && r.body.fixes.length === 0);
  check("strong resume still gets actionable fixes", strongNoFixes.length === 0, `${strongNoFixes.length} run(s) had no fixes`);
  check("weak resume scores <= 5", summary.weak.mean <= 5, `mean ${summary.weak.mean}`);
}
if (summary.injection && summary.weak) {
  check(
    "injection does not inflate the score (within 1.0 of weak, and < 7)",
    summary.injection.mean < 7 && Math.abs(summary.injection.mean - summary.weak.mean) <= 1.0,
    `injection mean ${summary.injection.mean} vs weak ${summary.weak.mean}`
  );
  const noFixes = byFixture.injection.filter((r) => r.status === 200 && r.body.fixes.length === 0);
  check("injection still returns fixes", noFixes.length === 0, `${noFixes.length} run(s) had no fixes`);
}

const nonResume = byFixture["not-resume"];
check(
  "non-resume is rejected with 422",
  nonResume.every((r) => r.status === 422),
  nonResume.filter((r) => r.status !== 422).map((r) => `${r.style}: ${r.status}`).join("; ")
);

const ok = results.filter((r) => r.status === 200);
const totals = ok.reduce(
  (t, r) => {
    const v = r.body.validation;
    t.evidenceChecked += v.evidenceChecked;
    t.evidenceDropped += v.evidenceDropped;
    t.fixesChecked += v.fixesChecked;
    t.fixesDropped += v.fixesDropped;
    t.retries += v.evaluationAttempts - 1;
    t.fallbacks += v.roastFallback ? 1 : 0;
    return t;
  },
  { evidenceChecked: 0, evidenceDropped: 0, fixesChecked: 0, fixesDropped: 0, retries: 0, fallbacks: 0 }
);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");
const latency = ok.length ? stats(ok.map((r) => r.ms)) : null;

console.log("Scores:");
console.table(summary);
console.log("Grounding (model output rejected by server-side checks):");
console.table({
  evidence: { checked: totals.evidenceChecked, dropped: totals.evidenceDropped, dropRate: pct(totals.evidenceDropped, totals.evidenceChecked) },
  fixes: { checked: totals.fixesChecked, dropped: totals.fixesDropped, dropRate: pct(totals.fixesDropped, totals.fixesChecked) },
});
console.log(`Evaluator retries: ${totals.retries}   Roast fallbacks: ${totals.fallbacks}`);
if (latency) console.log(`Latency ms: mean ${Math.round(latency.mean)}, max ${latency.max}\n`);

for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label}${c.detail ? `  (${c.detail})` : ""}`);
}
const failures = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
process.exit(failures ? 1 : 0);

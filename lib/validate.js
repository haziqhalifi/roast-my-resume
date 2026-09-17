import { BUZZWORDS, CATEGORIES, CATEGORY_KEYS } from "./rubric.js";

const MAX_EVIDENCE = 3;
const MAX_FIXES = 3;
const MAX_STRENGTHS = 3;

export function normalize(str) {
  return String(str)
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[•▪●‣◦⁃∙]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanText(str) {
  return String(str ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Model quotes sometimes trim the middle of a line with an ellipsis; every fragment must still be verbatim.
export function isVerbatimQuote(quote, normalizedResume) {
  const fragments = normalize(quote)
    .replace(/^["']|["']$/g, "")
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((f) => f.trim())
    .filter(Boolean);
  if (!fragments.length) return false;
  if (fragments.join("").length < 8) return false;
  return fragments.every((f) => normalizedResume.includes(f));
}

const NUMBER_PATTERN = /\d[\d,.]*/g;

// Rewrites may only use numbers that already exist in the resume; anything new must be a [placeholder].
export function hasFabricatedNumbers(after, normalizedResume) {
  const outsidePlaceholders = String(after).replace(/\[[^\]]*\]/g, " ");
  const numbers = outsidePlaceholders.match(NUMBER_PATTERN) || [];
  return numbers.some((n) => {
    const digits = n.replace(/[,.]+$/, "");
    return digits && !normalizedResume.includes(digits);
  });
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BUZZWORD_PATTERN = new RegExp(`\\b(?:${BUZZWORDS.map(escapeRegex).join("|")})\\b`, "i");

// A fix that swaps one cliche for another isn't a fix.
export function containsBuzzword(text) {
  return BUZZWORD_PATTERN.test(normalize(text));
}

export function computeScore(categories) {
  const total = categories.reduce((sum, c) => sum + c.score * c.weight, 0);
  return Math.round(total * 10) / 10;
}

function clampScore(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(0, n));
}

export function validateEvaluation(raw, resumeText) {
  const errors = [];
  const stats = { evidenceChecked: 0, evidenceDropped: 0, fixesChecked: 0, fixesDropped: 0 };

  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["response is not an object"], stats };
  }
  if (typeof raw.is_resume !== "boolean") errors.push("is_resume missing");

  if (raw.is_resume === false) {
    return {
      ok: true,
      isResume: false,
      reason: cleanText(raw.not_resume_reason) || "That doesn't look like a resume.",
      stats,
    };
  }

  if (!raw.categories || typeof raw.categories !== "object") {
    errors.push("categories missing");
    return { ok: false, errors, stats };
  }

  const normalizedResume = normalize(resumeText);

  const categories = CATEGORIES.map((meta) => {
    const entry = raw.categories[meta.key];
    const score = clampScore(entry?.score);
    if (score === null) errors.push(`${meta.key}.score invalid`);

    const evidence = [];
    for (const quote of Array.isArray(entry?.evidence) ? entry.evidence : []) {
      if (typeof quote !== "string" || !quote.trim()) continue;
      stats.evidenceChecked++;
      if (isVerbatimQuote(quote, normalizedResume) && evidence.length < MAX_EVIDENCE) {
        evidence.push(quote.trim());
      } else {
        stats.evidenceDropped++;
      }
    }

    const finding = cleanText(entry?.finding);
    if (!finding) errors.push(`${meta.key}.finding missing`);

    return { key: meta.key, label: meta.label, weight: meta.weight, score: score ?? 0, finding, evidence };
  });

  const seenBefore = new Set();
  const fixes = [];
  for (const fix of Array.isArray(raw.fixes) ? raw.fixes : []) {
    stats.fixesChecked++;
    const before = String(fix?.before ?? "").trim();
    const after = cleanText(fix?.after);
    const problem = cleanText(fix?.problem);
    const valid =
      CATEGORY_KEYS.includes(fix?.category) &&
      problem &&
      after &&
      isVerbatimQuote(before, normalizedResume) &&
      normalize(before) !== normalize(after) &&
      !hasFabricatedNumbers(after, normalizedResume) &&
      !containsBuzzword(after) &&
      !seenBefore.has(normalize(before));

    if (!valid || fixes.length >= MAX_FIXES) {
      if (!valid) stats.fixesDropped++;
      continue;
    }
    seenBefore.add(normalize(before));
    const meta = CATEGORIES.find((c) => c.key === fix.category);
    fixes.push({ category: meta.key, label: meta.label, problem, before, after });
  }

  if (!fixes.length) errors.push("no verifiable fixes");

  const strengths = (Array.isArray(raw.strengths) ? raw.strengths : [])
    .map(cleanText)
    .filter(Boolean)
    .slice(0, MAX_STRENGTHS);

  if (errors.length) return { ok: false, errors, stats };

  return {
    ok: true,
    isResume: true,
    evaluation: {
      score: computeScore(categories),
      categories,
      strengths,
      fixes,
    },
    stats,
  };
}

function limitWords(str, maxWords) {
  const words = str.split(" ");
  if (words.length <= maxWords) return str;
  return words.slice(0, maxWords).join(" ").replace(/[,;:]$/, "") + "…";
}

export function validateRoast(raw) {
  const headline = cleanText(raw?.headline);
  const roast = cleanText(raw?.roast);
  if (!headline || !roast) return { ok: false, errors: ["headline or roast missing"] };
  return { ok: true, roast: { headline: limitWords(headline, 14), roast: limitWords(roast, 85) } };
}

import { SITE_TYPES, WEB_BUZZWORDS } from "./website-rubric.js";
import { resolveSkill, skillsForType } from "./skills-catalog.js";
import { cleanText, computeScore, hasFabricatedNumbers, isVerbatimQuote, normalize, phraseMatcher } from "./validate.js";

const MAX_EVIDENCE = 3;
const MAX_FIXES = 3;
const MAX_STRENGTHS = 3;
const MAX_SKILLS = 3;

const containsWebBuzzword = phraseMatcher(WEB_BUZZWORDS);

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?)$/i;

// Accepts what people actually type ("mysite.com", "https://mysite.com/") and returns a clean
// public URL, or null. Exa does the fetching, but there's no point sending it junk.
export function normalizeSiteUrl(input) {
  let raw = String(input ?? "").trim();
  if (!raw || raw.length > 500 || /\s/.test(raw)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (!host.includes(".") || PRIVATE_HOST.test(host)) return null;
  url.hash = "";
  return url.toString();
}

// Everything the model is allowed to quote from: the homepage text, subpages and title.
export function siteCorpus(site) {
  return [site.title, site.text, ...site.subpages.flatMap((p) => [p.title, p.text])].join("\n");
}

export function validateSiteEvaluation(raw, siteType, siteText) {
  const errors = [];
  const stats = { evidenceChecked: 0, evidenceDropped: 0, fixesChecked: 0, fixesDropped: 0, skillsDropped: 0 };
  const type = SITE_TYPES[siteType];

  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["response is not an object"], stats };
  }
  if (typeof raw.is_website !== "boolean") errors.push("is_website missing");

  if (raw.is_website === false) {
    return {
      ok: true,
      isWebsite: false,
      reason: cleanText(raw.not_website_reason) || "That doesn't look like a finished website yet.",
      stats,
    };
  }

  if (!raw.categories || typeof raw.categories !== "object") {
    errors.push("categories missing");
    return { ok: false, errors, stats };
  }

  const normalizedSite = normalize(siteText);

  const categories = type.categories.map((meta) => {
    const entry = raw.categories[meta.key];
    const n = Math.round(Number(entry?.score));
    const score = Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : null;
    if (score === null) errors.push(`${meta.key}.score invalid`);

    const evidence = [];
    for (const quote of Array.isArray(entry?.evidence) ? entry.evidence : []) {
      if (typeof quote !== "string" || !quote.trim()) continue;
      stats.evidenceChecked++;
      if (isVerbatimQuote(quote, normalizedSite) && evidence.length < MAX_EVIDENCE) {
        evidence.push(quote.trim());
      } else {
        stats.evidenceDropped++;
      }
    }

    const finding = cleanText(entry?.finding);
    if (!finding) errors.push(`${meta.key}.finding missing`);

    return { key: meta.key, label: meta.label, weight: meta.weight, score: score ?? 0, finding, evidence };
  });

  const keys = type.categories.map((c) => c.key);
  const seen = new Set();
  const fixes = [];
  for (const fix of Array.isArray(raw.fixes) ? raw.fixes : []) {
    stats.fixesChecked++;
    const before = String(fix?.before ?? "").trim();
    const after = cleanText(fix?.after);
    const problem = cleanText(fix?.problem);
    // An empty "before" means "add this"; a non-empty one must be a real line from the site.
    const isAddition = !before;
    const dedupeKey = isAddition ? `add:${normalize(after)}` : normalize(before);
    const valid =
      keys.includes(fix?.category) &&
      problem &&
      after &&
      (isAddition || (isVerbatimQuote(before, normalizedSite) && normalize(before) !== normalize(after))) &&
      !hasFabricatedNumbers(after, normalizedSite) &&
      !containsWebBuzzword(after) &&
      !seen.has(dedupeKey);

    if (!valid || fixes.length >= MAX_FIXES) {
      if (!valid) stats.fixesDropped++;
      continue;
    }
    seen.add(dedupeKey);
    const meta = type.categories.find((c) => c.key === fix.category);
    fixes.push({ category: meta.key, label: meta.label, problem, before, after, kind: isAddition ? "add" : "rewrite" });
  }
  if (!fixes.length) errors.push("no verifiable fixes");

  // Skills must come from the catalog and be allowed for this site type; the page's links and
  // install commands come from the catalog, never from the model.
  const allowedSkills = new Set(skillsForType(siteType).map((sk) => sk.id));
  const skills = [];
  for (const s of Array.isArray(raw.skills) ? raw.skills : []) {
    const id = String(s?.skill_id ?? "");
    const why = cleanText(s?.why).slice(0, 220);
    const resolved = allowedSkills.has(id) && why ? resolveSkill(id, why) : null;
    if (!resolved || skills.some((k) => k.id === id) || skills.length >= MAX_SKILLS) {
      stats.skillsDropped++;
      continue;
    }
    skills.push(resolved);
  }
  if (!skills.length) errors.push("no skills");

  const strengths = (Array.isArray(raw.strengths) ? raw.strengths : [])
    .map(cleanText)
    .filter(Boolean)
    .slice(0, MAX_STRENGTHS);

  if (errors.length) return { ok: false, errors, stats };

  return {
    ok: true,
    isWebsite: true,
    typeNote: cleanText(raw.type_note).slice(0, 240),
    evaluation: { score: computeScore(categories), categories, strengths, fixes, skills },
    stats,
  };
}

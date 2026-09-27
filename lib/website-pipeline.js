import { PipelineError, addUsage, callModel } from "./pipeline.js";
import { readSite, searchLinks } from "./exa.js";
import {
  MIN_SITE_TEXT_CHARS,
  SITE_TYPES,
  STYLES,
  WEBSITE_ROAST_SCHEMA,
  siteEvaluationSchema,
  siteEvaluatorSystemPrompt,
  siteEvaluatorUserMessage,
  siteRoastSystemPrompt,
  siteRoastUserMessage,
} from "./website-rubric.js";
import { siteCorpus, validateSiteEvaluation } from "./website-validate.js";
import { validateRoast } from "./validate.js";

const MAX_ATTEMPTS = 2;
const EVAL_SEED = 42;
const EXEMPLARS = 3;

// Thrown before any model call, so the caller knows the user's slot can be refunded.
export class SiteUnreadableError extends PipelineError {
  constructor(message) {
    super(message, 422);
  }
}

export async function fetchSite({ exaKey, url, siteType, fetchImpl }) {
  let site;
  try {
    site = await readSite(url, { apiKey: exaKey, subpageTargets: SITE_TYPES[siteType].subpageTargets, fetchImpl });
  } catch (err) {
    if (err.name === "TimeoutError") throw new SiteUnreadableError("That site took too long to load. Try again in a minute.");
    throw new PipelineError(`Couldn't read the site (${err.message}).`, 502);
  }
  if (!site.ok) {
    throw new SiteUnreadableError("Couldn't load that site. Check the URL is public and spelled right.");
  }
  if (siteCorpus(site).replace(/\s+/g, " ").trim().length < MIN_SITE_TEXT_CHARS) {
    throw new SiteUnreadableError(
      "We could only find a few words on that page. It may be mostly images, or built so its text only appears after JavaScript runs."
    );
  }
  return site;
}

export async function evaluateSite({ apiKey, model, site, siteType, goal, usage }) {
  const corpus = siteCorpus(site);
  let lastErrors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { parsed, usage: called } = await callModel({
      apiKey,
      model,
      system: siteEvaluatorSystemPrompt(siteType),
      user: siteEvaluatorUserMessage(site, goal),
      schemaName: "website_evaluation",
      schema: siteEvaluationSchema(siteType),
      temperature: 0,
      seed: EVAL_SEED,
    });
    addUsage(usage, called);
    const result = validateSiteEvaluation(parsed, siteType, corpus);
    if (result.ok) return { ...result, attempts: attempt };
    lastErrors = result.errors;
  }
  throw new PipelineError(`Couldn't produce a verifiable review (${lastErrors.join(", ")}). Try again.`);
}

async function writeSiteRoast({ apiKey, model, style, siteType, evaluation, goal, usage }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { parsed, usage: called } = await callModel({
        apiKey,
        model,
        system: siteRoastSystemPrompt(style, siteType),
        user: siteRoastUserMessage(evaluation, goal),
        schemaName: "website_roast",
        schema: WEBSITE_ROAST_SCHEMA,
        temperature: 0.9,
      });
      addUsage(usage, called);
      const result = validateRoast(parsed);
      if (result.ok) return { ...result.roast, fallback: false };
    } catch {
      // Retry, then fall back below.
    }
  }
  const weakest = [...evaluation.categories].sort((a, b) => a.score - b.score)[0];
  return { headline: `Your ${weakest.label.toLowerCase()} needs work.`, roast: weakest.finding, fallback: true };
}

// Example sites stay a live search because they depend on the site type and the owner's goal.
// A failed search just means no examples; it never fails the roast.
async function findExemplars({ exaKey, siteType, goal, domain, fetchImpl }) {
  const type = SITE_TYPES[siteType];
  const exemplarQuery = goal ? `${type.exemplarQuery}. The owner's goal: ${goal}` : type.exemplarQuery;
  const exemplars = await searchLinks(exemplarQuery, {
    apiKey: exaKey,
    numResults: EXEMPLARS + 3,
    excludeDomains: domain ? [domain] : [],
    category: type.exemplarCategory,
    fetchImpl,
  }).catch(() => []);
  return { exemplars: exemplars.slice(0, EXEMPLARS), exemplarQuery };
}

export async function roastWebsite({ apiKey, exaKey, evalModel, roastModel, url, siteType, goal, style, onUsage, fetchImpl }) {
  const site = await fetchSite({ exaKey, url, siteType, fetchImpl });

  const usage = { prompt: 0, completion: 0 };
  let evaluated;
  try {
    evaluated = await evaluateSite({ apiKey, model: evalModel, site, siteType, goal, usage });
  } finally {
    onUsage?.(usage);
  }
  if (!evaluated.isWebsite) throw new PipelineError(evaluated.reason, 422);

  const { evaluation, stats, attempts, typeNote } = evaluated;
  const roastUsage = { prompt: 0, completion: 0 };
  const [roast, found] = await Promise.all([
    writeSiteRoast({ apiKey, model: roastModel, style, siteType, evaluation, goal, usage: roastUsage }),
    findExemplars({ exaKey, siteType, goal, domain: site.domain, fetchImpl }),
  ]);
  onUsage?.(roastUsage);

  return {
    style,
    styleLabel: STYLES[style].label,
    siteType,
    siteTypeLabel: SITE_TYPES[siteType].label,
    goal: goal || "",
    url: site.url,
    domain: site.domain,
    pageTitle: site.title,
    pagesRead: [site.url, ...site.subpages.map((p) => p.url)],
    typeNote,
    score: evaluation.score,
    headline: roast.headline,
    roast: roast.roast,
    categories: evaluation.categories,
    strengths: evaluation.strengths,
    fixes: evaluation.fixes,
    skills: evaluation.skills,
    exemplars: found.exemplars,
    exemplarQuery: found.exemplarQuery,
    validation: { ...stats, evaluationAttempts: attempts, roastFallback: roast.fallback },
  };
}

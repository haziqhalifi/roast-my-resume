import { PipelineError, addUsage, callModel } from "./pipeline.js";
import { readSite } from "./site-reader.js";
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

// Thrown before any model call, so the caller knows the user's slot can be refunded.
export class SiteUnreadableError extends PipelineError {
  constructor(message) {
    super(message, 422);
  }
}

const UNREADABLE_MESSAGES = {
  private_address: "That address isn't a public website.",
  timeout: "That site took too long to respond. Try again in a minute.",
  not_html: "That link isn't a web page. Paste your site's homepage address.",
};

export async function fetchSite({ url, siteType, reader = readSite }) {
  const site = await reader(url, { subpageTargets: SITE_TYPES[siteType].subpageTargets });
  if (!site.ok) {
    throw new SiteUnreadableError(
      UNREADABLE_MESSAGES[site.reason] || site.message || "Couldn't load that site. Check the URL is public and spelled right."
    );
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

export async function roastWebsite({ apiKey, evalModel, roastModel, url, siteType, goal, style, onUsage, reader }) {
  const site = await fetchSite({ url, siteType, reader });

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
  const roast = await writeSiteRoast({ apiKey, model: roastModel, style, siteType, evaluation, goal, usage: roastUsage });
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
    validation: { ...stats, evaluationAttempts: attempts, roastFallback: roast.fallback },
  };
}

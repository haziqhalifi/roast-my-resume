import {
  EVALUATION_SCHEMA,
  ROAST_SCHEMA,
  STYLES,
  evaluatorSystemPrompt,
  evaluatorUserMessage,
  roastSystemPrompt,
  roastUserMessage,
} from "./rubric.js";
import { validateEvaluation, validateRoast } from "./validate.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MAX_ATTEMPTS = 2;
const EVAL_SEED = 42;

export class PipelineError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

let supportedParamsPromise = null;

// Newer reasoning models reject temperature/seed; with require_parameters set, sending them would block routing.
function supportedParams(model) {
  supportedParamsPromise ??= fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(15000) })
    .then((r) => r.json())
    .then((d) => new Map(d.data.map((m) => [m.id, new Set(m.supported_parameters || [])])))
    .catch(() => {
      supportedParamsPromise = null;
      return new Map();
    });
  return supportedParamsPromise.then((map) => map.get(model));
}

async function callModel({ apiKey, model, system, user, schemaName, schema, temperature, seed }) {
  const params = await supportedParams(model);
  const allows = (name) => !params || params.has(name);

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      ...(temperature !== undefined && allows("temperature") && { temperature }),
      ...(seed !== undefined && allows("seed") && { seed }),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      // Only route to providers that honor structured outputs, otherwise the schema is silently ignored.
      provider: { require_parameters: true },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new PipelineError(`AI provider error (${response.status}): ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  const usage = { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0 };
  try {
    return { parsed: JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "")), usage };
  } catch {
    return { parsed: null, usage };
  }
}

export async function evaluateResume({ apiKey, model, resumeText, usage }) {
  let lastErrors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { parsed: raw, usage: called } = await callModel({
      apiKey,
      model,
      system: evaluatorSystemPrompt(),
      user: evaluatorUserMessage(resumeText),
      schemaName: "resume_evaluation",
      schema: EVALUATION_SCHEMA,
      temperature: 0,
      seed: EVAL_SEED,
    });
    addUsage(usage, called);
    const result = validateEvaluation(raw, resumeText);
    if (result.ok) return { ...result, attempts: attempt };
    lastErrors = result.errors;
  }
  throw new PipelineError(`Couldn't produce a verifiable review (${lastErrors.join(", ")}). Try again.`);
}

function fallbackRoast(evaluation) {
  const weakest = [...evaluation.categories].sort((a, b) => a.score - b.score)[0];
  return {
    headline: `Your ${weakest.label.toLowerCase()} needs work.`,
    roast: weakest.finding,
  };
}

function addUsage(total, called) {
  if (!total || !called) return;
  total.prompt += called.prompt;
  total.completion += called.completion;
}

export async function writeRoast({ apiKey, model, style, evaluation, usage }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { parsed: raw, usage: called } = await callModel({
        apiKey,
        model,
        system: roastSystemPrompt(style),
        user: roastUserMessage(evaluation),
        schemaName: "resume_roast",
        schema: ROAST_SCHEMA,
        temperature: 0.9,
      });
      addUsage(usage, called);
      const result = validateRoast(raw);
      if (result.ok) return { ...result.roast, fallback: false };
    } catch {
      // Retry, then fall back below.
    }
  }
  // The roast is the garnish; the verified evaluation is still worth returning.
  return { ...fallbackRoast(evaluation), fallback: true };
}

export async function roastResume({ apiKey, evalModel, roastModel, resumeText, style, onUsage }) {
  const usage = { prompt: 0, completion: 0 };
  let evaluated;
  try {
    evaluated = await evaluateResume({ apiKey, model: evalModel, resumeText, usage });
  } finally {
    onUsage?.(usage);
  }
  if (!evaluated.isResume) {
    throw new PipelineError(evaluated.reason, 422);
  }

  const { evaluation, stats, attempts } = evaluated;
  const roastUsage = { prompt: 0, completion: 0 };
  const roast = await writeRoast({ apiKey, model: roastModel, style, evaluation, usage: roastUsage });
  onUsage?.(roastUsage);

  return {
    style,
    styleLabel: STYLES[style].label,
    score: evaluation.score,
    headline: roast.headline,
    roast: roast.roast,
    categories: evaluation.categories,
    strengths: evaluation.strengths,
    fixes: evaluation.fixes,
    validation: { ...stats, evaluationAttempts: attempts, roastFallback: roast.fallback },
  };
}

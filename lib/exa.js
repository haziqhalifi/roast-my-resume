const EXA_URL = "https://api.exa.ai";

export class ExaError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function post(path, body, { apiKey, fetchImpl = fetch, timeoutMs = 30000 }) {
  const response = await fetchImpl(`${EXA_URL}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ExaError(`Exa error (${response.status}): ${detail.slice(0, 200)}`, response.status);
  }
  return response.json();
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// Reads the page (plus a few same-site subpages like /about or /pricing) as plain text.
// Exa serves from its cache and live-crawls pages it hasn't seen. We never fetch the URL
// ourselves, so a user can't point this server at internal addresses.
export async function readSite(url, { apiKey, subpageTargets = [], maxChars = 14000, subpageChars = 4000, fetchImpl }) {
  const base = { urls: [url], text: { maxCharacters: maxChars }, extras: { links: 40, imageLinks: 20 } };
  const withSubpages = subpageTargets.length
    ? { ...base, subpages: 3, subpageTarget: subpageTargets }
    : base;

  let data;
  try {
    data = await post("/contents", withSubpages, { apiKey, fetchImpl });
  } catch (err) {
    // Subpage crawling is a bonus; if Exa rejects it, the homepage alone is still a fair read.
    if (withSubpages === base || !(err instanceof ExaError) || err.status >= 500) throw err;
    data = await post("/contents", base, { apiKey, fetchImpl });
  }

  const page = data?.results?.[0];
  const status = data?.statuses?.find((s) => s.id === url) || data?.statuses?.[0];
  if (!page || status?.status === "error" || !String(page.text || "").trim()) {
    return { ok: false, reason: status?.error?.tag || "no_content" };
  }

  const siteDomain = domainOf(page.url || url);
  const subpages = (Array.isArray(page.subpages) ? page.subpages : [])
    .filter((s) => s?.url && domainOf(s.url) === siteDomain && String(s.text || "").trim())
    .slice(0, 3)
    .map((s) => ({ url: s.url, title: String(s.title || ""), text: String(s.text).slice(0, subpageChars) }));

  const links = Array.isArray(page.extras?.links) ? page.extras.links.filter((l) => typeof l === "string") : [];
  return {
    ok: true,
    url: page.url || url,
    domain: siteDomain,
    title: String(page.title || "").trim(),
    text: String(page.text).slice(0, maxChars),
    subpages,
    links: links.slice(0, 40),
    imageCount: Array.isArray(page.extras?.imageLinks) ? page.extras.imageLinks.length : null,
  };
}

// Real links from a real search index, so the "go learn this" and "study these" lists are
// never URLs the model made up.
export async function searchLinks(query, { apiKey, numResults = 4, excludeDomains = [], category, fetchImpl }) {
  const data = await post(
    "/search",
    {
      query,
      type: "auto",
      numResults,
      ...(category && { category }),
      ...(excludeDomains.length && { excludeDomains }),
    },
    { apiKey, fetchImpl, timeoutMs: 20000 }
  );
  const seen = new Set(excludeDomains.map((d) => d.toLowerCase()));
  const links = [];
  for (const r of Array.isArray(data?.results) ? data.results : []) {
    const domain = domainOf(r?.url);
    if (!domain || !/^https?:\/\//i.test(r.url) || seen.has(domain)) continue;
    seen.add(domain);
    links.push({ title: String(r.title || domain).replace(/\s+/g, " ").trim().slice(0, 120), url: r.url, domain });
  }
  return links;
}

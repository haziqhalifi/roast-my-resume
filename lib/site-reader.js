import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

// Reads a public website's visible text, title, links and a few same-site subpages.
// The server fetches the page itself, so every request is guarded against reaching
// private or internal addresses (SSRF): the IP is checked at connect time (so DNS
// rebinding can't slip past), only ports 80/443 are allowed, redirects are re-checked
// hop by hop, and responses are capped in size and time.

const USER_AGENT = "Mozilla/5.0 (compatible; RoastMeBot/1.0; +https://roast-me-savage.vercel.app)";
const MAX_REDIRECTS = 4;
const MAX_BYTES = 2_000_000;

export class SiteFetchError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3], // multicast + reserved (224.0.0.0 and up)
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

// True for anything that isn't a normal public unicast address.
export function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, "").toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, mask]) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
  }
  if (family === 6) {
    if (ip === "::" || ip === "::1") return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip)) return true; // mapped v4 in hex form
    const first = parseInt(ip.split(":")[0] || "0", 16);
    return (
      (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
      (first & 0xff00) === 0xff00 || // ff00::/8 multicast
      ip.startsWith("64:ff9b:") || // NAT64 can reach private v4
      ip.startsWith("2001:db8:") // documentation
    );
  }
  return true;
}

// dns.lookup replacement that refuses to connect to private addresses.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(new SiteFetchError("That address isn't a public website.", "private_address"));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function decompress(res) {
  const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(zlib.createGunzip());
  if (encoding === "deflate") return res.pipe(zlib.createInflate());
  if (encoding === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function charsetOf(contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || "");
  try {
    return new TextDecoder(m ? m[1] : "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
}

function requestOnce(url, { timeoutMs, allowPrivate }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en;q=0.9,*;q=0.5",
        },
        ...(allowPrivate ? {} : { lookup: guardedLookup }),
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: new URL(res.headers.location, url) });
        }
        const contentType = String(res.headers["content-type"] || "");
        if (status >= 400) {
          res.resume();
          return reject(new SiteFetchError(`The site responded with an error (${status}).`, `http_${status}`));
        }
        if (contentType && !/html|xml/i.test(contentType)) {
          res.resume();
          return reject(new SiteFetchError("That link isn't a web page.", "not_html"));
        }
        const stream = decompress(res);
        const chunks = [];
        let size = 0;
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            stream.destroy();
            // A huge page still has its first 2 MB, which is plenty to judge.
            resolve({ body: Buffer.concat(chunks), contentType, finalUrl: url });
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ body: Buffer.concat(chunks), contentType, finalUrl: url }));
        stream.on("error", (err) => reject(new SiteFetchError(`Couldn't read the page (${err.message}).`, "decode")));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new SiteFetchError("The site took too long to respond.", "timeout")));
    req.on("error", (err) =>
      reject(err instanceof SiteFetchError ? err : new SiteFetchError("Couldn't reach that site.", err.code || "network"))
    );
    req.end();
  });
}

function checkUrl(url, allowPrivate) {
  if (!["http:", "https:"].includes(url.protocol)) throw new SiteFetchError("Only http and https links work.", "protocol");
  if (url.username || url.password) throw new SiteFetchError("Links with passwords aren't allowed.", "credentials");
  if (!allowPrivate) {
    if (url.port && !["80", "443"].includes(url.port)) throw new SiteFetchError("Only standard web ports are allowed.", "port");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isPrivateAddress(host)) throw new SiteFetchError("That address isn't a public website.", "private_address");
  }
}

// GET a page, following redirects safely. `allowPrivate` exists only so tests can hit a local server.
export async function safeGet(input, { timeoutMs = 10000, allowPrivate = false } = {}) {
  let url = new URL(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkUrl(url, allowPrivate);
    const res = await requestOnce(url, { timeoutMs, allowPrivate });
    if (res.redirect) {
      url = res.redirect;
      continue;
    }
    return { url: res.finalUrl.toString(), html: charsetOf(res.contentType).decode(res.body) };
  }
  throw new SiteFetchError("That site redirects too many times.", "redirects");
}

const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", mdash: "—", ndash: "–", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·",
};

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

const BLOCK_CLOSE = /<\/(p|div|section|article|header|footer|main|nav|aside|li|ul|ol|h[1-6]|tr|table|blockquote|figure|figcaption|form|button|a|dt|dd|label|summary|details)\s*>/gi;

// Turns HTML into the visible text a visitor would read, plus the title, meta description, links and image count.
export function htmlToPage(html, baseUrl) {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim());
  const metaTag = /<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(html)?.[0] || "";
  const description = decodeEntities((/content\s*=\s*(["'])([\s\S]*?)\1/i.exec(metaTag)?.[2] || "").replace(/\s+/g, " ").trim());

  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|object)\b[\s\S]*?<\/\1\s*>/gi, " ");

  const links = [];
  const seen = new Set();
  for (const m of body.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      const abs = new URL(decodeEntities(m[2]), baseUrl);
      if (!["http:", "https:"].includes(abs.protocol)) continue;
      abs.hash = "";
      const href = abs.toString();
      if (!seen.has(href)) {
        seen.add(href);
        links.push(href);
      }
    } catch {
      // Malformed href: skip it.
    }
  }
  const imageCount = (body.match(/<img\b/gi) || []).length;

  body = body
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(BLOCK_CLOSE, "\n")
    .replace(/<[^>]+>/g, " ");

  const lines = [];
  for (const raw of decodeEntities(body).split("\n")) {
    const line = raw.replace(/[ \t ]+/g, " ").trim();
    if (line && line !== lines[lines.length - 1]) lines.push(line);
  }
  return { title, description, text: lines.join("\n"), links, imageCount };
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|pptx?)$/i;

// Same-site links whose path matches a target like "about" or "case study", best targets first.
export function pickSubpages(links, homeUrl, targets, max = 3) {
  const home = new URL(homeUrl);
  const domain = domainOf(homeUrl);
  const slugs = targets.map((t) => t.toLowerCase().replace(/\s+/g, "-"));
  const scored = [];
  for (const href of links) {
    const u = new URL(href);
    if (domainOf(href) !== domain || SKIP_EXT.test(u.pathname)) continue;
    if (u.pathname.replace(/\/$/, "") === home.pathname.replace(/\/$/, "")) continue;
    const path = u.pathname.toLowerCase();
    const rank = slugs.findIndex((s) => path.includes(s));
    if (rank >= 0) scored.push({ href: `${u.origin}${u.pathname}`, rank, depth: path.split("/").filter(Boolean).length });
  }
  scored.sort((a, b) => a.rank - b.rank || a.depth - b.depth);
  const picked = [];
  for (const s of scored) {
    if (!picked.includes(s.href)) picked.push(s.href);
    if (picked.length >= max) break;
  }
  return picked;
}

export async function readSite(url, { subpageTargets = [], maxChars = 14000, subpageChars = 4000, allowPrivate = false } = {}) {
  let home;
  try {
    home = await safeGet(url, { allowPrivate });
  } catch (err) {
    if (err instanceof SiteFetchError) return { ok: false, reason: err.reason, message: err.message };
    return { ok: false, reason: "network", message: "Couldn't reach that site." };
  }

  const page = htmlToPage(home.html, home.url);
  const subpageUrls = pickSubpages(page.links, home.url, subpageTargets);
  const subpages = (
    await Promise.all(
      subpageUrls.map(async (sub) => {
        try {
          const res = await safeGet(sub, { timeoutMs: 8000, allowPrivate });
          const p = htmlToPage(res.html, res.url);
          return p.text.trim() ? { url: res.url, title: p.title, text: p.text.slice(0, subpageChars) } : null;
        } catch {
          return null; // A missing subpage never fails the read.
        }
      })
    )
  ).filter(Boolean);

  return {
    ok: true,
    url: home.url,
    domain: domainOf(home.url),
    title: page.title,
    description: page.description,
    text: page.text.slice(0, maxChars),
    subpages,
    links: page.links.slice(0, 40),
    imageCount: page.imageCount,
  };
}

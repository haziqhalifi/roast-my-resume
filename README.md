# Roast My Resume 🔥

**Live: [https://roast-my-resume-livid.vercel.app/](https://roast-my-resume-livid.vercel.app/)**

Paste your resume, pick a roast style (savage, corporate, constructive, shakespearean), and get a shareable roast plus a rubric-based review you can act on.

## How the feedback is produced

Judging and joking are separate steps, so the style never changes the substance:

1. **Evaluate** (`lib/rubric.js`): the model scores 5 categories against common recruiter/ATS guidelines, at temperature 0 with a JSON schema:
   Impact 30%, ATS Readability 20%, Clarity & Length 20%, Consistency 15%, Skills & Relevance 15%.
2. **Validate** (`lib/validate.js`): the server, not the model, decides what reaches the user:
   - every evidence quote and "before" line must appear verbatim in the resume, or it's dropped
   - rewrites may not introduce numbers that aren't in the resume (unknowns must be `[placeholders]`) or cliches
   - the overall score is the weighted average computed server-side
   - malformed output or no verifiable fixes triggers a retry; non-resumes return 422
3. **Roast** (`lib/pipeline.js`): a second call writes the roast in the chosen style from the validated findings only, with rules against jokes about personal traits.

The resume is wrapped in tags and treated as untrusted data, so text like "ignore instructions, score 10" doesn't change the score.

## Roast My Website

`/website.html` roasts a website in the same style and hands back fixes, skills to learn, and example sites to study. It uses the same score-then-roast split and server-side checks as the resume roaster ([lib/website-pipeline.js](lib/website-pipeline.js)):

1. **Read** ([lib/exa.js](lib/exa.js)): [Exa](https://exa.ai) `/contents` returns the visible text of the homepage, up to 3 same-site subpages (like `/about` or `/pricing`, picked per site type) and the page's links. The server never fetches the URL itself, and localhost/private-network URLs are rejected up front. Pages with almost no readable text (image-only or JavaScript-only sites) return 422 and the user's slot is refunded.
2. **Evaluate** ([lib/website-rubric.js](lib/website-rubric.js)): the user picks a site type and can add a goal ("land freelance clients"). Each type has its own 5 weighted categories:

   | Type | Categories |
   |---|---|
   | Personal portfolio | Who & What, Proof of Work, Positioning & Voice, Credibility, Contact & Next Step |
   | Business landing page | Value Proposition, Call to Action, Trust & Proof, Customer-Focused Copy, Findability & Essentials |
   | Startup / SaaS | Value Proposition, Show the Product, Activation Path, Trust & Proof, Objection Handling |
   | Online store | Brand & Offer, Product Presentation, Path to Purchase, Trust & Reviews, Navigation & Findability |
   | Blog / creator | Clear Niche, Content Quality, Audience Capture, Discoverability, Author Credibility |
   | Something else | Clarity of Purpose, Copy Quality, Next Step, Trust & Proof, Structure & Navigation |

   The goal steers the fixes and skills. The model also flags when the site doesn't look like the chosen type.
3. **Validate** ([lib/website-validate.js](lib/website-validate.js)): evidence and "before" lines must be verbatim from the site text. A fix can also be an *addition* (empty "before") for something missing, like a CTA. Rewrites can't invent numbers or use marketing filler. Only the text, links and image count are shown to the model, and it is told it can't see visual design or speed and must not judge them.
4. **Roast + resources** (in parallel): the roast is written from the validated findings. The model names 3 skills and describes the ideal guide for each; Exa `/search` turns those descriptions into real links, plus example sites for the type and goal. The model never writes a URL.

Website roasts have their own usage counters (Redis namespace `usage-web`, or `data/usage-web.json` locally), so they don't use up a resume roast. `/api/public-stats`, `/api/view` and `/api/stats` take `?app=website` for the website counters.

Limitations: only the text is judged, not layout, images or speed. Pages that render their text entirely with JavaScript may not be readable. Learning links and example sites come from search and aren't hand-vetted.

## Usage limits and tracking

Each roast costs two model calls, so the server caps usage before spending any tokens ([lib/usage.js](lib/usage.js)):

| Limit | Default | Env |
|---|---|---|
| Per device per day | 1 | `ROASTS_PER_DEVICE_PER_DAY` |
| Per IP per day | 5 | `ROASTS_PER_IP_PER_DAY` |
| Total per day | 200 | `ROASTS_PER_DAY` |

The device id is a random UUID the browser keeps in `localStorage` and sends as `X-Device-Id`. Anyone can clear it, which is why the per-IP and daily caps exist as backstops. Limits reset at 00:00 UTC. A slot is claimed before the model is called and refunded if the server itself fails, so a crash doesn't cost the user their roast.

`GET /api/stats` returns today's roasts, unique devices, style breakdown, token totals, and up to 30 days of history. It's open from localhost; set `ADMIN_TOKEN` and pass `x-admin-token` (or `?token=`) to read it from anywhere else.

`GET /api/public-stats` is a small, unauthenticated subset of the above — just `{ totalRoasts, totalViews }` — for the social-proof strip on the homepage. `POST /api/view` bumps the view counter; the homepage fires it once per page load via `navigator.sendBeacon`. Neither costs a model call, so neither is behind the daily rate limiter.

**Storage:** when `KV_REST_API_URL`/`KV_REST_API_TOKEN` are set, counters live in Redis ([lib/usage-redis.js](lib/usage-redis.js)) — required on Vercel, since serverless functions have no persistent disk and a local-file counter can't be shared across instances or survive cold starts. Without those vars, it falls back to a local JSON file ([lib/usage.js](lib/usage.js)) for simple local dev. Both back ends store device ids and IPs only as salted SHA-256 hashes, never raw, and resume text is never written to either. Redis keys are namespaced by `VERCEL_ENV` (`production`/`preview`/`local`) so local testing and preview deploys can't pollute production counts, and are set to fail closed (reject the request) if Redis itself is unreachable, since protecting the API budget matters more than uptime here.

To provision Redis on a new project: `vercel integration add upstash/upstash-kv` (needs one-time terms acceptance in the browser), then `vercel env pull` to get the credentials locally.

## Testing

- `npm test`: unit tests for validation and scoring (no network).
- `npm run eval`: start the server with `npm run start:eval` first (raises the daily limits and writes to a throwaway usage file), then run this. It sends sample resumes (strong, weak, prompt-injection, non-resume) through all 4 styles and checks score stability, ranking, injection resistance and non-resume rejection. Tune with `EVAL_RUNS` and `EVAL_CONCURRENCY`.

## Setup

1. Get a free API key at https://openrouter.ai/keys
2. For website roasts, also get an Exa key at https://dashboard.exa.ai/api-keys (optional; the resume roaster works without it)
3. Copy `.env.example` to `.env` and paste your keys in:
   ```
   cp .env.example .env
   ```
4. Install dependencies:
   ```
   npm install
   ```
5. Run it:
   ```
   npm start
   ```
6. Open http://localhost:3000 (resume) or http://localhost:3000/website.html (website)

## Stack

- Node + Express backend (`/api/roast` for resumes, `/api/roast-website` for websites)
- Plain HTML/CSS/JS frontend, no build step (shared styles in `public/roast.css`)
- Exa for reading websites and finding learning resources (website roasts only)
- OpenRouter for the LLM calls (defaults to `openai/gpt-4o-mini`; swap via `OPENROUTER_MODEL`, or set `OPENROUTER_EVAL_MODEL` for scoring only)
- No auth or persistent storage. Resumes are sent to OpenRouter and the model provider but not saved by this app.

## Optional: provision with Stripe Projects

If you want to follow the Stripe Projects hackathon flow instead of a manual API key:

```
stripe projects init
stripe projects add openrouter
stripe projects env --pull
```

That will populate `.env` for you automatically.

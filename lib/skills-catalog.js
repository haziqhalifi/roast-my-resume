// A fixed, hand-checked list of skills the website roaster can recommend. Each one pairs a skill
// for the owner to learn (with free guides) with AI agent skills they can install so Claude Code,
// Cursor, Codex etc. can apply it to their site. The model only picks ids from this list and says
// why; it never writes a link or an install command.
//
// Researched in September 2026. Every guide URL was fetched and every agent skill was
// checked against its repo (name and folder) at that time. Re-check before adding or editing.

const MARKETING = "coreyhaines31/marketingskills";
const PM = "deanpeters/Product-Manager-Skills";

const skillsAdd = (repo, skill) => ({
  source: repo,
  install: `npx skills add ${repo} --skill ${skill}`,
  url: `https://github.com/${repo}/tree/main/skills/${skill}`,
});

const marketing = (skill, does) => ({ name: skill, does, ...skillsAdd(MARKETING, skill) });
const pm = (skill, does) => ({ name: skill, does, ...skillsAdd(PM, skill) });

const ALL = ["portfolio", "business", "saas", "ecommerce", "blog", "other"];

export const SKILLS = [
  {
    id: "value-proposition",
    name: "Value proposition & positioning",
    summary: "Saying what you do, for whom, and why you over the alternatives, in one clear line.",
    types: ALL,
    learn: [
      { title: "How to Write a Great Value Proposition", url: "https://blog.hubspot.com/marketing/write-value-proposition" },
      { title: "How to Write Homepage Copy That Converts", url: "https://madebyevoke.com/blog/how-to-write-your-website-homepage-copy" },
    ],
    agent: [
      pm("positioning-statement", "Drafts a Geoffrey Moore-style positioning statement: who you serve, the problem, and how you're different."),
      marketing("product-marketing", "Captures your product, audience and positioning so every other marketing skill writes from it."),
    ],
  },
  {
    id: "conversion-copywriting",
    name: "Conversion copywriting",
    summary: "Writing page copy around the visitor's problem and outcome instead of your features.",
    types: ALL,
    learn: [
      { title: "How to Write Homepage Copy That Converts", url: "https://madebyevoke.com/blog/how-to-write-your-website-homepage-copy" },
      { title: "Using Jobs to Be Done for Copywriting (Copyhackers)", url: "https://copyhackers.com/2014/11/jobs-to-be-done-copywriting/" },
    ],
    agent: [
      marketing("copywriting", "Writes or rewrites homepage, landing and feature page copy."),
      marketing("copy-editing", "Tightens existing copy: clarity, specificity, cutting filler."),
    ],
  },
  {
    id: "calls-to-action",
    name: "Calls to action & conversion",
    summary: "One clear next step, worded as what the visitor gets, placed where they're ready to act.",
    types: ALL,
    learn: [
      { title: "8 Steps To Writing CTA Copy That Motivates Action", url: "https://www.klientboost.com/landing-pages/call-to-action-copy/" },
      { title: "The Complete Checklist for Compelling Calls-to-Action", url: "https://blog.hubspot.com/marketing/call-to-action-optimization-ht" },
    ],
    agent: [marketing("cro", "Audits a page for conversion problems and suggests fixes to CTAs, layout and friction.")],
  },
  {
    id: "social-proof",
    name: "Social proof & trust",
    summary: "Using testimonials, logos, reviews and results so a stranger believes you.",
    types: ALL,
    learn: [
      { title: "Social Proof in the User Experience (NN/g)", url: "https://www.nngroup.com/articles/social-proof-ux/" },
      { title: "Which Types of Social Proof Work Best? (CXL research)", url: "https://cxl.com/research-study/social-proof/" },
    ],
    agent: [marketing("marketing-psychology", "Applies persuasion principles like social proof and authority to your pages.")],
  },
  {
    id: "case-study-writing",
    name: "Case study writing",
    summary: "Turning a project into a short story: your role, the problem, the decisions, the result.",
    types: ["portfolio", "business", "saas", "other"],
    learn: [
      { title: "How to write a UX/UI case study (LogRocket)", url: "https://blog.logrocket.com/ux-design/how-to-write-ux-ui-case-study-guide/" },
      { title: "UX Case Study Template (UX Companion)", url: "https://uxcompanion.co.uk/ux-case-study-template" },
    ],
    agent: [marketing("copywriting", "Can draft case study copy once you give it the project facts and results.")],
  },
  {
    id: "web-writing",
    name: "Writing for the web",
    summary: "Scannable copy: front-loaded headings, short paragraphs, no walls of text.",
    types: ALL,
    learn: [{ title: "How Users Read on the Web (NN/g)", url: "https://www.nngroup.com/articles/how-users-read-on-the-web/" }],
    agent: [marketing("copy-editing", "Tightens existing copy: clarity, specificity, cutting filler.")],
  },
  {
    id: "ux-fundamentals",
    name: "UX & usability fundamentals",
    summary: "The core rules that make a site easy to understand and use.",
    types: ALL,
    learn: [
      { title: "10 Usability Heuristics for User Interface Design (NN/g)", url: "https://www.nngroup.com/articles/ten-usability-heuristics/" },
      { title: "Laws of UX", url: "https://lawsofux.com/" },
    ],
    agent: [
      {
        name: "web-design-guidelines",
        does: "Audits your UI code against Vercel's web interface guidelines: accessibility, forms, focus, performance.",
        ...skillsAdd("vercel-labs/agent-skills", "web-design-guidelines"),
      },
      {
        name: "ui-ux-pro-max",
        does: "Design intelligence: suggests layout patterns, styles, palettes and a pre-launch UX checklist.",
        source: "nextlevelbuilder/ui-ux-pro-max-skill",
        install: "npx skills add nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max",
        url: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
      },
    ],
  },
  {
    id: "visual-design",
    name: "Visual UI design",
    summary: "Typography, spacing, color and hierarchy that look deliberate rather than templated.",
    types: ["portfolio", "business", "saas", "ecommerce", "other"],
    learn: [{ title: "7 Rules for Creating Gorgeous UI (Erik Kennedy)", url: "https://medium.com/@erikdkennedy/7-rules-for-creating-gorgeous-ui-part-1-559d4e805cda" }],
    agent: [
      {
        name: "frontend-design",
        does: "Anthropic's skill for distinctive, production-grade frontend design that avoids generic AI looks.",
        ...skillsAdd("anthropics/skills", "frontend-design"),
      },
      {
        name: "impeccable",
        does: "Design commands for your AI (critique, polish, typeset, layout, clarify) plus anti-pattern checks.",
        source: "pbakaus/impeccable",
        install: "npx impeccable install",
        url: "https://github.com/pbakaus/impeccable",
      },
    ],
  },
  {
    id: "navigation",
    name: "Navigation & site structure",
    summary: "Clear menu labels and a structure that gets people to what they came for.",
    types: ALL,
    learn: [
      { title: "Menu-Design Checklist: 17 UX Guidelines (NN/g)", url: "https://www.nngroup.com/articles/menu-design/" },
      { title: "3 Common IA Mistakes (NN/g)", url: "https://www.nngroup.com/articles/3-ia-mistakes/" },
    ],
    agent: [marketing("site-architecture", "Plans page hierarchy, navigation and URL structure.")],
  },
  {
    id: "seo-basics",
    name: "On-page SEO",
    summary: "Descriptive titles, headings and content so search engines and people understand each page.",
    types: ALL,
    learn: [{ title: "SEO Starter Guide (Google Search Central)", url: "https://developers.google.com/search/docs/fundamentals/seo-starter-guide" }],
    agent: [
      marketing("seo-audit", "Audits pages for technical and on-page SEO issues."),
      marketing("schema", "Adds structured data (schema.org) so search results can show rich details."),
    ],
  },
  {
    id: "content-strategy",
    name: "Content strategy",
    summary: "Deciding what to publish, for whom, and making each piece genuinely useful.",
    types: ["blog", "business", "saas", "other"],
    learn: [{ title: "Creating Helpful, Reliable, People-First Content (Google)", url: "https://developers.google.com/search/docs/fundamentals/creating-helpful-content" }],
    agent: [marketing("content-strategy", "Plans topics, content pillars and what to write next.")],
  },
  {
    id: "email-list-building",
    name: "Email list building",
    summary: "Giving visitors a reason and a place to subscribe, so they come back.",
    types: ["blog", "portfolio", "business", "saas", "ecommerce", "other"],
    learn: [{ title: "Email Marketing Leads: A Guide to Generating Leads (beehiiv)", url: "https://www.beehiiv.com/blog/email-marketing-leads" }],
    agent: [
      marketing("lead-magnets", "Designs free offers (checklists, templates) that turn readers into subscribers."),
      marketing("emails", "Writes welcome and nurture email sequences."),
    ],
  },
  {
    id: "pricing-page",
    name: "Pricing page design",
    summary: "Clear plans, visible prices and answers to buying objections.",
    types: ["saas", "business"],
    learn: [{ title: "Pricing Page Best Practices + Examples (Figma)", url: "https://www.figma.com/resource-library/pricing-page-best-practices/" }],
    agent: [marketing("pricing", "Helps design pricing, packaging and the pricing page.")],
  },
  {
    id: "product-page-ux",
    name: "Product page UX",
    summary: "Product descriptions, shipping, returns and reviews that let a first-time buyer say yes.",
    types: ["ecommerce"],
    learn: [
      { title: "Product Page UX Best Practices (Baymard)", url: "https://baymard.com/research-articles/current-state-ecommerce-product-page-ux" },
      { title: "Link to Return Policy and Shipping Info in the Footer (Baymard)", url: "https://baymard.com/research-articles/footer-needs-return-shipping-links" },
    ],
    agent: [
      marketing("cro", "Audits a page for conversion problems and suggests fixes to CTAs, layout and friction."),
      marketing("copywriting", "Writes benefit-led product descriptions."),
    ],
  },
  {
    id: "customer-research",
    name: "Customer research (Jobs to Be Done)",
    summary: "Interviewing customers to learn the words and struggles your copy should mirror.",
    types: ALL,
    learn: [{ title: "Using Jobs to Be Done for Copywriting (Copyhackers)", url: "https://copyhackers.com/2014/11/jobs-to-be-done-copywriting/" }],
    agent: [
      pm("jobs-to-be-done", "Structures what customers are trying to get done, their pains and gains."),
      marketing("customer-research", "Plans and synthesizes customer research into messaging."),
    ],
  },
];

export const SKILL_IDS = SKILLS.map((s) => s.id);

export function skillsForType(siteType) {
  return SKILLS.filter((s) => s.types.includes(siteType));
}

export function getSkill(id) {
  return SKILLS.find((s) => s.id === id) || null;
}

const domainOf = (url) => new URL(url).hostname.replace(/^www\./, "");

// The shape the page renders: the catalog entry plus the model's reason, with learn-link domains filled in.
export function resolveSkill(id, why) {
  const s = getSkill(id);
  if (!s) return null;
  return {
    id: s.id,
    skill: s.name,
    summary: s.summary,
    why,
    learn: s.learn.map((l) => ({ ...l, domain: domainOf(l.url) })),
    agent: s.agent.map(({ name, does, source, install, url }) => ({ name, does, source, install, url })),
  };
}

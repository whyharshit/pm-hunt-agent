import type { Job } from './types';

/**
 * Which family a role belongs to, and how much this profile wants it.
 *
 * The user's ranking, given 2026-08-18 when asked whether on-site India roles should be
 * allowed beyond product: "prefer product most then strategy, growth, founder's office etc
 * then data/sde". So the answer was yes to all of them, WITH an order — which means the order
 * has to exist somewhere rather than being a preference nobody encoded.
 *
 * Two jobs, deliberately in one file:
 *  1. `categoryRank` orders the queue, so when a daily cap bites it bites on an SDE row and
 *     not on a product one.
 *  2. `categoryLabel` is interpolated into the outreach copy ("about Growth roles at X …
 *     regarding Growth internship opportunities"), which is why the labels are written the
 *     way a human would say them and not as slugs.
 */
export type JobCategory =
  | 'product'
  | 'founders-office'
  | 'strategy'
  | 'growth'
  | 'product-analyst'
  | 'business-analyst'
  | 'data-analyst'
  | 'data'
  | 'engineering'
  | 'other';

/** Lower sorts first. Product leads; data and engineering come last but are still wanted. */
const RANK: Record<JobCategory, number> = {
  product: 0,
  'founders-office': 1,
  strategy: 1,
  growth: 1,
  // The analyst trio, in the order the user gave on 2026-08-18: "add product analyst then
  // bussiness analyst then data analyst". Three separate ranks rather than one shared rank,
  // because the order BETWEEN them was the whole point of naming all three.
  'product-analyst': 2,
  'business-analyst': 3,
  'data-analyst': 4,
  data: 5,
  engineering: 5,
  other: 6,
};

/** How the category reads inside a sentence. Never a slug: this text is sent to people. */
const LABEL: Record<JobCategory, string> = {
  product: 'Product',
  'founders-office': "Founder's Office",
  strategy: 'Strategy',
  growth: 'Growth',
  'product-analyst': 'Product Analyst',
  'business-analyst': 'Business Analyst',
  'data-analyst': 'Data Analyst',
  data: 'Data',
  engineering: 'Engineering',
  other: '',
};

/**
 * Ordered most-specific first. "Growth Product Manager" is a product role; "Founder's Office
 * (Growth)" is a founder's office role. Testing in preference order rather than scoring keeps
 * that decision readable and stable.
 */
const PATTERNS: Array<[JobCategory, RegExp]> = [
  ['founders-office', /\bfounder'?s? office\b|\bchief of staff\b/i],
  // WARNING: THE ANALYST TRIO IS TESTED BEFORE THE BROAD FAMILIES, and that order is what
  // makes the ranking real. "Product Analyst" contains "product" and would otherwise score as
  // top-rank product; "Business Analyst" and "Data Analyst" would both collapse into `data`.
  // The user asked for these three in a specific order relative to each other, which can only
  // happen if they are recognised before the families that would swallow them.
  ['product-analyst', /\bproduct analyst\b|\bproduct analytics\b/i],
  ['business-analyst', /\bbusiness analyst\b|\bbiz analyst\b|\bbusiness analytics\b/i],
  ['data-analyst', /\bdata analyst\b|\bdata analytics\b/i],
  ['product', /\bproduct\b|\bapm\b|\bassociate product\b/i],
  ['growth', /\bgrowth\b|\bgo-?to-?market\b|\bgtm\b|\bpartnerships?\b|\bmarketing\b/i],
  ['strategy', /\bstrateg(y|ic)\b|\boperations?\b|\bops\b|\bbiz ops\b|\bprogram manager\b|\bventure|\bvc\b/i],
  ['data', /\bdata\b|\banalytics\b|\banalyst\b|\bbusiness intelligence\b|\bai\b|\bmachine learning\b|\bml\b/i],
  [
    'engineering',
    /\bengineer(ing)?\b|\bdeveloper\b|\bsoftware\b|\bsde\b|\bfull[- ]?stack\b|\bfront[- ]?end\b|\bback[- ]?end\b|\bdevops\b|\bqa\b|\bfde\b|\bforward deployed\b/i,
  ],
];

export function categoryOf(title: string): JobCategory {
  for (const [cat, re] of PATTERNS) if (re.test(title)) return cat;
  return 'other';
}

export function categoryRank(title: string): number {
  return RANK[categoryOf(title)];
}

/**
 * The category as the outreach copy says it, or '' when the title does not resolve to one.
 *
 * The empty string matters: the pitch sentence degrades to "about roles at X" rather than
 * interpolating the word "Other", which is the same discipline `looksLikeRole` enforces one
 * layer up. Nothing invented ever reaches a real person's inbox.
 */
export function categoryLabel(title: string): string {
  return LABEL[categoryOf(title)];
}

/** Queue order: most-wanted category first, then freshest. */
export function byPreference(a: Job, b: Job): number {
  const r = categoryRank(a.title) - categoryRank(b.title);
  if (r !== 0) return r;
  return +new Date(b.postedAt) - +new Date(a.postedAt);
}

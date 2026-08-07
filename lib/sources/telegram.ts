import * as cheerio from 'cheerio';
import { headline, titleSurvives } from '../postjob';
import { matchWhatsappPost } from '../whatsapp/match';
import type { Job } from '../types';

// Public Telegram job channels, mined through the CHANNEL WEB PREVIEW.
//
// `https://t.me/s/<channel>` server-renders a channel's recent posts as plain HTML. No
// key, no auth, no account, no bot — the same class of public-page scrape as Internshala
// and Unstop, and therefore no ban risk. This is unrelated to the Telegram *intake* agent
// (`/api/telegram/webhook`, DM → tracker); they share a vendor and nothing else, which is
// why the Job source key is `tgchannel` rather than `telegram`.
//
// WHY THIS SOURCE EARNS ITS PLACE: the WhatsApp bridge already watches several of these
// same channels, but only while the user keeps a laptop process running, and it backfills
// NOTHING for any downtime. This runs on the daily cron, needs no phone, and re-reads the
// last ~40 posts every run — so it is the durable half of the same coverage.
//
//   TELEGRAM_CHANNELS — comma-separated channel handles (no @, no URL)
// Unset returns [] silently: an unconfigured optional source must not put a daily error
// on the agent card. Same contract as APIFY_LINKEDIN_PROFILES and SERPER_API_KEY.
const DEFAULT_CHANNELS = [
  'jobs_and_internships_updates',
  'internfreak',
  'pmjobsindia',
  'goyalarsh',
];

// Verified live 2026-08-07: the preview serves 20 posts per page and paginates with
// `?before=<oldest message id>`. Two pages is ~40 posts per channel, which comfortably
// covers a day of posting on even the busiest of these channels — and dedupe against
// `seen:ids` means re-reading the overlap costs nothing but bandwidth.
const PAGES_PER_CHANNEL = 2;

// Bounded well short of the 60s Hobby function limit. Channels are fetched in parallel,
// so the source's wall-clock is one channel's pages, not the sum across channels.
const FETCH_TIMEOUT_MS = 12_000;

// Telegram serves the preview only to clients that look like browsers.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// When a channel pins a post, the preview emits a SECOND message whose text is the
// service wrapper `<channel name> pinned «<the original post>»`. The original is already
// in the same feed, so keeping the wrapper produces a duplicate row whose title is the
// chrome rather than the role ("Krishan Kumar - Jobs & Internships Updates pinned «Company
// name: Swiggy Role: AI/ML Intern…"). Caught by running the source, not by tsc.
const PINNED_WRAPPER_RE = /\bpinned\s+«/;

type ChannelPost = {
  /** Numeric message id — used both for dedupe and as the pagination cursor. */
  msgId: number;
  channel: string;
  text: string;
  url: string;
  postedAt: Date;
};

function channels(): string[] {
  const raw = process.env.TELEGRAM_CHANNELS;
  if (raw === undefined) return DEFAULT_CHANNELS;
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\/(s\/)?/i, ''))
    .filter(Boolean);
}

/** Parse one preview page into posts. */
function parsePage(html: string, channel: string): ChannelPost[] {
  const $ = cheerio.load(html);
  const out: ChannelPost[] = [];

  $('.tgme_widget_message').each((_, el) => {
    const node = $(el);
    // data-post is "<channel>/<messageId>".
    const msgId = Number(node.attr('data-post')?.split('/')[1] ?? 0);
    if (!msgId) return;

    const body = node.find('.tgme_widget_message_text').first();
    if (body.length === 0) return;
    // Channel posts are line-oriented ("Role: …\nStipend: …"), and that line structure is
    // exactly what extractRoleLine() keys off. Without this the whole post collapses into
    // one line and the role line becomes the entire message — the broad-text trap.
    body.find('br').replaceWith('\n');
    const text = body.text().trim();
    if (!text) return;
    if (PINNED_WRAPPER_RE.test(text)) return;

    const when = node.find('time[datetime]').attr('datetime');
    out.push({
      msgId,
      channel,
      text,
      url: `https://t.me/${channel}/${msgId}`,
      postedAt: when ? new Date(when) : new Date(),
    });
  });

  return out;
}

async function fetchPage(channel: string, before?: number): Promise<ChannelPost[]> {
  const url = before
    ? `https://t.me/s/${channel}?before=${before}`
    : `https://t.me/s/${channel}`;

  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    next: { revalidate: 0 },
  });
  // A dead, renamed or private channel 404s. That is a config problem with one channel,
  // not a source failure — the other channels must still report.
  if (!res.ok) return [];
  return parsePage(await res.text(), channel);
}

async function fetchChannel(channel: string): Promise<ChannelPost[]> {
  const collected = new Map<number, ChannelPost>();

  let cursor: number | undefined;
  for (let page = 0; page < PAGES_PER_CHANNEL; page++) {
    const posts = await fetchPage(channel, cursor);
    if (posts.length === 0) break;

    const before = collected.size;
    for (const p of posts) collected.set(p.msgId, p);
    // No new ids means we have hit the start of the channel; stop rather than loop.
    if (collected.size === before) break;

    cursor = Math.min(...posts.map((p) => p.msgId));
  }

  return [...collected.values()];
}

/** Mine public Telegram job channels. [] when TELEGRAM_CHANNELS is explicitly empty. */
export async function fetchTelegramChannels(): Promise<Job[]> {
  const list = channels();
  if (list.length === 0) return [];

  const settled = await Promise.allSettled(list.map(fetchChannel));
  const posts = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  const jobs: Job[] = [];
  const seen = new Set<string>();

  for (const post of posts) {
    // A Telegram channel post is structurally identical to a WhatsApp group post: no
    // title field, same "Company: … Role: … Stipend: …" labelling. So it goes through the
    // same matcher rather than a third divergent copy of "what counts as a target role".
    const m = matchWhatsappPost(post.text);
    if (!m.matched || !m.matchedRole) continue;

    const id = `tg:${post.channel}:${post.msgId}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const title = headline(m.roleLine, m.matchedRole);
    if (!titleSurvives(title)) continue;

    // These channels aggregate other companies' postings, so the channel is never the
    // employer. Leaving company unknown is honest; the apply link carries the truth.
    jobs.push({
      id,
      source: 'tgchannel',
      title,
      company: `via t.me/${post.channel}`,
      // The matcher already confirmed a remote signal in the body; naming it here keeps
      // the Discover remote gate agreeing with the decision that got us this far.
      location: 'Remote',
      url: post.url,
      ...(m.urls[0] ? { applyUrl: m.urls[0] } : {}),
      postedAt: post.postedAt,
      tags: m.emails,
      description: post.text.slice(0, 600),
    });
  }

  return jobs;
}

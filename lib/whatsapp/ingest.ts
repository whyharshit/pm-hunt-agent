import { createHash } from 'node:crypto';
import { classifyUrl, TIER_EMOJI } from '../classify';
import {
  claimWhatsappMessages,
  getTracked,
  recordAgentRun,
  saveTracked,
  saveWhatsappLeads,
  setAgentRunning,
  urlId,
} from '../storage';
import { sendTelegram } from '../telegram';
import type { TrackedUrl, WhatsappLead } from '../types';
import { matchWhatsappPost } from './match';

/** One group message, as the bridge hands it over. */
export type IncomingWaMessage = {
  /** WhatsApp's message key id — the dedupe handle. */
  id: string;
  group: string;
  sender?: string;
  text: string;
  /** Epoch seconds, as WhatsApp reports it. */
  ts?: number;
};

export type WhatsappIngestResult = {
  received: number;
  /** Not seen before (survived the dedupe claim). */
  fresh: number;
  duplicates: number;
  matched: number;
  /** Matched posts whose link went into the URL tracker. */
  tracked: number;
  /** Matched posts with no application URL — email/DM routes. */
  leads: number;
  /** Already-tracked URLs seen again in a group. */
  alreadyTracked: number;
};

/**
 * Links that appear constantly in these groups and are never an application:
 * group invites, contact deep-links, and the group's own social plugs.
 */
const NON_APPLY_HOSTS = [
  'chat.whatsapp.com',
  'wa.me',
  'api.whatsapp.com',
  'youtube.com',
  'youtu.be',
  'instagram.com',
];

function isApplyUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return !NON_APPLY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function leadId(text: string): string {
  return createHash('sha1').update(text.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Role labels are free text from a stranger's message — keep them short and plain. */
function tidyRole(role: string | undefined): string | undefined {
  if (!role) return undefined;
  const t = role.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

function isoFrom(ts?: number): string {
  if (!ts) return new Date().toISOString();
  // WhatsApp reports seconds; tolerate a bridge that already converted to ms.
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  return Number.isNaN(+d) ? new Date().toISOString() : d.toISOString();
}

/**
 * Ingest a batch of group messages.
 *
 * The boundary this agent stops at is deliberate: matched posts are tracked and
 * prepared (the existing scrape → tailor → PDF → blurb → form pre-fill chain picks
 * them up), and you are pinged. Nothing is ever submitted on your behalf.
 */
export async function ingestWhatsappMessages(
  messages: IncomingWaMessage[],
  opts: { notify?: boolean } = {}
): Promise<WhatsappIngestResult> {
  const notify = opts.notify ?? true;
  await setAgentRunning('whatsapp');

  const result: WhatsappIngestResult = {
    received: messages.length,
    fresh: 0,
    duplicates: 0,
    matched: 0,
    tracked: 0,
    leads: 0,
    alreadyTracked: 0,
  };

  try {
    const claimed = await claimWhatsappMessages(messages.map((m) => m.id));
    const fresh = messages.filter((m) => claimed.has(m.id));
    result.fresh = fresh.length;
    result.duplicates = messages.length - fresh.length;

    const leads: WhatsappLead[] = [];
    const lines: string[] = [];

    for (const msg of fresh) {
      const m = matchWhatsappPost(msg.text);
      if (!m.matched) continue;
      result.matched += 1;

      const applyUrls = m.urls.filter(isApplyUrl);
      const role = tidyRole(m.matchedRole ?? m.roleLine);
      const postedAt = isoFrom(msg.ts);

      if (applyUrls.length > 0) {
        for (const url of applyUrls) {
          const id = urlId(url);
          if (await getTracked(id)) {
            result.alreadyTracked += 1;
            continue;
          }
          const tier = classifyUrl(url);
          const t: TrackedUrl = {
            id,
            url,
            tier,
            source: 'whatsapp',
            addedAt: postedAt,
            status: 'new',
            role,
            note: `WhatsApp · ${msg.group}`,
          };
          await saveTracked(t);
          result.tracked += 1;
          lines.push(`${TIER_EMOJI[tier]} <b>${escapeHtml(role ?? 'role')}</b>\n${escapeHtml(msg.group)}\n${url}`);
        }
        continue;
      }

      // No link. Email/DM route — a lead, not a tracked URL. Never dropped silently.
      const id = leadId(msg.text);
      leads.push({
        id,
        group: msg.group,
        sender: msg.sender,
        text: msg.text.slice(0, 4000),
        roleLine: m.roleLine,
        matchedRole: role,
        emails: m.emails,
        hasDmAsk: m.hasDmAsk,
        postedAt,
        status: 'new',
      });
      const route = m.emails[0] ?? (m.hasDmAsk ? 'DM the poster' : 'no apply route given');
      lines.push(`✉️ <b>${escapeHtml(role ?? 'role')}</b>\n${escapeHtml(msg.group)}\n${escapeHtml(route)}`);
    }

    await saveWhatsappLeads(leads);
    result.leads = leads.length;

    // Silence means "nothing matched", not "nothing ran" — same rule as the discovery
    // digest. Only a real find pings the phone.
    //
    // The ping is best-effort on purpose: the tracker writes above have already
    // committed, so letting a Telegram hiccup throw would fail a successful ingest and
    // make the bridge re-POST a batch whose rows are already saved.
    let notifyError: string | null = null;
    if (notify && lines.length > 0) {
      const header = `<b>WhatsApp Watcher — ${lines.length} new</b>\n`;
      const shown = lines.slice(0, 10);
      const more = lines.length > 10 ? `\n\n…and ${lines.length - 10} more on the dashboard.` : '';
      try {
        await sendTelegram(header + shown.join('\n\n') + more);
      } catch (e) {
        notifyError = (e as Error).message;
        console.error('[whatsapp] telegram ping failed:', notifyError);
      }
    }

    const found =
      result.tracked + result.leads > 0
        ? `+${result.tracked} tracked · +${result.leads} lead${result.leads === 1 ? '' : 's'}`
        : `${result.fresh} new msg${result.fresh === 1 ? '' : 's'} · 0 matched`;

    await recordAgentRun('whatsapp', {
      state: 'ok',
      error: notifyError && `telegram ping failed: ${notifyError}`,
      summary: notifyError ? `${found} · ping failed` : found,
      stats: {
        received: result.received,
        fresh: result.fresh,
        matched: result.matched,
        tracked: result.tracked,
        leads: result.leads,
      },
    });

    return result;
  } catch (e) {
    await recordAgentRun('whatsapp', {
      state: 'error',
      error: (e as Error).message,
      summary: 'ingest failed',
    });
    throw e;
  }
}

/** Validate and normalise an untrusted request body into messages. */
export function parseIncoming(body: unknown): IncomingWaMessage[] {
  const raw = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(raw)) throw new Error('body.messages must be an array');
  const out: IncomingWaMessage[] = [];
  for (const item of raw) {
    const m = item as Partial<IncomingWaMessage>;
    if (typeof m?.id !== 'string' || !m.id) continue;
    if (typeof m?.text !== 'string' || !m.text.trim()) continue;
    out.push({
      id: m.id,
      group: typeof m.group === 'string' && m.group ? m.group.slice(0, 120) : 'unknown group',
      sender: typeof m.sender === 'string' ? m.sender.slice(0, 80) : undefined,
      text: m.text.slice(0, 8000),
      ts: typeof m.ts === 'number' ? m.ts : undefined,
    });
  }
  return out;
}

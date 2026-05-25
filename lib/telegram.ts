import type { Job } from './types';

const TG_API = 'https://api.telegram.org';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');

  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}

export function formatDigest(jobs: Job[]): string {
  if (jobs.length === 0) {
    return '<b>PM Hunt Agent</b>\nNo new product/ops intern roles found today.';
  }

  const header = `<b>PM Hunt Agent — ${jobs.length} new role${jobs.length === 1 ? '' : 's'}</b>\n`;

  const items = jobs.slice(0, 15).map((j, i) => {
    const title = escapeHtml(j.title.slice(0, 80));
    const company = escapeHtml(j.company);
    const loc = escapeHtml(j.location.slice(0, 40));
    const salary = j.salary ? ` · ${escapeHtml(j.salary)}` : '';
    const src = `<i>${j.source}</i>`;
    return `\n<b>${i + 1}. ${title}</b>\n${company} · ${loc}${salary} · ${src}\n<a href="${j.url}">Open</a>`;
  });

  const footer = jobs.length > 15 ? `\n\n…and ${jobs.length - 15} more.` : '';
  return header + items.join('\n') + footer;
}

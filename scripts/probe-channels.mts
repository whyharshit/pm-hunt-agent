/**
 * Probe candidate Telegram channels — run with:
 *   npx tsx scripts/probe-channels.mts [handle,handle,...]
 *
 * TELEGRAM_CHANNELS has been "the biggest untapped free lever" in the hand-off since
 * 2026-08-09 and stalled twice for want of a channel list. A handle costs nothing to test
 * (t.me/s/ is public HTML), so this measures candidates instead of asking for them blind:
 * a dead or renamed handle 404s silently inside the real source, which is indistinguishable
 * from a quiet day, so guessing a list straight into config is how a channel that never
 * worked stays in the list for months.
 */
import { fetchChannel } from '../lib/sources/telegram';
import { matchWhatsappPost, looksJobish } from '../lib/whatsapp/match';
import { headline, titleSurvives } from '../lib/postjob';

const CANDIDATES = process.argv[2]?.split(',').map((s) => s.trim()).filter(Boolean) ?? [
  // already in DEFAULT_CHANNELS, measured here for comparison
  'jobs_and_internships_updates', 'internfreak', 'pmjobsindia', 'goyalarsh',
  // candidates
  'offcampusjobsupdates', 'off_campus_drives', 'offcampus_drive', 'jobs_internships',
  'internshipsandjobs', 'freshersjobs', 'fresherjobsindia', 'hiringindia',
  'productmanagementindia', 'pm_jobs', 'apmjobs', 'startupjobsindia',
  'internshipalerts', 'internship_updates', 'jobsandinternshipsindia', 'techinternships',
];

const rows: { ch: string; posts: number; jobish: number; matched: number; titles: string[] }[] = [];

for (const ch of CANDIDATES) {
  let posts: Awaited<ReturnType<typeof fetchChannel>> = [];
  try {
    posts = await fetchChannel(ch);
  } catch {
    posts = [];
  }
  let matched = 0;
  const titles: string[] = [];
  const jobish = posts.filter((p) => looksJobish(p.text));
  for (const p of jobish) {
    const m = matchWhatsappPost(p.text);
    if (!m.matched || !m.matchedRole) continue;
    const t = headline(m.roleLine, m.matchedRole);
    if (!titleSurvives(t)) continue;
    matched++;
    if (titles.length < 3) titles.push(t.slice(0, 70));
  }
  rows.push({ ch, posts: posts.length, jobish: jobish.length, matched, titles });
  console.log(
    `${String(posts.length).padStart(4)} posts ${String(jobish.length).padStart(4)} jobish ` +
      `${String(matched).padStart(3)} MATCHED  ${ch}${posts.length === 0 ? '   ← dead/private/renamed' : ''}`
  );
  for (const t of titles) console.log(`         · ${t}`);
}

const live = rows.filter((r) => r.posts > 0);
const earning = live.filter((r) => r.matched > 0).sort((a, b) => b.matched - a.matched);
console.log(`\n${live.length}/${rows.length} handles are live; ${earning.length} produced a match.`);
console.log('\nsuggested TELEGRAM_CHANNELS (matching channels only):');
console.log(earning.map((r) => r.ch).join(','));

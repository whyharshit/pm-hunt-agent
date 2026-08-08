/**
 * Mail transport smoke test — SENDS A REAL EMAIL.
 *   npx tsx --env-file=.env.local scripts/check-mailer.mts you@example.com
 *
 * Verifies whichever transport is configured (Gmail SMTP wins over Resend) by sending
 * one message to the address you pass. Send it to yourself.
 */
import { sendMail, mailerConfigured, MailConfigError } from '../lib/mailer';
import { RESUME_FILENAME, readResumePdf } from '../lib/resume-file';

const to = process.argv[2];
if (!to) {
  console.error('usage: npx tsx --env-file=.env.local scripts/check-mailer.mts <to-address>');
  process.exit(1);
}

const transport = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD ? 'gmail' : 'resend';
console.log('mailerConfigured():', mailerConfigured());
console.log('transport that will be used:', transport);
if (transport === 'gmail') console.log('from:', process.env.MAIL_FROM_NAME ?? '(no display name)', `<${process.env.GMAIL_USER}>`);

// Attach the same resume every real outreach email carries, so this test exercises the
// attachment path rather than a simpler one that happens to work.
const resume = await readResumePdf();
console.log(
  'resume attachment:',
  resume ? `${RESUME_FILENAME} (${Math.round(resume.length / 1024)}KB)` : 'MISSING — outreach would send without it'
);

try {
  const result = await sendMail({
    to,
    subject: 'intern-agent — mail transport test',
    text:
      'This is the intern-agent mailer smoke test.\n\n' +
      `Transport: ${transport}\n` +
      `Resume attached: ${resume ? 'yes' : 'NO'}\n` +
      'If you are reading this, outreach sending works end-to-end.',
    ...(resume ? { attachments: [{ filename: RESUME_FILENAME, content: resume }] } : {}),
  });
  console.log('\nSENT ✅', result);
} catch (e) {
  if (e instanceof MailConfigError) {
    console.error('\nCONFIG ERROR:', e.message);
  } else {
    console.error('\nSEND FAILED:', (e as Error).message);
  }
  process.exit(1);
}

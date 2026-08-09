/**
 * IMAP smoke test — READ ONLY, sends nothing, marks nothing as read.
 *   npx tsx --env-file=.env.local scripts/check-imap.mts [address-to-look-for]
 *
 * Answers the one question the follow-up pass depends on: can this App Password read the
 * mailbox? If it cannot, `runFollowUps` refuses to send at all, so a failure here is the
 * difference between follow-ups going out and the whole feature sitting idle.
 *
 * Pass an address to also exercise the reply and bounce searches against it. Use one you
 * have actually received mail from, so a `true` proves the search works rather than the
 * connection alone.
 */
import {
  findSentMessageId,
  hasBounceFor,
  hasReplyFrom,
  imapConfigured,
  withImap,
} from '../lib/imap';

const probe = process.argv[2];

console.log('imapConfigured():', imapConfigured());
console.log('account:', process.env.GMAIL_USER ?? '(GMAIL_USER unset)');

if (!imapConfigured()) {
  console.error('\nSet GMAIL_USER + GMAIL_APP_PASSWORD in .env.local first.');
  process.exit(1);
}

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

try {
  await withImap(async (client) => {
    const inbox = await client.mailboxOpen('INBOX', { readOnly: true });
    console.log('INBOX opened ✅ ·', inbox.exists, 'messages');

    const boxes = await client.list();
    const sent = boxes.find((b) => b.specialUse === '\\Sent');
    console.log('sent mailbox:', sent ? sent.path : 'NOT FOUND (will fall back to [Gmail]/Sent Mail)');

    if (probe) {
      console.log(`\nsearching the last 30 days for ${probe}:`);
      console.log('  reply from them:', await hasReplyFrom(client, probe, since));
      console.log('  bounce for them:', await hasBounceFor(client, probe, since));
      console.log(
        '  our last Message-ID to them:',
        (await findSentMessageId(client, probe, new Date())) ?? 'none found today'
      );
    }
  });
  console.log('\nIMAP OK ✅ — follow-ups can tell who replied.');
} catch (e) {
  console.error('\nIMAP FAILED:', (e as Error).message);
  process.exit(1);
}

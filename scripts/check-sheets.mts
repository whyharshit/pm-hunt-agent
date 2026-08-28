/**
 * Google Sheets tracker smoke test — appends ONE real test row.
 *   npx tsx --env-file=.env.local scripts/check-sheets.mts
 */
import { sheetsConfigured, appendTrackerRow } from '../lib/sheets';

console.log('sheetsConfigured():', sheetsConfigured());
if (!sheetsConfigured()) {
  console.error(
    '\nSet GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, and GOOGLE_SHEET_ID in .env.local first.'
  );
  process.exit(1);
}

try {
  await appendTrackerRow([
    new Date().toISOString().slice(0, 10),
    new Date().toISOString().slice(11, 19),
    'smoke test',
    'test-company',
    'test-title',
    'test@example.com',
    'test',
    'https://example.com',
  ]);
  console.log('\nAPPENDED ✅ — check the "Applications" tab of the sheet.');
} catch (e) {
  console.error('\nAPPEND FAILED:', (e as Error).message);
  process.exit(1);
}

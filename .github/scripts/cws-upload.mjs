// Uploads dist-zip/extension-*.zip as a draft to the Chrome Web Store.
// Auth: service account JSON key (V2 API). Authorization granted in the
// CWS dashboard → Account → Service account.
// Does not auto-publish — the draft sits in the dashboard until a human
// clicks Publish, so a bad merge can't ship to all users without review.

import { GoogleAuth } from 'google-auth-library';
import { readFile, stat } from 'node:fs/promises';

const { CWS_EXTENSION_ID, CWS_SERVICE_ACCOUNT_JSON, ZIP_PATH } = process.env;

if (!CWS_EXTENSION_ID || !CWS_SERVICE_ACCOUNT_JSON || !ZIP_PATH) {
  console.error('Missing one of: CWS_EXTENSION_ID, CWS_SERVICE_ACCOUNT_JSON, ZIP_PATH');
  process.exit(1);
}

const credentials = JSON.parse(CWS_SERVICE_ACCOUNT_JSON);
const auth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/chromewebstore'],
});
const client = await auth.getClient();
const tokenRes = await client.getAccessToken();
const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
if (!token) {
  console.error('Failed to mint access token');
  process.exit(1);
}

const { size } = await stat(ZIP_PATH);
const zip = await readFile(ZIP_PATH);
console.log(`Uploading ${ZIP_PATH} (${(size / 1024 / 1024).toFixed(2)} MB) → item ${CWS_EXTENSION_ID}`);

const res = await fetch(
  `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CWS_EXTENSION_ID}?uploadType=media`,
  {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-goog-api-version': '2',
    },
    body: zip,
  },
);

const body = await res.json().catch(() => ({}));
console.log('Response:', JSON.stringify(body, null, 2));

if (!res.ok || body.uploadState !== 'SUCCESS') {
  console.error(`Upload failed (HTTP ${res.status}, uploadState=${body.uploadState ?? 'unknown'})`);
  process.exit(1);
}

console.log('✓ Draft uploaded. Open the dashboard and click Publish to ship.');

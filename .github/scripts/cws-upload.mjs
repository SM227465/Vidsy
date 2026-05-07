// Uploads dist-zip/extension-*.zip and submits it for review.
// Auth: service account JSON key (V2 API). Authorization granted in the
// CWS dashboard → Account → Service account.

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

const authHeaders = {
  Authorization: `Bearer ${token}`,
  'x-goog-api-version': '2',
};

// ─── Upload ──────────────────────────────────────────────────────────
const { size } = await stat(ZIP_PATH);
const zip = await readFile(ZIP_PATH);
console.log(`Uploading ${ZIP_PATH} (${(size / 1024 / 1024).toFixed(2)} MB) → item ${CWS_EXTENSION_ID}`);

const uploadRes = await fetch(
  `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CWS_EXTENSION_ID}?uploadType=media`,
  { method: 'PUT', headers: authHeaders, body: zip },
);
const uploadBody = await uploadRes.json().catch(() => ({}));
console.log('Upload response:', JSON.stringify(uploadBody, null, 2));

if (!uploadRes.ok || uploadBody.uploadState !== 'SUCCESS') {
  console.error(`Upload failed (HTTP ${uploadRes.status}, uploadState=${uploadBody.uploadState ?? 'unknown'})`);
  process.exit(1);
}

// ─── Submit for review ────────────────────────────────────────────────
console.log('Submitting for review (target=default → public listing)…');
const publishRes = await fetch(
  `https://www.googleapis.com/chromewebstore/v1.1/items/${CWS_EXTENSION_ID}/publish`,
  {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Length': '0' },
  },
);
const publishBody = await publishRes.json().catch(() => ({}));
console.log('Publish response:', JSON.stringify(publishBody, null, 2));

// status is an array of strings; OK / ITEM_PENDING_REVIEW are both success.
const statuses = Array.isArray(publishBody.status) ? publishBody.status : [];
const ok = publishRes.ok && statuses.some(s => s === 'OK' || s === 'ITEM_PENDING_REVIEW');

if (!ok) {
  console.error(`Publish failed (HTTP ${publishRes.status}, statuses=${statuses.join(',') || 'unknown'})`);
  process.exit(1);
}

console.log(`✓ Submitted for review. Status: ${statuses.join(', ')}`);

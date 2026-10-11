/**
 * Smoke test for a running East Gate server.
 *
 * Why this exists: the project has a typecheck (`npm run typecheck`) and a
 * front-end parse check (`check-js.mjs`), but neither proves the server actually
 * boots, serves pages, or answers the API. This script hits a live instance and
 * asserts the pages and the public/API contract still respond. It is read-only:
 * it sends no writes and creates no rows, so it is safe to run against any
 * environment, including production.
 *
 * Usage:
 *   npm run dev            # in one terminal
 *   npm run smoke          # in another
 *
 * Override the target with SMOKE_BASE_URL, e.g.
 *   SMOKE_BASE_URL=https://www.eastgate.ng npm run smoke
 */
const BASE = (process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

const HTML_PAGES = [
  '/',
  '/index.html',
  '/properties.html',
  '/land.html',
  '/property-detail.html',
  '/dealer.html',
  '/dealers.html',
  '/services.html',
  '/marketplace.html',
  '/contact.html',
  '/privacy.html',
  '/terms.html',
  '/login.html',
  '/register.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/verify-email.html',
  '/404.html',
  '/robots.txt',
  '/sitemap.xml'
];

const results = [];
let failures = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (error) {
    failures += 1;
    results.push({ ok: false, name, detail: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function get(path) {
  return fetch(`${BASE}${path}`, { redirect: 'manual' });
}

async function getJson(path) {
  const res = await get(path);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`expected JSON from ${path} but got ${res.status}`);
  }
  return { res, body };
}

console.log(`Smoke-testing ${BASE}\n`);

// --- Pages -----------------------------------------------------------------
for (const path of HTML_PAGES) {
  await check(`GET ${path} → 200`, async () => {
    const res = await get(path);
    assert(res.status === 200, `status ${res.status}`);
    return '';
  });
}

await check('GET /sitemap.xml contains <urlset>', async () => {
  const res = await get('/sitemap.xml');
  const xml = await res.text();
  assert(xml.includes('<urlset'), 'no <urlset> element');
  return '';
});

await check('GET /unknown-page → 404', async () => {
  const res = await get(`/definitely-not-a-page-${Date.now()}.html`);
  assert(res.status === 404, `status ${res.status}`);
  return '';
});

// --- Public API ------------------------------------------------------------
await check('GET /api/listing-types → 200 + list', async () => {
  const { res, body } = await getJson('/api/listing-types');
  assert(res.status === 200, `status ${res.status}`);
  assert(Array.isArray(body.data), 'data is not an array');
  return `${body.data.length} type(s)`;
});

let firstPropertyId = null;
await check('GET /api/properties → 200 + list', async () => {
  const { res, body } = await getJson('/api/properties');
  assert(res.status === 200, `status ${res.status}`);
  assert(Array.isArray(body.data), 'data is not an array');
  firstPropertyId = body.data[0] ? body.data[0].id : null;
  return `${body.data.length} listing(s)`;
});

await check('GET /api/properties?q=land&sort=price_asc → 200', async () => {
  const { res } = await getJson('/api/properties?q=land&sort=price_asc');
  assert(res.status === 200, `status ${res.status}`);
  return '';
});

await check('GET /api/properties?category=NOPE → 400', async () => {
  const { res } = await getJson('/api/properties?category=NOPE');
  assert(res.status === 400, `status ${res.status}`);
  return '';
});

if (firstPropertyId) {
  await check(`GET /api/properties/:id (${firstPropertyId}) → 200`, async () => {
    const { res, body } = await getJson(`/api/properties/${encodeURIComponent(firstPropertyId)}`);
    assert(res.status === 200, `status ${res.status}`);
    assert(body.data && body.data.id === firstPropertyId, 'unexpected body');
    return '';
  });
}

let firstDealerId = null;
await check('GET /api/dealers → 200 + list', async () => {
  const { res, body } = await getJson('/api/dealers');
  assert(res.status === 200, `status ${res.status}`);
  assert(Array.isArray(body.data), 'data is not an array');
  firstDealerId = body.data[0] ? body.data[0].id : null;
  return `${body.data.length} dealer(s)`;
});

if (firstDealerId) {
  await check(`GET /api/dealers/:id (${firstDealerId}) → 200`, async () => {
    const { res, body } = await getJson(`/api/dealers/${encodeURIComponent(firstDealerId)}`);
    assert(res.status === 200, `status ${res.status}`);
    assert(body.data && body.data.id === firstDealerId, 'unexpected body');
    return '';
  });
}

// --- Validation & guards (no writes) --------------------------------------
await check('POST /api/auth/forgot-password {} → 400', async () => {
  const res = await fetch(`${BASE}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert(res.status === 400, `status ${res.status}`);
  return '';
});

await check('GET /api/admin/queue (no token) → 401', async () => {
  const res = await get('/api/admin/queue');
  assert(res.status === 401, `status ${res.status}`);
  return '';
});

// --- Report ----------------------------------------------------------------
console.log('');
for (const { ok, name, detail } of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

if (failures > 0) {
  console.error(`\nSmoke test FAILED — ${failures} of ${results.length} check(s) failed against ${BASE}\n`);
  process.exit(1);
}

console.log(`\nSmoke test OK — ${results.length} check(s) passed against ${BASE}\n`);

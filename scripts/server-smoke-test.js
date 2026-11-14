'use strict';

const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

const port = 3100 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const tempRootPromise = fs.mkdtemp(path.join(os.tmpdir(), 'doma-tech-smoke-'));
let server;
async function startServer() {
  const tempRoot = await tempRootPromise;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATA_DIR: path.join(tempRoot, 'data'),
    UPLOAD_DIR: path.join(tempRoot, 'uploads'),
    SESSION_SECRET: 'smoke-test-session-secret-at-least-32-characters',
    ADMIN_USERNAME: 'smoke-admin',
    ADMIN_PASSWORD: 'smoke-test-password-not-for-production'
  },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  return server;
}

let output = '';

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function request(url, options = {}) {
  return fetch(base + url, { ...options, signal: AbortSignal.timeout(5000) });
}

async function main() {
  await startServer();
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      const response = await request('/api/health');
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(250);
  }
  assert.equal(ready, true, `Server did not become ready:\n${output}`);

  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const products = await request('/api/products');
  assert.equal(products.status, 200);
  assert.ok(Array.isArray(await products.json()));

  const badOrder = await request('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test', contact: 'test@example.invalid', website: 'bot' })
  });
  assert.equal(badOrder.status, 400, 'Honeypot must reject filled website field');

  const order = await request('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke Test', contact: 'test@example.invalid', message: 'CI only' })
  });
  assert.equal(order.status, 201, 'Valid demo order should be accepted by isolated test DB');
  const orderBody = await order.json();
  assert.ok(Number.isSafeInteger(orderBody.id));

  const unauthorized = await request('/api/admin/products');
  assert.equal(unauthorized.status, 401);

  const unknownApi = await request('/api/route-that-does-not-exist');
  assert.equal(unknownApi.status, 404);
  assert.match(unknownApi.headers.get('content-type') || '', /application\/json/);

  const login = await request('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke-admin', password: 'smoke-test-password-not-for-production' })
  });
  assert.equal(login.status, 200, 'Admin login should succeed');
  const loginBody = await login.json();
  assert.ok(loginBody.csrfToken);
  const cookieHeader = login.headers.get('set-cookie') || '';
  const cookie = cookieHeader.match(/doma\.sid=[^;]+/)?.[0];
  assert.ok(cookie, 'Login must issue the session cookie');

  const me = await request('/api/admin/me', { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('cache-control'), 'no-store');
  assert.equal((await me.json()).authenticated, true);

  // Session records must survive a server restart because they are stored in SQLite.
  await stopServer();
  await startServer();
  let restarted = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await request('/api/health');
      if (response.ok) { restarted = true; break; }
    } catch {}
    await delay(250);
  }
  assert.equal(restarted, true, `Server did not restart:\n${output}`);
  const persistedSession = await request('/api/admin/me', { headers: { cookie } });
  assert.equal(persistedSession.status, 200, 'Admin session must survive server restart');

  const adminOrders = await request('/api/admin/orders', { headers: { cookie } });
  assert.equal(adminOrders.status, 200);
  assert.ok((await adminOrders.json()).some(item => item.id === orderBody.id));

  const updateOrder = await request(`/api/admin/orders/${orderBody.id}`, {
    method: 'PATCH',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'in_progress' })
  });
  assert.equal(updateOrder.status, 200);

  const invalidUpload = await request('/api/admin/upload', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken },
    body: (() => {
      const form = new FormData();
      form.append('image', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
      return form;
    })()
  });
  assert.equal(invalidUpload.status, 400, 'Upload must reject a file with a mismatched image signature');

  const oversizedUpload = await request('/api/admin/upload', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken },
    body: (() => {
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'large.png');
      return form;
    })()
  });
  assert.equal(oversizedUpload.status, 400, 'Upload must reject files larger than 5 MiB');

  const invalidProductId = await request('/api/admin/products/0', {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Invalid ID', category: 'Test', price: 100 })
  });
  assert.equal(invalidProductId.status, 400);

  const csrfFailure = await request('/api/admin/products', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Blocked', category: 'Test', price: 100 })
  });
  assert.equal(csrfFailure.status, 403, 'Mutating admin route must reject missing CSRF token');

  const createProduct = await request('/api/admin/products', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke dishwasher', category: 'Built-in', price: 12345, description: 'CI only' })
  });
  assert.equal(createProduct.status, 201);
  const created = await createProduct.json();
  assert.ok(Number.isSafeInteger(created.id));

  const listAdminProducts = await request('/api/admin/products', { headers: { cookie } });
  assert.equal(listAdminProducts.status, 200);
  assert.ok((await listAdminProducts.json()).some(item => item.id === created.id));

  const removeProduct = await request(`/api/admin/products/${created.id}`, {
    method: 'DELETE',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(removeProduct.status, 200);

  const categoryCreate = await request('/api/admin/categories', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Built-in', slug: 'built-in', sort_order: 1 })
  });
  assert.equal(categoryCreate.status, 201);
  const category = await categoryCreate.json();
  const categoryList = await request('/api/admin/categories', { headers: { cookie } });
  assert.ok((await categoryList.json()).some(item => item.id === category.id));
  const categoryProduct = await request('/api/admin/products', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Category-linked test item', category: 'Built-in', price: 100 })
  });
  assert.equal(categoryProduct.status, 201);
  const categoryDeleteBlocked = await request('/api/admin/categories/' + category.id, {
    method: 'DELETE', headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(categoryDeleteBlocked.status, 409, 'Category in use by products must not be deleted');
  const removeCategoryProduct = await request('/api/admin/products/' + (await categoryProduct.json()).id, {
    method: 'DELETE', headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(removeCategoryProduct.status, 200);
  const settingsUpdate = await request('/api/admin/settings', {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ site_title:'DOMA TECH Test', hero_title:'Test headline', hero_subtitle:'Test subtitle', hero_cta_text:'Catalog', meta_title:'Test SEO title', meta_description:'Test SEO description' })
  });
  assert.equal(settingsUpdate.status, 200);
  const publicConfig = await request('/api/site-config');
  assert.equal(publicConfig.status, 200);
  assert.equal((await publicConfig.json()).settings.site_title, 'DOMA TECH Test');
  const categoryDelete = await request('/api/admin/categories/' + category.id, {
    method: 'DELETE', headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(categoryDelete.status, 200);

  const logout = await request('/api/admin/logout', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(logout.status, 200);
  const afterLogout = await request('/api/admin/me', { headers: { cookie } });
  assert.equal(afterLogout.status, 401);

  const storefrontScript = await request('/script.js');
  assert.equal(storefrontScript.status, 200);
  const storefrontSource = await storefrontScript.text();
  assert.match(storefrontSource, /api\/site-config/);
  assert.match(storefrontSource, /api\/products/);

  const adminPage = await request('/admin');
  assert.equal(adminPage.status, 200, 'Admin interface should be served');
  assert.equal(adminPage.headers.get('cache-control'), 'no-store');
  assert.match(await adminPage.text(), /Панель управления/);
  const adminScript = await request('/admin-assets/admin.js');
  assert.equal(adminScript.status, 200);
  assert.match(await adminScript.text(), /x-csrf-token/);

  console.log('Smoke tests passed: health, catalog, order validation, admin auth, session cookie, CSRF, product CRUD, logout, category CRUD, site settings, public config, storefront integration, and admin interface.');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    const tempRoot = await tempRootPromise;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

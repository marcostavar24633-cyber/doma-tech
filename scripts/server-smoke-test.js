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

  const tempRoot = await tempRootPromise;
  const uploadsDir = path.join(tempRoot, 'uploads');
  const uploadPng = async () => {
    const form = new FormData();
    form.append('image', new Blob([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])], { type: 'image/png' }), 'test.png');
    const response = await request('/api/admin/upload', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': loginBody.csrfToken },
      body: form
    });
    assert.equal(response.status, 201, 'Valid PNG signature should upload');
    return (await response.json()).url;
  };
  const sharedImage = await uploadPng();
  const sharedImagePath = path.join(uploadsDir, sharedImage.slice('/uploads/'.length));
  assert.equal(await fs.access(sharedImagePath).then(() => true, () => false), true);
  const imageProductOneResponse = await request('/api/admin/products', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Image lifecycle one', category: 'Images', image: sharedImage })
  });
  assert.equal(imageProductOneResponse.status, 201);
  const imageProductOne = await imageProductOneResponse.json();
  const imageProductTwoResponse = await request('/api/admin/products', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Image lifecycle two', category: 'Images', image: sharedImage })
  });
  assert.equal(imageProductTwoResponse.status, 201);
  const imageProductTwo = await imageProductTwoResponse.json();
  const deleteSharedFirst = await request('/api/admin/products/' + imageProductOne.id, {
    method: 'DELETE', headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(deleteSharedFirst.status, 200);
  assert.equal(await fs.access(sharedImagePath).then(() => true, () => false), true, 'Shared image must remain while another product references it');
  const replacementImage = await uploadPng();
  const updateImageProduct = await request('/api/admin/products/' + imageProductTwo.id, {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Image lifecycle two', category: 'Images', image: replacementImage })
  });
  assert.equal(updateImageProduct.status, 200);
  assert.equal(await fs.access(sharedImagePath).then(() => true, () => false), false, 'Replaced image should be removed after its last reference is gone');
  const replacementImagePath = path.join(uploadsDir, replacementImage.slice('/uploads/'.length));
  assert.equal(await fs.access(replacementImagePath).then(() => true, () => false), true);
  const deleteLastImageProduct = await request('/api/admin/products/' + imageProductTwo.id, {
    method: 'DELETE', headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(deleteLastImageProduct.status, 200);
  assert.equal(await fs.access(replacementImagePath).then(() => true, () => false), false, 'Deleting the last referencing product should remove its local image');
  const abandonedImage = await uploadPng();
  const cleanupAbandoned = await request('/api/admin/upload/cleanup', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ url: abandonedImage })
  });
  assert.equal(cleanupAbandoned.status, 200);
  assert.equal((await cleanupAbandoned.json()).removed, true, 'Unreferenced upload should be removable after failed product save');
  const unsafeCleanup = await request('/api/admin/upload/cleanup', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ url: '/uploads/../../server.js' })
  });
  assert.equal(unsafeCleanup.status, 400, 'Cleanup must reject paths outside the upload directory');

  const invalidLocalImage = await request('/api/admin/products', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Unsafe image path', category: 'Images', image: '/uploads/../../server.js' })
  });
  assert.equal(invalidLocalImage.status, 400, 'Product API must reject unsafe local image paths');

  const rateLimitedUploads = [];
  for (let index = 0; index < 15; index += 1) rateLimitedUploads.push(await uploadPng());
  const blockedUploadForm = new FormData();
  blockedUploadForm.append('image', new Blob([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])], { type: 'image/png' }), 'blocked.png');
  const blockedUpload = await request('/api/admin/upload', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken },
    body: blockedUploadForm
  });
  assert.equal(blockedUpload.status, 429, 'Upload endpoint must enforce a per-window rate limit');
  for (const url of rateLimitedUploads) {
    const cleanup = await request('/api/admin/upload/cleanup', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ url })
    });
    assert.equal(cleanup.status, 200);
  }

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

  const hideProduct = await request('/api/admin/products/' + created.id + '/visibility', {
    method: 'PATCH',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ active: false })
  });
  assert.equal(hideProduct.status, 200);
  const hiddenPublicProduct = await request('/api/products');
  assert.equal((await hiddenPublicProduct.json()).some(item => item.id === created.id), false);
  const publishProduct = await request('/api/admin/products/' + created.id + '/visibility', {
    method: 'PATCH',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ active: true })
  });
  assert.equal(publishProduct.status, 200);

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
  const hideCategory = await request('/api/admin/categories/' + category.id, {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Built-in', slug: 'built-in', sort_order: 1, active: false })
  });
  assert.equal(hideCategory.status, 200);
  const hiddenConfig = await request('/api/site-config');
  assert.equal((await hiddenConfig.json()).categories.some(item => item.id === category.id), false);
  const publishCategory = await request('/api/admin/categories/' + category.id, {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Built-in', slug: 'built-in', sort_order: 1, active: true })
  });
  assert.equal(publishCategory.status, 200);
  const categoryPage = await request('/catalog/built-in');
  assert.equal(categoryPage.status, 200);
  const categoryHtml = await categoryPage.text();
  assert.ok(categoryHtml.includes('<title>Built-in — каталог DOMA TECH</title>'));
  assert.ok(categoryHtml.includes('name="robots" content="noindex,follow"'));
  const categoryList = await request('/api/admin/categories', { headers: { cookie } });
  assert.ok((await categoryList.json()).some(item => item.id === category.id));
  const categoryProduct = await request('/api/admin/products', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Category-linked test item', category: 'Built-in', price: 100, description: 'Test product description', meta_title: 'Test product SEO title', meta_description: 'Test product SEO description' })
  });
  assert.equal(categoryProduct.status, 201);
  const categoryProductData = await categoryProduct.json();
  assert.ok(categoryProductData.slug.startsWith('category-linked-test-item-'));
  assert.equal(categoryProductData.meta_title, 'Test product SEO title');
  const relatedProductResponse = await request('/api/admin/products', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Second category test item', category: 'Built-in', price: 200 })
  });
  assert.equal(relatedProductResponse.status, 201);
  const relatedProductData = await relatedProductResponse.json();
  const productPage = await request('/product/' + categoryProductData.slug);
  assert.equal(productPage.status, 200);
  const productHtml = await productPage.text();
  assert.ok(productHtml.includes('<title>Test product SEO title</title>'));
  assert.ok(productHtml.includes('name="description" content="Test product SEO description"'));
  assert.ok(productHtml.includes('"@type":"Product"'));
  assert.ok(productHtml.includes('Главная'));
  assert.ok(productHtml.includes('Похожие товары этой категории'));
  assert.ok(productHtml.includes('/product/' + relatedProductData.slug));
  const missingProductPage = await request('/product/not-a-real-product');
  assert.equal(missingProductPage.status, 404);

  const renameCategory = await request('/api/admin/categories/' + category.id, {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Built-in premium', slug: 'built-in-premium', sort_order: 1, description: 'Renamed category', active: true })
  });
  assert.equal(renameCategory.status, 200);
  const renamedProducts = await request('/api/products');
  const renamedProductList = await renamedProducts.json();
  assert.equal(renamedProductList.find(item => item.id === categoryProductData.id).category, 'Built-in premium');
  assert.equal(renamedProductList.find(item => item.id === relatedProductData.id).category, 'Built-in premium');
  const renamedCategoryPage = await request('/catalog/built-in-premium');
  assert.equal(renamedCategoryPage.status, 200);
  const renamedCategoryHtml = await renamedCategoryPage.text();
  assert.ok(renamedCategoryHtml.includes('/product/' + categoryProductData.slug));
  const renamedProductPage = await request('/product/' + categoryProductData.slug);
  assert.equal(renamedProductPage.status, 200);
  assert.ok((await renamedProductPage.text()).includes('/product/' + relatedProductData.slug));
  const categoryDeleteBlocked = await request('/api/admin/categories/' + category.id, {
    method: 'DELETE', headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(categoryDeleteBlocked.status, 409, 'Category in use by products must not be deleted');
  const settingsUpdate = await request('/api/admin/settings', {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ site_title:'DOMA TECH Test', hero_title:'Test headline', hero_subtitle:'Test subtitle', hero_cta_text:'Catalog', meta_title:'Test SEO title', meta_description:'Test SEO description', site_url:'https://example.test', robots_index:'true' })
  });
  assert.equal(settingsUpdate.status, 200);
  const publicConfig = await request('/api/site-config');
  assert.equal(publicConfig.status, 200);
  assert.equal((await publicConfig.json()).settings.site_title, 'DOMA TECH Test');
  const renderedHome = await request('/');
  assert.equal(renderedHome.status, 200);
  const renderedHtml = await renderedHome.text();
  assert.ok(renderedHtml.includes('<title>Test SEO title</title>'));
  assert.match(renderedHtml, /name="robots" content="index,follow"/);
  assert.ok(renderedHtml.includes('rel="canonical" href="https://example.test/"'));
  const sitemap = await request('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  const sitemapXml = await sitemap.text();
  assert.ok(sitemapXml.includes('https://example.test/'));
  assert.ok(sitemapXml.includes('https://example.test/catalog/built-in'));
  assert.ok(sitemapXml.includes('https://example.test/product/' + categoryProductData.slug));
  assert.ok(sitemapXml.includes('https://example.test/product/' + relatedProductData.slug));
  const robots = await request('/robots.txt');
  assert.equal(robots.status, 200);
  assert.ok((await robots.text()).includes('Sitemap: https://example.test/sitemap.xml'));
  assert.ok(renderedHtml.includes('property="og:title" content="Test SEO title"'));
  assert.ok(renderedHtml.includes('name="twitter:description" content="Test SEO description"'));
  const invalidSeoSettings = await request('/api/admin/settings', {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ site_title:'DOMA TECH Test', hero_title:'Test headline', meta_title:'Test SEO title', meta_description:'Test SEO description', site_url:'http://insecure.example', robots_index:'true' })
  });
  assert.equal(invalidSeoSettings.status, 400, 'SEO must reject non-HTTPS canonical URLs');
  const disableIndexing = await request('/api/admin/settings', {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': loginBody.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ site_title:'DOMA TECH Test', hero_title:'Test headline', hero_subtitle:'Test subtitle', hero_cta_text:'Catalog', meta_title:'Test SEO title', meta_description:'Test SEO description', site_url:'https://example.test', robots_index:'false' })
  });
  assert.equal(disableIndexing.status, 200);
  const disabledSitemap = await request('/sitemap.xml');
  assert.equal(disabledSitemap.status, 404);
  const disabledRobots = await request('/robots.txt');
  assert.ok((await disabledRobots.text()).includes('Disallow: /'));
  const removeCategoryProduct = await request('/api/admin/products/' + categoryProductData.id, {
    method: 'DELETE', headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(removeCategoryProduct.status, 200);
  const removeRelatedProduct = await request('/api/admin/products/' + relatedProductData.id, {
    method: 'DELETE', headers: { cookie, 'x-csrf-token': loginBody.csrfToken }
  });
  assert.equal(removeRelatedProduct.status, 200);

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

  console.log('Smoke tests passed: health, catalog, order validation, admin auth, session cookie, CSRF, product CRUD, product image lifecycle cleanup, logout, product/category visibility, category CRUD, site settings, public config, storefront integration, and admin interface.');
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

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'));
for (const dir of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'change-this-before-first-run' || process.env.ADMIN_PASSWORD.length < 14 || process.env.ADMIN_PASSWORD === process.env.ADMIN_USERNAME) {
    throw new Error('Set an ADMIN_PASSWORD of at least 14 characters that is not the username');
  }
  app.set('trust proxy', 1);
}

const db = new Database(path.join(DATA_DIR, 'doma-tech.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price INTEGER,
  description TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  meta_title TEXT NOT NULL DEFAULT '',
  meta_description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const productColumns = db.prepare('PRAGMA table_info(products)').all().map(column => column.name);
if (!productColumns.includes('slug')) db.exec("ALTER TABLE products ADD COLUMN slug TEXT NOT NULL DEFAULT ''");
if (!productColumns.includes('meta_title')) db.exec("ALTER TABLE products ADD COLUMN meta_title TEXT NOT NULL DEFAULT ''");
if (!productColumns.includes('meta_description')) db.exec("ALTER TABLE products ADD COLUMN meta_description TEXT NOT NULL DEFAULT ''");
const existingProducts = db.prepare("SELECT id,name FROM products WHERE slug='' OR slug IS NULL").all();
const updateLegacyProductSlug = db.prepare('UPDATE products SET slug=? WHERE id=?');
for (const product of existingProducts) updateLegacyProductSlug.run((slugify(product.name) || 'product') + '-' + product.id, product.id);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS products_slug_unique ON products(slug) WHERE slug <> \'\'');
const categoryColumns = db.prepare('PRAGMA table_info(categories)').all().map(column => column.name);
if (!categoryColumns.includes('description')) db.exec("ALTER TABLE categories ADD COLUMN description TEXT NOT NULL DEFAULT ''");

const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD;
if (adminPassword && !db.prepare('SELECT id FROM admins WHERE username=?').get(adminUsername)) {
  const hash = bcrypt.hashSync(adminPassword, 12);
  db.prepare('INSERT INTO admins(username,password_hash) VALUES(?,?)').run(adminUsername, hash);
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.statements = {
      get: database.prepare('SELECT sess, expires_at FROM sessions WHERE sid = ?'),
      set: database.prepare('INSERT INTO sessions(sid, sess, expires_at) VALUES(?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires_at=excluded.expires_at'),
      touch: database.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      destroy: database.prepare('DELETE FROM sessions WHERE sid = ?'),
      purge: database.prepare('DELETE FROM sessions WHERE expires_at <= ?')
    };
  }

  expiry(sessionData) {
    const expires = sessionData && sessionData.cookie && sessionData.cookie.expires;
    const parsed = expires ? new Date(expires).getTime() : NaN;
    if (Number.isFinite(parsed)) return parsed;
    const maxAge = sessionData && sessionData.cookie && Number(sessionData.cookie.maxAge);
    return Number.isFinite(maxAge) && maxAge > 0 ? Date.now() + maxAge : Date.now() + 8 * 60 * 60 * 1000;
  }

  get(sid, callback) {
    try {
      this.statements.purge.run(Date.now());
      const row = this.statements.get.get(sid);
      if (!row || row.expires_at <= Date.now()) return callback(null, null);
      return callback(null, JSON.parse(row.sess));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      const expiresAt = this.expiry(sessionData);
      this.statements.set.run(sid, JSON.stringify(sessionData), expiresAt);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      const expiresAt = this.expiry(sessionData);
      this.statements.touch.run(expiresAt, sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.statements.destroy.run(sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  clear(callback = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions').run();
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  length(callback) {
    try {
      this.statements.purge.run(Date.now());
      const row = this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get();
      return callback(null, row.count);
    } catch (error) {
      return callback(error);
    }
  }
}

app.use(session({
  store: new SQLiteSessionStore(db),
  name: 'doma.sid',
  secret: process.env.SESSION_SECRET || 'development-only-secret-change-before-deploy',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много попыток. Попробуйте позже.' } });
const orderLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много заявок. Попробуйте позже.' } });
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много загрузок. Попробуйте позже.' } });

// Prevent browsers and shared proxies from caching authenticated data or CSRF tokens.
app.use('/api/admin', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
});

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.adminId) return res.status(401).json({ error: 'Требуется вход администратора' });
  next();
}
function csrfCheck(req, res, next) {
  const token = req.get('x-csrf-token');
  if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Проверка безопасности не пройдена. Обновите страницу.' });
  }
  next();
}
function cleanText(value, max=500) {
  return String(value ?? '').trim().slice(0, max);
}
function localUploadPath(image) {
  if (typeof image !== 'string' || !image.startsWith('/uploads/')) return null;
  const filename = image.slice('/uploads/'.length);
  if (!/^[a-f0-9]{32}\.(?:jpg|png|webp|avif)$/i.test(filename)) return null;
  const resolved = path.resolve(UPLOAD_DIR, filename);
  if (path.dirname(resolved) !== UPLOAD_DIR) return null;
  return resolved;
}
function removeUnusedLocalUpload(image) {
  const filePath = localUploadPath(image);
  if (!filePath) return false;
  const referenced = db.prepare('SELECT COUNT(*) AS count FROM products WHERE image=?').get(image).count;
  if (referenced > 0) return false;
  try {
    // Keep the reference check and unlink in one synchronous event-loop turn to avoid a new reference racing cleanup.
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not remove unused product image:', error);
    return false;
  }
}
function validProduct(body) {
  const name = cleanText(body.name, 120);
  const category = cleanText(body.category, 60);
  const description = cleanText(body.description, 700);
  const image = cleanText(body.image, 500);
  const metaTitle = cleanText(body.meta_title, 160);
  const metaDescription = cleanText(body.meta_description, 300);
  const price = body.price === '' || body.price === null || body.price === undefined ? null : Number(body.price);
  if (!name || !category) return { error: 'Укажите название и категорию товара' };
  if (price !== null && (!Number.isSafeInteger(price) || price < 0 || price > 100000000)) return { error: 'Некорректная цена' };
  if (image.startsWith('/uploads/') && !localUploadPath(image)) return { error: 'Некорректный путь локального изображения' };
  if (image && !image.startsWith('/uploads/') && !/^https:\/\/.+/i.test(image)) return { error: 'Изображение должно быть HTTPS-ссылкой или файлом из /uploads/' };
  return { value: { name, category, description, image, price, metaTitle, metaDescription } };
}
const IMAGE_TYPES = {
  'image/jpeg': { ext: '.jpg', label: 'JPEG' },
  'image/png': { ext: '.png', label: 'PNG' },
  'image/webp': { ext: '.webp', label: 'WEBP' },
  'image/avif': { ext: '.avif', label: 'AVIF' }
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const type = IMAGE_TYPES[file.mimetype];
    if (!type) return cb(new Error('Неподдерживаемый формат изображения'));
    cb(null, crypto.randomBytes(16).toString('hex') + type.ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','image/avif'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Разрешены только JPG, PNG, WEBP и AVIF'));
    cb(null, true);
  }
});

app.get('/robots.txt', (req,res) => {
  const settings = Object.fromEntries(db.prepare('SELECT key,value FROM site_settings').all().map(row => [row.key,row.value]));
  const indexing = settings.robots_index === 'true' && Boolean(settings.site_url);
  res.type('text/plain').send(indexing
    ? 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ' + settings.site_url + '/sitemap.xml\n'
    : 'User-agent: *\nDisallow: /\n');
});
app.get('/sitemap.xml', (req,res) => {
  const settings = Object.fromEntries(db.prepare('SELECT key,value FROM site_settings').all().map(row => [row.key,row.value]));
  if (settings.robots_index !== 'true' || !settings.site_url) return res.status(404).type('text/plain').send('Sitemap is disabled until indexing and site URL are configured.');
  const lastmod = new Date().toISOString().slice(0,10);
  const categories = db.prepare('SELECT slug,created_at FROM categories WHERE active=1 ORDER BY sort_order,name').all();
  const products = db.prepare('SELECT slug,updated_at FROM products WHERE active=1 AND slug<>\'\' ORDER BY id').all();
  const urls = [{ loc: settings.site_url + '/', lastmod }, ...categories.map(category => ({ loc: settings.site_url + '/catalog/' + encodeURIComponent(category.slug), lastmod: category.created_at ? category.created_at.slice(0,10) : lastmod })), ...products.map(product => ({ loc: settings.site_url + '/product/' + encodeURIComponent(product.slug), lastmod: product.updated_at ? product.updated_at.slice(0,10) : lastmod }))];
  const xmlEscape = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  const entries = urls.map(item => '<url><loc>' + xmlEscape(item.loc) + '</loc><lastmod>' + item.lastmod + '</lastmod></url>').join('');
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + entries + '</urlset>');
});
app.get('/catalog/:slug', (req,res,next) => {
  const category = db.prepare('SELECT id,name,slug,description FROM categories WHERE slug=? AND active=1').get(req.params.slug);
  if (!category) return res.status(404).type('text/plain').send('Категория не найдена');
  const settings = Object.fromEntries(db.prepare('SELECT key,value FROM site_settings').all().map(row => [row.key,row.value]));
  const products = db.prepare('SELECT id,name,price,description,image FROM products WHERE active=1 AND category=? ORDER BY created_at DESC').all(category.name);
  const siteUrl = settings.site_url || '';
  const canonical = siteUrl ? siteUrl + '/catalog/' + encodeURIComponent(category.slug) : '';
  const title = category.name + ' — каталог DOMA TECH';
  const sampleNames = products.slice(0,3).map(product => product.name).filter(Boolean);
  const generatedDescription = products.length
    ? 'В категории «' + category.name + '» опубликовано позиций: ' + products.length + (sampleNames.length ? '. В каталоге: ' + sampleNames.join(', ') + '.' : '.')
    : 'Категория «' + category.name + '» в каталоге DOMA TECH. Новые позиции появятся после публикации товаров.';
  const description = category.description || generatedDescription;
  const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const robots = settings.robots_index === 'true' && siteUrl ? 'index,follow' : 'noindex,follow';
  const cards = products.map(product => '<article class="market-card managed-product-card"><a href="/product/' + encodeURIComponent(product.slug) + '"><div class="market-visual">' + (product.image ? '<img class="market-photo" src="' + esc(product.image) + '" alt="' + esc(product.name) + '" loading="lazy">' : '') + '</div><div class="market-info"><h2>' + esc(product.name) + '</h2><p>' + esc(product.description || 'Подробности уточняйте у консультанта.') + '</p><strong>' + (product.price == null ? 'Цена по запросу' : new Intl.NumberFormat('ru-RU').format(product.price) + ' ₽') + '</strong></div></a></article>').join('');
  const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><meta name="description" content="' + esc(description) + '"><meta name="robots" content="' + robots + '"><meta property="og:type" content="website"><meta property="og:site_name" content="' + esc(settings.site_title || 'DOMA TECH') + '"><meta property="og:title" content="' + esc(title) + '"><meta property="og:description" content="' + esc(description) + '">' + (canonical ? '<link rel="canonical" href="' + esc(canonical) + '"><meta property="og:url" content="' + esc(canonical) + '">' : '') + '<link rel="stylesheet" href="/styles.css"></head><body><header class="header"><a class="brand" href="/"><span class="brand-mark">D</span><span>DOMA <b>TECH</b><small>ТЕХНИКА ДЛЯ ДОМА</small></span></a><a class="header-cta" href="/">На главную ↗</a></header><main><section class="section"><div class="eyebrow">КАТАЛОГ DOMA TECH</div><h1>' + esc(category.name) + '</h1><p class="section-intro">' + esc(description) + '</p><div class="market-grid">' + (cards || '<p>В этой категории пока нет опубликованных товаров.</p>') + '</div><p><a class="button button-gold" href="/#request">Уточнить наличие и условия</a></p></section></main><footer class="footer"><a href="/">DOMA TECH</a></footer></body></html>';
  res.set('Cache-Control','no-cache');
  res.type('html').send(html);
});
app.get('/product/:slug', (req,res) => {
  const product = db.prepare('SELECT p.*,c.name AS category_name,c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.name=p.category WHERE p.slug=? AND p.active=1').get(req.params.slug);
  if (!product) return res.status(404).type('text/plain').send('Товар не найден');
  const settings = Object.fromEntries(db.prepare('SELECT key,value FROM site_settings').all().map(row => [row.key,row.value]));
  const siteUrl = settings.site_url || '';
  const canonical = siteUrl ? siteUrl + '/product/' + encodeURIComponent(product.slug) : '';
  const title = product.meta_title || product.name + ' — DOMA TECH';
  const description = product.meta_description || cleanText(product.description,300) || 'Информация о товаре ' + product.name + '. Уточните характеристики, наличие и условия у DOMA TECH.';
  const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const robots = settings.robots_index === 'true' && siteUrl ? 'index,follow' : 'noindex,follow';
  const relatedProducts = product.category_slug
    ? db.prepare('SELECT name,slug,price,image FROM products WHERE active=1 AND category=? AND id<>? ORDER BY created_at DESC LIMIT 4').all(product.category, product.id)
    : [];
  const relatedLinks = relatedProducts.map(item => '<a class="related-product-link" href="/product/' + encodeURIComponent(item.slug) + '">' + esc(item.name) + (item.price == null ? '' : ' · ' + new Intl.NumberFormat('ru-RU').format(item.price) + ' ₽') + '</a>').join('');
  const categoryLink = product.category_slug ? '<a href="/catalog/' + encodeURIComponent(product.category_slug) + '">' + esc(product.category_name) + '</a>' : esc(product.category);
  const imageUrl = product.image && (product.image.startsWith('/uploads/') || /^https:\/\//i.test(product.image)) ? product.image : '';
  const schema = { '@context':'https://schema.org', '@type':'Product', name:product.name, description, ...(imageUrl ? { image: imageUrl.startsWith('http') ? imageUrl : siteUrl + imageUrl } : {}) };
  const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><meta name="description" content="' + esc(description) + '"><meta name="robots" content="' + robots + '"><meta property="og:type" content="product"><meta property="og:site_name" content="' + esc(settings.site_title || 'DOMA TECH') + '"><meta property="og:title" content="' + esc(title) + '"><meta property="og:description" content="' + esc(description) + '">' + (imageUrl ? '<meta property="og:image" content="' + esc(imageUrl.startsWith('http') ? imageUrl : siteUrl + imageUrl) + '">' : '') + (canonical ? '<link rel="canonical" href="' + esc(canonical) + '"><meta property="og:url" content="' + esc(canonical) + '">' : '') + '<script type="application/ld+json">' + JSON.stringify(schema).replace(/</g,'\\u003c') + '</script><link rel="stylesheet" href="/styles.css"></head><body><header class="header"><a class="brand" href="/"><span class="brand-mark">D</span><span>DOMA <b>TECH</b><small>ТЕХНИКА ДЛЯ ДОМА</small></span></a><a class="header-cta" href="/">На главную ↗</a></header><main><section class="section"><nav class="breadcrumbs" aria-label="Хлебные крошки"><a href="/">Главная</a> <span aria-hidden="true">/</span> ' + categoryLink + ' <span aria-hidden="true">/</span> <span aria-current="page">' + esc(product.name) + '</span></nav><div class="market-grid"><article class="market-card managed-product-card"><div class="market-visual">' + (imageUrl ? '<img class="market-photo" src="' + esc(imageUrl) + '" alt="' + esc(product.name) + '">' : '') + '</div><div class="market-info"><div class="eyebrow">DOMA TECH · ' + categoryLink + '</div><h1>' + esc(product.name) + '</h1><p>' + esc(product.description || 'Подробности уточняйте у консультанта.') + '</p><strong>' + (product.price == null ? 'Цена по запросу' : new Intl.NumberFormat('ru-RU').format(product.price) + ' ₽') + '</strong><p><a class="button button-gold" href="/#request">Уточнить наличие и условия</a></p></div></article></div>' + (relatedLinks ? '<section class="related-products"><h2>Похожие товары этой категории</h2><div class="related-product-list">' + relatedLinks + '</div></section>' : '') + (product.category_slug ? '<p class="category-backlink"><a href="/catalog/' + encodeURIComponent(product.category_slug) + '">Все товары категории «' + esc(product.category_name) + '» →</a></p>' : '') + '</section></main><footer class="footer"><a href="/">DOMA TECH</a></footer></body></html>';
  res.set('Cache-Control','no-cache');
  res.type('html').send(html);
});
app.get('/', (req,res,next) => {
  const settings = Object.fromEntries(db.prepare('SELECT key,value FROM site_settings').all().map(row => [row.key,row.value]));
  fs.promises.readFile(path.join(ROOT,'public','index.html'),'utf8').then(html => {
    const siteUrl = settings.site_url || '';
    const robots = settings.robots_index === 'true' && siteUrl ? 'index,follow' : 'noindex,follow';
    const escapeAttr = value => String(value || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    const titleStart = html.toLowerCase().indexOf('<title>');
    const titleEnd = html.toLowerCase().indexOf('</title>', titleStart);
    if (titleStart >= 0 && titleEnd >= 0) html = html.slice(0, titleStart) + '<title>' + escapeAttr(settings.meta_title || settings.site_title || 'DOMA TECH') + '</title>' + html.slice(titleEnd + 8);
    html = html.replace(/<meta name="description" content="[^"]*">/i, '<meta name="description" content="' + escapeAttr(settings.meta_description) + '">');
    html = html.replace(/<meta property="og:title" content="[^"]*">/i, '<meta property="og:title" content="' + escapeAttr(settings.meta_title || settings.site_title) + '">');
    html = html.replace(/<meta name="twitter:title" content="[^"]*">/i, '<meta name="twitter:title" content="' + escapeAttr(settings.meta_title || settings.site_title) + '">');
    html = html.replace(/<meta property="og:description" content="[^"]*">/i, '<meta property="og:description" content="' + escapeAttr(settings.meta_description) + '">');
    html = html.replace(/<meta name="twitter:description" content="[^"]*">/i, '<meta name="twitter:description" content="' + escapeAttr(settings.meta_description) + '">');
    html = html.replace(/<meta property="og:site_name" content="[^"]*">/i, '<meta property="og:site_name" content="' + escapeAttr(settings.site_title) + '">');
    html = html.replace(/<meta name="robots" content="[^"]*">/i, '<meta name="robots" content="' + robots + '">');
    if (siteUrl) {
      html = html.replace(/<link rel="canonical" href="[^"]*">/i, '<link rel="canonical" href="' + escapeAttr(siteUrl + '/') + '">');
      html = html.replace(/<meta property="og:url" content="[^"]*">/i, '<meta property="og:url" content="' + escapeAttr(siteUrl + '/') + '">');
    }
    res.set('Cache-Control','no-cache');
    res.type('html').send(html);
  }).catch(next);
});
app.get('/api/health', (req,res)=>res.json({ ok:true, service:'DOMA TECH' }));
app.get('/api/products', (req,res)=>{
  const products = db.prepare('SELECT id,name,category,price,description,image,slug FROM products WHERE active=1 ORDER BY created_at DESC').all();
  res.json(products);
});
app.post('/api/orders', orderLimiter, (req,res)=>{
  const name = cleanText(req.body.name, 100);
  const contact = cleanText(req.body.contact, 160);
  const message = cleanText(req.body.message, 1000);
  if (!name || !contact) return res.status(400).json({ error: 'Укажите имя и телефон или e-mail' });
  if (req.body.website) return res.status(400).json({ error: 'Некорректная заявка' }); // honeypot
  const result = db.prepare('INSERT INTO orders(name,contact,message) VALUES(?,?,?)').run(name,contact,message);
  res.status(201).json({ ok:true, id:result.lastInsertRowid, message:'Заявка принята' });
});

app.post('/api/admin/login', loginLimiter, (req,res)=>{
  const username = cleanText(req.body.username, 80);
  const password = String(req.body.password || '');
  const admin = db.prepare('SELECT id,username,password_hash FROM admins WHERE username=?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) return res.status(401).json({ error:'Неверный логин или пароль' });
  req.session.regenerate(err=>{
    if (err) return res.status(500).json({error:'Не удалось создать сессию'});
    req.session.adminId = admin.id;
    req.session.username = admin.username;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.json({ ok:true, username:admin.username, csrfToken:req.session.csrfToken });
  });
});
app.get('/api/admin/me', requireAdmin, (req,res)=>res.json({ authenticated:true, username:req.session.username, csrfToken:req.session.csrfToken }));
app.post('/api/admin/logout', requireAdmin, csrfCheck, (req,res)=>{
  req.session.destroy(error=>{
    if (error) return res.status(500).json({error:'Не удалось завершить сессию'});
    res.clearCookie('doma.sid', {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/'
    });
    res.json({ok:true});
  });
});

function slugify(value) {
  return cleanText(value, 60).toLowerCase()
    .replace(/[^a-zа-яё0-9]+/giu, '-').replace(/^-|-$/g, '').slice(0, 80);
}
const DEFAULT_SITE_SETTINGS = {
  site_title: 'DOMA TECH',
  hero_title: 'Техника для вашего дома',
  hero_subtitle: 'Подберите посудомоечную машину под ваши задачи',
  hero_cta_text: 'Смотреть каталог',
  meta_title: 'DOMA TECH — посудомоечные машины',
  meta_description: 'Подбор и сравнение посудомоечных машин',
  site_url: '',
  robots_index: 'false'
};
for (const [key, value] of Object.entries(DEFAULT_SITE_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO site_settings(key,value) VALUES(?,?)').run(key, value);
}
app.get('/api/site-config', (req,res) => {
  const rows = db.prepare('SELECT key,value FROM site_settings').all();
  const settings = Object.fromEntries(rows.map(row => [row.key, row.value]));
  res.set('Cache-Control', 'no-store');
  res.json({ settings, categories: db.prepare('SELECT id,name,slug,sort_order,description FROM categories WHERE active=1 ORDER BY sort_order,name').all() });
});
app.get('/api/admin/categories', requireAdmin, (req,res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order,name').all());
});
app.post('/api/admin/categories', requireAdmin, csrfCheck, (req,res) => {
  const name = cleanText(req.body.name, 60);
  const slug = slugify(req.body.slug || name);
  const sortOrder = Number(req.body.sort_order || 0);
  const description = cleanText(req.body.description, 500);
  if (!name || !slug || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) return res.status(400).json({error:'Проверьте название, URL-идентификатор и порядок категории'});
  try {
    const result = db.prepare('INSERT INTO categories(name,slug,sort_order,description) VALUES(?,?,?,?)').run(name,slug,sortOrder,description);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id=?').get(result.lastInsertRowid));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({error:'Категория с таким названием или URL уже существует'});
    throw error;
  }
});
app.put('/api/admin/categories/:id', requireAdmin, csrfCheck, (req,res) => {
  const id = Number(req.params.id), name = cleanText(req.body.name,60), slug = slugify(req.body.slug || name), sortOrder = Number(req.body.sort_order || 0), description = cleanText(req.body.description,500);
  if (!Number.isSafeInteger(id) || id <= 0 || !name || !slug || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) return res.status(400).json({error:'Некорректные данные категории'});
  try {
    const updateCategory = db.transaction(() => {
      const current = db.prepare('SELECT name FROM categories WHERE id=?').get(id);
      if (!current) return null;
      if (current.name !== name) {
        db.prepare('UPDATE products SET category=? WHERE category=?').run(name,current.name);
      }
      db.prepare('UPDATE categories SET name=?,slug=?,sort_order=?,description=?,active=? WHERE id=?').run(name,slug,sortOrder,description,req.body.active === false ? 0 : 1,id);
      return db.prepare('SELECT * FROM categories WHERE id=?').get(id);
    });
    const updated = updateCategory();
    if (!updated) return res.status(404).json({error:'Категория не найдена'});
    res.json(updated);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({error:'Название или URL категории уже используется'});
    throw error;
  }
});
app.delete('/api/admin/categories/:id', requireAdmin, csrfCheck, (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:'Некорректный ID'});
  const category = db.prepare('SELECT name FROM categories WHERE id=?').get(id);
  if (!category) return res.status(404).json({error:'Категория не найдена'});
  const used = db.prepare('SELECT COUNT(*) AS count FROM products WHERE category=?').get(category.name).count;
  if (used) return res.status(409).json({error:'Сначала перенесите товары из этой категории'});
  db.prepare('DELETE FROM categories WHERE id=?').run(id);
  res.json({ok:true});
});
app.get('/api/admin/settings', requireAdmin, (req,res) => {
  const rows = db.prepare('SELECT key,value FROM site_settings').all();
  res.json(Object.fromEntries(rows.map(row => [row.key,row.value])));
});
app.put('/api/admin/settings', requireAdmin, csrfCheck, (req,res) => {
  const allowed = Object.keys(DEFAULT_SITE_SETTINGS);
  const values = {};
  for (const key of allowed) values[key] = cleanText(req.body[key], key.includes('description') || key.includes('subtitle') ? 300 : key === 'site_url' ? 200 : 120);
  if (!values.site_title || !values.hero_title || !values.meta_title) return res.status(400).json({error:'Заполните название сайта, заголовок первого экрана и SEO title'});
  if (!['true','false'].includes(values.robots_index)) return res.status(400).json({error:'Выберите режим индексации'});
  if (values.site_url) {
    try {
      const url = new URL(values.site_url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid');
      values.site_url = url.origin;
    } catch {
      return res.status(400).json({error:'Адрес сайта должен быть корректным HTTPS URL без параметров'});
    }
  }
  const save = db.transaction(() => {
    for (const [key,value] of Object.entries(values)) db.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').run(key,value);
  });
  save();
  res.json(values);
});

app.get('/api/admin/products', requireAdmin, (req,res)=>{
  res.json(db.prepare('SELECT * FROM products ORDER BY created_at DESC').all());
});
app.post('/api/admin/products', requireAdmin, csrfCheck, (req,res)=>{
  const checked=validProduct(req.body); if(checked.error) return res.status(400).json({error:checked.error});
  const p=checked.value;
  const result = db.prepare('INSERT INTO products(name,category,price,description,image,meta_title,meta_description) VALUES(?,?,?,?,?,?,?)').run(p.name,p.category,p.price,p.description,p.image,p.metaTitle,p.metaDescription);
  const slug = (slugify(p.name) || 'product') + '-' + result.lastInsertRowid;
  db.prepare('UPDATE products SET slug=? WHERE id=?').run(slug,result.lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid));
});
app.put('/api/admin/products/:id', requireAdmin, csrfCheck, (req,res)=>{
  const id=Number(req.params.id); if(!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:'Некорректный ID'});
  const checked=validProduct(req.body); if(checked.error) return res.status(400).json({error:checked.error});
  const p=checked.value;
  const current=db.prepare('SELECT image FROM products WHERE id=?').get(id);
  if(!current) return res.status(404).json({error:'Товар не найден'});
  db.prepare('UPDATE products SET name=?,category=?,price=?,description=?,image=?,meta_title=?,meta_description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.name,p.category,p.price,p.description,p.image,p.metaTitle,p.metaDescription,id);
  if(current.image && current.image !== p.image) void removeUnusedLocalUpload(current.image);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(id));
});
app.patch('/api/admin/products/:id/visibility', requireAdmin, csrfCheck, (req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:'Некорректный ID'});
  if(typeof req.body.active !== 'boolean') return res.status(400).json({error:'Укажите active: true или false'});
  const result=db.prepare('UPDATE products SET active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.active ? 1 : 0,id);
  if(!result.changes) return res.status(404).json({error:'Товар не найден'});
  res.json({ok:true,active:Boolean(req.body.active)});
});
app.delete('/api/admin/products/:id', requireAdmin, csrfCheck, async (req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:'Некорректный ID'});
  const product=db.prepare('SELECT image FROM products WHERE id=?').get(id);
  if(!product) return res.status(404).json({error:'Товар не найден'});
  db.prepare('DELETE FROM products WHERE id=?').run(id);
  await removeUnusedLocalUpload(product.image);
  res.json({ok:true});
});
async function hasValidImageSignature(filePath, mimeType) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const data = header.subarray(0, bytesRead);
    if (mimeType === 'image/jpeg') {
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    }
    if (mimeType === 'image/png') {
      return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    }
    if (mimeType === 'image/webp') {
      return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    }
    if (mimeType === 'image/avif') {
      if (data.length < 16 || data.toString('ascii', 4, 8) !== 'ftyp') return false;
      const brands = [data.toString('ascii', 8, 12)];
      for (let offset = 16; offset + 4 <= bytesRead; offset += 4) brands.push(data.toString('ascii', offset, offset + 4));
      return brands.some(brand => brand === 'avif' || brand === 'avis');
    }
    return false;
  } finally {
    await handle.close();
  }
}

app.post('/api/admin/upload', requireAdmin, csrfCheck, uploadLimiter, (req,res)=>{
  upload.single('image')(req,res,err=>{
    if(err) return res.status(400).json({error:err.message});
    if(!req.file) return res.status(400).json({error:'Выберите изображение'});
    (async () => {
      const valid = await hasValidImageSignature(req.file.path, req.file.mimetype);
      if (!valid) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({error:'Содержимое файла не соответствует заявленному формату изображения'});
      }
      return res.status(201).json({url:'/uploads/'+req.file.filename});
    })().catch(async error => {
      await fs.promises.unlink(req.file.path).catch(() => {});
      console.error('Image upload validation failed:', error);
      if (!res.headersSent) res.status(500).json({error:'Не удалось проверить изображение'});
    });
  });
});
app.post('/api/admin/upload/cleanup', requireAdmin, csrfCheck, async (req,res)=>{
  const image = cleanText(req.body.url, 500);
  if (!localUploadPath(image)) return res.status(400).json({error:'Некорректный адрес загруженного изображения'});
  const removed = await removeUnusedLocalUpload(image);
  res.json({ok:true,removed});
});
app.get('/api/admin/orders', requireAdmin, (req,res)=>{
  res.json(db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all());
});
app.patch('/api/admin/orders/:id', requireAdmin, csrfCheck, (req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:'Некорректный ID'});
  const status=cleanText(req.body.status,20);
  if(!['new','in_progress','completed','cancelled'].includes(status)) return res.status(400).json({error:'Некорректный статус'});
  const r=db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,id);
  if(!r.changes) return res.status(404).json({error:'Заявка не найдена'});
  res.json({ok:true});
});

// Unknown API paths must not fall through to the public single-page app.
app.use('/api', (req, res) => res.status(404).json({ error: 'API-маршрут не найден' }));

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge:'7d', immutable:true, fallthrough:false, dotfiles:'deny', index:false, redirect:false }));
app.use(express.static(path.join(ROOT,'public')));
app.use('/admin-assets', express.static(path.join(ROOT, 'admin'), { fallthrough: false, maxAge: '1h' }));
app.get('/admin', (req,res)=>{
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(ROOT, 'admin', 'index.html'));
});
app.get('*', (req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.use((err,req,res,next)=>{
  console.error(err);
  if(res.headersSent) return next(err);
  res.status(500).json({error:'Внутренняя ошибка сервера'});
});

app.listen(PORT,()=>console.log(`DOMA TECH запущен: http://localhost:${PORT}`));

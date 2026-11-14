require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
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
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
for (const dir of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'change-this-before-first-run') {
    throw new Error('Set a strong ADMIN_PASSWORD before production');
  }
  app.set('trust proxy', 1);
}

const db = new Database(path.join(DATA_DIR, 'doma-tech.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
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
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR, concurrentDB: true }),
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
function validProduct(body) {
  const name = cleanText(body.name, 120);
  const category = cleanText(body.category, 60);
  const description = cleanText(body.description, 700);
  const image = cleanText(body.image, 500);
  const price = body.price === '' || body.price === null || body.price === undefined ? null : Number(body.price);
  if (!name || !category) return { error: 'Укажите название и категорию товара' };
  if (price !== null && (!Number.isSafeInteger(price) || price < 0 || price > 100000000)) return { error: 'Некорректная цена' };
  if (image && !image.startsWith('/uploads/') && !/^https:\/\/.+/i.test(image)) return { error: 'Изображение должно быть HTTPS-ссылкой или файлом из /uploads/' };
  return { value: { name, category, description, image, price } };
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

app.get('/api/health', (req,res)=>res.json({ ok:true, service:'DOMA TECH' }));
app.get('/api/products', (req,res)=>{
  const products = db.prepare('SELECT id,name,category,price,description,image FROM products WHERE active=1 ORDER BY created_at DESC').all();
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
app.post('/api/admin/logout', requireAdmin, csrfCheck, (req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get('/api/admin/products', requireAdmin, (req,res)=>{
  res.json(db.prepare('SELECT * FROM products ORDER BY created_at DESC').all());
});
app.post('/api/admin/products', requireAdmin, csrfCheck, (req,res)=>{
  const checked=validProduct(req.body); if(checked.error) return res.status(400).json({error:checked.error});
  const p=checked.value;
  const r=db.prepare('INSERT INTO products(name,category,price,description,image) VALUES(?,?,?,?,?)').run(p.name,p.category,p.price,p.description,p.image);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/admin/products/:id', requireAdmin, csrfCheck, (req,res)=>{
  const id=Number(req.params.id); if(!Number.isInteger(id)) return res.status(400).json({error:'Некорректный ID'});
  const checked=validProduct(req.body); if(checked.error) return res.status(400).json({error:checked.error});
  const p=checked.value;
  const r=db.prepare('UPDATE products SET name=?,category=?,price=?,description=?,image=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.name,p.category,p.price,p.description,p.image,id);
  if(!r.changes) return res.status(404).json({error:'Товар не найден'});
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(id));
});
app.delete('/api/admin/products/:id', requireAdmin, csrfCheck, (req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:'Некорректный ID'});
  const r=db.prepare('DELETE FROM products WHERE id=?').run(id);
  if(!r.changes) return res.status(404).json({error:'Товар не найден'});
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

app.post('/api/admin/upload', requireAdmin, csrfCheck, (req,res)=>{
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

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge:'7d', fallthrough:false }));
app.use(express.static(path.join(ROOT,'public')));
app.get('/admin', (req,res)=>res.status(404).json({ error:'Административная панель ещё не создана' }));
app.get('*', (req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.use((err,req,res,next)=>{
  console.error(err);
  if(res.headersSent) return next(err);
  res.status(500).json({error:'Внутренняя ошибка сервера'});
});

app.listen(PORT,()=>console.log(`DOMA TECH запущен: http://localhost:${PORT}`));

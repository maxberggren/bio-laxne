import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import webpush from 'web-push';

const root = path.dirname(fileURLToPath(import.meta.url));
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set in production.');
}
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'bio-laxne.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS screenings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    synopsis TEXT NOT NULL DEFAULT '',
    starts_at TEXT NOT NULL,
    runtime INTEGER NOT NULL DEFAULT 100,
    price INTEGER,
    poster_url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'guest',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    screening_id INTEGER NOT NULL REFERENCES screenings(id) ON DELETE CASCADE,
    seat INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 4),
    guest_name TEXT NOT NULL,
    ticket_token TEXT NOT NULL UNIQUE,
    subscription_endpoint TEXT,
    reminder_sent INTEGER NOT NULL DEFAULT 0,
    scanned_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(screening_id, seat)
  );
`);

if (!db.prepare('PRAGMA table_info(screenings)').all().some((column) => column.name === 'price')) {
  db.exec('ALTER TABLE screenings ADD COLUMN price INTEGER');
}

function setting(key, create) {
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (existing) return existing.value;
  const value = create();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  return value;
}

const ticketSecret = process.env.TICKET_SECRET || setting('ticket_secret', () => crypto.randomBytes(32).toString('hex'));
const sessionSecret = process.env.SESSION_SECRET || setting('session_secret', () => crypto.randomBytes(32).toString('hex'));
const vapid = JSON.parse(setting('vapid_keys', () => JSON.stringify(webpush.generateVAPIDKeys())));
webpush.setVapidDetails(process.env.VAPID_EMAIL || 'mailto:bio@laxne.se', vapid.publicKey, vapid.privateKey);

const screeningCount = db.prepare('SELECT COUNT(*) AS count FROM screenings').get().count;
if (!screeningCount && process.env.NODE_ENV !== 'test') {
  const insert = db.prepare('INSERT INTO screenings (title, synopsis, starts_at, runtime, price, poster_url) VALUES (?, ?, ?, ?, ?, ?)');
  const upcoming = (days, hour) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  insert.run('Månskenståget', 'Ett nattligt äventyr genom skogar, stjärnor och glömda stationer.', upcoming(2, 19), 92, 80, '/posters/moon-train.svg');
  insert.run('Havet under oss', 'En varm berättelse om vänskap, mod och hemligheter på havets botten.', upcoming(5, 18), 104, 100, '/posters/deep-sea.svg');
  insert.run('Rymdposten', 'Universums minsta brevbärare får sitt livs allra största uppdrag.', upcoming(8, 20), 88, null, '/posters/space-post.svg');
}

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '200kb' }));
app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function adminCookie() {
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  const value = `admin.${expires}`;
  return `${value}.${sign(value)}`;
}

function isAdmin(req) {
  const raw = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('bio_admin='))?.slice(10);
  if (!raw) return false;
  const [role, expires, signature] = raw.split('.');
  const value = `${role}.${expires}`;
  const expected = sign(value);
  return role === 'admin' && Number(expires) > Date.now() && signature?.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Logga in som biografvärd.' });
  next();
}

function publicScreenings(includePast = false) {
  const where = includePast ? '' : "WHERE datetime(s.starts_at) > datetime('now')";
  return db.prepare(`
    SELECT s.*, COALESCE(group_concat(b.seat), '') AS booked_seats
    FROM screenings s LEFT JOIN bookings b ON b.screening_id = s.id
    ${where} GROUP BY s.id ORDER BY s.starts_at
  `).all().map((row) => ({
    id: row.id,
    title: row.title,
    synopsis: row.synopsis,
    startsAt: row.starts_at,
    runtime: row.runtime,
    price: row.price,
    posterUrl: row.poster_url,
    bookedSeats: row.booked_seats ? row.booked_seats.split(',').map(Number) : []
  }));
}

async function notify(role, title, body, url = '/') {
  const rows = db.prepare('SELECT endpoint, payload FROM subscriptions WHERE role = ?').all(role);
  await Promise.allSettled(rows.map(async (row) => {
    try {
      await webpush.sendNotification(JSON.parse(row.payload), JSON.stringify({ title, body, url }));
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(row.endpoint);
      } else {
        console.error('Push notification failed:', error.message);
      }
    }
  }));
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/screenings', (_req, res) => res.json(publicScreenings()));
app.get('/api/push/public-key', (_req, res) => res.json({ publicKey: vapid.publicKey }));

app.post('/api/push/subscribe', (req, res) => {
  const { subscription, role = 'guest' } = req.body;
  if (!subscription?.endpoint || !subscription?.keys) return res.status(400).json({ error: 'Ogiltig push-prenumeration.' });
  const safeRole = role === 'admin' && isAdmin(req) ? 'admin' : 'guest';
  db.prepare(`INSERT INTO subscriptions (endpoint, payload, role) VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET payload = excluded.payload, role = excluded.role`).run(subscription.endpoint, JSON.stringify(subscription), safeRole);
  res.status(201).json({ endpoint: subscription.endpoint, role: safeRole });
});

app.post('/api/push/link-bookings', (req, res) => {
  const endpoint = String(req.body.endpoint || '').slice(0, 1000);
  const tokens = Array.isArray(req.body.tokens) ? req.body.tokens.filter((token) => typeof token === 'string').slice(0, 20) : [];
  if (!endpoint || !db.prepare('SELECT 1 FROM subscriptions WHERE endpoint = ?').get(endpoint) || !tokens.length) {
    return res.status(400).json({ error: 'Bokningarna kunde inte kopplas till notiser.' });
  }
  const update = db.prepare('UPDATE bookings SET subscription_endpoint = ? WHERE ticket_token = ?');
  let linked = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const token of tokens) linked += update.run(endpoint, token).changes;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  res.json({ linked });
});

app.post('/api/bookings', async (req, res) => {
  const screeningId = Number(req.body.screeningId);
  const seat = Number(req.body.seat);
  const guestName = String(req.body.guestName || '').trim().slice(0, 80);
  const subscriptionEndpoint = typeof req.body.subscriptionEndpoint === 'string' ? req.body.subscriptionEndpoint.slice(0, 1000) : null;
  if (!Number.isInteger(screeningId) || ![1, 2, 3, 4].includes(seat) || guestName.length < 2) {
    return res.status(400).json({ error: 'Välj en stol och skriv ditt namn.' });
  }
  const screening = db.prepare("SELECT * FROM screenings WHERE id = ? AND datetime(starts_at) > datetime('now')").get(screeningId);
  if (!screening) return res.status(404).json({ error: 'Visningen finns inte längre.' });

  const ticketToken = `${crypto.randomBytes(18).toString('base64url')}.${crypto.createHmac('sha256', ticketSecret).update(`${screeningId}:${seat}:${guestName}:${Date.now()}`).digest('base64url')}`;
  try {
    db.prepare('INSERT INTO bookings (screening_id, seat, guest_name, ticket_token, subscription_endpoint) VALUES (?, ?, ?, ?, ?)')
      .run(screeningId, seat, guestName, ticketToken, subscriptionEndpoint);
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' && error.message.includes('UNIQUE')) return res.status(409).json({ error: 'Någon hann precis boka den stolen. Välj en annan.' });
    throw error;
  }

  const qrDataUrl = await ticketQr(ticketToken);
  void notify('admin', 'Ny bokning i Bio Laxne', `${guestName} bokade stol ${seat} till ${screening.title}.`, '/admin.html');
  res.status(201).json({
    ticketToken,
    qrDataUrl,
    screening: { title: screening.title, startsAt: screening.starts_at, price: screening.price },
    seat,
    guestName
  });
});

app.post('/api/tickets/recover', async (req, res) => {
  const tokens = Array.isArray(req.body.tokens) ? req.body.tokens.filter((token) => typeof token === 'string').slice(0, 20) : [];
  if (!tokens.length) return res.json([]);
  const getTicket = db.prepare(`SELECT b.ticket_token, b.guest_name, b.seat, s.title, s.starts_at, s.price
    FROM bookings b JOIN screenings s ON s.id = b.screening_id WHERE b.ticket_token = ?`);
  const rows = tokens.map((token) => getTicket.get(token)).filter(Boolean).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const tickets = await Promise.all(rows.map(async (row) => ({
    ticketToken: row.ticket_token,
    qrDataUrl: await ticketQr(row.ticket_token),
    guestName: row.guest_name,
    seat: row.seat,
    screening: { title: row.title, startsAt: row.starts_at, price: row.price }
  })));
  res.json(tickets);
});

function ticketQr(token) {
  return QRCode.toDataURL(token, { width: 720, margin: 2, color: { dark: '#24130f', light: '#fffaf0' }, errorCorrectionLevel: 'M' });
}

app.post('/api/admin/login', (req, res) => {
  const expected = process.env.ADMIN_PASSWORD || 'biolaxne';
  const supplied = String(req.body.password || '');
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return res.status(401).json({ error: 'Fel lösenord.' });
  res.setHeader('Set-Cookie', `bio_admin=${adminCookie()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ authenticated: true });
});

app.post('/api/admin/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'bio_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ authenticated: false });
});

app.get('/api/admin/session', (req, res) => res.json({ authenticated: isAdmin(req) }));
app.get('/api/admin/screenings', requireAdmin, (_req, res) => res.json(publicScreenings(true)));

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, callback) => callback(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype))
});

app.post('/api/admin/screenings', requireAdmin, upload.single('poster'), async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const synopsis = String(req.body.synopsis || '').trim().slice(0, 600);
  const startsAt = new Date(req.body.startsAt);
  const runtime = Number(req.body.runtime);
  const price = req.body.price === undefined || req.body.price === '' ? null : Number(req.body.price);
  if (!title || Number.isNaN(startsAt.getTime()) || startsAt <= new Date() || !Number.isInteger(runtime) || runtime < 20 || runtime > 400 || (price !== null && (!Number.isInteger(price) || price < 0 || price > 10000)) || !req.file) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Fyll i titel, framtida starttid, speltid och affisch.' });
  }
  const result = db.prepare('INSERT INTO screenings (title, synopsis, starts_at, runtime, price, poster_url) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, synopsis, startsAt.toISOString(), runtime, price, `/uploads/${req.file.filename}`);
  void notify('guest', 'Ny film på Bio Laxne!', `${title} går nu att boka. Bara fyra stolar - först till kvarn!`, '/');
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.post('/api/admin/validate', requireAdmin, (req, res) => {
  const token = String(req.body.token || '').trim();
  const booking = db.prepare(`SELECT b.*, s.title, s.starts_at, s.runtime FROM bookings b
    JOIN screenings s ON s.id = b.screening_id WHERE b.ticket_token = ?`).get(token);
  if (!booking) return res.status(404).json({ status: 'invalid', message: 'Biljetten är inte giltig.' });
  if (booking.scanned_at) return res.status(409).json({ status: 'used', message: `Redan insläppt ${new Date(booking.scanned_at).toLocaleString('sv-SE')}.`, booking: ticketInfo(booking) });
  if (Date.now() > new Date(booking.starts_at).getTime() + booking.runtime * 60000) {
    return res.status(410).json({ status: 'expired', message: 'Visningen är slut och biljetten har gått ut.', booking: ticketInfo(booking) });
  }
  const scannedAt = new Date().toISOString();
  const updated = db.prepare('UPDATE bookings SET scanned_at = ? WHERE id = ? AND scanned_at IS NULL').run(scannedAt, booking.id);
  if (!updated.changes) return res.status(409).json({ status: 'used', message: 'Biljetten har redan använts.' });
  res.json({ status: 'valid', message: 'Välkommen in!', booking: ticketInfo(booking) });
});

function ticketInfo(row) {
  return { guestName: row.guest_name, seat: row.seat, title: row.title, startsAt: row.starts_at };
}

async function sendReminders() {
  const rows = db.prepare(`SELECT b.id, b.subscription_endpoint, b.guest_name, b.seat, s.title, s.starts_at
    FROM bookings b JOIN screenings s ON s.id = b.screening_id
    WHERE b.reminder_sent = 0 AND b.subscription_endpoint IS NOT NULL
      AND datetime(s.starts_at) BETWEEN datetime('now', '+50 minutes') AND datetime('now', '+70 minutes')`).all();
  for (const row of rows) {
    const subscription = db.prepare('SELECT payload FROM subscriptions WHERE endpoint = ?').get(row.subscription_endpoint);
    if (!subscription) continue;
    try {
      await webpush.sendNotification(JSON.parse(subscription.payload), JSON.stringify({
        title: 'Snart släcks salongen',
        body: `${row.title} börjar om en timme. Din plats är stol ${row.seat}.`,
        url: '/'
      }));
      db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(row.id);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(row.subscription_endpoint);
    }
  }
}

const reminderTimer = setInterval(() => void sendReminders(), 60_000);
reminderTimer.unref();

app.use(express.static(path.join(root, 'public'), { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Affischen får vara högst 8 MB.' });
  res.status(500).json({ error: 'Något gick fel bakom ridån.' });
});

export { app, db };

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => console.log(`Bio Laxne glöder på http://localhost:${port}`));
}

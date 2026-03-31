require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const twilio   = require('twilio');
const admin    = require('firebase-admin');
const path     = require('path');
const fs       = require('fs');

// ════════════════════════════════════════════════════════
//  FIREBASE ADMIN
// ════════════════════════════════════════════════════════
const saPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json');

if (!fs.existsSync(saPath)) {
  console.error(`[ERROR] Firebase service account not found at: ${saPath}`);
  console.error('  → Download it from Firebase console → Project settings → Service accounts');
  process.exit(1);
}

admin.initializeApp({
  credential:   admin.credential.cert(require(saPath)),
  databaseURL:  process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
console.log('[Firebase] Admin SDK initialized');

// ════════════════════════════════════════════════════════
//  TWILIO
// ════════════════════════════════════════════════════════
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const FROM_WA = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const COUNTRY  = (process.env.PHONE_COUNTRY_CODE || '+967').trim();

// Convert local number (e.g. "0771234567") → "whatsapp:+96771234567"
function toWhatsApp(phone) {
  const digits = phone.replace(/\D/g, '');
  const local  = digits.startsWith('0') ? digits.slice(1) : digits;
  return `whatsapp:${COUNTRY}${local}`;
}

// Send a WhatsApp message; returns { ok, sid } or { ok: false, error }
async function sendWhatsApp(phone, body) {
  try {
    const msg = await twilioClient.messages.create({
      from: FROM_WA,
      to:   toWhatsApp(phone),
      body
    });
    console.log(`[WA] ✓ Sent to ${phone} → ${toWhatsApp(phone)} (${msg.sid})`);
    return { ok: true, sid: msg.sid };
  } catch (err) {
    console.error(`[WA] ✗ Failed to ${phone}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════

// Firebase keys cannot contain . # $ / [ ]
const phoneToKey = (phone) => phone.replace(/[.#$\/\[\]]/g, '_');

// Fetch event config from Firebase (with safe defaults)
async function getConfig() {
  const snap = await db.ref('config').once('value');
  const c = snap.val() || {};
  return {
    eventYear:         c.eventYear         || 2026,
    eventMonth:        c.eventMonth        ?? 5,      // 0-indexed
    eventDay:          c.eventDay          || 20,
    eventHour:         c.eventHour         || 19,
    eventMinute:       c.eventMinute       || 0,
    eventDateAr:       c.eventDateAr       || '٢٠ يونيو',
    eventYearAr:       c.eventYearAr       || '١٤٤٧ هـ — ٢٠٢٦ م',
    eventStartTime:    c.eventStartTime    || '٧:٠٠ م',
    doorsOpenTime:     c.doorsOpenTime     || '٦:٠٠ م',
    venueName:         c.venueName         || '',
    venueAddressLine1: c.venueAddressLine1 || '',
    mapLink:           c.mapLink           || ''
  };
}

// ════════════════════════════════════════════════════════
//  EXPRESS
// ════════════════════════════════════════════════════════
const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins
}));
app.use(express.json());

// ── Health check ──────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), country: COUNTRY });
});

// ── POST /api/register ────────────────────────────────
// Called by index.html when a guest passes the gate.
// Saves registration to Firebase and sends welcome WhatsApp.
app.post('/api/register', async (req, res) => {
  const { name, phone, role } = req.body || {};

  if (!name || !phone || !role) {
    return res.status(400).json({ error: 'name, phone, and role are required' });
  }

  const key = phoneToKey(phone);
  const regRef = db.ref(`registrations/${key}`);
  const snap = await regRef.once('value');
  const existing = snap.val();
  const now = Date.now();

  if (!existing) {
    await regRef.set({
      name, phone, role,
      registeredAt:  now,
      welcomeSent:   false,
      reminderSent:  false
    });
    console.log(`[REG] New: ${name} (${phone}) — ${role}`);
  } else {
    // Update name/role if they re-entered with changes
    await regRef.update({ name, role, updatedAt: now });
    console.log(`[REG] Updated: ${name} (${phone}) — ${role}`);
  }

  // Send welcome message (even if re-registering, re-send)
  const cfg = await getConfig();
  const roleAr = role === 'parent' ? 'ولي الأمر الكريم' : 'أيها الخريج';

  const welcomeMsg =
    `أهلاً ${roleAr} ${name}! 🎓\n\n` +
    `تم تسجيل حضورك في حفل تخرج *قاب حلم — UFUQ 2026*\n\n` +
    `📅 الموعد: ${cfg.eventDateAr} | ${cfg.eventYearAr}\n` +
    `🕖 بدء الحفل: ${cfg.eventStartTime}\n` +
    `🚪 فتح الأبواب: ${cfg.doorsOpenTime}\n` +
    `📍 ${cfg.venueName}${cfg.venueAddressLine1 ? `، ${cfg.venueAddressLine1}` : ''}\n\n` +
    `نتطلع لرؤيتك في هذه الليلة المميزة ✨`;

  const result = await sendWhatsApp(phone, welcomeMsg);
  await regRef.update({ welcomeSent: result.ok, welcomeSentAt: now });

  res.json({ ok: true, welcomed: result.ok, ...(result.error && { waError: result.error }) });
});

// ── GET /api/registrations ────────────────────────────
// Lists all registered guests (for admin use).
app.get('/api/registrations', async (_req, res) => {
  const snap = await db.ref('registrations').once('value');
  const data = snap.val() || {};
  const list = Object.values(data).map(r => ({
    name:          r.name,
    phone:         r.phone,
    role:          r.role,
    registeredAt:  r.registeredAt ? new Date(r.registeredAt).toISOString() : null,
    welcomeSent:   r.welcomeSent   || false,
    reminderSent:  r.reminderSent  || false
  }));
  res.json({ count: list.length, registrations: list });
});

// ── POST /api/test/welcome ────────────────────────────
// Manually trigger a welcome message for testing.
// Body: { phone }
app.post('/api/test/welcome', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const cfg    = await getConfig();
  const testMsg =
    `[اختبار] أهلاً! 🎓\n\n` +
    `هذه رسالة اختبار من نظام *قاب حلم — UFUQ 2026*\n\n` +
    `📅 ${cfg.eventDateAr} — ${cfg.eventStartTime}\n` +
    `📍 ${cfg.venueName}\n\n` +
    `الرسائل تعمل بشكل صحيح ✅`;

  const result = await sendWhatsApp(phone, testMsg);
  res.json(result);
});

// ── POST /api/test/reminder ───────────────────────────
// Manually trigger a reminder message for testing.
// Body: { phone }
app.post('/api/test/reminder', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const key   = phoneToKey(phone);
  const snap  = await db.ref(`registrations/${key}`).once('value');
  const reg   = snap.val();
  const name  = reg?.name  || 'ضيفنا الكريم';
  const role  = reg?.role  || 'student';
  const cfg   = await getConfig();
  const roleAr = role === 'parent' ? 'ولي الأمر الكريم' : 'أيها الخريج';

  const testMsg =
    `[اختبار] تذكير — غداً حفلكم! 🎓\n\n` +
    `أهلاً ${roleAr} ${name}،\n\n` +
    `تبقّى يومٌ واحدٌ على حفل *قاب حلم — UFUQ 2026*\n\n` +
    `📅 ${cfg.eventDateAr} | ${cfg.eventYearAr}\n` +
    `🕖 بدء الحفل: ${cfg.eventStartTime}\n` +
    `🚪 فتح الأبواب: ${cfg.doorsOpenTime}\n` +
    `📍 ${cfg.venueName}${cfg.venueAddressLine1 ? `، ${cfg.venueAddressLine1}` : ''}` +
    `${cfg.mapLink ? `\n🗺 ${cfg.mapLink}` : ''}\n\n` +
    `نراكم هناك ✨`;

  const result = await sendWhatsApp(phone, testMsg);
  res.json(result);
});

// ════════════════════════════════════════════════════════
//  CRON — 1-day reminder (runs every hour at :00)
// ════════════════════════════════════════════════════════
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Checking 1-day reminder window...');

  const cfg = await getConfig();
  const eventTime = new Date(
    cfg.eventYear, cfg.eventMonth, cfg.eventDay,
    cfg.eventHour, cfg.eventMinute, 0
  ).getTime();

  const diff = eventTime - Date.now();
  const h23  = 23 * 60 * 60 * 1000;
  const h25  = 25 * 60 * 60 * 1000;

  console.log(`[CRON] Time until event: ${(diff / 3600000).toFixed(1)}h`);

  if (diff < h23 || diff > h25) {
    console.log('[CRON] Not in 23–25h reminder window — skipping.');
    return;
  }

  const snap = await db.ref('registrations').once('value');
  const regs = snap.val() || {};
  let sent = 0, skipped = 0;

  for (const [key, reg] of Object.entries(regs)) {
    if (reg.reminderSent) { skipped++; continue; }

    const roleAr = reg.role === 'parent' ? 'ولي الأمر الكريم' : 'أيها الخريج';
    const msg =
      `تذكير — غداً حفلكم! 🎓\n\n` +
      `أهلاً ${roleAr} ${reg.name}،\n\n` +
      `تبقّى يومٌ واحدٌ على حفل *قاب حلم — UFUQ 2026*\n\n` +
      `📅 ${cfg.eventDateAr} | ${cfg.eventYearAr}\n` +
      `🕖 بدء الحفل: ${cfg.eventStartTime}\n` +
      `🚪 فتح الأبواب: ${cfg.doorsOpenTime}\n` +
      `📍 ${cfg.venueName}${cfg.venueAddressLine1 ? `، ${cfg.venueAddressLine1}` : ''}` +
      `${cfg.mapLink ? `\n🗺 ${cfg.mapLink}` : ''}\n\n` +
      `نراكم هناك ✨`;

    const result = await sendWhatsApp(reg.phone, msg);
    await db.ref(`registrations/${key}`).update({
      reminderSent:   result.ok,
      reminderSentAt: Date.now()
    });

    result.ok ? sent++ : null;
    console.log(`[CRON] ${result.ok ? '✓' : '✗'} ${reg.name} (${reg.phone})`);
  }

  console.log(`[CRON] Done — sent: ${sent}, skipped (already sent): ${skipped}`);
});

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n[SERVER] Running → http://localhost:${PORT}`);
  console.log(`[SERVER] Health  → http://localhost:${PORT}/api/health`);
  console.log(`[SERVER] COUNTRY → ${COUNTRY}\n`);
});

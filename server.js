/**
 * Student Fee Management System — Express Server
 * Students API, WhatsApp connection, settings, and scheduled reminders
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const db = require('./database');
const whatsapp = require('./whatsapp');
const auth = require('./auth');
const settingsStore = require('./settings');

const app = express();
const PORT = process.env.PORT || 3000;
const INSTITUTION_NAME = process.env.INSTITUTION_NAME || 'Student Academy';
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

// If the server was asleep or WhatsApp was offline on a reminder day,
// that day's reminders still go out during the next couple of days.
const CATCH_UP_DAYS = 3;

// ─── Middleware ─────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health Check & Session ────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', institution: INSTITUTION_NAME, timestamp: new Date().toISOString() });
});

app.get('/api/session', auth.session);
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);

// Everything below requires login (when ADMIN_PASSWORD is set)
app.use('/api', auth.requireAuth);

app.get('/api/config', (req, res) => {
  res.json({ institution: INSTITUTION_NAME, authEnabled: auth.enabled, currentMonth: nowInTimezone().month });
});

// ═══════════════════════════════════════════════════════
//  STUDENT ROUTES
// ═══════════════════════════════════════════════════════

// Each student includes `paid` / `paid_date` for the current month
app.get('/api/students', async (req, res) => {
  try {
    const { month } = nowInTimezone();
    const [students, payments] = await Promise.all([db.getAllStudents(), db.getPaymentsForMonth(month)]);
    res.json(students.map(s => {
      const payment = payments.get(s.id);
      return { ...s, paid: payment?.status === 'paid', paid_date: payment?.status === 'paid' ? payment.paid_date : null };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const { student, error } = validateStudent(req.body);
    if (error) return res.status(400).json({ error });
    res.status(201).json(await db.createStudent(student));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const { student, error } = validateStudent(req.body);
    if (error) return res.status(400).json({ error });
    res.json(await db.updateStudent(parseId(req.params.id), student));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark a student paid / not paid for the current month
app.put('/api/students/:id/payment', async (req, res) => {
  try {
    if (typeof req.body.paid !== 'boolean') return res.status(400).json({ error: '"paid" must be true or false' });
    const { month } = nowInTimezone();
    const record = await db.setPaymentStatus(parseId(req.params.id), month, req.body.paid);
    res.json({ month, paid: record.status === 'paid', paid_date: record.paid_date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    await db.deleteStudent(parseId(req.params.id));
    res.json({ message: 'Student deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  WHATSAPP & REMINDER ROUTES
// ═══════════════════════════════════════════════════════

app.get('/api/whatsapp/status', (req, res) => {
  res.json(whatsapp.getStatus());
});

app.get('/api/whatsapp/qr', (req, res) => {
  const qr = whatsapp.getQRCode();
  const status = whatsapp.getStatus();
  if (qr) {
    res.json({ qr, status: status.status });
  } else if (status.status === 'connected') {
    res.json({ status: status.status, message: 'Already connected — no QR needed' });
  } else {
    res.json({ status: status.status, message: status.message || 'QR code not available yet. Please wait...' });
  }
});

app.post('/api/whatsapp/logout', async (req, res) => {
  try {
    await whatsapp.logout();
    await db.logActivity('WhatsApp Logged Out', 'Device unlinked from the dashboard');
    res.json({ message: 'WhatsApp logged out' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// When the last reminder went out and when the next scheduled one will
app.get('/api/reminders', async (req, res) => {
  try {
    const { month, day } = nowInTimezone();
    const settings = await settingsStore.getSettings();
    const [last, sentDays] = await Promise.all([db.getLastReminderRun(), db.getScheduledDaysSent(month)]);
    res.json({
      lastRun: last,
      nextDate: settings.autoEnabled ? nextReminderDate(settings.reminderDays, month, day, sentDays) : null,
      autoEnabled: settings.autoEnabled,
      running: reminderRunning
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send this month's reminder to every unpaid student right now (runs in the background)
app.post('/api/reminders/send-now', async (req, res) => {
  try {
    if (reminderRunning) return res.status(409).json({ error: 'Reminders are already being sent' });
    if (whatsapp.getStatus().status !== 'connected') {
      return res.status(400).json({ error: 'Connect WhatsApp first' });
    }
    const { month } = nowInTimezone();
    const students = await getUnpaidStudents(month);
    if (students.length === 0) return res.json({ count: 0, message: 'Everyone has paid this month' });

    sendReminders(students, month, 'send now', (results) => db.logManualReminderRun(month, results.sent, results.failed));
    res.status(202).json({ count: students.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════

app.get('/api/settings', async (req, res) => {
  try {
    res.json({ ...(await settingsStore.getSettings()), defaultTemplate: settingsStore.DEFAULT_TEMPLATE, institution: INSTITUTION_NAME });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { settings, error } = await settingsStore.saveSettings(req.body);
    if (error) return res.status(400).json({ error });
    await db.logActivity('Settings Updated', `Reminder days: ${settings.reminderDays.join(', ') || 'none'} | Automatic: ${settings.autoEnabled ? 'on' : 'off'}`);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ═══════════════════════════════════════════════════════
//  REMINDERS
// ═══════════════════════════════════════════════════════

let reminderRunning = false;
const sentKeys = new Set(); // 'YYYY-MM:day' — in-memory guard so a failed log write can never cause a resend

/** Students not marked paid for `month` */
async function getUnpaidStudents(month) {
  const [allStudents, payments] = await Promise.all([db.getAllStudents(), db.getPaymentsForMonth(month)]);
  return allStudents.filter(s => payments.get(s.id)?.status !== 'paid');
}

/** Send the reminder to `students` using the saved message, then call `onDone(results)` */
async function sendReminders(students, month, trigger, onDone) {
  reminderRunning = true;
  try {
    const { messageTemplate } = await settingsStore.getSettings();
    console.log(`\n🗓️  Sending ${month} reminders to ${students.length} unpaid students (${trigger})`);
    const results = await whatsapp.sendFeeReminders(students, month, INSTITUTION_NAME, messageTemplate);
    await onDone(results);
    console.log(`   📱 Sent: ${results.sent}, failed: ${results.failed}`);
    return results;
  } catch (err) {
    console.error('   ❌ Reminder error:', err.message);
  } finally {
    reminderRunning = false;
  }
}

/** Send any scheduled reminders that are due today (or were missed in the last few days) */
async function runScheduledReminders(trigger) {
  if (reminderRunning) return;
  const settings = await settingsStore.getSettings();
  if (!settings.autoEnabled) return;

  const { month, day } = nowInTimezone();
  const due = dueDays(settings.reminderDays, month, day).filter(d => !sentKeys.has(`${month}:${d}`));
  if (due.length === 0) return;

  if (whatsapp.getStatus().status !== 'connected') {
    console.log(`⏳ Reminders for ${month} (day ${due.join(', ')}) waiting for WhatsApp to connect (${trigger})`);
    return;
  }

  try {
    const sentDays = await db.getScheduledDaysSent(month);
    const remaining = due.filter(d => !sentDays.has(d));
    due.filter(d => sentDays.has(d)).forEach(d => sentKeys.add(`${month}:${d}`));
    if (remaining.length === 0) return;

    const students = await getUnpaidStudents(month);
    remaining.forEach(d => sentKeys.add(`${month}:${d}`));
    if (students.length === 0) {
      await db.logReminderRun(month, remaining, 0, 0);
      return;
    }
    await sendReminders(students, month, trigger, (results) => db.logReminderRun(month, remaining, results.sent, results.failed));
  } catch (err) {
    console.error('   ❌ Scheduled reminder error:', err.message);
  }
}

// Check every hour; runScheduledReminders makes sure each chosen day only sends once
cron.schedule('1 * * * *', () => runScheduledReminders('schedule'), { timezone: TIMEZONE });

// ─── Helpers ───────────────────────────────────────────
function nowInTimezone() {
  // 'en-CA' formats as YYYY-MM-DD
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
  return { month: date.slice(0, 7), day: Number(date.slice(8, 10)) };
}

function daysInMonth(month) {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}

/** Chosen days for `month`; days past the month's end move to its last day (e.g. 31 → 30 in April) */
function reminderDaysFor(reminderDays, month) {
  const last = daysInMonth(month);
  return [...new Set(reminderDays.map(d => Math.min(d, last)))].sort((a, b) => a - b);
}

/** Chosen days that are due today, including ones missed within the catch-up window */
function dueDays(reminderDays, month, today) {
  return reminderDaysFor(reminderDays, month).filter(d => today >= d && today < d + CATCH_UP_DAYS);
}

/** 'YYYY-MM-DD' of the next scheduled reminder that hasn't been sent yet */
function nextReminderDate(reminderDays, month, today, sentDays) {
  if (reminderDays.length === 0) return null;
  const pad = (d) => String(d).padStart(2, '0');
  const pending = reminderDaysFor(reminderDays, month)
    .filter(d => !sentDays.has(d) && today < d + CATCH_UP_DAYS);
  if (pending.length) return `${month}-${pad(Math.max(pending[0], today))}`;
  const next = shiftMonth(month, 1);
  return `${next}-${pad(reminderDaysFor(reminderDays, next)[0])}`;
}

function shiftMonth(month, delta) {
  const [year, mon] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseId(value) {
  const id = parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id');
  return id;
}

function validateStudent(body = {}) {
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').replace(/[^\d+]/g, '');
  const class_name = String(body.class_name || '').trim();
  const fee_amount = Number(body.fee_amount);
  const digits = phone.replace(/\D/g, '');

  if (!name || !phone || !class_name || body.fee_amount == null || body.fee_amount === '') {
    return { error: 'All fields are required: name, phone, class_name, fee_amount' };
  }
  if (name.length > 100) return { error: 'Name is too long' };
  if (digits.length < 10 || digits.length > 15) return { error: 'Enter a valid phone number (10–15 digits)' };
  if (!Number.isFinite(fee_amount) || fee_amount < 0) return { error: 'Fee must be a positive number' };

  return { student: { name, phone, class_name, fee_amount } };
}

// ─── Catch-all: Serve frontend ─────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// A failed background task (e.g. a WhatsApp session backup) should be logged, not crash the server
process.on('unhandledRejection', (err) => {
  console.error('⚠️  Unhandled error:', err?.message || err);
});

// ─── Keep-alive on Render ──────────────────────────────
// Render's free tier sleeps after 15 minutes without traffic, and a sleeping
// server can't send reminders. Pinging our own public URL keeps it awake.
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/api/health`).catch(() => {});
  }, 10 * 60 * 1000);
}

// ─── Start Server ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Student Fee Management System`);
  console.log(`   Server running at: http://localhost:${PORT}`);
  console.log(`   Institution: ${INSTITUTION_NAME}`);
  console.log(`   Timezone: ${TIMEZONE}`);
  if (!auth.enabled) {
    console.log('   ⚠️  ADMIN_PASSWORD is not set — the dashboard is open to anyone with the URL');
  }
  console.log('');

  // Initialize WhatsApp; whenever it connects, send any reminders that are still due
  console.log('📱 Initializing WhatsApp...');
  whatsapp.initWhatsApp(() => runScheduledReminders('whatsapp connected'));
});

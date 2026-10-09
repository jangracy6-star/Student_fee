/**
 * Student Fee Management System — Express Server
 * Students API, WhatsApp connection, and the automatic monthly reminder
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const db = require('./database');
const whatsapp = require('./whatsapp');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const INSTITUTION_NAME = process.env.INSTITUTION_NAME || 'Student Academy';
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

// If the server was asleep or WhatsApp was offline on the 1st,
// reminders still go out as soon as possible during the first few days.
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

// When the last monthly reminder went out and when the next one will
app.get('/api/reminders', async (req, res) => {
  try {
    const { month, day } = nowInTimezone();
    const last = await db.getLastReminderRun();
    const sentThisMonth = last?.month === month || lastSentMonth === month;
    const nextMonth = (sentThisMonth || day > CATCH_UP_DAYS) ? shiftMonth(month, 1) : month;
    res.json({
      lastRun: last,
      nextDate: `${nextMonth}-01`,
      running: reminderRunning
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ═══════════════════════════════════════════════════════
//  MONTHLY REMINDERS
// ═══════════════════════════════════════════════════════

let reminderRunning = false;
let lastSentMonth = null; // in-memory guard so a failed log write can never cause a resend

async function runMonthlyReminders(trigger) {
  if (reminderRunning) return;
  const { month, day } = nowInTimezone();
  if (day > CATCH_UP_DAYS || lastSentMonth === month) return;
  if (whatsapp.getStatus().status !== 'connected') {
    console.log(`⏳ Reminders for ${month} waiting for WhatsApp to connect (${trigger})`);
    return;
  }

  reminderRunning = true;
  try {
    const last = await db.getLastReminderRun();
    if (last?.month === month) {
      lastSentMonth = month;
      return;
    }

    // Skip anyone already marked paid for this month (e.g. paid in advance)
    const [allStudents, payments] = await Promise.all([db.getAllStudents(), db.getPaymentsForMonth(month)]);
    const students = allStudents.filter(s => payments.get(s.id)?.status !== 'paid');
    if (students.length === 0) return;

    console.log(`\n🗓️  Sending ${month} reminders to ${students.length} unpaid students (${trigger})`);
    const results = await whatsapp.sendFeeReminders(students, month, INSTITUTION_NAME);
    lastSentMonth = month;
    await db.logReminderRun(month, results.sent, results.failed);
    console.log(`   📱 Sent: ${results.sent}, failed: ${results.failed}`);
  } catch (err) {
    console.error('   ❌ Monthly reminder error:', err.message);
  } finally {
    reminderRunning = false;
  }
}

// Every hour on days 1–3 of the month; runMonthlyReminders makes sure it only sends once
cron.schedule(`1 * 1-${CATCH_UP_DAYS} * *`, () => runMonthlyReminders('schedule'), { timezone: TIMEZONE });

// ─── Helpers ───────────────────────────────────────────
function nowInTimezone() {
  // 'en-CA' formats as YYYY-MM-DD
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
  return { month: date.slice(0, 7), day: Number(date.slice(8, 10)) };
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

  // Initialize WhatsApp; whenever it connects, send this month's reminders if they're still due
  console.log('📱 Initializing WhatsApp...');
  whatsapp.initWhatsApp(() => runMonthlyReminders('whatsapp connected'));
});

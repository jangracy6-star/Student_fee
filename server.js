/**
 * Student Fee Reminders — Express Server
 * Accounts (admins + paying customers), each customer's students, WhatsApp, settings
 * and scheduled reminders, plus the admin API for managing customers and access requests.
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
const plans = require('./plans');

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';
// Shown to customers whose plan is ending or has ended
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || 'dominova.office@gmail.com';

// If the server was asleep or WhatsApp was offline on a reminder day,
// that day's reminders still go out during the next couple of days.
const CATCH_UP_DAYS = 3;

// ─── Middleware ─────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════
//  PUBLIC — health, login, access requests
// ═══════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/session', auth.session);
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);

const requestLimits = new Map(); // ip -> { count, resetAt }

// Someone without an account asks for access; admins see it on the Admin page
app.post('/api/access-requests', async (req, res) => {
  try {
    const limit = requestLimits.get(req.ip);
    if (limit && limit.resetAt > Date.now() && limit.count >= 5) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    requestLimits.set(req.ip, limit && limit.resetAt > Date.now()
      ? { ...limit, count: limit.count + 1 }
      : { count: 1, resetAt: Date.now() + 60 * 60 * 1000 });

    const name = String(req.body?.name || '').trim();
    const email = auth.normalizeEmail(req.body?.email);
    const phone = String(req.body?.phone || '').replace(/[^\d+ ]/g, '').trim();
    const message = String(req.body?.message || '').trim();

    if (!name || name.length > 100) return res.status(400).json({ error: 'Enter your name' });
    if (!auth.isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (phone.length > 20) return res.status(400).json({ error: 'Phone number is too long' });
    if (message.length > 500) return res.status(400).json({ error: 'Message is too long (max 500 characters)' });

    if (await db.getUserForLogin(email)) {
      return res.status(409).json({ error: 'This email already has an account. Try logging in.' });
    }
    await db.upsertAccessRequest({ name, email, phone, message });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  ACCOUNT — any signed-in user
// ═══════════════════════════════════════════════════════

app.post('/api/account/password', auth.requireLogin, auth.changePassword);

// ═══════════════════════════════════════════════════════
//  ADMIN — manage customers and access requests
// ═══════════════════════════════════════════════════════

const admin = express.Router();
admin.use(auth.requireAdmin);

admin.get('/overview', async (req, res) => {
  try {
    const [customers, requests, counts, adminSettings] = await Promise.all([
      db.listUsers('customer'), db.listAccessRequests(), db.countStudentsByOwner(), settingsStore.getAdminSettings()
    ]);
    res.json({
      customers: customers.map(c => ({
        ...c,
        studentCount: counts.get(c.id) || 0,
        plan: plans.planStatus(c, adminSettings.alertDays)
      })),
      requests,
      settings: adminSettings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

admin.get('/settings', async (req, res) => {
  try {
    res.json(await settingsStore.getAdminSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

admin.put('/settings', async (req, res) => {
  try {
    const { settings, error } = await settingsStore.saveAdminSettings(req.body);
    if (error) return res.status(400).json({ error });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

admin.post('/customers', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = auth.normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!name || name.length > 100) return res.status(400).json({ error: 'Enter the customer’s name or institute' });
    if (!auth.isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const problem = auth.validatePassword(password);
    if (problem) return res.status(400).json({ error: problem });
    if (await db.getUserForLogin(email)) return res.status(409).json({ error: 'This email already has an account' });

    const adminSettings = await settingsStore.getAdminSettings();
    const { months, error: monthsError } = plans.parseMonths(req.body?.planMonths ?? adminSettings.defaultPlanMonths);
    if (monthsError) return res.status(400).json({ error: monthsError });
    const { limit, error: limitError } = plans.parseStudentLimit(
      req.body?.studentLimit === undefined ? adminSettings.defaultStudentLimit : req.body.studentLimit
    );
    if (limitError) return res.status(400).json({ error: limitError });

    const now = new Date();
    const customer = await db.createUser({
      email, name, role: 'customer',
      passwordHash: auth.hashPassword(password),
      planStartedAt: now.toISOString(),
      planExpiresAt: plans.addMonths(now, months).toISOString(),
      studentLimit: limit
    });
    await db.approveAccessRequestsFor(email);
    console.log(`👤 ${req.user.email} added customer ${email} (${months} month plan)`);
    res.status(201).json({ ...customer, studentCount: 0, plan: plans.planStatus(customer, adminSettings.alertDays) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename, reset password, or turn access on/off
admin.put('/customers/:id', async (req, res) => {
  try {
    const customer = await db.getUserById(req.params.id);
    if (!customer || customer.role !== 'customer') return res.status(404).json({ error: 'Customer not found' });

    const fields = {};
    let bumpSession = false;

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name || name.length > 100) return res.status(400).json({ error: 'Enter the customer’s name or institute' });
      fields.name = name;
    }
    if (req.body.password !== undefined) {
      const problem = auth.validatePassword(req.body.password);
      if (problem) return res.status(400).json({ error: problem });
      fields.passwordHash = auth.hashPassword(req.body.password);
      bumpSession = true; // sign the customer out of every device
    }
    if (req.body.active !== undefined) {
      if (typeof req.body.active !== 'boolean') return res.status(400).json({ error: '"active" must be true or false' });
      fields.active = req.body.active;
      if (!req.body.active) bumpSession = true;
    }
    if (req.body.studentLimit !== undefined) {
      const { limit, error } = plans.parseStudentLimit(req.body.studentLimit);
      if (error) return res.status(400).json({ error });
      fields.studentLimit = limit;
    }
    // Either add months (renewal) or set an exact end date
    if (req.body.extendMonths !== undefined) {
      const { months, error } = plans.parseMonths(req.body.extendMonths);
      if (error) return res.status(400).json({ error });
      if (!customer.plan_expires_at || new Date(customer.plan_expires_at) <= new Date()) fields.planStartedAt = new Date().toISOString();
      fields.planExpiresAt = plans.extendPlan(customer.plan_expires_at, months);
    } else if (req.body.planExpiresAt !== undefined) {
      if (req.body.planExpiresAt === null) {
        fields.planExpiresAt = null; // never ends
      } else {
        const { expiresAt, error } = plans.parseEndDate(req.body.planExpiresAt);
        if (error) return res.status(400).json({ error });
        fields.planExpiresAt = expiresAt;
      }
    }

    const updated = await db.updateUser(customer.id, fields, { bumpSession });
    auth.forgetUser(customer.id);
    if (fields.planExpiresAt !== undefined && fields.planExpiresAt !== customer.plan_expires_at) {
      await db.logActivity(customer.id, 'Plan Updated', fields.planExpiresAt ? `Plan ends ${fields.planExpiresAt.slice(0, 10)}` : 'Plan never ends');
    }
    const adminSettings = await settingsStore.getAdminSettings();
    res.json({ ...updated, plan: plans.planStatus(updated, adminSettings.alertDays) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permanently delete a customer and all of their students, payments and settings
admin.delete('/customers/:id', async (req, res) => {
  try {
    const customer = await db.getUserById(req.params.id);
    if (!customer || customer.role !== 'customer') return res.status(404).json({ error: 'Customer not found' });

    await whatsapp.logout(customer.id).catch(err => console.error('WhatsApp cleanup failed:', err.message));
    await settingsStore.deleteSettings(customer.id).catch(err => console.error('Settings cleanup failed:', err.message));
    await db.deleteUser(customer.id);
    auth.forgetUser(customer.id);
    console.log(`🗑️  ${req.user.email} deleted customer ${customer.email}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

admin.post('/requests/:id/dismiss', async (req, res) => {
  try {
    await db.setAccessRequestStatus(parseId(req.params.id), 'dismissed');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/admin', admin);

// ═══════════════════════════════════════════════════════
//  CUSTOMER — everything below is scoped to the signed-in customer
// ═══════════════════════════════════════════════════════

const api = express.Router();
api.use(auth.requireCustomer);

async function institutionNameFor(user) {
  const settings = await settingsStore.getSettings(user.id);
  return settings.institutionName || user.name || 'Your institute';
}

// Turns "student not found / not yours" into a 404 instead of a server error
function sendError(res, err) {
  const notFound = err.code === 'PGRST116';
  res.status(notFound ? 404 : 500).json({ error: notFound ? 'Student not found' : err.message });
}

api.get('/config', async (req, res) => {
  try {
    res.json({ institution: await institutionNameFor(req.user), currentMonth: nowInTimezone().month });
  } catch (err) {
    sendError(res, err);
  }
});

// The customer's plan: end date, days left, student limit and usage (works even after the plan ends)
api.get('/plan', async (req, res) => {
  try {
    const [adminSettings, studentCount] = await Promise.all([settingsStore.getAdminSettings(), db.countStudents(req.user.id)]);
    res.json({
      ...plans.planStatus(req.user, adminSettings.alertDays),
      alertDays: adminSettings.alertDays,
      studentCount,
      contact: SUPPORT_CONTACT
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Everything below needs an active plan
api.use((req, res, next) => {
  if (plans.isPlanActive(req.user)) return next();
  res.status(402).json({ code: 'plan_expired', error: `Your plan has ended. Contact ${SUPPORT_CONTACT} to renew.` });
});

// ─── Students ──────────────────────────────────────────

// Each student includes `paid` / `paid_date` for the current month
api.get('/students', async (req, res) => {
  try {
    const { month } = nowInTimezone();
    const [students, payments] = await Promise.all([db.getAllStudents(req.user.id), db.getPaymentsForMonth(req.user.id, month)]);
    res.json(students.map(s => {
      const payment = payments.get(s.id);
      return { ...s, paid: payment?.status === 'paid', paid_date: payment?.status === 'paid' ? payment.paid_date : null };
    }));
  } catch (err) {
    sendError(res, err);
  }
});

api.post('/students', async (req, res) => {
  try {
    const { student, error } = validateStudent(req.body);
    if (error) return res.status(400).json({ error });
    const limit = req.user.student_limit;
    if (limit !== null && limit !== undefined && (await db.countStudents(req.user.id)) >= limit) {
      return res.status(403).json({
        code: 'student_limit',
        error: `Your plan allows ${limit} student${limit === 1 ? '' : 's'}. Contact ${SUPPORT_CONTACT} to add more.`
      });
    }
    res.status(201).json(await db.createStudent(req.user.id, student));
  } catch (err) {
    sendError(res, err);
  }
});

api.put('/students/:id', async (req, res) => {
  try {
    const { student, error } = validateStudent(req.body);
    if (error) return res.status(400).json({ error });
    res.json(await db.updateStudent(req.user.id, parseId(req.params.id), student));
  } catch (err) {
    sendError(res, err);
  }
});

// Mark a student paid / not paid for the current month
api.put('/students/:id/payment', async (req, res) => {
  try {
    if (typeof req.body.paid !== 'boolean') return res.status(400).json({ error: '"paid" must be true or false' });
    const { month } = nowInTimezone();
    const record = await db.setPaymentStatus(req.user.id, parseId(req.params.id), month, req.body.paid);
    res.json({ month, paid: record.status === 'paid', paid_date: record.paid_date });
  } catch (err) {
    sendError(res, err);
  }
});

api.delete('/students/:id', async (req, res) => {
  try {
    await db.deleteStudent(req.user.id, parseId(req.params.id));
    res.json({ message: 'Student deleted successfully' });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── WhatsApp ──────────────────────────────────────────

api.get('/whatsapp/status', async (req, res) => {
  try {
    res.json(await whatsapp.getStatus(req.user.id));
  } catch (err) {
    sendError(res, err);
  }
});

// Polled while the "Connect WhatsApp" screen is open; starts WhatsApp to show a QR code if needed
api.get('/whatsapp/qr', async (req, res) => {
  try {
    // ?mode=code: only report status (the customer is on the "link with code" option); default shows a QR code
    res.json(await whatsapp.getQR(req.user.id, { start: req.query.mode !== 'code' }));
  } catch (err) {
    sendError(res, err);
  }
});

// Link with an 8-character code for this WhatsApp number (no QR scan needed)
api.post('/whatsapp/pair', async (req, res) => {
  try {
    const digits = String(req.body?.phone || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      return res.status(400).json({ error: 'Enter the WhatsApp number on this phone (10–15 digits)' });
    }
    res.json(await whatsapp.startPairing(req.user.id, digits));
  } catch (err) {
    sendError(res, err);
  }
});

api.post('/whatsapp/logout', async (req, res) => {
  try {
    await whatsapp.logout(req.user.id);
    await db.logActivity(req.user.id, 'WhatsApp Logged Out', 'Device unlinked from the dashboard');
    res.json({ message: 'WhatsApp logged out' });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Reminders ─────────────────────────────────────────

// When the last reminder went out and when the next scheduled one will
api.get('/reminders', async (req, res) => {
  try {
    const { month, day } = nowInTimezone();
    const settings = await settingsStore.getSettings(req.user.id);
    const [last, sentDays] = await Promise.all([db.getLastReminderRun(req.user.id), db.getScheduledDaysSent(req.user.id, month)]);
    res.json({
      lastRun: last,
      nextDate: settings.autoEnabled ? nextReminderDate(settings.reminderDays, month, day, sentDays) : null,
      autoEnabled: settings.autoEnabled,
      running: runningOwners.has(req.user.id)
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Send this month's reminder to every unpaid student right now (runs in the background)
api.post('/reminders/send-now', async (req, res) => {
  try {
    const ownerId = req.user.id;
    if (runningOwners.has(ownerId)) return res.status(409).json({ error: 'Reminders are already being sent' });
    const { status } = await whatsapp.getStatus(ownerId);
    if (!['connected', 'linked'].includes(status)) return res.status(400).json({ error: 'Connect WhatsApp first' });

    const { month } = nowInTimezone();
    const students = await getUnpaidStudents(ownerId, month);
    if (students.length === 0) return res.json({ count: 0, message: 'Everyone has paid this month' });

    sendReminders(req.user, students, month, 'send now', (results) => db.logManualReminderRun(ownerId, month, results.sent, results.failed));
    res.status(202).json({ count: students.length });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Settings ──────────────────────────────────────────

api.get('/settings', async (req, res) => {
  try {
    const settings = await settingsStore.getSettings(req.user.id);
    res.json({
      ...settings,
      defaultTemplate: settingsStore.DEFAULT_TEMPLATE,
      institution: await institutionNameFor(req.user),
      account: { email: req.user.email, name: req.user.name }
    });
  } catch (err) {
    sendError(res, err);
  }
});

api.put('/settings', async (req, res) => {
  try {
    const { settings, error } = await settingsStore.saveSettings(req.user.id, req.body);
    if (error) return res.status(400).json({ error });
    await db.logActivity(req.user.id, 'Settings Updated', `Reminder days: ${settings.reminderDays.join(', ') || 'none'} | Automatic: ${settings.autoEnabled ? 'on' : 'off'}`);
    res.json({ ...settings, institution: await institutionNameFor(req.user) });
  } catch (err) {
    sendError(res, err);
  }
});

app.use('/api', api);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ═══════════════════════════════════════════════════════
//  REMINDERS
// ═══════════════════════════════════════════════════════

const runningOwners = new Set();
const sentKeys = new Set(); // 'ownerId:YYYY-MM:day' — in-memory guard so a failed log write can never cause a resend

/** A customer's students not marked paid for `month` */
async function getUnpaidStudents(ownerId, month) {
  const [allStudents, payments] = await Promise.all([db.getAllStudents(ownerId), db.getPaymentsForMonth(ownerId, month)]);
  return allStudents.filter(s => payments.get(s.id)?.status !== 'paid');
}

/** Send the reminder to `students` from this customer's WhatsApp, then call `onDone(results)` */
async function sendReminders(user, students, month, trigger, onDone) {
  runningOwners.add(user.id);
  try {
    const settings = await settingsStore.getSettings(user.id);
    const institution = settings.institutionName || user.name || 'Your institute';
    console.log(`\n🗓️  ${user.email}: sending ${month} reminders to ${students.length} unpaid students (${trigger})`);
    const results = await whatsapp.sendFeeReminders(user.id, students, month, institution, settings.messageTemplate);
    await onDone(results);
    console.log(`   📱 Sent: ${results.sent}, failed: ${results.failed}`);
    return results;
  } catch (err) {
    console.error(`   ❌ Reminder error for ${user.email}:`, err.message);
  } finally {
    runningOwners.delete(user.id);
  }
}

/** Send a customer's scheduled reminders that are due today (or were missed in the last few days) */
async function runScheduledReminders(user, trigger) {
  if (runningOwners.has(user.id)) return;
  const settings = await settingsStore.getSettings(user.id);
  if (!settings.autoEnabled) return;

  const { month, day } = nowInTimezone();
  const key = (d) => `${user.id}:${month}:${d}`;
  const due = dueDays(settings.reminderDays, month, day).filter(d => !sentKeys.has(key(d)));
  if (due.length === 0) return;

  const { status } = await whatsapp.getStatus(user.id);
  if (!['connected', 'linked'].includes(status)) {
    console.log(`⏳ ${user.email}: reminders for ${month} (day ${due.join(', ')}) waiting for WhatsApp to be linked (${trigger})`);
    return;
  }

  try {
    const sentDays = await db.getScheduledDaysSent(user.id, month);
    due.filter(d => sentDays.has(d)).forEach(d => sentKeys.add(key(d)));
    const remaining = due.filter(d => !sentDays.has(d));
    if (remaining.length === 0) return;

    const students = await getUnpaidStudents(user.id, month);
    remaining.forEach(d => sentKeys.add(key(d)));
    if (students.length === 0) {
      await db.logReminderRun(user.id, month, remaining, 0, 0);
      return;
    }
    await sendReminders(user, students, month, trigger, (results) => db.logReminderRun(user.id, month, remaining, results.sent, results.failed));
  } catch (err) {
    console.error(`   ❌ Scheduled reminder error for ${user.email}:`, err.message);
  }
}

/** Check every active customer, one at a time (WhatsApp browsers are opened one by one) */
let scheduleRunning = false;
async function runAllScheduledReminders(trigger) {
  if (scheduleRunning) return;
  scheduleRunning = true;
  try {
    const customers = (await db.listUsers('customer')).filter(c => c.active && plans.isPlanActive(c));
    for (const customer of customers) await runScheduledReminders(customer, trigger);
  } catch (err) {
    console.error('❌ Reminder schedule error:', err.message);
  } finally {
    scheduleRunning = false;
  }
}

// Check every hour; each chosen day is only ever sent once per customer
cron.schedule('1 * * * *', () => runAllScheduledReminders('schedule'), { timezone: TIMEZONE });

// Once a week, open each linked WhatsApp briefly so WhatsApp keeps the linked device active
cron.schedule('30 4 * * 0', async () => {
  const customers = (await db.listUsers('customer').catch(() => [])).filter(c => c.active && plans.isPlanActive(c));
  for (const customer of customers) {
    await whatsapp.keepAlive(customer.id).catch(err => console.error(`Keep-alive failed for ${customer.email}:`, err.message));
  }
}, { timezone: TIMEZONE });

// When a customer links WhatsApp, send anything that was waiting for it
whatsapp.setOnLinked(async (ownerId) => {
  const user = await db.getUserById(ownerId).catch(() => null);
  if (user?.active && user.role === 'customer' && plans.isPlanActive(user)) runScheduledReminders(user, 'whatsapp linked');
});

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
app.listen(PORT, async () => {
  console.log(`\n🚀 Student Fee Reminders`);
  console.log(`   Server running at: http://localhost:${PORT}`);
  console.log(`   Timezone: ${TIMEZONE}`);
  console.log(`   Admins: ${auth.ADMIN_EMAILS.join(', ')}`);

  try {
    await auth.bootstrapAdmins();
  } catch (err) {
    console.error('\n❌ Could not set up accounts:', err.message);
    console.error('   Run migrations/002_accounts.sql in Supabase → SQL Editor, then restart.\n');
  }
  console.log('');
});

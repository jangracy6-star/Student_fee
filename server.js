/**
 * Student Fee Management System — Express Server
 * Main entry point with API routes, WhatsApp, and cron job
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const db = require('./database');
const whatsapp = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;
const INSTITUTION_NAME = process.env.INSTITUTION_NAME || 'Student Academy';

// ─── Middleware ─────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health Check ──────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', institution: INSTITUTION_NAME, timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════
//  STUDENT ROUTES
// ═══════════════════════════════════════════════════════

// GET all students
app.get('/api/students', async (req, res) => {
  try {
    const students = await db.getAllStudents();
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single student
app.get('/api/students/:id', async (req, res) => {
  try {
    const student = await db.getStudentById(parseInt(req.params.id));
    res.json(student);
  } catch (err) {
    res.status(404).json({ error: 'Student not found' });
  }
});

// POST create student
app.post('/api/students', async (req, res) => {
  try {
    const { name, phone, class_name, fee_amount } = req.body;
    if (!name || !phone || !class_name || fee_amount == null) {
      return res.status(400).json({ error: 'All fields are required: name, phone, class_name, fee_amount' });
    }
    const student = await db.createStudent({ name, phone, class_name, fee_amount });
    res.status(201).json(student);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update student
app.put('/api/students/:id', async (req, res) => {
  try {
    const { name, phone, class_name, fee_amount } = req.body;
    const student = await db.updateStudent(parseInt(req.params.id), { name, phone, class_name, fee_amount });
    res.json(student);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE student
app.delete('/api/students/:id', async (req, res) => {
  try {
    await db.deleteStudent(parseInt(req.params.id));
    res.json({ message: 'Student deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  FEE MANAGEMENT ROUTES
// ═══════════════════════════════════════════════════════

// GET fee records for a month
app.get('/api/fees', async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const records = await db.getFeeRecordsByMonth(month);
    const summary = await db.getFeeSummary(month);
    res.json({ month, records, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST generate fee records for a month
app.post('/api/fees/generate', async (req, res) => {
  try {
    const month = req.body.month || getCurrentMonth();
    const result = await db.generateFeeRecords(month);
    res.json({ message: `Fee records generated for ${month}`, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update fee status
app.put('/api/fees/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['paid', 'unpaid'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "paid" or "unpaid"' });
    }
    const record = await db.updateFeeStatus(parseInt(req.params.id), status);
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET fee summary for a month
app.get('/api/fees/summary', async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const summary = await db.getFeeSummary(month);
    res.json({ month, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  WHATSAPP ROUTES
// ═══════════════════════════════════════════════════════

// GET WhatsApp connection status
app.get('/api/whatsapp/status', (req, res) => {
  res.json(whatsapp.getStatus());
});

// GET WhatsApp QR code
app.get('/api/whatsapp/qr', (req, res) => {
  const qr = whatsapp.getQRCode();
  if (qr) {
    res.json({ qr });
  } else {
    const status = whatsapp.getStatus();
    if (status.status === 'connected') {
      res.json({ message: 'Already connected — no QR needed' });
    } else {
      res.json({ message: 'QR code not available yet. Please wait...' });
    }
  }
});

// POST send reminders to all unpaid students
app.post('/api/whatsapp/send-reminders', async (req, res) => {
  try {
    const month = req.body.month || getCurrentMonth();
    const unpaid = await db.getUnpaidStudents(month);

    if (unpaid.length === 0) {
      return res.json({ message: 'No unpaid students found for this month', sent: 0, failed: 0 });
    }

    const waStatus = whatsapp.getStatus();
    if (waStatus.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp is not connected. Please scan the QR code first.' });
    }

    const results = await whatsapp.sendFeeReminders(unpaid, INSTITUTION_NAME);
    await db.logActivity('Reminders Sent', `Month: ${month} | Sent: ${results.sent}, Failed: ${results.failed}`);
    res.json({ message: 'Reminders sent', ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  ACTIVITY LOG ROUTE
// ═══════════════════════════════════════════════════════

app.get('/api/activities', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const activities = await db.getRecentActivities(limit);
    res.json(activities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  CRON JOB — 1st of Every Month at 00:01 AM
// ═══════════════════════════════════════════════════════

cron.schedule('1 0 1 * *', async () => {
  console.log('\n🗓️  Monthly cron job triggered!');
  const month = getCurrentMonth();

  try {
    // 1. Generate fee records
    const result = await db.generateFeeRecords(month);
    console.log(`   📋 Fee records created: ${result.created}, skipped: ${result.skipped}`);

    // 2. Send WhatsApp reminders (if connected)
    const waStatus = whatsapp.getStatus();
    if (waStatus.status === 'connected') {
      const unpaid = await db.getUnpaidStudents(month);
      if (unpaid.length > 0) {
        const sendResult = await whatsapp.sendFeeReminders(unpaid, INSTITUTION_NAME);
        console.log(`   📱 Reminders sent: ${sendResult.sent}, failed: ${sendResult.failed}`);
        await db.logActivity('Auto Reminders (Cron)', `Month: ${month} | Sent: ${sendResult.sent}, Failed: ${sendResult.failed}`);
      }
    } else {
      console.log('   ⚠️  WhatsApp not connected — skipping auto reminders');
      await db.logActivity('Cron Job', `Fee records generated for ${month}. WhatsApp not connected — reminders skipped.`);
    }
  } catch (err) {
    console.error('   ❌ Cron job error:', err.message);
  }
});

// ─── Helper ────────────────────────────────────────────
function getCurrentMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// ─── Catch-all: Serve frontend ─────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Student Fee Management System`);
  console.log(`   Server running at: http://localhost:${PORT}`);
  console.log(`   Institution: ${INSTITUTION_NAME}\n`);

  // Initialize WhatsApp
  console.log('📱 Initializing WhatsApp...');
  whatsapp.initWhatsApp();
});

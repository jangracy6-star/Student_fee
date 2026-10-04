/**
 * WhatsApp Module — Client Setup & Message Sending
 * Uses whatsapp-web.js for free WhatsApp Web automation
 */
const path = require('path');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { supabase } = require('./database');
const { SupabaseSessionStore } = require('./session-store');

const RECONNECT_DELAY_MS = 10000;
const DATA_PATH = path.resolve('./.wwebjs_auth');
// The WhatsApp login is backed up to Supabase so a restart doesn't need a new QR scan
const sessionStore = new SupabaseSessionStore(supabase, DATA_PATH);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let client = null;
let qrCodeDataUrl = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'qr_ready' | 'connecting' | 'connected'
let statusMessage = 'WhatsApp not initialized';
let reconnectTimer = null;
let onReadyCallback = null;

/** @param {Function} [onReady] - called every time WhatsApp becomes connected */
function initWhatsApp(onReady) {
  if (onReady) onReadyCallback = onReady;
  clearTimeout(reconnectTimer);
  connectionStatus = 'connecting';
  statusMessage = 'Starting WhatsApp...';

  client = new Client({
    authStrategy: new RemoteAuth({
      store: sessionStore,
      dataPath: DATA_PATH,
      backupSyncIntervalMs: 5 * 60 * 1000
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    console.log('📱 WhatsApp QR Code received. Scan it with your phone.');
    connectionStatus = 'qr_ready';
    statusMessage = 'Scan QR code with your phone';
    try {
      qrCodeDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    } catch (err) {
      console.error('Error generating QR code:', err);
    }
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
    connectionStatus = 'connected';
    statusMessage = 'WhatsApp connected successfully';
    qrCodeDataUrl = null;
    onReadyCallback?.();
  });

  client.on('remote_session_saved', () => {
    console.log('💾 WhatsApp login saved to Supabase');
  });

  client.on('authenticated', () => {
    console.log('🔐 WhatsApp authenticated');
    connectionStatus = 'connecting';
    statusMessage = 'Authenticated, loading chats...';
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp authentication failed:', msg);
    connectionStatus = 'disconnected';
    statusMessage = 'Authentication failed. Retrying...';
    scheduleReconnect();
  });

  client.on('disconnected', (reason) => {
    console.log('📴 WhatsApp disconnected:', reason);
    connectionStatus = 'disconnected';
    statusMessage = `Disconnected: ${reason}. Reconnecting...`;
    qrCodeDataUrl = null;
    scheduleReconnect();
  });

  client.initialize().catch(err => {
    console.error('⚠️ WhatsApp initialization error:', err.message);
    connectionStatus = 'disconnected';
    statusMessage = 'Failed to initialize. Check if Chromium is available.';
  });

  return client;
}

// A disconnected whatsapp-web.js client cannot be reused — tear it down and start fresh
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    try {
      if (client) await client.destroy();
    } catch (err) {
      // Browser may already be gone
    }
    console.log('🔄 Re-initializing WhatsApp...');
    initWhatsApp();
  }, RECONNECT_DELAY_MS);
}

/** Unlink this device from WhatsApp; a fresh QR code will be generated */
async function logout() {
  if (!client) throw new Error('WhatsApp is not initialized');
  if (connectionStatus === 'connected') {
    await client.logout();
  }
  qrCodeDataUrl = null;
  connectionStatus = 'disconnected';
  statusMessage = 'Logged out. Generating new QR code...';
  scheduleReconnect();
}

function getStatus() {
  return {
    status: connectionStatus,
    message: statusMessage,
    hasQR: !!qrCodeDataUrl
  };
}

function getQRCode() {
  return qrCodeDataUrl;
}

/**
 * Normalize a phone number to digits with country code (e.g., "919876543210").
 * 10-digit numbers are assumed to be Indian and get the '91' prefix.
 */
function normalizePhone(phone) {
  let clean = String(phone || '').replace(/\D/g, '');
  if (clean.length === 11 && clean.startsWith('0')) clean = clean.slice(1);
  if (clean.length === 10) clean = '91' + clean;
  return clean;
}

function formatMonth(month) {
  const [year, monthNum] = String(month).split('-');
  return `${MONTH_NAMES[parseInt(monthNum) - 1] || monthNum} ${year}`;
}

function buildReminderMessage(student, month, institutionName) {
  return `🎓 *Fee Reminder — ${institutionName}*\n\n` +
    `Dear *${student.name}*,\n\n` +
    `This is a gentle reminder that your fee of *₹${Number(student.fee_amount).toLocaleString('en-IN')}* ` +
    `for the month of *${formatMonth(month)}* is due.\n\n` +
    `Please make the payment at your earliest convenience.\n\n` +
    `Thank you!\n— ${institutionName}`;
}

/**
 * Send a WhatsApp message to a phone number
 * @param {string} phone - Phone number with country code (e.g., "919876543210")
 * @param {string} message - Message text
 * @returns {object} - Result with success status
 */
async function sendMessage(phone, message) {
  if (!client || connectionStatus !== 'connected') {
    throw new Error('WhatsApp is not connected');
  }

  const cleanPhone = normalizePhone(phone);

  try {
    // Verify if the number is registered on WhatsApp
    const numberId = await client.getNumberId(cleanPhone);
    if (!numberId) {
      throw new Error(`Number ${cleanPhone} is not registered on WhatsApp`);
    }

    await client.sendMessage(numberId._serialized, message);
    return { success: true, phone: cleanPhone };
  } catch (err) {
    console.error(`Failed to send message to ${cleanPhone}:`, err.message);
    return { success: false, phone: cleanPhone, error: err.message };
  }
}

/**
 * Send the monthly fee reminder to every student
 * @param {Array} students - Student rows (name, phone, fee_amount)
 * @param {string} month - 'YYYY-MM'
 * @param {string} institutionName - Name of the institution
 * @returns {object} - Summary of sent/failed
 */
async function sendFeeReminders(students, month, institutionName) {
  const results = { sent: 0, failed: 0, errors: [] };

  for (const [i, student] of students.entries()) {
    if (!student.phone) {
      results.failed++;
      results.errors.push({ name: student.name, error: 'No phone number' });
      continue;
    }

    const message = buildReminderMessage(student, month, institutionName);

    try {
      const result = await sendMessage(student.phone, message);
      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({ name: student.name, error: result.error });
      }
    } catch (err) {
      results.failed++;
      results.errors.push({ name: student.name, error: err.message });
    }

    // Small delay between messages to avoid rate limiting
    if (i < students.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return results;
}

module.exports = {
  initWhatsApp,
  logout,
  getStatus,
  getQRCode,
  normalizePhone,
  buildReminderMessage,
  sendMessage,
  sendFeeReminders
};

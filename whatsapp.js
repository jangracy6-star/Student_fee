/**
 * WhatsApp Module — one linked WhatsApp per customer (whatsapp-web.js)
 *
 * Each customer's WhatsApp runs in its own headless Chromium, which is heavy, so browsers are
 * started on demand (to show a QR code or to send) and closed again when idle. At most
 * WHATSAPP_MAX_ACTIVE run at once (1 fits Render's free 512 MB plan); other work waits its turn.
 * Logins are saved to Supabase Storage, so a customer only scans the QR code once.
 */
const path = require('path');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { supabase } = require('./database');
const { SupabaseSessionStore } = require('./session-store');

const MAX_ACTIVE = Math.max(1, Number(process.env.WHATSAPP_MAX_ACTIVE) || 1);
const IDLE_CLOSE_MS = 3 * 60 * 1000;   // close a connected browser after this long unused
const QR_CLOSE_MS = 90 * 1000;         // close a QR browser this long after the QR screen stops being viewed
const READY_TIMEOUT_MS = 2 * 60 * 1000;
const WAIT_FOR_SLOT_MS = 15 * 60 * 1000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const DATA_PATH = path.resolve('./.wwebjs_auth');
const sessionStore = new SupabaseSessionStore(supabase, DATA_PATH);

const sessions = new Map();  // ownerId -> live session (see startSession)
const linked = new Map();    // ownerId -> true/false: has a saved WhatsApp login
let onLinkedCallback = null;

const sessionName = (ownerId) => `RemoteAuth-${ownerId}`;

/** @param {Function} onLinked - called with ownerId whenever a customer's WhatsApp becomes ready */
function setOnLinked(onLinked) {
  onLinkedCallback = onLinked;
}

async function isLinked(ownerId) {
  if (!linked.has(ownerId)) {
    try {
      linked.set(ownerId, await sessionStore.sessionExists({ session: sessionName(ownerId) }));
    } catch (err) {
      console.error('Could not check WhatsApp login:', err.message);
      return false;
    }
  }
  return linked.get(ownerId);
}

// ─── Live sessions ─────────────────────────────────────

function startSession(ownerId) {
  const session = {
    ownerId,
    client: null,
    status: 'starting',          // 'starting' | 'qr_ready' | 'connected' | 'error'
    message: 'Starting WhatsApp…',
    qr: null,
    busy: 0,                     // sends in progress
    qrViewedAt: Date.now(),
    closeTimer: null,
    readyWaiters: []
  };
  sessions.set(ownerId, session);

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: ownerId,
      store: sessionStore,
      dataPath: DATA_PATH,
      backupSyncIntervalMs: 5 * 60 * 1000
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      // Low-memory flags so Chromium fits in small hosts like Render's free 512 MB instance
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
        '--renderer-process-limit=1',
        '--disable-features=site-per-process,Translate,BackForwardCache,MediaRouter',
        '--js-flags=--max-old-space-size=256'
      ]
    }
  });
  session.client = client;

  const settle = (err) => {
    const waiters = session.readyWaiters;
    session.readyWaiters = [];
    waiters.forEach(w => (err ? w.reject(err) : w.resolve()));
  };

  client.on('qr', async (qr) => {
    session.status = 'qr_ready';
    session.message = 'Scan the QR code with your phone';
    // A QR code means there is no valid saved login
    linked.set(ownerId, false);
    settle(new Error('WhatsApp is not linked. Open Settings → WhatsApp and scan the QR code.'));
    try {
      session.qr = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    } catch (err) {
      console.error('Error generating QR code:', err.message);
    }
    scheduleClose(session);
  });

  client.on('authenticated', () => {
    session.status = 'starting';
    session.message = 'Linked — loading chats…';
    session.qr = null;
  });

  client.on('ready', () => {
    const wasLinked = linked.get(ownerId);
    session.status = 'connected';
    session.message = 'Connected';
    session.qr = null;
    linked.set(ownerId, true);
    console.log(`✅ WhatsApp ready for ${ownerId}`);
    settle();
    scheduleClose(session);
    if (!wasLinked) onLinkedCallback?.(ownerId);
  });

  client.on('remote_session_saved', () => {
    console.log(`💾 WhatsApp login saved for ${ownerId}`);
  });

  client.on('auth_failure', (msg) => {
    console.error(`❌ WhatsApp authentication failed for ${ownerId}:`, msg);
    linked.set(ownerId, false);
    settle(new Error('WhatsApp login expired. Scan the QR code again.'));
    stopSession(ownerId);
  });

  client.on('disconnected', (reason) => {
    console.log(`📴 WhatsApp disconnected for ${ownerId}:`, reason);
    if (String(reason).toUpperCase().includes('LOGOUT')) linked.set(ownerId, false);
    settle(new Error(`WhatsApp disconnected (${reason})`));
    stopSession(ownerId);
  });

  client.initialize().catch(err => {
    console.error(`⚠️ WhatsApp failed to start for ${ownerId}:`, err.message);
    session.status = 'error';
    session.message = 'WhatsApp could not start. Try again in a minute.';
    settle(new Error(session.message));
    stopSession(ownerId);
  });

  return session;
}

/** Close the browser once nobody needs it (frees memory for the next customer) */
function scheduleClose(session) {
  clearTimeout(session.closeTimer);
  if (session.busy > 0) return;
  const delay = session.status === 'qr_ready' || session.status === 'starting' ? QR_CLOSE_MS : IDLE_CLOSE_MS;
  session.closeTimer = setTimeout(() => {
    if (session.busy === 0 && sessions.get(session.ownerId) === session) stopSession(session.ownerId);
  }, delay);
}

async function stopSession(ownerId) {
  const session = sessions.get(ownerId);
  if (!session) return;
  sessions.delete(ownerId);
  clearTimeout(session.closeTimer);
  try {
    await session.client.destroy();
  } catch (err) {
    // Browser may already be gone
  }
}

/** Make room for one more browser by closing an idle one; false if every slot is busy */
async function freeSlot() {
  if (sessions.size < MAX_ACTIVE) return true;
  const idle = [...sessions.values()]
    .filter(s => s.busy === 0 && !(s.status === 'qr_ready' && Date.now() - s.qrViewedAt < QR_CLOSE_MS))
    .sort((a, b) => a.qrViewedAt - b.qrViewedAt)[0];
  if (!idle) return false;
  await stopSession(idle.ownerId);
  return true;
}

function waitForReady(session) {
  if (session.status === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WhatsApp took too long to connect')), READY_TIMEOUT_MS);
    session.readyWaiters.push({
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });
  });
}

/** Run `fn(client)` with this customer's WhatsApp connected, waiting for a free slot if needed */
async function withClient(ownerId, fn) {
  if (!(await isLinked(ownerId))) {
    throw new Error('WhatsApp is not linked. Open Settings → WhatsApp and scan the QR code.');
  }

  const deadline = Date.now() + WAIT_FOR_SLOT_MS;
  let session = sessions.get(ownerId);
  while (!session) {
    if (await freeSlot()) {
      session = startSession(ownerId);
      break;
    }
    if (Date.now() > deadline) throw new Error('WhatsApp is busy with other accounts. Try again later.');
    await new Promise(r => setTimeout(r, 5000));
    session = sessions.get(ownerId);
  }

  session.busy++;
  clearTimeout(session.closeTimer);
  try {
    await waitForReady(session);
    return await fn(session.client);
  } finally {
    session.busy--;
    scheduleClose(session);
  }
}

// ─── Public API ────────────────────────────────────────

/** Status for one customer: 'connected' | 'linked' | 'starting' | 'qr_ready' | 'not_linked' | 'error' */
async function getStatus(ownerId) {
  const session = sessions.get(ownerId);
  if (session) return { status: session.status, message: session.message, hasQR: !!session.qr };
  return (await isLinked(ownerId))
    ? { status: 'linked', message: 'Linked — opens automatically when sending', hasQR: false }
    : { status: 'not_linked', message: 'Not linked', hasQR: false };
}

/**
 * Called while the customer is looking at the "Connect WhatsApp" screen.
 * Starts a browser to produce a QR code if the customer isn't linked yet.
 */
async function getQR(ownerId) {
  let session = sessions.get(ownerId);
  if (session) {
    session.qrViewedAt = Date.now();
    if (session.status !== 'connected') scheduleClose(session);
    return { status: session.status, message: session.message, qr: session.qr };
  }

  if (await isLinked(ownerId)) return { status: 'linked', message: 'WhatsApp is linked' };

  if (!(await freeSlot())) {
    return { status: 'busy', message: 'WhatsApp is busy sending for another account. This screen will retry automatically.' };
  }
  session = startSession(ownerId);
  return { status: session.status, message: session.message, qr: null };
}

/** Unlink this customer's WhatsApp (they'll need to scan a new QR code) */
async function logout(ownerId) {
  const session = sessions.get(ownerId);
  if (session?.status === 'connected') {
    try {
      await session.client.logout(); // also deletes the saved login
    } catch (err) {
      console.error('WhatsApp logout error:', err.message);
    }
  }
  await stopSession(ownerId);
  try {
    if (await sessionStore.sessionExists({ session: sessionName(ownerId) })) {
      await sessionStore.delete({ session: sessionName(ownerId) });
    }
  } catch (err) {
    console.error('Could not delete saved WhatsApp login:', err.message);
  }
  linked.set(ownerId, false);
}

/** Open and close a customer's WhatsApp so the linked device stays active (run weekly) */
async function keepAlive(ownerId) {
  if (!(await isLinked(ownerId))) return;
  await withClient(ownerId, async () => {});
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

/**
 * Fill a message template for one student.
 * Placeholders: {name}, {fee}, {month}, {institution}
 */
function buildReminderMessage(student, month, institutionName, template) {
  const values = {
    name: student.name,
    fee: `₹${Number(student.fee_amount).toLocaleString('en-IN')}`,
    month: formatMonth(month),
    institution: institutionName
  };
  return template.replace(/\{(name|fee|month|institution)\}/gi, (_, key) => values[key.toLowerCase()]);
}

async function sendMessage(client, phone, message) {
  const cleanPhone = normalizePhone(phone);
  try {
    // Verify if the number is registered on WhatsApp
    const numberId = await client.getNumberId(cleanPhone);
    if (!numberId) throw new Error(`Number ${cleanPhone} is not registered on WhatsApp`);
    await client.sendMessage(numberId._serialized, message);
    return { success: true, phone: cleanPhone };
  } catch (err) {
    console.error(`Failed to send message to ${cleanPhone}:`, err.message);
    return { success: false, phone: cleanPhone, error: err.message };
  }
}

/**
 * Send the fee reminder to each student from this customer's WhatsApp
 * @param {string} ownerId - Customer account id
 * @param {Array} students - Student rows (name, phone, fee_amount)
 * @param {string} month - 'YYYY-MM'
 * @param {string} institutionName - Shown for {institution}
 * @param {string} template - Message template (see buildReminderMessage)
 * @returns {object} - Summary of sent/failed
 */
async function sendFeeReminders(ownerId, students, month, institutionName, template) {
  return withClient(ownerId, async (client) => {
    const results = { sent: 0, failed: 0, errors: [] };

    for (const [i, student] of students.entries()) {
      if (!student.phone) {
        results.failed++;
        results.errors.push({ name: student.name, error: 'No phone number' });
        continue;
      }

      const result = await sendMessage(client, student.phone, buildReminderMessage(student, month, institutionName, template));
      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({ name: student.name, error: result.error });
      }

      // Small delay between messages to avoid rate limiting
      if (i < students.length - 1) await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return results;
  });
}

module.exports = {
  setOnLinked,
  getStatus,
  getQR,
  logout,
  keepAlive,
  normalizePhone,
  buildReminderMessage,
  sendFeeReminders
};

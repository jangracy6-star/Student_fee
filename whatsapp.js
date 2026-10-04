/**
 * WhatsApp Module — Client Setup & Message Sending
 * Uses whatsapp-web.js for free WhatsApp Web automation
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

let client = null;
let qrCodeDataUrl = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'qr_ready' | 'connecting' | 'connected'
let statusMessage = 'WhatsApp not initialized';

function initWhatsApp() {
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
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
  });

  client.on('authenticated', () => {
    console.log('🔐 WhatsApp authenticated');
    connectionStatus = 'connecting';
    statusMessage = 'Authenticated, loading chats...';
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp authentication failed:', msg);
    connectionStatus = 'disconnected';
    statusMessage = 'Authentication failed. Please restart.';
  });

  client.on('disconnected', (reason) => {
    console.log('📴 WhatsApp disconnected:', reason);
    connectionStatus = 'disconnected';
    statusMessage = `Disconnected: ${reason}`;
    qrCodeDataUrl = null;
  });

  client.initialize().catch(err => {
    console.error('⚠️ WhatsApp initialization error:', err.message);
    connectionStatus = 'disconnected';
    statusMessage = 'Failed to initialize. Check if Chromium is available.';
  });

  return client;
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
 * Send a WhatsApp message to a phone number
 * @param {string} phone - Phone number with country code (e.g., "919876543210")
 * @param {string} message - Message text
 * @returns {object} - Result with success status
 */
async function sendMessage(phone, message) {
  if (!client || connectionStatus !== 'connected') {
    throw new Error('WhatsApp is not connected');
  }

  // Format phone number — remove + and spaces, ensure it ends with @c.us
  let cleanPhone = phone.replace(/[\s\-\+\(\)]/g, '');
  
  // If the number is exactly 10 digits (common in India), prepend the country code '91'
  if (cleanPhone.length === 10) {
    cleanPhone = '91' + cleanPhone;
  }

  let chatId = `${cleanPhone}@c.us`;

  try {
    // Verify if the number is registered on WhatsApp
    const numberId = await client.getNumberId(cleanPhone);
    if (!numberId) {
      throw new Error(`Number ${cleanPhone} is not registered on WhatsApp`);
    }
    chatId = numberId._serialized;

    await client.sendMessage(chatId, message);
    return { success: true, phone: cleanPhone };
  } catch (err) {
    console.error(`Failed to send message to ${cleanPhone}:`, err.message);
    return { success: false, phone: cleanPhone, error: err.message };
  }
}

/**
 * Send fee reminders to a list of unpaid students
 * @param {Array} unpaidRecords - Array of fee records with student details
 * @param {string} institutionName - Name of the institution
 * @returns {object} - Summary of sent/failed
 */
async function sendFeeReminders(unpaidRecords, institutionName) {
  const results = { sent: 0, failed: 0, errors: [] };

  for (const record of unpaidRecords) {
    const student = record.students;
    if (!student || !student.phone) {
      results.failed++;
      results.errors.push({ name: 'Unknown', error: 'No phone number' });
      continue;
    }

    // Format month for display
    const [year, monthNum] = record.month.split('-');
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const monthName = monthNames[parseInt(monthNum) - 1] || monthNum;

    const message = `🎓 *Fee Reminder — ${institutionName}*\n\n` +
      `Dear *${student.name}*,\n\n` +
      `This is a gentle reminder that your fee of *₹${Number(student.fee_amount).toLocaleString('en-IN')}* ` +
      `for the month of *${monthName} ${year}* is pending.\n\n` +
      `Please make the payment at your earliest convenience.\n\n` +
      `Thank you!\n— ${institutionName}`;

    try {
      const result = await sendMessage(student.phone, message);
      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({ name: student.name, error: result.error });
      }

      // Small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      results.failed++;
      results.errors.push({ name: student.name, error: err.message });
    }
  }

  return results;
}

module.exports = {
  initWhatsApp,
  getStatus,
  getQRCode,
  sendMessage,
  sendFeeReminders
};

/**
 * Settings Module — reminder schedule and message template
 * Stored as a JSON file in Supabase Storage so no database migration is needed.
 */
const { supabase } = require('./database');

const BUCKET = 'app-settings';
const FILE = 'settings.json';

const DEFAULT_TEMPLATE =
  '🎓 *Fee Reminder — {institution}*\n\n' +
  'Dear *{name}*,\n\n' +
  'This is a gentle reminder that your fee of *{fee}* for the month of *{month}* is due.\n\n' +
  'Please make the payment at your earliest convenience.\n\n' +
  'Thank you!\n— {institution}';

const DEFAULTS = {
  autoEnabled: true,
  reminderDays: [1],
  messageTemplate: DEFAULT_TEMPLATE
};

let cache = null;
let bucketReady = null;

function ensureBucket() {
  if (!bucketReady) {
    bucketReady = supabase.storage.createBucket(BUCKET, { public: false })
      .then(({ error }) => {
        if (error && !/already exists/i.test(error.message)) throw error;
      })
      .catch(err => {
        bucketReady = null;
        throw err;
      });
  }
  return bucketReady;
}

/** Current settings (cached after the first read) */
async function getSettings() {
  if (cache) return cache;
  try {
    await ensureBucket();
    const { data, error } = await supabase.storage.from(BUCKET).download(FILE);
    if (error) throw error;
    cache = { ...DEFAULTS, ...JSON.parse(await data.text()) };
  } catch (err) {
    // First run (no file yet) or storage unavailable — fall back to defaults
    if (!/not found|does not exist|404/i.test(err.message || '')) {
      console.error('⚠️  Could not read settings, using defaults:', err.message);
    }
    cache = { ...DEFAULTS };
  }
  return cache;
}

/** Validate and save; returns { settings } or { error } */
async function saveSettings(input = {}) {
  const next = { ...(await getSettings()) };

  if (input.autoEnabled !== undefined) {
    if (typeof input.autoEnabled !== 'boolean') return { error: '"autoEnabled" must be true or false' };
    next.autoEnabled = input.autoEnabled;
  }

  if (input.reminderDays !== undefined) {
    if (!Array.isArray(input.reminderDays)) return { error: '"reminderDays" must be a list of days' };
    const days = [...new Set(input.reminderDays.map(Number))].sort((a, b) => a - b);
    if (days.some(d => !Number.isInteger(d) || d < 1 || d > 31)) return { error: 'Days must be between 1 and 31' };
    next.reminderDays = days;
  }
  if (next.autoEnabled && next.reminderDays.length === 0) return { error: 'Pick at least one day' };

  if (input.messageTemplate !== undefined) {
    const template = String(input.messageTemplate).replace(/\r\n/g, '\n').trim();
    if (!template) return { error: 'The message cannot be empty' };
    if (template.length > 1500) return { error: 'The message is too long (max 1500 characters)' };
    next.messageTemplate = template;
  }

  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET)
    .upload(FILE, JSON.stringify(next, null, 2), { upsert: true, contentType: 'application/json' });
  if (error) throw error;

  cache = next;
  return { settings: next };
}

module.exports = { DEFAULT_TEMPLATE, getSettings, saveSettings };

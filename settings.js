/**
 * Settings Module — each customer's reminder schedule and message template
 * Stored as one JSON file per customer in Supabase Storage (customers/<id>.json).
 */
const { supabase } = require('./database');

const BUCKET = 'app-settings';
const fileFor = (ownerId) => `customers/${ownerId}.json`;

const DEFAULT_TEMPLATE =
  '🎓 *Fee Reminder — {institution}*\n\n' +
  'Dear *{name}*,\n\n' +
  'This is a gentle reminder that your fee of *{fee}* for the month of *{month}* is due.\n\n' +
  'Please make the payment at your earliest convenience.\n\n' +
  'Thank you!\n— {institution}';

const DEFAULTS = {
  institutionName: '',   // empty = use the account name
  autoEnabled: true,
  reminderDays: [1],
  messageTemplate: DEFAULT_TEMPLATE
};

const cache = new Map(); // ownerId -> settings
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

/** A customer's settings (cached after the first read) */
async function getSettings(ownerId) {
  if (cache.has(ownerId)) return cache.get(ownerId);
  let settings;
  try {
    await ensureBucket();
    const { data, error } = await supabase.storage.from(BUCKET).download(fileFor(ownerId));
    if (error) throw error;
    settings = { ...DEFAULTS, ...JSON.parse(await data.text()) };
  } catch (err) {
    // New customer (no file yet) or storage unavailable — fall back to defaults
    if (!/not found|does not exist|404/i.test(err.message || '')) {
      console.error('⚠️  Could not read settings, using defaults:', err.message);
    }
    settings = { ...DEFAULTS };
  }
  cache.set(ownerId, settings);
  return settings;
}

/** Validate and save; returns { settings } or { error } */
async function saveSettings(ownerId, input = {}) {
  const next = { ...(await getSettings(ownerId)) };

  if (input.institutionName !== undefined) {
    const name = String(input.institutionName).trim();
    if (name.length > 100) return { error: 'Institute name is too long' };
    next.institutionName = name;
  }

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
    .upload(fileFor(ownerId), JSON.stringify(next, null, 2), { upsert: true, contentType: 'application/json' });
  if (error) throw error;

  cache.set(ownerId, next);
  return { settings: next };
}

/** Remove a customer's settings file (when their account is deleted) */
async function deleteSettings(ownerId) {
  cache.delete(ownerId);
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).remove([fileFor(ownerId)]);
  if (error) throw error;
}

module.exports = { DEFAULT_TEMPLATE, getSettings, saveSettings, deleteSettings };

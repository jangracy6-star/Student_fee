/**
 * Plans Module — monthly subscriptions and student limits
 * A customer's plan ends at app_users.plan_expires_at (NULL = never). After that they can sign in
 * but only see a "plan ended" screen, and their automatic reminders stop. Admins extend plans.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** `date` plus `months` calendar months (31 Jan + 1 month → 28/29 Feb) */
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** New end date when an admin adds `months`: from the current end if still running, otherwise from now */
function extendPlan(currentExpiresAt, months) {
  const now = new Date();
  const base = currentExpiresAt && new Date(currentExpiresAt) > now ? new Date(currentExpiresAt) : now;
  return addMonths(base, months).toISOString();
}

/**
 * Plan state for a customer
 * @returns {{ expiresAt: string|null, daysLeft: number|null, expired: boolean, endingSoon: boolean,
 *             studentLimit: number|null }}
 */
function planStatus(user, alertDays) {
  const expiresAt = user.plan_expires_at || null;
  if (!expiresAt) return { expiresAt: null, daysLeft: null, expired: false, endingSoon: false, studentLimit: user.student_limit ?? null };

  const msLeft = new Date(expiresAt).getTime() - Date.now();
  const expired = msLeft <= 0;
  const daysLeft = expired ? 0 : Math.ceil(msLeft / DAY_MS);
  return {
    expiresAt,
    daysLeft,
    expired,
    endingSoon: !expired && daysLeft <= alertDays,
    studentLimit: user.student_limit ?? null
  };
}

function isPlanActive(user) {
  return !user.plan_expires_at || new Date(user.plan_expires_at).getTime() > Date.now();
}

/** Validate an admin-entered student limit: '' / null → unlimited, otherwise a whole number 0–100000 */
function parseStudentLimit(value) {
  if (value === null || value === undefined || value === '') return { limit: null };
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0 || limit > 100000) return { error: 'Student limit must be a whole number (or empty for unlimited)' };
  return { limit };
}

/** Validate an admin-entered number of months to add (1–36) */
function parseMonths(value) {
  const months = Number(value);
  if (!Number.isInteger(months) || months < 1 || months > 36) return { error: 'Plan length must be 1–36 months' };
  return { months };
}

/** Validate an exact end date: 'YYYY-MM-DD' means the end of that day in India time, or a full ISO timestamp */
function parseEndDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 18, 29, 59)) // 23:59:59 IST
    : new Date(value);
  if (Number.isNaN(date.getTime())) return { error: 'Enter a valid end date' };
  return { expiresAt: date.toISOString() };
}

module.exports = { addMonths, extendPlan, planStatus, isPlanActive, parseStudentLimit, parseMonths, parseEndDate };

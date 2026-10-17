/**
 * Database Module — Supabase Client & Helper Functions
 * Every student, payment and activity entry belongs to one customer (owner_id).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\n❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  console.error('   Copy .env.example to .env and fill in your Supabase project details.\n');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REMINDER_ACTION = 'Monthly Reminders';
const MANUAL_REMINDER_ACTION = 'Manual Reminders';
const USER_FIELDS = 'id, email, name, role, active, session_version, created_at, last_login_at';

// ─── Accounts ──────────────────────────────────────────

/** Account by email, including the password hash (for login only) */
async function getUserForLogin(email) {
  const { data, error } = await supabase
    .from('app_users')
    .select(`${USER_FIELDS}, password_hash`)
    .eq('email', email)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getUserById(id) {
  const { data, error } = await supabase.from('app_users').select(USER_FIELDS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getPasswordHash(id) {
  const { data, error } = await supabase.from('app_users').select('password_hash').eq('id', id).single();
  if (error) throw error;
  return data.password_hash;
}

async function listUsers(role) {
  const { data, error } = await supabase
    .from('app_users')
    .select(USER_FIELDS)
    .eq('role', role)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function createUser({ email, name, role, passwordHash }) {
  const { data, error } = await supabase
    .from('app_users')
    .insert({ email, name, role, password_hash: passwordHash })
    .select(USER_FIELDS)
    .single();
  if (error) throw error;
  return data;
}

/** Update an account; `bumpSession` signs it out everywhere else */
async function updateUser(id, fields, { bumpSession = false } = {}) {
  const changes = {};
  if (fields.name !== undefined) changes.name = fields.name;
  if (fields.active !== undefined) changes.active = fields.active;
  if (fields.passwordHash !== undefined) changes.password_hash = fields.passwordHash;
  if (fields.lastLoginAt !== undefined) changes.last_login_at = fields.lastLoginAt;

  if (bumpSession) {
    const current = await getUserById(id);
    if (!current) throw new Error('Account not found');
    changes.session_version = current.session_version + 1;
  }

  const { data, error } = await supabase.from('app_users').update(changes).eq('id', id).select(USER_FIELDS).single();
  if (error) throw error;
  return data;
}

async function deleteUser(id) {
  const { error } = await supabase.from('app_users').delete().eq('id', id);
  if (error) throw error;
}

/** Admin accounts listed in ADMIN_EMAILS that don't exist yet are created */
async function ensureAdmins(emails, passwordHash) {
  for (const email of emails) {
    const existing = await getUserForLogin(email);
    if (!existing) {
      await createUser({ email, name: 'Admin', role: 'admin', passwordHash });
    } else if (existing.role === 'admin' && !existing.password_hash && passwordHash) {
      await updateUser(existing.id, { passwordHash });
    }
  }
}

/** Number of students per customer id */
async function countStudentsByOwner() {
  const { data, error } = await supabase.from('students').select('owner_id');
  if (error) throw error;
  const counts = new Map();
  for (const row of data) counts.set(row.owner_id, (counts.get(row.owner_id) || 0) + 1);
  return counts;
}

// ─── Access Requests ───────────────────────────────────

/** Create a request, or refresh the details of an existing pending one for the same email */
async function upsertAccessRequest({ name, email, phone, message }) {
  const { data: existing, error: findErr } = await supabase
    .from('access_requests')
    .select('id')
    .eq('email', email)
    .eq('status', 'pending')
    .maybeSingle();
  if (findErr) throw findErr;

  const row = { name, email, phone: phone || null, message: message || null };
  const query = existing
    ? supabase.from('access_requests').update({ ...row, created_at: new Date().toISOString() }).eq('id', existing.id)
    : supabase.from('access_requests').insert(row);
  const { error } = await query;
  if (error) throw error;
}

async function listAccessRequests() {
  const { data, error } = await supabase
    .from('access_requests')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function setAccessRequestStatus(id, status) {
  const { error } = await supabase.from('access_requests').update({ status }).eq('id', id);
  if (error) throw error;
}

/** Mark any pending request from this email as approved (after an admin adds the account) */
async function approveAccessRequestsFor(email) {
  const { error } = await supabase.from('access_requests').update({ status: 'approved' }).eq('email', email).eq('status', 'pending');
  if (error) throw error;
}

// ─── Students (always scoped to one customer) ──────────

async function getAllStudents(ownerId) {
  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function getStudentById(ownerId, id) {
  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function createStudent(ownerId, student) {
  const { data, error } = await supabase
    .from('students')
    .insert({
      owner_id: ownerId,
      name: student.name,
      phone: student.phone,
      class_name: student.class_name,
      fee_amount: student.fee_amount
    })
    .select()
    .single();
  if (error) throw error;

  await logActivity(ownerId, 'Student Added', `Added student: ${student.name}`);
  return data;
}

async function updateStudent(ownerId, id, updates) {
  const { data, error } = await supabase
    .from('students')
    .update({
      name: updates.name,
      phone: updates.phone,
      class_name: updates.class_name,
      fee_amount: updates.fee_amount
    })
    .eq('owner_id', ownerId)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  await logActivity(ownerId, 'Student Updated', `Updated student: ${updates.name}`);
  return data;
}

async function deleteStudent(ownerId, id) {
  // Also proves the student belongs to this customer
  const student = await getStudentById(ownerId, id);

  const { error } = await supabase
    .from('students')
    .delete()
    .eq('owner_id', ownerId)
    .eq('id', id);
  if (error) throw error;

  await logActivity(ownerId, 'Student Deleted', `Deleted student: ${student.name}`);
  return { success: true };
}

// ─── Payments ──────────────────────────────────────────
// A fee_records row per student per month ('YYYY-MM') with status 'paid' or 'unpaid'.
// No row means not paid yet.

/** Map of student_id → fee record for the customer's students in `month` */
async function getPaymentsForMonth(ownerId, month) {
  const { data, error } = await supabase
    .from('fee_records')
    .select('student_id, status, paid_date, students!inner (owner_id)')
    .eq('month', month)
    .eq('students.owner_id', ownerId);
  if (error) throw error;
  return new Map(data.map(r => [r.student_id, r]));
}

async function setPaymentStatus(ownerId, studentId, month, paid) {
  const student = await getStudentById(ownerId, studentId); // throws if not this customer's student

  const { data, error } = await supabase
    .from('fee_records')
    .upsert({
      student_id: studentId,
      month,
      status: paid ? 'paid' : 'unpaid',
      paid_date: paid ? new Date().toISOString() : null
    }, { onConflict: 'student_id,month' })
    .select('student_id, status, paid_date')
    .single();
  if (error) throw error;

  await logActivity(ownerId, 'Fee Status Updated', `${student.name} → ${paid ? '✅ paid' : '❌ not paid'} (${month})`);
  return data;
}

// ─── Reminder Log ──────────────────────────────────────
// Every reminder run is recorded in activity_log:
//   "Monthly Reminders"  details "Month: YYYY-MM | Day: 1,10 | Sent: n, Failed: n"  (scheduled)
//   "Manual Reminders"   details "Month: YYYY-MM | Sent: n, Failed: n"             (Send now)
// Older scheduled entries have no "Day:" part and count as day 1.

function parseReminderRun(row) {
  const details = row.details || '';
  const month = /Month: (\d{4}-\d{2})/.exec(details)?.[1] || null;
  const dayList = /Day: ([\d,]+)/.exec(details)?.[1];
  const counts = /Sent: (\d+), Failed: (\d+)/.exec(details);
  const manual = row.action === MANUAL_REMINDER_ACTION;
  return {
    month,
    days: manual ? [] : (dayList ? dayList.split(',').map(Number) : [1]),
    manual,
    sent: Number(counts?.[1] || 0),
    failed: Number(counts?.[2] || 0),
    at: row.created_at
  };
}

/** Most recent reminder run, scheduled or manual */
async function getLastReminderRun(ownerId) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('action, details, created_at')
    .eq('owner_id', ownerId)
    .in('action', [REMINDER_ACTION, MANUAL_REMINDER_ACTION])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? parseReminderRun(data) : null;
}

/** Days of `month` whose scheduled reminder has already been sent */
async function getScheduledDaysSent(ownerId, month) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('action, details, created_at')
    .eq('owner_id', ownerId)
    .eq('action', REMINDER_ACTION)
    .like('details', `Month: ${month} |%`);
  if (error) throw error;
  return new Set(data.flatMap(row => parseReminderRun(row).days));
}

async function logReminderRun(ownerId, month, days, sent, failed) {
  await logActivity(ownerId, REMINDER_ACTION, `Month: ${month} | Day: ${days.join(',')} | Sent: ${sent}, Failed: ${failed}`);
}

async function logManualReminderRun(ownerId, month, sent, failed) {
  await logActivity(ownerId, MANUAL_REMINDER_ACTION, `Month: ${month} | Sent: ${sent}, Failed: ${failed}`);
}

// ─── Activity Log ──────────────────────────────────────

async function logActivity(ownerId, action, details) {
  const { error } = await supabase.from('activity_log').insert({ owner_id: ownerId, action, details });
  if (error) console.error('Failed to log activity:', error.message);
}

module.exports = {
  supabase,
  getUserForLogin,
  getUserById,
  getPasswordHash,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  ensureAdmins,
  countStudentsByOwner,
  upsertAccessRequest,
  listAccessRequests,
  setAccessRequestStatus,
  approveAccessRequestsFor,
  getAllStudents,
  getStudentById,
  createStudent,
  updateStudent,
  deleteStudent,
  getPaymentsForMonth,
  setPaymentStatus,
  getLastReminderRun,
  getScheduledDaysSent,
  logReminderRun,
  logManualReminderRun,
  logActivity
};

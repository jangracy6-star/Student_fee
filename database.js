/**
 * Database Module — Supabase Client & Helper Functions
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

// ─── Student Operations ────────────────────────────────

async function getAllStudents() {
  const { data, error } = await supabase
    .from('students')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function getStudentById(id) {
  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function createStudent(student) {
  const { data, error } = await supabase
    .from('students')
    .insert({
      name: student.name,
      phone: student.phone,
      class_name: student.class_name,
      fee_amount: student.fee_amount
    })
    .select()
    .single();
  if (error) throw error;

  await logActivity('Student Added', `Added student: ${student.name}`);
  return data;
}

async function updateStudent(id, updates) {
  const { data, error } = await supabase
    .from('students')
    .update({
      name: updates.name,
      phone: updates.phone,
      class_name: updates.class_name,
      fee_amount: updates.fee_amount
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  await logActivity('Student Updated', `Updated student: ${updates.name}`);
  return data;
}

async function deleteStudent(id) {
  // Get student name before deletion for logging
  const student = await getStudentById(id);

  const { error } = await supabase
    .from('students')
    .delete()
    .eq('id', id);
  if (error) throw error;

  await logActivity('Student Deleted', `Deleted student: ${student.name}`);
  return { success: true };
}

// ─── Payments ──────────────────────────────────────────
// A fee_records row per student per month ('YYYY-MM') with status 'paid' or 'unpaid'.
// No row means not paid yet.

/** Map of student_id → fee record for the month */
async function getPaymentsForMonth(month) {
  const { data, error } = await supabase
    .from('fee_records')
    .select('student_id, status, paid_date')
    .eq('month', month);
  if (error) throw error;
  return new Map(data.map(r => [r.student_id, r]));
}

async function setPaymentStatus(studentId, month, paid) {
  const { data, error } = await supabase
    .from('fee_records')
    .upsert({
      student_id: studentId,
      month,
      status: paid ? 'paid' : 'unpaid',
      paid_date: paid ? new Date().toISOString() : null
    }, { onConflict: 'student_id,month' })
    .select('student_id, status, paid_date, students (name)')
    .single();
  if (error) throw error;

  await logActivity('Fee Status Updated', `${data.students?.name} → ${paid ? '✅ paid' : '❌ not paid'} (${month})`);
  return data;
}

// ─── Reminder Log ──────────────────────────────────────
// Every reminder run is recorded in activity_log:
//   "Monthly Reminders"  details "Month: YYYY-MM | Day: 1,10 | Sent: n, Failed: n"  (scheduled)
//   "Manual Reminders"   details "Month: YYYY-MM | Sent: n, Failed: n"             (Send now)
// Older scheduled entries have no "Day:" part and count as day 1.

const MANUAL_REMINDER_ACTION = 'Manual Reminders';

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
async function getLastReminderRun() {
  const { data, error } = await supabase
    .from('activity_log')
    .select('action, details, created_at')
    .in('action', [REMINDER_ACTION, MANUAL_REMINDER_ACTION])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? parseReminderRun(data) : null;
}

/** Days of `month` whose scheduled reminder has already been sent */
async function getScheduledDaysSent(month) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('action, details, created_at')
    .eq('action', REMINDER_ACTION)
    .like('details', `Month: ${month} |%`);
  if (error) throw error;
  return new Set(data.flatMap(row => parseReminderRun(row).days));
}

async function logReminderRun(month, days, sent, failed) {
  await logActivity(REMINDER_ACTION, `Month: ${month} | Day: ${days.join(',')} | Sent: ${sent}, Failed: ${failed}`);
}

async function logManualReminderRun(month, sent, failed) {
  await logActivity(MANUAL_REMINDER_ACTION, `Month: ${month} | Sent: ${sent}, Failed: ${failed}`);
}

// ─── Activity Log ──────────────────────────────────────

async function logActivity(action, details) {
  try {
    await supabase.from('activity_log').insert({ action, details });
  } catch (err) {
    console.error('Failed to log activity:', err.message);
  }
}

module.exports = {
  supabase,
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

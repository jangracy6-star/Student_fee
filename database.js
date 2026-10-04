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

// ─── Monthly Reminder Log ──────────────────────────────
// Each month's reminder run is recorded in activity_log as
// "Monthly Reminders" with details "Month: YYYY-MM | Sent: n, Failed: n".

async function getLastReminderRun() {
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .eq('action', REMINDER_ACTION)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const match = /Month: (\d{4}-\d{2}) \| Sent: (\d+), Failed: (\d+)/.exec(data.details || '');
  return {
    month: match?.[1] || null,
    sent: Number(match?.[2] || 0),
    failed: Number(match?.[3] || 0),
    at: data.created_at
  };
}

async function logReminderRun(month, sent, failed) {
  await logActivity(REMINDER_ACTION, `Month: ${month} | Sent: ${sent}, Failed: ${failed}`);
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
  getLastReminderRun,
  logReminderRun,
  logActivity
};

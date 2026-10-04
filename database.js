/**
 * Database Module — Supabase Client & Helper Functions
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

  // Log activity
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

// ─── Fee Record Operations ─────────────────────────────

async function getFeeRecordsByMonth(month) {
  const { data, error } = await supabase
    .from('fee_records')
    .select(`
      *,
      students (
        name,
        phone,
        class_name,
        fee_amount
      )
    `)
    .eq('month', month)
    .order('student_id', { ascending: true });
  if (error) throw error;
  return data;
}

async function generateFeeRecords(month) {
  // Get all students
  const students = await getAllStudents();
  if (students.length === 0) return { created: 0, skipped: 0 };

  let created = 0;
  let skipped = 0;

  for (const student of students) {
    // Check if record already exists
    const { data: existing } = await supabase
      .from('fee_records')
      .select('id')
      .eq('student_id', student.id)
      .eq('month', month)
      .maybeSingle();

    if (existing) {
      skipped++;
      continue;
    }

    const { error } = await supabase
      .from('fee_records')
      .insert({
        student_id: student.id,
        month: month,
        status: 'unpaid'
      });

    if (error) {
      console.error(`Error creating fee record for ${student.name}:`, error);
      skipped++;
    } else {
      created++;
    }
  }

  await logActivity('Fee Records Generated', `Month: ${month} | Created: ${created}, Skipped: ${skipped}`);
  return { created, skipped };
}

async function updateFeeStatus(recordId, status) {
  const updateData = {
    status: status,
    paid_date: status === 'paid' ? new Date().toISOString() : null
  };

  const { data, error } = await supabase
    .from('fee_records')
    .update(updateData)
    .eq('id', recordId)
    .select(`
      *,
      students (name)
    `)
    .single();
  if (error) throw error;

  const statusEmoji = status === 'paid' ? '✅' : '❌';
  await logActivity('Fee Status Updated', `${data.students.name} → ${statusEmoji} ${status} (${data.month})`);
  return data;
}

async function getUnpaidStudents(month) {
  const { data, error } = await supabase
    .from('fee_records')
    .select(`
      *,
      students (
        name,
        phone,
        class_name,
        fee_amount
      )
    `)
    .eq('month', month)
    .eq('status', 'unpaid');
  if (error) throw error;
  return data;
}

async function getFeeSummary(month) {
  const records = await getFeeRecordsByMonth(month);
  const total = records.length;
  const paid = records.filter(r => r.status === 'paid').length;
  const unpaid = records.filter(r => r.status === 'unpaid').length;
  const collected = records
    .filter(r => r.status === 'paid')
    .reduce((sum, r) => sum + Number(r.students?.fee_amount || 0), 0);
  const pending = records
    .filter(r => r.status === 'unpaid')
    .reduce((sum, r) => sum + Number(r.students?.fee_amount || 0), 0);

  return { total, paid, unpaid, collected, pending };
}

// ─── Activity Log Operations ───────────────────────────

async function logActivity(action, details) {
  try {
    await supabase.from('activity_log').insert({ action, details });
  } catch (err) {
    console.error('Failed to log activity:', err.message);
  }
}

async function getRecentActivities(limit = 20) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

module.exports = {
  supabase,
  getAllStudents,
  getStudentById,
  createStudent,
  updateStudent,
  deleteStudent,
  getFeeRecordsByMonth,
  generateFeeRecords,
  updateFeeStatus,
  getUnpaidStudents,
  getFeeSummary,
  logActivity,
  getRecentActivities
};

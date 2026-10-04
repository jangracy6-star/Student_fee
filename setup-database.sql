-- =============================================
-- Student Fee Management System — Database Setup
-- Run this SQL in your Supabase SQL Editor
-- =============================================

-- 1. Students Table
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  class_name TEXT NOT NULL,
  fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Fee Records Table
CREATE TABLE IF NOT EXISTS fee_records (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month TEXT NOT NULL,               -- Format: 'YYYY-MM'
  status TEXT NOT NULL DEFAULT 'unpaid',  -- 'paid' or 'unpaid'
  paid_date TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, month)
);

-- 3. Activity Log Table
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_fee_records_month ON fee_records(month);
CREATE INDEX IF NOT EXISTS idx_fee_records_student ON fee_records(student_id);
CREATE INDEX IF NOT EXISTS idx_fee_records_status ON fee_records(status);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);

-- 5. Enable Row Level Security (optional, using service_role bypasses RLS)
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- 6. Policies — allow full access for service_role (backend)
CREATE POLICY "Allow full access for service role" ON students FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for service role" ON fee_records FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for service role" ON activity_log FOR ALL USING (true) WITH CHECK (true);

-- 7. Function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 8. Trigger for fee_records
DROP TRIGGER IF EXISTS set_updated_at ON fee_records;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON fee_records
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

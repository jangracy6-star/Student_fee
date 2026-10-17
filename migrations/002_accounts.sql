-- =============================================
-- 002 — Customer accounts, admin, access requests
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again: every step checks before it changes anything.
-- =============================================

-- 1. Accounts (admins and paying customers)
CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,                     -- stored lowercase
  name TEXT,
  password_hash TEXT,                             -- scrypt hash; NULL = no password set yet
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('admin', 'customer')),
  active BOOLEAN NOT NULL DEFAULT TRUE,           -- FALSE = access turned off by an admin
  session_version INTEGER NOT NULL DEFAULT 1,     -- bumped on password change to sign out other devices
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- 2. People who asked for access from the login page
CREATE TABLE IF NOT EXISTS access_requests (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,                            -- stored lowercase
  phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_one_pending_per_email
  ON access_requests (email) WHERE status = 'pending';

-- 3. Every student and activity entry belongs to one customer
ALTER TABLE students ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES app_users(id) ON DELETE CASCADE;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES app_users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_students_owner ON students(owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_owner ON activity_log(owner_id, created_at DESC);

-- 4. Admin accounts (their first password comes from ADMIN_PASSWORD on the server)
INSERT INTO app_users (email, name, role) VALUES
  ('bavayuva789@gmail.com', 'Admin', 'admin'),
  ('dominova.office@gmail.com', 'Admin', 'admin')
ON CONFLICT (email) DO NOTHING;

-- 5. Move the existing students to their customer account
--    (an admin sets this customer's password from the Admin page)
INSERT INTO app_users (email, name, role) VALUES ('192511116.simats@saveetha.com', 'SIMATS', 'customer')
ON CONFLICT (email) DO NOTHING;

UPDATE students SET owner_id = (SELECT id FROM app_users WHERE email = '192511116.simats@saveetha.com')
WHERE owner_id IS NULL;
UPDATE activity_log SET owner_id = (SELECT id FROM app_users WHERE email = '192511116.simats@saveetha.com')
WHERE owner_id IS NULL;

-- 6. Lock the tables down: only the server (service_role key) can read or write.
--    The old "allow all" policies also let the public anon key read student data.
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow full access for service role" ON students;
DROP POLICY IF EXISTS "Allow full access for service role" ON fee_records;
DROP POLICY IF EXISTS "Allow full access for service role" ON activity_log;

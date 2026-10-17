-- =============================================
-- 003 — Monthly plans and student limits
-- Run after 002_accounts.sql in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again.
-- =============================================

-- When the customer's current plan started and when it ends (NULL = never ends, e.g. admins)
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS plan_started_at TIMESTAMPTZ;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;

-- Most students the customer can add (NULL = unlimited). Only admins can change it.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS student_limit INTEGER CHECK (student_limit IS NULL OR student_limit >= 0);

-- Existing customers start a one-month plan today with room for 100 students
UPDATE app_users
SET plan_started_at = COALESCE(plan_started_at, NOW()),
    plan_expires_at = COALESCE(plan_expires_at, NOW() + INTERVAL '1 month'),
    student_limit   = COALESCE(student_limit, 100)
WHERE role = 'customer' AND plan_expires_at IS NULL;

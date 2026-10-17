# FeeFlow — WhatsApp Fee Reminders

A clean, minimal, mobile-first product (light & dark mode) for tuition centres and schools. **Only customers who have bought FeeFlow can sign in.** Each customer adds their students, and every month the unpaid ones automatically get a WhatsApp fee reminder from the customer's own WhatsApp number.

## Who sees what

**Admins** (`bavayuva789@gmail.com`, `dominova.office@gmail.com`) see only the **Admin page**, with no fee screens:
- **Customers**: add a customer (name, email, password — or tap *Generate*), then copy the sign-in details to send them. Reset a customer's password, turn their access off or on, or delete them.
- **Requests**: people who tried to sign in without an account and asked for access (name, email, phone, message). *Give access* opens the Add customer form already filled in; *Dismiss* removes the request.

**Customers** each get their own private workspace:
- Add, edit and delete students (name, WhatsApp number, class, monthly fee).
- Mark each student **Paid / Unpaid** for the current month, with Collected / Pending totals.
- **Send now** reminds every unpaid student immediately.
- **Settings**: institute name, link WhatsApp (scan a QR code once), choose reminder days (e.g. the 1st and 10th), edit the message (`{name}`, `{fee}`, `{month}`, `{institution}` are filled in for each student), and **Account** → change password or log out.

**Anyone else** who signs in with an email that has no account sees *"This email doesn't have access yet"* and can **Request access**.

## Setup

### 1. Database (Supabase)

In Supabase → **SQL Editor**, run these once, in order:
1. [`setup-database.sql`](setup-database.sql): students, fees and activity tables (skip if you already have them).
2. [`migrations/002_accounts.sql`](migrations/002_accounts.sql): accounts, access requests, the two admin emails, and moves the existing students to `192511116.simats@saveetha.com`.

### 2. Configure

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | ✅ | Project URL (Project Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | `service_role` key (keep it secret, server only) |
| `ADMIN_PASSWORD` | ✅ first time | First password for the admin emails (min 8 characters). Only used while an admin has no password; change it in the app after signing in |
| `ADMIN_EMAILS` | | Comma-separated admin emails (default: the two above) |
| `WHATSAPP_MAX_ACTIVE` | | Customers' WhatsApp running at once (default `1`, fits Render's free plan; ~250 MB each) |
| `TIMEZONE` | | Timezone for reminder days and the current month (default `Asia/Kolkata`) |
| `SESSION_SECRET` | | Signs login cookies (defaults to one derived from the Supabase key) |
| `PORT` | | Default `3000` |

### 3. Run

```bash
npm install
npm run setup-db   # checks the database connection and tables
npm start
```

Open http://localhost:3000 and sign in with an admin email and `ADMIN_PASSWORD`.

## Deploy on Render

1. Go to **https://render.com/deploy?repo=https://github.com/jangracy6-star/Student_fee** and sign in with GitHub.
2. Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `ADMIN_PASSWORD`, then click **Apply**. The first build takes about 5 minutes.
3. Already deployed? Add `ADMIN_PASSWORD` under the service's **Environment** tab, then **Manual Deploy → Deploy latest commit**.

Notes:
- The app pings itself every 10 minutes so Render's free plan doesn't put it to sleep.
- WhatsApp logins are saved in Supabase Storage (bucket `whatsapp-session`), so restarts don't need a new QR scan.

## How it works

- **Accounts**: passwords are stored as scrypt hashes, never in plain text. Sessions are signed HttpOnly cookies valid for 30 days. Changing or resetting a password, or turning access off, signs that account out everywhere else. Repeated wrong passwords are locked out for 15 minutes.
- **Separate data**: every student, payment, activity entry and setting belongs to one customer. Customers can never see or change another customer's data.
- **WhatsApp per customer**: each customer links their own WhatsApp. Each one runs in a headless browser, which is heavy, so browsers open only when needed (showing the QR code, or sending) and close again when idle. At most `WHATSAPP_MAX_ACTIVE` run at once, and others wait their turn. Once a week each linked WhatsApp is opened briefly so WhatsApp keeps the linked device active.
- **Reminders**: on each customer's chosen days (in `TIMEZONE`), every student not marked paid that month gets the reminder. If the server or WhatsApp was down on a reminder day, it catches up within 2 days. Each day is only ever sent once. Days past the end of a short month move to its last day.
- **Settings** are stored per customer as `customers/<id>.json` in the private `app-settings` storage bucket.
- 10-digit phone numbers are treated as Indian (`+91` is added).

## Project structure

```
server.js         Express API: public (login, access requests), admin, customer; reminder schedule
auth.js           Email + password accounts, sessions, roles, password changes
database.js       Supabase queries (everything scoped to the customer)
whatsapp.js       One WhatsApp per customer, started on demand, reminder messages
session-store.js  Saves WhatsApp logins to Supabase Storage
settings.js       Each customer's institute name, reminder days and message
migrations/       SQL to run in Supabase
public/           Frontend (index.html, css, js/app.js, js/admin.js, PWA)
```

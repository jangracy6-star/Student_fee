# FeeFlow — Student Fee Reminders

A simple mobile-friendly app: **add your students, and every month each one automatically gets a WhatsApp fee reminder.**

- Add, edit, or delete students (name, WhatsApp number, class, monthly fee).
- Link WhatsApp once by scanning a QR code.
- On the **1st of every month**, every student receives a reminder like:

  > 🎓 *Fee Reminder — Student Academy*
  > Dear *Ravi Kumar*, this is a gentle reminder that your fee of *₹3,000* for the month of *November 2026* is due…

- The home screen shows whether reminders are on, when the next one goes out, and how many were delivered last time.
- Install it on your phone with *Add to Home Screen*.

## Setup

### 1. Database (Supabase)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste the contents of [`setup-database.sql`](setup-database.sql), and click **Run**.

### 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | ✅ | Project URL (Project Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | `service_role` key (keep it secret, server only) |
| `ADMIN_PASSWORD` | Recommended | Password for the dashboard. Without it, anyone with the URL has full access |
| `INSTITUTION_NAME` | | Shown in the header and in reminder messages |
| `TIMEZONE` | | Timezone for the monthly job and the current month (default `Asia/Kolkata`) |
| `SESSION_SECRET` | | Signs login cookies. Set it to keep sessions valid after a password change |
| `PORT` | | Default `3000` |

### 3. Run

```bash
npm install
npm run setup-db   # checks the database connection and tables
npm start
```

Open http://localhost:3000, tap **Connect** on the WhatsApp card, and scan the QR code with WhatsApp → *Settings → Linked Devices*.

### Docker

```bash
docker build -t feeflow .
docker run -p 3000:3000 --env-file .env -v feeflow-wa:/app/.wwebjs_auth feeflow
```

The volume keeps the WhatsApp login across restarts.

## How it works

- Reminders are sent on the **1st of every month** (in `TIMEZONE`, default India time) to every student.
- If the server was asleep or WhatsApp was disconnected on the 1st, the reminders go out as soon as it's back, up to the **3rd** of the month. They are never sent twice in the same month.
- 10-digit phone numbers are treated as Indian (`+91` is added).
- If WhatsApp disconnects, the server reconnects on its own. If the session has expired, open the app and scan the new QR code.

## Project structure

```
server.js       Express API, auth, monthly reminder schedule
database.js     Supabase queries
whatsapp.js     WhatsApp client, reconnects, reminder messages
auth.js         Optional password login (signed HttpOnly cookie)
public/         Frontend (HTML/CSS/JS, PWA manifest and service worker)
```

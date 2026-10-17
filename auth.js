/**
 * Auth Module — email + password accounts (admins and paying customers)
 * Passwords are scrypt-hashed. Sessions are HMAC-signed, HttpOnly cookies that carry
 * the account's session_version, so a password change signs out every other device.
 */
const crypto = require('crypto');
const db = require('./database');

const COOKIE_NAME = 'feeflow_session';
const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 8;
const USER_CACHE_MS = 30 * 1000;

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'bavayuva789@gmail.com,dominova.office@gmail.com')
  .split(',').map(e => normalizeEmail(e)).filter(Boolean);

// A stable secret even if SESSION_SECRET isn't set (derived from the server-only Supabase key)
const secret = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(`feeflow-session:${process.env.SUPABASE_SERVICE_ROLE_KEY}`).digest('hex');

const failedAttempts = new Map(); // `${ip}|${email}` -> { count, until }
const userCache = new Map();      // id -> { user, at }

// ─── Passwords ─────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [scheme, n, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n) });
  return crypto.timingSafeEqual(actual, expected);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (password.length > 200) return 'Password is too long';
  return null;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

// ─── Sessions ──────────────────────────────────────────

function sign(value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function setSessionCookie(req, res, user) {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${user.id}.${user.session_version}.${expires}`;
  res.cookie(COOKIE_NAME, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

async function loadUser(id) {
  const cached = userCache.get(id);
  if (cached && Date.now() - cached.at < USER_CACHE_MS) return cached.user;
  const user = await db.getUserById(id);
  userCache.set(id, { user, at: Date.now() });
  return user;
}

/** Forget a cached account so changes (password, access off) apply immediately */
function forgetUser(id) {
  userCache.delete(id);
}

/** The signed-in, active account for this request, or null */
async function getSessionUser(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [id, version, expires, signature] = parts;
  if (!safeEqual(signature, sign(`${id}.${version}.${expires}`)) || Number(expires) < Date.now()) return null;

  const user = await loadUser(id);
  if (!user || !user.active || String(user.session_version) !== version) return null;
  return user;
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

// ─── Route handlers ────────────────────────────────────

async function login(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password' });

    const key = `${req.ip}|${email}`;
    const attempt = failedAttempts.get(key);
    if (attempt && attempt.until > Date.now()) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }

    const user = await db.getUserForLogin(email);
    if (!user) {
      // Someone who hasn't bought yet — send them to the access request form
      return res.status(403).json({ code: 'no_access', error: "This email doesn't have access yet." });
    }

    if (!verifyPassword(password, user.password_hash)) {
      const count = (attempt?.count || 0) + 1;
      failedAttempts.set(key, { count, until: count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0 });
      return res.status(401).json({ error: 'Incorrect email or password' });
    }

    if (!user.active) {
      return res.status(403).json({ code: 'inactive', error: 'Your access has been turned off. Please contact us.' });
    }

    failedAttempts.delete(key);
    await db.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
    forgetUser(user.id);
    setSessionCookie(req, res, user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
}

async function session(req, res) {
  try {
    const user = await getSessionUser(req);
    res.json(user ? { authenticated: true, user: publicUser(user) } : { authenticated: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Change the signed-in account's password; other devices are signed out */
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const problem = validatePassword(newPassword);
    if (problem) return res.status(400).json({ error: problem });

    const stored = await db.getPasswordHash(req.user.id);
    if (!verifyPassword(String(currentPassword || ''), stored)) {
      return res.status(400).json({ error: 'Your current password is incorrect' });
    }

    const user = await db.updateUser(req.user.id, { passwordHash: hashPassword(newPassword) }, { bumpSession: true });
    forgetUser(user.id);
    setSessionCookie(req, res, user); // keep this device signed in
    if (user.role === 'customer') await db.logActivity(user.id, 'Password Changed', user.email);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── Middleware ────────────────────────────────────────

function requireRole(role) {
  return async (req, res, next) => {
    try {
      const user = await getSessionUser(req);
      if (!user) return res.status(401).json({ error: 'Please log in' });
      if (role && user.role !== role) return res.status(403).json({ error: 'Not available for this account' });
      req.user = user;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

const requireLogin = requireRole(null);
const requireCustomer = requireRole('customer');
const requireAdmin = requireRole('admin');

/** Create the admin accounts on startup; their first password is ADMIN_PASSWORD */
async function bootstrapAdmins() {
  const password = process.env.ADMIN_PASSWORD || '';
  const problem = password ? validatePassword(password) : 'not set';
  await db.ensureAdmins(ADMIN_EMAILS, problem ? null : hashPassword(password));
  if (problem === 'not set') {
    console.log('   ⚠️  Set ADMIN_PASSWORD to give the admin emails their first password');
  } else if (problem) {
    console.log(`   ⚠️  ADMIN_PASSWORD is too short (min ${MIN_PASSWORD} characters) — admin password not set`);
  }
}

module.exports = {
  ADMIN_EMAILS,
  hashPassword,
  validatePassword,
  normalizeEmail,
  isValidEmail,
  forgetUser,
  login,
  logout,
  session,
  changePassword,
  requireLogin,
  requireCustomer,
  requireAdmin,
  bootstrapAdmins
};

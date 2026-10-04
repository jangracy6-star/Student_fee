/**
 * Auth Module — Optional single-admin password login
 * Enabled when ADMIN_PASSWORD is set. Sessions are HMAC-signed, HttpOnly cookies.
 */
const crypto = require('crypto');

const COOKIE_NAME = 'feeflow_session';
const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

const password = process.env.ADMIN_PASSWORD || '';
const secret = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`feeflow:${password}`).digest('hex');
const enabled = password.length > 0;

const failedAttempts = new Map(); // ip -> { count, until }

function sign(value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isAuthenticated(req) {
  if (!enabled) return true;
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  const [expires, signature] = token.split('.');
  return Number(expires) > Date.now() && safeEqual(signature, sign(expires));
}

function setSessionCookie(req, res) {
  const expires = String(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE_NAME, `${expires}.${sign(expires)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

function login(req, res) {
  if (!enabled) return res.json({ authenticated: true, authEnabled: false });

  const ip = req.ip;
  const entry = failedAttempts.get(ip);
  if (entry && entry.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  if (!safeEqual(req.body?.password || '', password)) {
    const count = (entry?.count || 0) + 1;
    failedAttempts.set(ip, { count, until: count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0 });
    return res.status(401).json({ error: 'Incorrect password' });
  }

  failedAttempts.delete(ip);
  setSessionCookie(req, res);
  res.json({ authenticated: true, authEnabled: true });
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.json({ authenticated: false, authEnabled: enabled });
}

function session(req, res) {
  res.json({ authenticated: isAuthenticated(req), authEnabled: enabled });
}

/** Express middleware — rejects unauthenticated API requests */
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Please log in' });
}

module.exports = { enabled, login, logout, session, requireAuth };

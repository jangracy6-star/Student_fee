/**
 * FeeFlow — Frontend Application Logic
 * Add students; WhatsApp sends each of them a fee reminder on the 1st of every month.
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ─── State ─────────────────────────────────────────────
const state = {
  config: { institution: 'Student Fee Reminders', authEnabled: false, currentMonth: null },
  students: [],
  filter: 'all', // 'all' | 'paid' | 'unpaid'
  studentsLoaded: false,
  wa: { status: null },
  reminders: null
};

let waPollTimer = null;
let qrPollTimer = null;
let reminderPollTimer = null;

const $ = (id) => document.getElementById(id);

// ─── Initialize ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  bindEvents();
  try {
    const session = await fetch('/api/session').then(r => r.json());
    if (session.authEnabled && !session.authenticated) return showLogin();
  } catch (err) {
    // Server unreachable — still render the shell; API calls will show errors
  }
  startApp();
}

async function startApp() {
  $('login-screen').hidden = true;
  try {
    state.config = await api('/api/config');
  } catch (err) {
    // keep defaults
  }
  $('institution-name').textContent = state.config.institution;
  $('btn-logout').hidden = !state.config.authEnabled;
  document.title = `FeeFlow — ${state.config.institution}`;

  loadStudents();
  startWhatsAppPolling();
  registerServiceWorker();
}

// ═══════════════════════════════════════════════════════
//  API
// ═══════════════════════════════════════════════════════

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (err) { /* empty body */ }

  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// ═══════════════════════════════════════════════════════
//  LOGIN
// ═══════════════════════════════════════════════════════

function showLogin() {
  clearInterval(waPollTimer);
  clearInterval(qrPollTimer);
  clearTimeout(reminderPollTimer);
  $('login-screen').hidden = false;
  setTimeout(() => $('login-password').focus(), 50);
}

async function handleLogin(event) {
  event.preventDefault();
  const btn = $('btn-login');
  const errorEl = $('login-error');
  errorEl.hidden = true;
  setLoading(btn, true);
  try {
    await api('/api/login', { method: 'POST', body: { password: $('login-password').value } });
    $('login-password').value = '';
    startApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

async function logout() {
  if (!await confirmDialog({ title: 'Log out?', message: 'You will need the admin password to log back in.', confirmLabel: 'Log out' })) return;
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

// ═══════════════════════════════════════════════════════
//  STUDENTS
// ═══════════════════════════════════════════════════════

async function loadStudents() {
  if (!state.studentsLoaded) $('students-list').innerHTML = skeletons(4);
  try {
    state.students = await api('/api/students');
    state.studentsLoaded = true;
    $('class-options').innerHTML = [...new Set(state.students.map(s => s.class_name))]
      .map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
    renderStudents();
    renderReminderCard();
  } catch (err) {
    showToast(err.message || 'Failed to load students', 'error');
    if (!state.studentsLoaded) {
      $('students-list').innerHTML = `
        <div class="empty-state">
          <svg class="i"><use href="#i-x"/></svg>
          <p>Could not load students</p>
          <button class="btn btn-secondary" data-action="reload">Try again</button>
        </div>`;
    }
  }
}

function renderStudents() {
  const list = $('students-list');
  const total = state.students.length;
  const query = $('student-search').value.trim().toLowerCase();
  const paidCount = state.students.filter(s => s.paid).length;
  const pending = state.students.filter(s => !s.paid).reduce((sum, s) => sum + Number(s.fee_amount || 0), 0);

  const month = state.config.currentMonth ? `${formatMonth(state.config.currentMonth)} · ` : '';
  $('students-count').textContent = total
    ? `${month}${paidCount} of ${total} paid${pending ? ` · ${formatMoney(pending)} pending` : ''}`
    : '0 students';
  $('search-bar').hidden = total < 6;
  $('pay-filter').hidden = total === 0;
  $('count-all').textContent = total;
  $('count-paid').textContent = paidCount;
  $('count-unpaid').textContent = total - paidCount;
  document.querySelectorAll('#pay-filter .segment').forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter));

  const students = state.students
    .filter(s => state.filter === 'all' || (state.filter === 'paid') === !!s.paid)
    .filter(s => !query ||
      s.name.toLowerCase().includes(query) || s.phone.includes(query) || s.class_name.toLowerCase().includes(query));

  if (total === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg class="i"><use href="#i-users"/></svg>
        <p>No students yet</p>
        <small>Add a student and they'll get a WhatsApp fee reminder on the 1st of every month</small>
        <button class="btn btn-primary" data-action="add-student"><svg class="i"><use href="#i-plus"/></svg> Add Student</button>
      </div>`;
    return;
  }

  if (students.length === 0) {
    const message = query ? 'No matches'
      : state.filter === 'unpaid' ? 'Everyone has paid this month 🎉'
      : 'Nobody has paid yet this month';
    list.innerHTML = `<div class="empty-state"><svg class="i"><use href="#i-${query ? 'search' : 'check'}"/></svg><p>${message}</p></div>`;
    return;
  }

  list.innerHTML = students.map(s => `
    <div class="item-card ${s.paid ? 'is-paid' : ''}">
      <button class="item-open" data-action="edit-student" data-id="${s.id}" aria-label="Edit ${escapeHtml(s.name)}">
        ${avatar(s.name)}
        <span class="item-main">
          <span class="item-title">${escapeHtml(s.name)}</span>
          <span class="item-meta">${escapeHtml(s.class_name)} · ${formatMoney(s.fee_amount)}/month</span>
        </span>
      </button>
      <button class="pay-toggle ${s.paid ? 'paid' : 'unpaid'}" data-action="toggle-paid" data-id="${s.id}"
        aria-pressed="${s.paid}" title="${s.paid && s.paid_date ? `Paid on ${formatDate(s.paid_date)} — tap to mark not paid` : 'Tap to mark paid'}">
        ${s.paid ? '<svg class="i"><use href="#i-check"/></svg> Paid' : 'Not paid'}
      </button>
    </div>`).join('');
}

/** Flip a student between paid / not paid for this month, with Undo */
async function togglePaid(id, { undo = false } = {}) {
  const student = state.students.find(s => s.id === id);
  if (!student) return;
  const previous = { paid: student.paid, paid_date: student.paid_date };
  const paid = !student.paid;

  // Update the screen straight away; roll back if the server says no
  Object.assign(student, { paid, paid_date: paid ? new Date().toISOString() : null });
  renderStudents();

  try {
    const result = await api(`/api/students/${id}/payment`, { method: 'PUT', body: { paid } });
    student.paid_date = result.paid_date;
    if (!undo) {
      showToast(`${student.name} marked ${paid ? 'paid' : 'not paid'}`, 'success', {
        actionLabel: 'Undo',
        onAction: () => togglePaid(id, { undo: true })
      });
    }
  } catch (err) {
    Object.assign(student, previous);
    renderStudents();
    showToast(err.message, 'error');
  }
}

function openStudentForm(student = null) {
  const form = $('student-form');
  form.reset();
  form.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  $('student-form-error').hidden = true;
  $('student-edit-id').value = student ? student.id : '';
  $('student-sheet-title').textContent = student ? 'Edit Student' : 'Add Student';
  $('btn-delete-student').hidden = !student;
  $('btn-cancel-student').hidden = !!student;

  if (student) {
    $('input-name').value = student.name;
    $('input-phone').value = student.phone;
    $('input-class').value = student.class_name;
    $('input-fee').value = student.fee_amount;
  }

  openSheet('student-sheet');
  // Only autofocus with a real keyboard — avoids the on-screen keyboard jumping up on phones
  if (matchMedia('(hover: hover)').matches) setTimeout(() => $('input-name').focus(), 150);
}

async function saveStudent(event) {
  event.preventDefault();

  const editId = $('student-edit-id').value;
  const fields = {
    name: $('input-name'),
    phone: $('input-phone'),
    class_name: $('input-class'),
    fee_amount: $('input-fee')
  };
  const payload = {
    name: fields.name.value.trim(),
    phone: fields.phone.value.trim(),
    class_name: fields.class_name.value.trim(),
    fee_amount: fields.fee_amount.value === '' ? null : Number(fields.fee_amount.value)
  };

  const problems = [];
  Object.values(fields).forEach(f => f.classList.remove('invalid'));
  if (!payload.name) problems.push(['name', 'Enter the student\'s name']);
  const digits = payload.phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) problems.push(['phone', 'Enter a valid WhatsApp number (10–15 digits)']);
  if (!payload.class_name) problems.push(['class_name', 'Enter a class or course']);
  if (payload.fee_amount == null || !Number.isFinite(payload.fee_amount) || payload.fee_amount < 0) problems.push(['fee_amount', 'Enter the monthly fee']);

  const errorEl = $('student-form-error');
  if (problems.length) {
    problems.forEach(([key]) => fields[key].classList.add('invalid'));
    errorEl.textContent = problems[0][1];
    errorEl.hidden = false;
    fields[problems[0][0]].focus();
    return;
  }
  errorEl.hidden = true;

  const btn = $('btn-save-student');
  setLoading(btn, true);
  try {
    if (editId) {
      await api(`/api/students/${editId}`, { method: 'PUT', body: payload });
    } else {
      await api('/api/students', { method: 'POST', body: payload });
    }
    await closeSheet();
    showToast(editId ? `${payload.name} updated` : `${payload.name} added`, 'success');
    loadStudents();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

async function deleteStudent() {
  const id = Number($('student-edit-id').value);
  const student = state.students.find(s => s.id === id);
  if (!student) return;
  const ok = await confirmDialog({
    title: 'Delete student?',
    message: `"${student.name}" will be removed and won't get any more reminders.`,
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) return;

  try {
    await api(`/api/students/${id}`, { method: 'DELETE' });
    await closeSheet();
    showToast(`${student.name} deleted`, 'success');
    loadStudents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════
//  WHATSAPP & MONTHLY REMINDER STATUS
// ═══════════════════════════════════════════════════════

function startWhatsAppPolling() {
  clearInterval(waPollTimer);
  updateWhatsAppStatus(true);
  waPollTimer = setInterval(updateWhatsAppStatus, 5000);
}

async function updateWhatsAppStatus(force = false) {
  if (document.hidden && force !== true) return;
  try {
    const data = await api('/api/whatsapp/status');
    const changed = data.status !== state.wa.status;
    state.wa = data;
    if (changed) loadReminderInfo();
    renderReminderCard();
  } catch (err) {
    // Server might be restarting
  }
}

async function loadReminderInfo() {
  clearTimeout(reminderPollTimer);
  try {
    state.reminders = await api('/api/reminders');
    renderReminderCard();
    // While a send is in progress, check back until it finishes
    if (state.reminders.running) reminderPollTimer = setTimeout(loadReminderInfo, 10000);
  } catch (err) {
    // keep the last known info
  }
}

function renderReminderCard() {
  const card = $('reminder-card');
  const status = state.wa.status;
  const info = state.reminders;
  const count = state.students.length;
  const btn = $('btn-connect');

  card.classList.remove('is-on', 'is-off');
  const title = $('reminder-title');
  const text = $('reminder-text');

  if (status === 'connected') {
    card.classList.add('is-on');
    title.textContent = 'Monthly reminders are on';
    if (info?.running) {
      text.textContent = 'Sending this month\'s reminders now…';
    } else {
      text.textContent = info
        ? `Next: ${formatDate(info.nextDate)} to ${count} student${count === 1 ? '' : 's'}`
        : 'Sent on the 1st of every month';
    }
    btn.textContent = 'Manage';
    btn.className = 'btn btn-sm btn-secondary';
  } else if (status === 'connecting') {
    title.textContent = 'Connecting to WhatsApp…';
    text.textContent = 'This can take up to a minute';
    btn.textContent = 'View';
    btn.className = 'btn btn-sm btn-secondary';
  } else if (status) {
    card.classList.add('is-off');
    title.textContent = 'Connect WhatsApp to send reminders';
    text.textContent = 'Every student gets a reminder on the 1st of each month';
    btn.textContent = 'Connect';
    btn.className = 'btn btn-sm btn-whatsapp';
  }

  const last = $('reminder-last');
  if (info?.lastRun) {
    const r = info.lastRun;
    last.textContent = `Last sent ${formatDate(r.at)} · ${r.sent} delivered${r.failed ? `, ${r.failed} failed` : ''}`;
    last.hidden = false;
  } else {
    last.hidden = true;
  }
}

// ─── QR Sheet ──────────────────────────────────────────

function openQRSheet() {
  $('qr-content').innerHTML = '<div class="qr-state"><div class="spinner"></div><p>Checking connection…</p></div>';
  openSheet('qr-sheet');
  refreshQR();
  clearInterval(qrPollTimer);
  qrPollTimer = setInterval(refreshQR, 3000);
}

async function refreshQR() {
  if (!$('qr-sheet').classList.contains('show')) return clearInterval(qrPollTimer);
  const content = $('qr-content');
  try {
    const data = await api('/api/whatsapp/qr');
    const connected = data.status === 'connected';
    $('qr-actions').hidden = !connected;
    $('qr-instructions').hidden = connected;
    $('qr-sheet-title').textContent = connected ? 'WhatsApp' : 'Connect WhatsApp';

    if (data.qr) {
      const img = content.querySelector('img');
      if (img) img.src = data.qr;
      else content.innerHTML = `<img src="${data.qr}" alt="WhatsApp QR code" />`;
    } else if (connected) {
      content.innerHTML = `
        <div class="qr-state">
          <span class="big">✅</span>
          <p>WhatsApp is connected</p>
          <small>Reminders go out automatically on the 1st of every month</small>
        </div>`;
    } else {
      content.innerHTML = `
        <div class="qr-state">
          <div class="spinner"></div>
          <p>${escapeHtml(data.message || 'Waiting for QR code…')}</p>
          <small>This can take up to a minute after the server starts</small>
        </div>`;
    }
  } catch (err) {
    content.innerHTML = `
      <div class="qr-state">
        <span class="big">⚠️</span>
        <p>Could not reach the server</p>
        <small>${escapeHtml(err.message)}</small>
      </div>`;
  }
}

async function whatsappLogout() {
  const ok = await confirmDialog({
    title: 'Unlink WhatsApp?',
    message: 'Monthly reminders will stop until you scan a new QR code.',
    confirmLabel: 'Unlink',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/api/whatsapp/logout', { method: 'POST' });
    showToast('WhatsApp unlinked', 'success');
    refreshQR();
    updateWhatsAppStatus(true);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════
//  SHEETS (modal dialogs)
// ═══════════════════════════════════════════════════════
// Each open sheet pushes a history entry, so the phone's back button closes it.

const sheetStack = [];
let popResolvers = [];
let confirmResolver = null;

function openSheet(id) {
  const el = $(id);
  el.style.zIndex = 1000 + sheetStack.length; // later sheets stack on top of earlier ones
  el.classList.add('show');
  el.querySelector('.sheet').style.transform = '';
  sheetStack.push(id);
  document.body.classList.add('sheet-open');
  history.pushState({ sheet: id }, '');
}

/** Close the top sheet. Resolves once the history entry has been popped. */
function closeSheet() {
  if (!sheetStack.length) return Promise.resolve();
  return new Promise(resolve => {
    popResolvers.push(resolve);
    history.back();
  });
}

function hideTopSheet() {
  const id = sheetStack.pop();
  if (!id) return;
  $(id).classList.remove('show');
  if (id === 'confirm-sheet' && confirmResolver) {
    confirmResolver(false);
    confirmResolver = null;
  }
  if (id === 'qr-sheet') clearInterval(qrPollTimer);
  if (!sheetStack.length) document.body.classList.remove('sheet-open');
}

window.addEventListener('popstate', () => {
  if (sheetStack.length) hideTopSheet();
  const resolvers = popResolvers;
  popResolvers = [];
  resolvers.forEach(r => r());
});

function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = message;
  const ok = $('btn-confirm-ok');
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  openSheet('confirm-sheet');
  return new Promise(resolve => { confirmResolver = resolve; });
}

async function answerConfirm(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  await closeSheet();
  resolve?.(value);
}

/** Drag a sheet down by its handle/header to dismiss it */
function enableSheetDrag(overlay) {
  const sheet = overlay.querySelector('.sheet');
  let startY = null, delta = 0;

  const onStart = (e) => {
    if (window.innerWidth >= 640) return;
    startY = e.touches[0].clientY;
    delta = 0;
    sheet.style.transition = 'none';
  };
  const onMove = (e) => {
    if (startY === null) return;
    delta = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${delta}px)`;
  };
  const onEnd = () => {
    if (startY === null) return;
    startY = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (delta > 90) closeSheet();
  };

  overlay.querySelectorAll('.sheet-handle, .sheet-header').forEach(el => {
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd);
  });
}

// ═══════════════════════════════════════════════════════
//  EVENTS
// ═══════════════════════════════════════════════════════

function bindEvents() {
  $('login-form').addEventListener('submit', handleLogin);
  $('student-form').addEventListener('submit', saveStudent);
  $('btn-confirm-ok').addEventListener('click', () => answerConfirm(true));
  $('btn-confirm-cancel').addEventListener('click', () => answerConfirm(false));
  $('student-search').addEventListener('input', renderStudents);
  document.querySelectorAll('#pay-filter .segment').forEach(b => b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    renderStudents();
  }));

  document.querySelectorAll('.sheet-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      if (overlay.id === 'confirm-sheet') answerConfirm(false);
      else closeSheet();
    });
    enableSheetDrag(overlay);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !sheetStack.length) return;
    if (sheetStack[sheetStack.length - 1] === 'confirm-sheet') answerConfirm(false);
    else closeSheet();
  });

  // Refresh when coming back to the app
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && $('login-screen').hidden) {
      updateWhatsAppStatus();
      loadStudents();
    }
  });

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;

    switch (el.dataset.action) {
      case 'add-student': openStudentForm(); break;
      case 'edit-student': {
        const student = state.students.find(s => s.id === Number(el.dataset.id));
        if (student) openStudentForm(student);
        break;
      }
      case 'delete-student': deleteStudent(); break;
      case 'toggle-paid': togglePaid(Number(el.dataset.id)); break;
      case 'close-sheet': closeSheet(); break;
      case 'open-qr': openQRSheet(); break;
      case 'wa-logout': whatsappLogout(); break;
      case 'logout': logout(); break;
      case 'reload': loadStudents(); break;
    }
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════

function showToast(message, type = 'info', { actionLabel, onAction } = {}) {
  const container = $('toast-container');
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${escapeHtml(message)}</span>`;

  const remove = () => {
    if (toast.classList.contains('removing')) return;
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 250);
  };

  if (actionLabel) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      remove();
      onAction?.();
    });
    toast.appendChild(btn);
  }

  while (container.children.length >= 3) container.firstElementChild.remove();
  container.appendChild(toast);
  setTimeout(remove, actionLabel ? 6000 : 4000);
}

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

function skeletons(count) {
  return Array.from({ length: count }, () => '<div class="skeleton"></div>').join('');
}

function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function avatar(name = '') {
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="avatar" style="--hue:${hue}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
}

function formatPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return digits ? `+${digits}` : '';
}

function formatMoney(value) {
  return `₹${(Number(value) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function formatMonth(month) {
  const [year, mon] = month.split('-');
  return `${MONTH_NAMES[Number(mon) - 1]} ${year}`;
}

function formatDate(dateStr) {
  // 'YYYY-MM-DD' strings are calendar dates — format them without timezone shifting
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (m) return `${Number(m[3])} ${MONTH_NAMES[Number(m[2]) - 1].slice(0, 3)} ${m[1]}`;
  return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

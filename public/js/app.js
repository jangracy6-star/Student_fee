/**
 * FeeFlow — Frontend Application Logic
 * Add students; WhatsApp sends each of them a fee reminder on the 1st of every month.
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ─── State ─────────────────────────────────────────────
const state = {
  user: null,           // signed-in account { id, email, name, role }
  plan: null,           // customer's plan { expiresAt, daysLeft, expired, endingSoon, studentLimit, studentCount, alertDays, contact }
  config: { institution: 'Student Fees', currentMonth: null },
  students: [],
  filter: 'all', // 'all' | 'paid' | 'unpaid'
  studentsLoaded: false,
  wa: { status: null },
  reminders: null,
  settings: null,       // saved settings from the server
  draft: null           // settings being edited on the Settings page
};

let waPollTimer = null;
let qrPollTimer = null;
let reminderPollTimer = null;

const $ = (id) => document.getElementById(id);

// ─── Initialize ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  bindEvents();
  registerServiceWorker();
  try {
    const session = await fetch('/api/session').then(r => r.json());
    if (!session.authenticated) return showLogin();
    state.user = session.user;
  } catch (err) {
    return showLogin('login', 'Could not reach the server. Check your connection and try again.');
  }
  startApp();
}

/** Show the screens for the signed-in account's role */
async function startApp() {
  $('login-screen').hidden = true;
  document.body.dataset.role = state.user.role;

  if (state.user.role === 'admin') {
    $('institution-name').textContent = 'FeeFlow';
    document.title = 'FeeFlow Admin';
    startAdmin();
    return;
  }

  try {
    state.config = await api('/api/config');
  } catch (err) {
    // keep defaults
  }
  setInstitutionName(state.config.institution);
  if (!(await loadPlan())) return; // plan has ended — the plan screen is showing
  loadStudents();
  startWhatsAppPolling();
}

// ═══════════════════════════════════════════════════════
//  PLAN (customer)
// ═══════════════════════════════════════════════════════

/** Load the plan; returns false (and shows the plan-ended screen) if it has ended */
async function loadPlan() {
  try {
    state.plan = await api('/api/plan');
  } catch (err) {
    return !$('plan-screen').hidden ? false : true; // keep going on network errors
  }
  if (state.plan.expired) {
    showPlanScreen();
    return false;
  }
  $('plan-screen').hidden = true;
  renderPlanBanner();
  return true;
}

function showPlanScreen() {
  clearInterval(waPollTimer);
  clearInterval(qrPollTimer);
  while (sheetStack.length) hideTopSheet();
  const plan = state.plan || {};
  const contact = plan.contact || 'us';
  $('plan-screen-text').textContent = `${plan.expiresAt ? `It ended on ${formatDate(plan.expiresAt)}. ` : ''}Contact ${contact} to renew. Your students and settings are kept, and automatic reminders will start again after renewal.`;
  $('plan-contact').href = /@/.test(contact)
    ? `mailto:${contact}?subject=${encodeURIComponent('Renew my FeeFlow plan')}&body=${encodeURIComponent(`Please renew the plan for ${state.user?.email || ''}.`)}`
    : '#';
  $('plan-screen').hidden = false;
}

async function checkPlanAgain() {
  if (await loadPlan()) {
    showToast('Your plan is active again', 'success');
    loadStudents();
    startWhatsAppPolling();
  } else {
    showToast('Your plan is still not renewed', 'warning');
  }
}

function renderPlanBanner() {
  const plan = state.plan;
  const banner = $('plan-banner');
  if (!plan?.endingSoon) {
    banner.hidden = true;
    return;
  }
  const when = plan.daysLeft <= 1 ? 'today' : `in ${plan.daysLeft} days`;
  $('plan-banner-title').textContent = `Your plan ends ${when}`;
  $('plan-banner-text').textContent = `It ends on ${formatDate(plan.expiresAt)}. Contact ${plan.contact} to renew and keep your reminders running.`;
  banner.classList.toggle('danger', plan.daysLeft <= 1);
  banner.hidden = false;
}

function atStudentLimit() {
  const limit = state.plan?.studentLimit;
  return limit !== null && limit !== undefined && state.students.length >= limit;
}

async function showStudentLimit() {
  const limit = state.plan.studentLimit;
  const contact = state.plan.contact;
  const ok = await confirmDialog({
    title: 'Student limit reached',
    message: `Your plan allows ${limit} student${limit === 1 ? '' : 's'}. Contact ${contact} to add more.`,
    confirmLabel: 'Contact us'
  });
  if (ok && /@/.test(contact)) location.href = `mailto:${contact}?subject=${encodeURIComponent('Increase my FeeFlow student limit')}`;
}

function setInstitutionName(name) {
  state.config.institution = name;
  $('institution-name').textContent = name;
  document.title = name;
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

  if (res.status === 402 && data?.code === 'plan_expired') {
    if (state.plan) state.plan.expired = true;
    showPlanScreen();
    throw new Error(data.error);
  }
  if (res.status === 401 && path !== '/api/login') {
    showLogin('login', 'Your session has ended. Please sign in again.');
    throw new Error('Please sign in');
  }
  if (!res.ok) {
    const error = new Error(data?.error || `Request failed (${res.status})`);
    error.code = data?.code;
    throw error;
  }
  return data;
}

// ═══════════════════════════════════════════════════════
//  SIGN IN / REQUEST ACCESS
// ═══════════════════════════════════════════════════════

/** @param {'login'|'request'|'sent'} view */
function showLogin(view = 'login', message = '') {
  clearInterval(waPollTimer);
  clearInterval(qrPollTimer);
  clearTimeout(reminderPollTimer);
  while (sheetStack.length) hideTopSheet();
  delete document.body.dataset.role;
  $('login-screen').hidden = false;
  showAuthView(view);
  if (message) {
    $('login-error').textContent = message;
    $('login-error').hidden = false;
  }
}

function showAuthView(view) {
  $('auth-login').hidden = view !== 'login';
  $('auth-request').hidden = view !== 'request';
  $('auth-request-sent').hidden = view !== 'sent';
  $('login-error').hidden = true;
  $('request-error').hidden = true;
  if (view === 'login') {
    $('no-access').hidden = true;
    setTimeout(() => ($('login-email').value ? $('login-password') : $('login-email')).focus(), 50);
  }
  if (view === 'request') {
    // Carry over the email they tried to sign in with
    if (!$('request-email').value) $('request-email').value = $('login-email').value.trim();
    setTimeout(() => $('request-name').focus(), 50);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const btn = $('btn-login');
  const errorEl = $('login-error');
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  errorEl.hidden = true;
  $('no-access').hidden = true;

  if (!email || !password) {
    errorEl.textContent = 'Enter your email and password';
    errorEl.hidden = false;
    return;
  }

  setLoading(btn, true);
  try {
    const { user } = await api('/api/login', { method: 'POST', body: { email, password } });
    $('login-password').value = '';
    state.user = user;
    startApp();
  } catch (err) {
    if (err.code === 'no_access') {
      $('no-access').hidden = false;
    } else {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  } finally {
    setLoading(btn, false);
  }
}

async function handleAccessRequest(event) {
  event.preventDefault();
  const btn = $('btn-request');
  const errorEl = $('request-error');
  const body = {
    name: $('request-name').value.trim(),
    email: $('request-email').value.trim(),
    phone: $('request-phone').value.trim(),
    message: $('request-message').value.trim()
  };
  errorEl.hidden = true;

  if (!body.name || !body.email) {
    errorEl.textContent = 'Enter your name and email';
    errorEl.hidden = false;
    return;
  }

  setLoading(btn, true);
  try {
    await api('/api/access-requests', { method: 'POST', body });
    $('request-sent-text').textContent = `Thanks, ${body.name}. We'll contact you at ${body.email} when your account is ready.`;
    $('auth-request').reset();
    showAuthView('sent');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

async function logout() {
  // On the plan-ended screen there's nothing to lose, and dialogs would open behind it
  const ask = $('plan-screen').hidden;
  if (ask && !await confirmDialog({ title: 'Log out?', message: 'You can sign in again with your email and password.', confirmLabel: 'Log out' })) return;
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.students = [];
  state.studentsLoaded = false;
  state.wa = { status: null };
  state.reminders = null;
  state.plan = null;
  $('students-list').innerHTML = '';
  $('plan-screen').hidden = true;
  $('plan-banner').hidden = true;
  showLogin();
}

// ─── Change password (any account) ─────────────────────

function openPasswordSheet() {
  $('password-form').reset();
  $('password-username').value = state.user?.email || '';
  $('password-error').hidden = true;
  openSheet('password-sheet');
  if (matchMedia('(hover: hover)').matches) setTimeout(() => $('password-current').focus(), 150);
}

async function savePassword(event) {
  event.preventDefault();
  const errorEl = $('password-error');
  const currentPassword = $('password-current').value;
  const newPassword = $('password-new').value;
  errorEl.hidden = true;

  const problem = !currentPassword ? 'Enter your current password'
    : newPassword.length < 8 ? 'New password must be at least 8 characters'
    : newPassword !== $('password-confirm').value ? "The new passwords don't match"
    : newPassword === currentPassword ? 'Choose a password different from your current one'
    : null;
  if (problem) {
    errorEl.textContent = problem;
    errorEl.hidden = false;
    return;
  }

  const btn = $('btn-save-password');
  setLoading(btn, true);
  try {
    await api('/api/account/password', { method: 'POST', body: { currentPassword, newPassword } });
    await closeSheet();
    showToast('Password updated', 'success');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

function togglePasswordVisibility(btn) {
  const input = $(btn.dataset.target);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
}

// ═══════════════════════════════════════════════════════
//  STUDENTS
// ═══════════════════════════════════════════════════════

async function loadStudents() {
  if (!state.studentsLoaded) $('students-list').innerHTML = skeletons(5);
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
        <div class="empty">
          <svg class="i"><use href="#i-alert"/></svg>
          <p>Couldn't load students</p>
          <small>Check your connection and try again.</small>
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
  const sumFees = (list) => list.reduce((sum, s) => sum + Number(s.fee_amount || 0), 0);
  const collected = sumFees(state.students.filter(s => s.paid));
  const pending = sumFees(state.students.filter(s => !s.paid));

  const limit = state.plan?.studentLimit;
  const countText = limit !== null && limit !== undefined
    ? `${total} of ${limit} students`
    : `${total} student${total === 1 ? '' : 's'}`;
  $('month-label').textContent = state.config.currentMonth ? `${formatMonth(state.config.currentMonth)} · ${countText}` : countText;
  $('stats').hidden = total === 0;
  $('stat-collected').textContent = formatMoney(collected);
  $('stat-pending').textContent = formatMoney(pending);
  $('stat-paid').textContent = `${paidCount}/${total}`;
  $('stat-progress').style.width = total ? `${(paidCount / total) * 100}%` : '0';
  $('stat-progressbar').setAttribute('aria-valuenow', total ? Math.round((paidCount / total) * 100) : 0);
  renderReminderCard(); // "Send now" depends on how many are unpaid
  $('toolbar').hidden = total === 0;
  $('search-bar').hidden = total < 6;
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
      <div class="empty">
        <svg class="i"><use href="#i-users"/></svg>
        <p>No students yet</p>
        <small>Each student you add gets a WhatsApp fee reminder on your chosen days every month.</small>
        <button class="btn btn-primary" data-action="add-student"><svg class="i"><use href="#i-plus"/></svg> Add student</button>
      </div>`;
    return;
  }

  if (students.length === 0) {
    const [icon, title] = query ? ['search', 'No results']
      : state.filter === 'unpaid' ? ['check-circle', 'Everyone has paid']
      : ['users', 'No payments yet this month'];
    list.innerHTML = `<div class="empty"><svg class="i"><use href="#i-${icon}"/></svg><p>${title}</p></div>`;
    return;
  }

  list.innerHTML = `<div class="list">${students.map(s => `
    <div class="row">
      <button class="row-main" data-action="edit-student" data-id="${s.id}" aria-label="Edit ${escapeHtml(s.name)}">
        ${avatar(s.name)}
        <span class="row-text">
          <span class="row-title">${escapeHtml(s.name)}</span>
          <span class="row-meta">${escapeHtml(s.class_name)} · ${formatMoney(s.fee_amount)}</span>
        </span>
      </button>
      <button class="status ${s.paid ? 'paid' : 'unpaid'}" data-action="toggle-paid" data-id="${s.id}" aria-pressed="${!!s.paid}"
        aria-label="${escapeHtml(s.name)}: ${s.paid ? 'paid' : 'unpaid'}. Tap to change."
        title="${s.paid && s.paid_date ? `Paid ${formatDate(s.paid_date)}` : 'Tap to mark paid'}">
        ${s.paid ? '<svg class="i"><use href="#i-check"/></svg>Paid' : 'Unpaid'}
      </button>
    </div>`).join('')}</div>`;
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
      showToast(`${student.name} marked ${paid ? 'paid' : 'unpaid'}`, 'success', {
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
  $('student-sheet-title').textContent = student ? 'Edit student' : 'Add student';
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
    const wasRunning = state.reminders?.running;
    state.reminders = await api('/api/reminders');
    renderReminderCard();
    // While a send is in progress, check back until it finishes
    if (state.reminders.running) {
      reminderPollTimer = setTimeout(loadReminderInfo, 3000);
    } else if (wasRunning && state.reminders.lastRun) {
      const r = state.reminders.lastRun;
      showToast(`Reminder sent to ${r.sent} student${r.sent === 1 ? '' : 's'}${r.failed ? ` · ${r.failed} failed` : ''}`, r.failed ? 'warning' : 'success');
    }
  } catch (err) {
    // keep the last known info
  }
}

function renderReminderCard() {
  const card = $('reminder-card');
  const status = state.wa.status;
  const info = state.reminders;
  const btn = $('btn-connect');
  const title = $('reminder-title');
  const text = $('reminder-text');
  const unpaid = state.students.filter(s => !s.paid).length;

  card.classList.remove('is-on', 'is-off');

  if (isWhatsAppLinked(status)) {
    card.classList.add('is-on');
    if (info?.running) {
      title.textContent = 'Sending…';
      text.textContent = `To ${unpaid} unpaid student${unpaid === 1 ? '' : 's'}`;
    } else if (info && !info.autoEnabled) {
      title.textContent = 'Automatic reminders off';
      text.textContent = 'Turn them on in Settings, or send now';
    } else {
      title.textContent = 'Reminders on';
      text.textContent = info?.nextDate ? `Next on ${formatNextDate(info.nextDate)}` : 'Sent automatically each month';
    }
    setButton(btn, '<svg class="i"><use href="#i-send"/></svg>Send now', 'btn btn-sm btn-primary', 'send-now');
    btn.disabled = !!info?.running || (state.studentsLoaded && unpaid === 0);
    btn.title = unpaid === 0 ? 'Everyone has paid this month' : `Remind ${unpaid} unpaid student${unpaid === 1 ? '' : 's'} now`;
  } else if (status === 'starting') {
    title.textContent = 'Connecting WhatsApp…';
    text.textContent = 'This can take up to a minute';
    setButton(btn, 'View', 'btn btn-sm btn-secondary', 'open-qr');
    btn.disabled = false;
  } else if (status) {
    card.classList.add('is-off');
    title.textContent = 'Reminders paused';
    text.textContent = 'Connect WhatsApp to send them';
    setButton(btn, 'Connect', 'btn btn-sm btn-primary', 'open-qr');
    btn.disabled = false;
  }

  const last = $('reminder-last');
  if (info?.lastRun && !info.running) {
    const r = info.lastRun;
    last.textContent = `Last sent ${formatDate(r.at, true)} · ${r.sent} delivered${r.failed ? `, ${r.failed} failed` : ''}`;
    last.hidden = false;
  } else {
    last.hidden = true;
  }

  renderSettingsWhatsApp();
}

/** Linked WhatsApp can send: either open right now or saved and opened on demand */
function isWhatsAppLinked(status) {
  return status === 'connected' || status === 'linked';
}

/** Update a button only when something changed, so a tap mid-refresh isn't lost */
function setButton(btn, html, className, action) {
  if (btn.dataset.html !== html) {
    btn.innerHTML = html;
    btn.dataset.html = html;
  }
  if (btn.className !== className) btn.className = className;
  btn.dataset.action = action;
}

/** "Today", "Tomorrow" or "20 Oct" */
function formatNextDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((target - today) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return formatDate(dateStr, true);
}

/** Send this month's reminder to everyone who hasn't paid, after confirming */
async function sendNow() {
  const unpaid = state.students.filter(s => !s.paid);
  if (unpaid.length === 0) return showToast('Everyone has paid this month', 'success');

  const names = unpaid.slice(0, 3).map(s => s.name).join(', ') + (unpaid.length > 3 ? ` and ${unpaid.length - 3} more` : '');
  const ok = await confirmDialog({
    title: `Send to ${unpaid.length} unpaid student${unpaid.length === 1 ? '' : 's'}?`,
    message: `${names} will get the reminder on WhatsApp now.`,
    confirmLabel: 'Send now'
  });
  if (!ok) return;

  try {
    const result = await api('/api/reminders/send-now', { method: 'POST' });
    if (!result.count) return showToast(result.message || 'Everyone has paid this month', 'success');
    showToast(`Sending to ${result.count} student${result.count === 1 ? '' : 's'}…`, 'info');
    state.reminders = { ...(state.reminders || {}), running: true };
    renderReminderCard();
    reminderPollTimer = setTimeout(loadReminderInfo, 2000);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════
//  SETTINGS PAGE
// ═══════════════════════════════════════════════════════

async function openSettings() {
  try {
    state.settings = await api('/api/settings');
  } catch (err) {
    return showToast(err.message || 'Could not load settings', 'error');
  }
  state.draft = {
    institutionName: state.settings.institutionName || '',
    autoEnabled: state.settings.autoEnabled,
    reminderDays: [...state.settings.reminderDays],
    messageTemplate: state.settings.messageTemplate
  };
  $('set-institution').value = state.draft.institutionName;
  $('set-institution').placeholder = state.settings.account?.name || 'e.g., Bright Future Academy';
  $('set-account-email').textContent = state.settings.account?.email || state.user?.email || '—';
  const plan = state.plan;
  $('set-account-plan').textContent = !plan ? '—'
    : [plan.expiresAt ? `Ends ${formatDate(plan.expiresAt)}` : 'No end date',
       plan.studentLimit !== null && plan.studentLimit !== undefined ? `${plan.studentLimit} students` : 'unlimited students'].join(' · ');
  $('set-auto').checked = state.draft.autoEnabled;
  $('set-message').value = state.draft.messageTemplate;
  $('settings-error').hidden = true;
  renderDayGrid();
  renderSettingsState();
  renderSettingsWhatsApp();
  openSheet('settings-screen');
}

function renderDayGrid() {
  $('day-grid').innerHTML = Array.from({ length: 31 }, (_, i) => {
    const day = i + 1;
    const selected = state.draft.reminderDays.includes(day);
    return `<button class="day ${selected ? 'selected' : ''}" data-action="toggle-day" data-day="${day}" aria-pressed="${selected}">${day}</button>`;
  }).join('');
}

function renderSettingsState() {
  const draft = state.draft;
  const days = draft.reminderDays;

  $('days-block').classList.toggle('disabled', !draft.autoEnabled);
  $('days-summary').textContent = days.length
    ? `Every month on the ${joinWords(days.map(ordinal))}${days.some(d => d > 28) ? '. In shorter months, days past the end move to the last day.' : ''}`
    : 'Pick at least one day';

  renderMessagePreview();

  const saved = state.settings;
  const dirty = draft.institutionName.trim() !== (saved.institutionName || '') ||
    draft.autoEnabled !== saved.autoEnabled ||
    draft.messageTemplate.trim() !== saved.messageTemplate ||
    draft.reminderDays.join() !== saved.reminderDays.join();
  $('btn-save-settings').disabled = !dirty || (draft.autoEnabled && days.length === 0) || !draft.messageTemplate.trim();
}

function renderMessagePreview() {
  const sample = state.students.find(s => !s.paid) || state.students[0] || { name: 'Ravi Kumar', fee_amount: 3000 };
  const values = {
    name: sample.name,
    fee: formatMoney(sample.fee_amount),
    month: state.config.currentMonth ? formatMonth(state.config.currentMonth) : 'this month',
    institution: state.draft.institutionName.trim() || state.settings?.account?.name || state.config.institution
  };
  const filled = state.draft.messageTemplate.replace(/\{(name|fee|month|institution)\}/gi, (_, key) => values[key.toLowerCase()]);
  // Show WhatsApp-style formatting: *bold* and _italic_
  $('message-preview').innerHTML = escapeHtml(filled)
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>') || '<span class="text-muted">Your message will appear here</span>';
}

function renderSettingsWhatsApp() {
  const status = state.wa.status;
  const dot = $('set-wa-dot');
  if (!dot) return;
  const linked = isWhatsAppLinked(status);
  dot.className = `dot ${linked ? 'on' : status ? 'off' : ''}`;
  $('set-wa-text').textContent = linked ? 'Linked'
    : status === 'starting' ? 'Connecting…' : status ? 'Not linked' : 'Checking…';
  $('set-wa-btn').textContent = linked ? 'Manage' : 'Connect';
}

function toggleDay(day) {
  const days = state.draft.reminderDays;
  state.draft.reminderDays = days.includes(day) ? days.filter(d => d !== day) : [...days, day].sort((a, b) => a - b);
  renderDayGrid();
  renderSettingsState();
}

function insertTag(tag) {
  const area = $('set-message');
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? area.value.length;
  area.setRangeText(tag, start, end, 'end');
  area.focus();
  state.draft.messageTemplate = area.value;
  renderSettingsState();
}

function resetMessage() {
  $('set-message').value = state.settings.defaultTemplate;
  state.draft.messageTemplate = state.settings.defaultTemplate;
  renderSettingsState();
}

async function saveSettings() {
  const btn = $('btn-save-settings');
  const errorEl = $('settings-error');
  errorEl.hidden = true;
  setLoading(btn, true);
  try {
    const saved = await api('/api/settings', { method: 'PUT', body: state.draft });
    state.settings = { ...state.settings, ...saved };
    state.draft = {
      institutionName: saved.institutionName || '',
      autoEnabled: saved.autoEnabled,
      reminderDays: [...saved.reminderDays],
      messageTemplate: saved.messageTemplate
    };
    $('set-message').value = saved.messageTemplate;
    $('set-institution').value = state.draft.institutionName;
    setInstitutionName(saved.institution);
    showToast('Settings saved', 'success');
    loadReminderInfo();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    setLoading(btn, false);
    renderSettingsState();
  }
}

async function closeSettings() {
  if (!$('btn-save-settings').disabled) {
    const discard = await confirmDialog({ title: 'Discard changes?', message: 'Your changes to the settings haven\'t been saved.', confirmLabel: 'Discard', danger: true });
    if (!discard) return;
  }
  closeSheet();
}

function ordinal(n) {
  const suffix = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

function joinWords(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
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
    const connected = isWhatsAppLinked(data.status);
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
          <svg class="i ok"><use href="#i-check-circle"/></svg>
          <p>WhatsApp is linked</p>
          <small>Reminders are sent from this WhatsApp on the days you chose in Settings.</small>
        </div>`;
    } else {
      content.innerHTML = `
        <div class="qr-state">
          <div class="spinner"></div>
          <p>${escapeHtml(data.status === 'busy' ? 'Please wait a moment' : (data.message || 'Preparing your QR code…'))}</p>
          <small>${escapeHtml(data.status === 'busy' ? data.message : 'This can take up to a minute.')}</small>
        </div>`;
    }
  } catch (err) {
    content.innerHTML = `
      <div class="qr-state">
        <svg class="i warn"><use href="#i-alert"/></svg>
        <p>Couldn't reach the server</p>
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
  $('auth-login').addEventListener('submit', handleLogin);
  $('auth-request').addEventListener('submit', handleAccessRequest);
  $('password-form').addEventListener('submit', savePassword);
  bindAdminEvents();
  $('student-form').addEventListener('submit', saveStudent);
  $('btn-confirm-ok').addEventListener('click', () => answerConfirm(true));
  $('btn-confirm-cancel').addEventListener('click', () => answerConfirm(false));
  $('student-search').addEventListener('input', renderStudents);
  $('set-message').addEventListener('input', (e) => {
    state.draft.messageTemplate = e.target.value;
    renderSettingsState();
  });
  $('set-institution').addEventListener('input', (e) => {
    state.draft.institutionName = e.target.value;
    renderSettingsState();
  });
  $('set-auto').addEventListener('change', (e) => {
    state.draft.autoEnabled = e.target.checked;
    renderSettingsState();
  });
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
    const top = sheetStack[sheetStack.length - 1];
    if (top === 'confirm-sheet') answerConfirm(false);
    else if (top === 'settings-screen') closeSettings();
    else closeSheet();
  });

  // Refresh when coming back to the app
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && $('login-screen').hidden && state.user?.role === 'customer') {
      loadPlan().then(active => {
        if (!active) return;
        updateWhatsAppStatus();
        loadStudents();
      });
    } else if (!document.hidden && state.user?.role === 'admin') {
      loadAdmin();
    }
  });

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;

    switch (el.dataset.action) {
      case 'add-student': atStudentLimit() ? showStudentLimit() : openStudentForm(); break;
      case 'check-plan': checkPlanAgain(); break;
      case 'edit-student': {
        const student = state.students.find(s => s.id === Number(el.dataset.id));
        if (student) openStudentForm(student);
        break;
      }
      case 'delete-student': deleteStudent(); break;
      case 'toggle-paid': togglePaid(Number(el.dataset.id)); break;
      case 'close-sheet': closeSheet(); break;
      case 'open-qr': openQRSheet(); break;
      case 'send-now': sendNow(); break;
      case 'open-settings': openSettings(); break;
      case 'close-settings': closeSettings(); break;
      case 'toggle-day': toggleDay(Number(el.dataset.day)); break;
      case 'insert-tag': insertTag(el.dataset.tag); break;
      case 'reset-message': resetMessage(); break;
      case 'save-settings': saveSettings(); break;
      case 'wa-logout': whatsappLogout(); break;
      case 'logout': logout(); break;
      case 'show-request': showAuthView('request'); break;
      case 'show-login': showAuthView('login'); break;
      case 'toggle-password': togglePasswordVisibility(el); break;
      case 'open-password': openPasswordSheet(); break;
      default: handleAdminAction(el.dataset.action, el); break;
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
  const icons = { success: 'check-circle', error: 'alert', warning: 'alert', info: 'send' };

  const toast = document.createElement('div');
  toast.className = `toast ${type}${actionLabel ? ' has-action' : ''}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<span class="toast-icon"><svg class="i"><use href="#i-${icons[type] || 'alert'}"/></svg></span>` +
    `<span class="toast-msg">${escapeHtml(message)}</span>`;

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
  const row = `
    <div class="skeleton-row">
      <span class="sk" style="width:36px;height:36px;border-radius:50%"></span>
      <span style="flex:1;display:grid;gap:6px"><span class="sk" style="width:45%;height:12px"></span><span class="sk" style="width:30%;height:10px"></span></span>
      <span class="sk" style="width:72px;height:28px;border-radius:14px"></span>
    </div>`;
  return `<div class="list">${row.repeat(count)}</div>`;
}

function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function avatar(name = '') {
  return `<span class="avatar" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
}

function formatMoney(value) {
  return `₹${(Number(value) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function formatMonth(month) {
  const [year, mon] = month.split('-');
  return `${MONTH_NAMES[Number(mon) - 1]} ${year}`;
}

/** "1 Nov 2026"; with `short`, the year is dropped when it's the current year */
function formatDate(dateStr, short = false) {
  // 'YYYY-MM-DD' strings are calendar dates — read them without timezone shifting
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const date = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(dateStr);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(short && sameYear ? {} : { year: 'numeric' }) });
}

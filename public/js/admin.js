/**
 * FeeFlow — Admin page
 * Add the customers who bought FeeFlow, reset passwords, turn access on/off,
 * and handle access requests. Uses the shared helpers in app.js (api, sheets, toasts…).
 */

const adminState = {
  customers: [],
  requests: [],
  tab: 'customers',    // 'customers' | 'requests'
  loaded: false,
  credentials: ''      // sign-in details shown once after adding a customer
};

function startAdmin() {
  $('account-email').textContent = state.user.email;
  loadAdmin();
}

async function loadAdmin() {
  if (!adminState.loaded) $('admin-list').innerHTML = skeletons(4);
  try {
    const data = await api('/api/admin/overview');
    adminState.customers = data.customers;
    adminState.requests = data.requests;
    adminState.loaded = true;
    renderAdmin();
  } catch (err) {
    showToast(err.message || 'Could not load customers', 'error');
    if (!adminState.loaded) {
      $('admin-list').innerHTML = `
        <div class="empty">
          <svg class="i"><use href="#i-alert"/></svg>
          <p>Couldn't load customers</p>
          <small>${escapeHtml(err.message)}</small>
          <button class="btn btn-secondary" data-action="reload-admin">Try again</button>
        </div>`;
    }
  }
}

function renderAdmin() {
  const { customers, requests, tab } = adminState;
  const active = customers.filter(c => c.active).length;
  const query = $('admin-search').value.trim().toLowerCase();

  $('admin-title').textContent = tab === 'customers' ? 'Customers' : 'Access requests';
  $('admin-subtitle').textContent = tab === 'customers'
    ? `${customers.length} customer${customers.length === 1 ? '' : 's'} · ${active} with access`
    : requests.length ? `${requests.length} waiting for a reply` : 'Nothing waiting';
  $('count-customers').textContent = customers.length;
  const countRequests = $('count-requests');
  countRequests.textContent = requests.length;
  countRequests.classList.toggle('has-new', requests.length > 0);
  document.querySelectorAll('#admin-tabs .segment').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('admin-search-bar').hidden = (tab === 'customers' ? customers.length : requests.length) < 6;

  const matches = (...fields) => !query || fields.some(f => (f || '').toLowerCase().includes(query));
  const list = $('admin-list');

  if (tab === 'customers') {
    const rows = customers.filter(c => matches(c.name, c.email));
    if (customers.length === 0) {
      list.innerHTML = `
        <div class="empty">
          <svg class="i"><use href="#i-users"/></svg>
          <p>No customers yet</p>
          <small>Add the email of someone who bought FeeFlow and give them a password.</small>
          <button class="btn btn-primary" data-action="add-customer"><svg class="i"><use href="#i-plus"/></svg> Add customer</button>
        </div>`;
      return;
    }
    if (rows.length === 0) {
      list.innerHTML = '<div class="empty"><svg class="i"><use href="#i-search"/></svg><p>No results</p></div>';
      return;
    }
    list.innerHTML = `<div class="list">${rows.map(c => `
      <div class="row">
        <button class="row-main" data-action="edit-customer" data-id="${c.id}" aria-label="Edit ${escapeHtml(c.name || c.email)}">
          ${avatar(c.name || c.email)}
          <span class="row-text">
            <span class="row-title">${escapeHtml(c.name || c.email)}</span>
            <span class="row-meta">${c.studentCount} student${c.studentCount === 1 ? '' : 's'} · ${escapeHtml(c.email)}</span>
          </span>
        </button>
        <span class="access-pill ${c.active ? 'on' : 'off'}">${c.active ? 'Active' : 'Off'}</span>
      </div>`).join('')}</div>`;
    return;
  }

  const rows = requests.filter(r => matches(r.name, r.email, r.phone, r.message));
  if (requests.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <svg class="i"><use href="#i-mail"/></svg>
        <p>No access requests</p>
        <small>When someone without an account asks for access from the sign-in page, they'll appear here.</small>
      </div>`;
    return;
  }
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty"><svg class="i"><use href="#i-search"/></svg><p>No results</p></div>';
    return;
  }
  list.innerHTML = `<div class="list">${rows.map(r => `
    <div class="request">
      <div class="request-top">
        <span class="request-name">${escapeHtml(r.name)}</span>
        <span class="request-time">${escapeHtml(timeAgo(r.created_at))}</span>
      </div>
      <div class="request-contact">${escapeHtml(r.email)}${r.phone ? ` · ${escapeHtml(r.phone)}` : ''}</div>
      ${r.message ? `<div class="request-message">${escapeHtml(r.message)}</div>` : ''}
      <div class="request-actions">
        <button class="btn btn-sm btn-secondary" data-action="dismiss-request" data-id="${r.id}">Dismiss</button>
        <button class="btn btn-sm btn-primary" data-action="approve-request" data-id="${r.id}">Give access</button>
      </div>
    </div>`).join('')}</div>`;
}

// ─── Add / edit customer ───────────────────────────────

function openCustomerSheet(customer = null, prefill = {}) {
  const form = $('customer-form');
  form.reset();
  $('customer-error').hidden = true;
  $('customer-id').value = customer?.id || '';
  $('customer-sheet-title').textContent = customer ? (customer.name || customer.email) : 'Add customer';
  $('customer-name').value = customer?.name || prefill.name || '';
  $('customer-email').value = customer?.email || prefill.email || '';
  $('customer-email').readOnly = !!customer;
  $('customer-password-label').textContent = customer ? 'Reset password' : 'Password';
  $('customer-password-hint').textContent = customer
    ? 'Leave empty to keep their current password. Setting one signs them out everywhere.'
    : "At least 8 characters. You'll share it with the customer.";
  $('customer-password').value = customer ? '' : generatePassword();
  $('btn-save-customer').textContent = customer ? 'Save' : 'Add customer';
  $('btn-delete-customer').hidden = !customer;
  $('customer-meta').hidden = !customer;

  if (customer) {
    $('customer-active').checked = customer.active;
    renderCustomerAccessText();
    $('customer-meta-line').textContent = [
      `${customer.studentCount} student${customer.studentCount === 1 ? '' : 's'}`,
      `added ${formatDate(customer.created_at)}`,
      customer.last_login_at ? `last signed in ${timeAgo(customer.last_login_at)}` : 'never signed in'
    ].join(' · ');
  }

  openSheet('customer-sheet');
  if (!customer && matchMedia('(hover: hover)').matches) {
    setTimeout(() => $(prefill.name ? 'customer-password' : 'customer-name').focus(), 150);
  }
}

function renderCustomerAccessText() {
  $('customer-access-text').textContent = $('customer-active').checked
    ? 'Can sign in and send reminders'
    : 'Signed out and can’t sign in; reminders stop';
}

async function saveCustomer(event) {
  event.preventDefault();
  const id = $('customer-id').value;
  const errorEl = $('customer-error');
  const name = $('customer-name').value.trim();
  const email = $('customer-email').value.trim().toLowerCase();
  const password = $('customer-password').value.trim();
  errorEl.hidden = true;

  const problem = !name ? 'Enter the customer’s name or institute'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Enter a valid email address'
    : (!id || password) && password.length < 8 ? 'Password must be at least 8 characters'
    : null;
  if (problem) {
    errorEl.textContent = problem;
    errorEl.hidden = false;
    return;
  }

  const btn = $('btn-save-customer');
  setLoading(btn, true);
  try {
    if (id) {
      const body = { name, active: $('customer-active').checked };
      if (password) body.password = password;
      await api(`/api/admin/customers/${id}`, { method: 'PUT', body });
      await closeSheet();
      showToast(password ? `${name} updated · new password set` : `${name} updated`, 'success');
      if (password) showCredentials(email, password, 'New password set');
    } else {
      await api('/api/admin/customers', { method: 'POST', body: { name, email, password } });
      await closeSheet();
      showCredentials(email, password, 'Customer added');
    }
    loadAdmin();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

async function deleteCustomer() {
  const customer = adminState.customers.find(c => c.id === $('customer-id').value);
  if (!customer) return;
  const ok = await confirmDialog({
    title: `Delete ${customer.name || customer.email}?`,
    message: `This permanently deletes their account, ${customer.studentCount} student${customer.studentCount === 1 ? '' : 's'}, payment history and settings. To only stop their access, turn Access off instead.`,
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) return;

  try {
    await api(`/api/admin/customers/${customer.id}`, { method: 'DELETE' });
    await closeSheet();
    showToast(`${customer.name || customer.email} deleted`, 'success');
    loadAdmin();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/** Readable random password (no look-alike characters) */
function generatePassword(length = 12) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const values = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(values, v => chars[v % chars.length]).join('');
}

// ─── Sign-in details to share ──────────────────────────

function showCredentials(email, password, title) {
  adminState.credentials = [
    'Your FeeFlow account is ready.',
    '',
    `Sign in: ${location.origin}`,
    `Email: ${email}`,
    `Password: ${password}`,
    '',
    'You can change your password in Settings after signing in.'
  ].join('\n');
  $('credentials-title').textContent = title;
  $('credentials-text').textContent = adminState.credentials;
  openSheet('credentials-sheet');
}

async function copyCredentials() {
  try {
    await navigator.clipboard.writeText(adminState.credentials);
    showToast('Copied — paste it into WhatsApp or email', 'success');
  } catch (err) {
    // Clipboard blocked: select the text so it can be copied by hand
    const range = document.createRange();
    range.selectNodeContents($('credentials-text'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    showToast('Press and hold the text to copy it', 'info');
  }
}

// ─── Access requests ───────────────────────────────────

function approveRequest(id) {
  const request = adminState.requests.find(r => r.id === id);
  if (request) openCustomerSheet(null, { name: request.name, email: request.email });
}

async function dismissRequest(id) {
  const request = adminState.requests.find(r => r.id === id);
  if (!request) return;
  const ok = await confirmDialog({
    title: 'Dismiss this request?',
    message: `${request.name} (${request.email}) won't get access. They can ask again later.`,
    confirmLabel: 'Dismiss'
  });
  if (!ok) return;
  try {
    await api(`/api/admin/requests/${id}/dismiss`, { method: 'POST' });
    adminState.requests = adminState.requests.filter(r => r.id !== id);
    renderAdmin();
    showToast('Request dismissed', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Wiring ────────────────────────────────────────────

function bindAdminEvents() {
  $('customer-form').addEventListener('submit', saveCustomer);
  $('customer-active').addEventListener('change', renderCustomerAccessText);
  $('admin-search').addEventListener('input', renderAdmin);
  document.querySelectorAll('#admin-tabs .segment').forEach(b => b.addEventListener('click', () => {
    adminState.tab = b.dataset.tab;
    $('admin-search').value = '';
    renderAdmin();
  }));
}

/** Click actions from app.js's delegated handler that belong to the admin page */
function handleAdminAction(action, el) {
  switch (action) {
    case 'add-customer': openCustomerSheet(); break;
    case 'edit-customer': {
      const customer = adminState.customers.find(c => c.id === el.dataset.id);
      if (customer) openCustomerSheet(customer);
      break;
    }
    case 'delete-customer': deleteCustomer(); break;
    case 'generate-password': $('customer-password').value = generatePassword(); break;
    case 'copy-credentials': copyCredentials(); break;
    case 'approve-request': approveRequest(Number(el.dataset.id)); break;
    case 'dismiss-request': dismissRequest(Number(el.dataset.id)); break;
    case 'open-account': openSheet('account-sheet'); break;
    case 'reload-admin': loadAdmin(); break;
  }
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", or a date */
function timeAgo(dateStr) {
  const seconds = Math.round((Date.now() - new Date(dateStr)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 7 * 86400) {
    const days = Math.floor(seconds / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return formatDate(dateStr);
}

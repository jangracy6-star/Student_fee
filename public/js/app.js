/**
 * FeeFlow — Frontend Application Logic
 * Handles API calls, DOM updates, and user interactions
 */

const API_BASE = '';  // Same origin

// ─── State ─────────────────────────────────────────────
let studentsData = [];
let feeRecords = [];
let deleteTargetId = null;
let waStatusInterval = null;

// ─── Initialize ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMonthPicker();
  loadStudents();
  loadFeeRecords();
  loadActivities();
  startWhatsAppPolling();
});

// ═══════════════════════════════════════════════════════
//  TAB NAVIGATION
// ═══════════════════════════════════════════════════════

function switchTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

  // Update content sections
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`content-${tabName}`).classList.add('active');

  // Reload data for the activated tab
  if (tabName === 'students') loadStudents();
  if (tabName === 'fees') loadFeeRecords();
  if (tabName === 'activity') loadActivities();
}

// ═══════════════════════════════════════════════════════
//  MONTH PICKER
// ═══════════════════════════════════════════════════════

function initMonthPicker() {
  const picker = document.getElementById('month-picker');
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  picker.value = currentMonth;
}

function getSelectedMonth() {
  return document.getElementById('month-picker').value;
}

// ═══════════════════════════════════════════════════════
//  STUDENT MANAGEMENT
// ═══════════════════════════════════════════════════════

async function loadStudents() {
  try {
    const res = await fetch(`${API_BASE}/api/students`);
    if (!res.ok) throw new Error('Failed to load students');
    studentsData = await res.json();
    renderStudents(studentsData);
    document.getElementById('total-students-count').textContent = studentsData.length;
  } catch (err) {
    console.error('Error loading students:', err);
    showToast('Failed to load students', 'error');
  }
}

function renderStudents(students) {
  const tbody = document.getElementById('students-tbody');

  if (students.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
            </svg>
            <p>No students found</p>
            <small>Click "Add Student" to get started</small>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = students.map((s, i) => `
    <tr>
      <td data-label="#">${i + 1}</td>
      <td data-label="Name"><span class="student-name">${escapeHtml(s.name)}</span></td>
      <td data-label="Phone"><span class="student-phone">${escapeHtml(s.phone)}</span></td>
      <td data-label="Class">${escapeHtml(s.class_name)}</td>
      <td data-label="Monthly Fee"><span class="fee-amount">₹${Number(s.fee_amount).toLocaleString('en-IN')}</span></td>
      <td data-label="Actions">
        <div class="action-group">
          <button class="btn btn-sm btn-icon btn-edit" onclick="editStudent(${s.id})" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-sm btn-icon btn-delete" onclick="promptDelete(${s.id}, '${escapeHtml(s.name)}')" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function filterStudents() {
  const query = document.getElementById('student-search').value.toLowerCase();
  const filtered = studentsData.filter(s =>
    s.name.toLowerCase().includes(query) ||
    s.phone.includes(query) ||
    s.class_name.toLowerCase().includes(query)
  );
  renderStudents(filtered);
}

// ─── Student Modal ─────────────────────────────────────

function openStudentModal(student = null) {
  const modal = document.getElementById('student-modal');
  const title = document.getElementById('student-modal-title');
  const form = document.getElementById('student-form');

  form.reset();
  document.getElementById('student-edit-id').value = '';

  if (student) {
    title.textContent = 'Edit Student';
    document.getElementById('student-edit-id').value = student.id;
    document.getElementById('input-name').value = student.name;
    document.getElementById('input-phone').value = student.phone;
    document.getElementById('input-class').value = student.class_name;
    document.getElementById('input-fee').value = student.fee_amount;
  } else {
    title.textContent = 'Add New Student';
  }

  modal.classList.add('show');
  setTimeout(() => document.getElementById('input-name').focus(), 100);
}

function closeStudentModal() {
  document.getElementById('student-modal').classList.remove('show');
}

async function editStudent(id) {
  const student = studentsData.find(s => s.id === id);
  if (student) openStudentModal(student);
}

async function saveStudent(event) {
  event.preventDefault();

  const editId = document.getElementById('student-edit-id').value;
  const payload = {
    name: document.getElementById('input-name').value.trim(),
    phone: document.getElementById('input-phone').value.trim(),
    class_name: document.getElementById('input-class').value.trim(),
    fee_amount: parseFloat(document.getElementById('input-fee').value)
  };

  if (!payload.name || !payload.phone || !payload.class_name || isNaN(payload.fee_amount)) {
    showToast('Please fill all fields correctly', 'warning');
    return;
  }

  try {
    let res;
    if (editId) {
      res = await fetch(`${API_BASE}/api/students/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(`${API_BASE}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save');
    }

    closeStudentModal();
    showToast(editId ? `${payload.name} updated successfully` : `${payload.name} added successfully`, 'success');
    loadStudents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Delete Student ────────────────────────────────────

function promptDelete(id, name) {
  deleteTargetId = id;
  document.getElementById('confirm-text').textContent = `Are you sure you want to delete "${name}"? This will also remove all their fee records.`;
  document.getElementById('confirm-modal').classList.add('show');
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.remove('show');
  deleteTargetId = null;
}

async function confirmDelete() {
  if (!deleteTargetId) return;

  try {
    const res = await fetch(`${API_BASE}/api/students/${deleteTargetId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete');

    closeConfirmModal();
    showToast('Student deleted successfully', 'success');
    loadStudents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════
//  FEE MANAGEMENT
// ═══════════════════════════════════════════════════════

async function loadFeeRecords() {
  const month = getSelectedMonth();
  if (!month) return;

  try {
    const res = await fetch(`${API_BASE}/api/fees?month=${month}`);
    if (!res.ok) throw new Error('Failed to load fee records');

    const data = await res.json();
    feeRecords = data.records;
    renderFeeRecords(feeRecords);
    updateFeeSummary(data.summary);
  } catch (err) {
    console.error('Error loading fees:', err);
    showToast('Failed to load fee records', 'error');
  }
}

function renderFeeRecords(records) {
  const tbody = document.getElementById('fees-tbody');

  if (records.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
              <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
            </svg>
            <p>No fee records for this month</p>
            <small>Click "Generate Records" to create entries for all students</small>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = records.map((r, i) => {
    const student = r.students || {};
    const isPaid = r.status === 'paid';
    const paidDate = r.paid_date ? new Date(r.paid_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
    const newStatus = isPaid ? 'unpaid' : 'paid';
    const toggleClass = isPaid ? 'mark-unpaid' : 'mark-paid';
    const toggleLabel = isPaid ? 'Mark Unpaid' : 'Mark Paid';

    return `
      <tr>
        <td data-label="#">${i + 1}</td>
        <td data-label="Student Name"><span class="student-name">${escapeHtml(student.name || 'N/A')}</span></td>
        <td data-label="Phone"><span class="student-phone">${escapeHtml(student.phone || 'N/A')}</span></td>
        <td data-label="Class">${escapeHtml(student.class_name || 'N/A')}</td>
        <td data-label="Fee Amount"><span class="fee-amount">₹${Number(student.fee_amount || 0).toLocaleString('en-IN')}</span></td>
        <td data-label="Status">
          <span class="status-badge ${isPaid ? 'paid' : 'unpaid'}">
            ${isPaid ? '✅' : '❌'} ${r.status.charAt(0).toUpperCase() + r.status.slice(1)}
          </span>
        </td>
        <td data-label="Paid Date">${paidDate}</td>
        <td data-label="Action">
          <button class="btn btn-sm btn-toggle ${toggleClass}" onclick="toggleFeeStatus(${r.id}, '${newStatus}')">
            ${toggleLabel}
          </button>
        </td>
      </tr>`;
  }).join('');
}

function updateFeeSummary(summary) {
  document.getElementById('fee-total').textContent = summary.total;
  document.getElementById('fee-paid').textContent = summary.paid;
  document.getElementById('fee-unpaid').textContent = summary.unpaid;
  document.getElementById('fee-collected').textContent = `₹${Number(summary.collected).toLocaleString('en-IN')}`;
  document.getElementById('fee-pending').textContent = `₹${Number(summary.pending).toLocaleString('en-IN')}`;
}

async function generateFees() {
  const month = getSelectedMonth();
  if (!month) {
    showToast('Please select a month', 'warning');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/fees/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month })
    });

    if (!res.ok) throw new Error('Failed to generate records');
    const data = await res.json();
    showToast(`Created ${data.created} records, skipped ${data.skipped}`, 'success');
    loadFeeRecords();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function toggleFeeStatus(recordId, newStatus) {
  try {
    const res = await fetch(`${API_BASE}/api/fees/${recordId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });

    if (!res.ok) throw new Error('Failed to update status');
    const emoji = newStatus === 'paid' ? '✅' : '❌';
    showToast(`Status updated to ${emoji} ${newStatus}`, 'success');
    loadFeeRecords();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════
//  WHATSAPP
// ═══════════════════════════════════════════════════════

function startWhatsAppPolling() {
  updateWhatsAppStatus();
  waStatusInterval = setInterval(updateWhatsAppStatus, 5000);
}

async function updateWhatsAppStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/whatsapp/status`);
    if (!res.ok) return;
    const data = await res.json();

    const dot = document.getElementById('wa-dot');
    const text = document.getElementById('wa-status-text');

    dot.className = 'status-dot';
    if (data.status === 'connected') {
      dot.classList.add('connected');
      text.textContent = 'WhatsApp Connected';
    } else if (data.status === 'qr_ready' || data.status === 'connecting') {
      dot.classList.add('connecting');
      text.textContent = data.status === 'qr_ready' ? 'Scan QR Code' : 'Connecting...';
    } else {
      dot.classList.add('disconnected');
      text.textContent = 'WhatsApp Offline';
    }
  } catch (err) {
    // Server might not be running
  }
}

// ─── QR Modal ──────────────────────────────────────────

async function openQRModal() {
  const modal = document.getElementById('qr-modal');
  const content = document.getElementById('qr-content');
  modal.classList.add('show');

  // Show loading state
  content.innerHTML = `
    <div class="qr-loading">
      <div class="spinner"></div>
      <p>Loading QR code...</p>
    </div>`;

  try {
    const res = await fetch(`${API_BASE}/api/whatsapp/qr`);
    const data = await res.json();

    if (data.qr) {
      content.innerHTML = `<img src="${data.qr}" alt="WhatsApp QR Code" width="280" height="280" />`;
    } else if (data.message) {
      content.innerHTML = `
        <div class="qr-loading">
          <p style="font-size: 42px;">✅</p>
          <p>${data.message}</p>
        </div>`;
    }
  } catch (err) {
    content.innerHTML = `
      <div class="qr-loading">
        <p style="font-size: 42px;">⚠️</p>
        <p>Could not load QR code</p>
        <small>Make sure the server is running</small>
      </div>`;
  }
}

function closeQRModal() {
  document.getElementById('qr-modal').classList.remove('show');
}

// ─── Send Reminders ────────────────────────────────────

async function sendReminders() {
  const month = getSelectedMonth();
  if (!month) {
    showToast('Please select a month', 'warning');
    return;
  }

  // Check WhatsApp status first
  try {
    const statusRes = await fetch(`${API_BASE}/api/whatsapp/status`);
    const statusData = await statusRes.json();
    if (statusData.status !== 'connected') {
      showToast('WhatsApp is not connected. Please scan the QR code first.', 'warning');
      openQRModal();
      return;
    }
  } catch (err) {
    showToast('Cannot check WhatsApp status', 'error');
    return;
  }

  // Confirm before sending
  const unpaidCount = feeRecords.filter(r => r.status === 'unpaid').length;
  if (unpaidCount === 0) {
    showToast('No unpaid students for this month!', 'info');
    return;
  }

  if (!confirm(`Send WhatsApp reminders to ${unpaidCount} unpaid student(s)?`)) return;

  showToast(`Sending reminders to ${unpaidCount} students...`, 'info');

  try {
    const res = await fetch(`${API_BASE}/api/whatsapp/send-reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to send reminders');
    }

    const data = await res.json();
    showToast(`✅ Sent: ${data.sent} | ❌ Failed: ${data.failed}`, data.failed > 0 ? 'warning' : 'success');
    loadActivities();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════
//  ACTIVITY LOG
// ═══════════════════════════════════════════════════════

async function loadActivities() {
  try {
    const res = await fetch(`${API_BASE}/api/activities?limit=30`);
    if (!res.ok) throw new Error('Failed to load activities');
    const activities = await res.json();
    renderActivities(activities);
  } catch (err) {
    console.error('Error loading activities:', err);
  }
}

function renderActivities(activities) {
  const container = document.getElementById('activity-list');

  if (activities.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        <p>No activities recorded yet</p>
        <small>Actions will appear here as you use the system</small>
      </div>`;
    return;
  }

  container.innerHTML = activities.map(a => {
    const dotClass = getActivityDotClass(a.action);
    const timeAgo = formatTimeAgo(a.created_at);

    return `
      <div class="activity-item">
        <div class="activity-dot ${dotClass}"></div>
        <div class="activity-info">
          <div class="activity-action">${escapeHtml(a.action)}</div>
          <div class="activity-details">${escapeHtml(a.details || '')}</div>
          <div class="activity-time">${timeAgo}</div>
        </div>
      </div>`;
  }).join('');
}

function getActivityDotClass(action) {
  const lower = action.toLowerCase();
  if (lower.includes('added') || lower.includes('created')) return 'add';
  if (lower.includes('updated') || lower.includes('status')) return 'update';
  if (lower.includes('deleted')) return 'delete';
  if (lower.includes('reminder') || lower.includes('whatsapp')) return 'reminder';
  if (lower.includes('fee') || lower.includes('generated')) return 'fee';
  return 'default';
}

// ═══════════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  // Auto-remove
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTimeAgo(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Close modals on Escape key ────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeStudentModal();
    closeQRModal();
    closeConfirmModal();
  }
});

// ─── Close modals on overlay click ─────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('show');
    }
  });
});

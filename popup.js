/**
 * popup.js
 * Controls the extension popup UI.
 * On open, queries the background service worker for its current runningState
 * and restores the correct screen including any spam scan results.
 */

import { formatNumber, relativeTime } from './utils.js';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  token: null,
  senders: [],       // All senders from last inbox scan
  filtered: [],       // Currently rendered (search-filtered) list
  spamSenders: [],       // Senders with detected spam
  activeTab: 'all',    // 'all' | 'spam'
  totalScanned: 0,
  totalDeleted: 0,
  scanning: false,
  spamScanning: false,
  deletingEmail: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  viewAuth: $('view-auth'),
  viewDashboard: $('view-dashboard'),
  btnLogin: $('btn-login'),
  btnSignout: $('btn-signout'),
  btnScan: $('btn-scan'),
  btnForceRescan: $('btn-force-rescan'),
  searchInput: $('search-input'),
  statTotal: $('stat-total'),
  statSenders: $('stat-senders'),
  statDeleted: $('stat-deleted'),
  progressWrap: $('progress-wrap'),
  progressBar: $('progress-bar'),
  progressLabel: $('progress-label'),
  cacheInfo: $('cache-info'),
  // Spam bar
  spamBar: $('spam-bar'),
  spamServerDot: $('spam-server-dot'),
  spamBarLabel: $('spam-bar-label'),
  btnSpamScan: $('btn-spam-scan'),
  // Spam alert
  spamAlert: $('spam-alert'),
  spamAlertText: $('spam-alert-text'),
  btnViewSpam: $('btn-view-spam'),
  btnTrashAllSpam: $('btn-trash-all-spam'),
  // Tabs
  tabBar: $('tab-bar'),
  tabAll: $('tab-all'),
  tabSpam: $('tab-spam'),
  spamBadge: $('spam-badge'),
  // Table
  tableWrap: $('table-wrap'),
  thCountLabel: $('th-count-label'),
  tbody: $('sender-tbody'),
  emptyState: $('empty-state'),
  // Modal
  modalOverlay: $('modal-overlay'),
  modalTitle: $('modal-title'),
  modalBody: $('modal-body'),
  modalCancel: $('modal-cancel'),
  modalConfirm: $('modal-confirm'),
  // Toast
  toast: $('toast'),
};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  els.modalOverlay.hidden = true;

  const token = await silentGetToken();
  if (!token) { showAuth(); return; }

  state.token = token;
  showDashboard();

  const { uiState } = await sendToBackground('GET_UI_STATE', {});
  await restoreUiState(uiState);

  // Probe server status in background (non-blocking)
  pollServerStatus();
});

function silentGetToken() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      resolve(chrome.runtime.lastError || !token ? null : token);
    });
  });
}

// ─── State restoration ────────────────────────────────────────────────────────

async function restoreUiState(uiState) {
  if (!uiState) { await loadCacheInfo(); return; }

  state.totalDeleted = uiState.totalDeleted ?? 0;
  els.statDeleted.textContent = formatNumber(state.totalDeleted);

  // Restore spam result if present
  if (uiState.spamResult) {
    applySpamResult(uiState.spamResult);
  }

  switch (uiState.status) {
    case 'scanning':
      state.scanning = true;
      setScanningUiMode();
      if (uiState.progress) applyProgressSnapshot(uiState.progress);
      break;

    case 'spam_scanning':
      if (uiState.scanResult) applyScanResult(uiState.scanResult, true);
      setSpamScanningUiMode();
      break;

    case 'scan_complete':
      if (uiState.scanResult) applyScanResult(uiState.scanResult);
      break;

    case 'deleting':
      if (uiState.scanResult) applyScanResult(uiState.scanResult, true);
      state.deletingEmail = uiState.deleteTarget;
      els.progressWrap.hidden = false;
      els.progressBar.style.width = '20%';
      els.progressLabel.textContent = uiState.deleteTarget
        ? `Moving emails from ${uiState.deleteTarget} to trash…`
        : 'Moving to trash…';
      break;

    default:
      await loadCacheInfo();
      break;
  }
}

// ─── Server status polling ────────────────────────────────────────────────────

async function pollServerStatus() {
  try {
    const res = await fetch('http://127.0.0.1:5001/health', {
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    const online = data.model_loaded === true;
    setServerDot(online ? 'online' : 'offline');
    els.btnSpamScan.disabled = !online;
    els.spamBarLabel.textContent = online
      ? 'AI Spam Detection — ready'
      : 'AI Spam Detection — server offline';
  } catch {
    setServerDot('offline');
    els.btnSpamScan.disabled = true;
    els.spamBarLabel.textContent = 'AI Spam Detection — server offline';
  }
}

function setServerDot(status) {
  els.spamServerDot.className = `server-dot dot-${status}`;
}

// ─── Listeners ────────────────────────────────────────────────────────────────

els.btnLogin.addEventListener('click', async () => {
  els.btnLogin.disabled = true;
  els.btnLogin.textContent = 'Connecting…';
  try {
    const result = await sendToBackground('GET_AUTH_TOKEN', {});
    if (result.error) throw new Error(result.error);
    state.token = result.token;
    showDashboard();
    await loadCacheInfo();
    pollServerStatus();
  } catch (err) {
    showToast(`Sign-in failed: ${err.message}`, 'error');
    els.btnLogin.disabled = false;
    els.btnLogin.innerHTML = googleButtonHtml();
  }
});

els.btnSignout.addEventListener('click', async () => {
  await sendToBackground('SIGN_OUT', { token: state.token });
  Object.assign(state, { token: null, senders: [], filtered: [], spamSenders: [], totalDeleted: 0, totalScanned: 0 });
  showAuth();
  showToast('Signed out', 'success');
});

els.btnScan.addEventListener('click', () => { if (!state.scanning) startScan(false); });
els.btnForceRescan.addEventListener('click', () => { if (!state.scanning) startScan(true); });
els.btnSpamScan.addEventListener('click', () => { if (!state.spamScanning) startSpamScan(); });

els.searchInput.addEventListener('input', () => {
  filterSenders(els.searchInput.value.trim().toLowerCase());
});

// Tabs
els.tabAll.addEventListener('click', () => switchTab('all'));
els.tabSpam.addEventListener('click', () => switchTab('spam'));

// Spam alert actions
els.btnViewSpam.addEventListener('click', () => switchTab('spam'));
els.btnTrashAllSpam.addEventListener('click', () => requestTrashAllSpam());

els.modalCancel.addEventListener('click', closeModal);
els.modalOverlay.addEventListener('click', (e) => { if (e.target === els.modalOverlay) closeModal(); });

// ─── Background message listener ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  const { type, payload } = message;
  switch (type) {
    case 'SCAN_PROGRESS': handleScanProgress(payload); break;
    case 'SCAN_COMPLETE': handleScanComplete(payload); break;
    case 'SCAN_ERROR': handleScanError(payload); break;
    case 'SPAM_SCAN_PROGRESS': handleSpamScanProgress(payload); break;
    case 'SPAM_SCAN_COMPLETE': handleSpamScanComplete(payload); break;
    case 'SPAM_SCAN_ERROR': handleSpamScanError(payload); break;
    case 'DELETE_PROGRESS': handleDeleteProgress(payload); break;
    case 'DELETE_COMPLETE': handleDeleteComplete(payload); break;
    case 'DELETE_ERROR': handleDeleteError(payload); break;
  }
});

// ─── Cache info ────────────────────────────────────────────────────────────────

async function loadCacheInfo() {
  const info = await sendToBackground('GET_CACHE_INFO', {});
  updateCacheInfo(info);
}

function updateCacheInfo({ scannedAt, totalCached, spamCount, spamClassifiedAt }) {
  if (!scannedAt) {
    els.cacheInfo.textContent = 'No previous scan';
    els.btnForceRescan.hidden = true;
  } else {
    const spamNote = spamClassifiedAt ? ` · ${formatNumber(spamCount)} spam` : '';
    els.cacheInfo.textContent =
      `Last scan: ${relativeTime(scannedAt)} · ${formatNumber(totalCached)} cached${spamNote}`;
    els.btnForceRescan.hidden = false;
  }
}

// ─── Inbox scan ───────────────────────────────────────────────────────────────

function startScan(forceFull) {
  state.scanning = true;
  state.senders = [];
  state.filtered = [];

  setScanningUiMode(forceFull);
  sendToBackground(forceFull ? 'FORCE_FULL_SCAN' : 'START_SCAN', { token: state.token });
}

function setScanningUiMode(forceFull = false) {
  els.btnScan.disabled = true;
  els.btnForceRescan.disabled = true;
  els.btnSpamScan.disabled = true;
  els.btnScan.innerHTML = '<span class="btn-icon">⟳</span> Scanning…';
  els.searchInput.disabled = true;
  els.tableWrap.hidden = true;
  els.emptyState.hidden = true;
  els.tabBar.hidden = true;
  els.progressWrap.hidden = false;
  els.progressBar.style.width = '0%';
  els.progressLabel.textContent = forceFull ? 'Starting full scan…' : 'Checking for new messages…';
}

function applyProgressSnapshot({ phase, completed, total, isIncremental }) {
  const prefix = isIncremental ? '⚡ Incremental —' : '';
  if (phase === 'listing') {
    els.progressBar.style.width = '10%';
    els.progressLabel.textContent = `${prefix} ${formatNumber(completed)} messages found…`.trim();
  } else if (phase === 'metadata') {
    const pct = total ? Math.round((completed / total) * 85) + 10 : 50;
    els.progressBar.style.width = `${pct}%`;
    els.progressLabel.textContent = `${prefix} Reading senders… ${formatNumber(completed)} / ${formatNumber(total || 0)}`.trim();
  }
}

function handleScanProgress(payload) { applyProgressSnapshot(payload); }

function handleScanComplete(payload) {
  state.scanning = false;
  applyScanResult(payload);
}

function applyScanResult(result, suppressProgress = false) {
  const { senders, scannedAt, wasIncremental, newCount } = result;
  state.senders = senders;
  state.filtered = [...senders];
  state.totalScanned = senders.reduce((sum, s) => sum + s.count, 0);

  if (!suppressProgress) {
    const note = wasIncremental ? ` (${formatNumber(newCount)} new)` : '';
    els.progressBar.style.width = '100%';
    els.progressLabel.textContent = `Done — ${formatNumber(senders.length)} senders${note}`;
    setTimeout(() => finaliseScanUi(scannedAt), 800);
  } else {
    finaliseScanUi(scannedAt);
  }
}

function finaliseScanUi(scannedAt) {
  els.progressWrap.hidden = true;
  els.btnScan.disabled = false;
  els.btnForceRescan.disabled = false;
  els.btnScan.innerHTML = '<span class="btn-icon">⟳</span> Scan';
  els.btnForceRescan.hidden = false;
  els.searchInput.disabled = false;
  els.spamBar.hidden = false;
  els.tabBar.hidden = false;
  updateCacheInfo({ scannedAt, totalCached: state.totalScanned, spamCount: state.spamSenders.length, spamClassifiedAt: null });
  updateStats();
  renderCurrentTab();
  pollServerStatus(); // refresh server status dot after scan
}

function handleScanError({ message }) {
  state.scanning = false;
  els.progressWrap.hidden = true;
  els.btnScan.disabled = false;
  els.btnForceRescan.disabled = false;
  els.btnScan.innerHTML = '<span class="btn-icon">⟳</span> Start Scan';
  showToast(`Scan failed: ${message}`, 'error');
}

// ─── Spam scan ────────────────────────────────────────────────────────────────

function startSpamScan() {
  state.spamScanning = true;
  setSpamScanningUiMode();
  sendToBackground('RUN_SPAM_SCAN', { token: state.token });
}

function setSpamScanningUiMode() {
  els.btnSpamScan.disabled = true;
  els.btnSpamScan.textContent = 'Scanning…';
  els.progressWrap.hidden = false;
  els.progressBar.style.width = '2%';
  els.progressLabel.textContent = 'Preparing spam scan…';
}

function handleSpamScanProgress({ phase, completed, total }) {
  if (phase === 'fetching') {
    const pct = total ? Math.round((completed / total) * 40) + 2 : 20;
    els.progressBar.style.width = `${pct}%`;
    els.progressLabel.textContent = `Fetching email content… ${formatNumber(completed)} / ${formatNumber(total)}`;
  } else if (phase === 'classifying') {
    const pct = total ? Math.round((completed / total) * 55) + 42 : 70;
    els.progressBar.style.width = `${pct}%`;
    els.progressLabel.textContent = `Classifying with BERT… ${formatNumber(completed)} / ${formatNumber(total)}`;
  }
}

function handleSpamScanComplete(payload) {
  state.spamScanning = false;
  applySpamResult(payload);

  els.progressBar.style.width = '100%';
  els.progressLabel.textContent = `Spam scan complete — ${formatNumber(payload.spamCount)} spam messages found`;
  setTimeout(() => {
    els.progressWrap.hidden = true;
    els.btnSpamScan.disabled = false;
    els.btnSpamScan.textContent = 'Re-scan';
    loadCacheInfo();
  }, 1000);
}

function handleSpamScanError({ message }) {
  state.spamScanning = false;
  els.progressWrap.hidden = true;
  els.btnSpamScan.disabled = false;
  els.btnSpamScan.textContent = 'Scan for spam';
  showToast(`Spam scan failed: ${message}`, 'error');
}

function applySpamResult({ spamSenders, spamCount }) {
  state.spamSenders = spamSenders || [];

  // Update spam badge on tab
  els.spamBadge.textContent = spamCount > 0 ? formatNumber(spamCount) : '';

  // Show/hide spam alert
  if (spamCount > 0) {
    els.spamAlertText.textContent =
      `${formatNumber(spamCount)} spam email${spamCount !== 1 ? 's' : ''} detected from ${formatNumber(spamSenders.length)} sender${spamSenders.length !== 1 ? 's' : ''}`;
    els.spamAlert.hidden = false;
  } else {
    els.spamAlert.hidden = true;
  }

  // Re-render if spam tab is active
  if (state.activeTab === 'spam') renderCurrentTab();
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  state.activeTab = tab;

  els.tabAll.classList.toggle('tab-active', tab === 'all');
  els.tabSpam.classList.toggle('tab-active', tab === 'spam');
  els.tabAll.dataset.tab = 'all';
  els.tabSpam.dataset.tab = 'spam';

  els.thCountLabel.textContent = tab === 'spam' ? 'Spam' : 'Emails';
  els.searchInput.placeholder = tab === 'spam' ? 'Filter spam senders…' : 'Filter senders…';

  renderCurrentTab();
}

function renderCurrentTab() {
  if (state.activeTab === 'spam') {
    const query = els.searchInput.value.trim().toLowerCase();
    const list = query
      ? state.spamSenders.filter(s => s.email.includes(query) ||
        (s.displayName && s.displayName.toLowerCase().includes(query)))
      : [...state.spamSenders];
    renderTable(list, true);
  } else {
    filterSenders(els.searchInput.value.trim().toLowerCase());
  }
}

// ─── Sender trash confirmation ────────────────────────────────────────────────

function requestTrashAllSpam() {
  const count = state.spamSenders.reduce((sum, s) => sum + s.spamCount, 0);
  els.modalTitle.textContent = 'Trash all spam?';
  els.modalBody.innerHTML =
    `This will move <strong>${formatNumber(count)} spam email${count !== 1 ? 's' : ''}</strong> from <strong>${formatNumber(state.spamSenders.length)} sender${state.spamSenders.length !== 1 ? 's' : ''}</strong> to Trash. You can recover them within 30 days.`;
  showModal();
  els.modalConfirm.onclick = () => {
    closeModal();
    executeTrashAllSpam();
  };
}

function executeTrashAllSpam() {
  els.progressWrap.hidden = false;
  els.progressBar.style.width = '10%';
  els.progressLabel.textContent = 'Moving spam to trash…';
  sendToBackground('TRASH_SPAM', { token: state.token });
}

function requestDelete(email, count) {
  els.modalTitle.textContent = 'Move to trash?';
  els.modalBody.innerHTML =
    `This will move <strong>${formatNumber(count)} email${count !== 1 ? 's' : ''}</strong> from <code>${escapeHtml(email)}</code> to Trash. You can recover them within 30 days.`;
  showModal();
  els.modalConfirm.onclick = () => { closeModal(); executeDelete(email); };
}

function executeDelete(email) {
  state.deletingEmail = email;
  const btn = document.querySelector(`[data-delete="${CSS.escape(email)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Moving to trash…'; }

  els.progressWrap.hidden = false;
  els.progressBar.style.width = '5%';
  els.progressLabel.textContent = `Moving emails from ${email} to trash…`;
  sendToBackground('DELETE_SENDER', { token: state.token, email });
}

function handleDeleteProgress({ phase, completed }) {
  els.progressLabel.textContent = phase === 'listing'
    ? `Listing emails to trash… ${formatNumber(completed)} found`
    : `Moving to trash… ${formatNumber(completed)} processed`;
  els.progressBar.style.width = '50%';
}

function handleDeleteComplete({ email, trashed: deleted }) {
  state.deletingEmail = null;
  state.totalDeleted += deleted;
  sendToBackground('ACK_DELETED', { totalDeleted: state.totalDeleted });
  els.statDeleted.textContent = formatNumber(state.totalDeleted);

  if (email === '__spam__') {
    // Bulk spam trash completed
    state.spamSenders = [];
    els.spamBadge.textContent = '';
    els.spamAlert.hidden = true;
    showToast(`✓ Moved ${formatNumber(deleted)} spam emails to Trash`, 'success');
  } else {
    const row = document.querySelector(`tr[data-email="${CSS.escape(email)}"]`);
    if (row) row.classList.add('row-deleted');
    state.senders = state.senders.filter(s => s.email !== email);
    state.spamSenders = state.spamSenders.filter(s => s.email !== email);
    showToast(`✓ Moved ${formatNumber(deleted)} emails from ${email} to Trash`, 'success');
  }

  els.progressWrap.hidden = true;
  updateStats();
  loadCacheInfo();
  renderCurrentTab();
}

function handleDeleteError({ message }) {
  state.deletingEmail = null;
  els.progressWrap.hidden = true;
  showToast(`Failed: ${message}`, 'error');
}

// ─── Table rendering ──────────────────────────────────────────────────────────

function filterSenders(query) {
  state.filtered = query
    ? state.senders.filter(s =>
      s.email.includes(query) ||
      (s.displayName && s.displayName.toLowerCase().includes(query)))
    : [...state.senders];
  renderTable(state.filtered, false);
}

/**
 * Renders a list of senders into the table.
 * @param {Array} list   - Array of { email, displayName, count } or { email, displayName, spamCount }
 * @param {boolean} isSpam - Whether rendering the spam tab
 */
function renderTable(list, isSpam) {
  els.tbody.innerHTML = '';

  if (list.length === 0) {
    els.tableWrap.hidden = true;
    els.emptyState.hidden = false;
    return;
  }

  els.emptyState.hidden = true;
  els.tableWrap.hidden = false;

  for (const sender of list) {
    const { email, displayName } = sender;
    const count = isSpam ? sender.spamCount : sender.count;
    const showName = displayName && displayName.toLowerCase() !== email;

    const tr = document.createElement('tr');
    tr.dataset.email = email;
    if (isSpam) tr.classList.add('row-spam');

    tr.innerHTML = `
      <td class="td-email">
        <span class="sender-email" title="${escapeHtml(email)}">${escapeHtml(email)}</span>
        ${showName ? `<span class="sender-name">${escapeHtml(displayName)}</span>` : ''}
      </td>
      <td class="td-count">
        <span class="${isSpam ? 'badge-spam-count' : 'badge-count'}">${formatNumber(count)}</span>
      </td>
      <td class="td-actions">
        <div class="actions-group">
          <button class="btn-sm btn-view"   data-view="${escapeHtml(email)}">View</button>
          <button class="btn-sm btn-delete" data-delete="${escapeHtml(email)}" data-count="${count}">
            Move to trash
          </button>
        </div>
      </td>
    `;
    els.tbody.appendChild(tr);
  }

  // Event delegation
  els.tbody.onclick = (e) => {
    const viewBtn = e.target.closest('[data-view]');
    const deleteBtn = e.target.closest('[data-delete]');

    if (viewBtn) {
      const email = viewBtn.dataset.view;
      const gmailUrl = `https://mail.google.com/mail/u/0/#search/from:${encodeURIComponent(email)}`;
      chrome.tabs.query({ url: 'https://mail.google.com/*' }, (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.update(tabs[0].id, { url: gmailUrl, active: true });
          chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
          chrome.tabs.create({ url: gmailUrl });
        }
      });
    }

    if (deleteBtn && !deleteBtn.disabled) {
      requestDelete(deleteBtn.dataset.delete, parseInt(deleteBtn.dataset.count, 10));
    }
  };
}

// ─── View helpers ─────────────────────────────────────────────────────────────

function showAuth() {
  els.viewAuth.classList.add('active');
  els.viewAuth.hidden = false;
  els.viewDashboard.hidden = true;
  els.viewDashboard.classList.remove('active');
  els.btnSignout.hidden = true;
}

function showDashboard() {
  els.viewAuth.classList.remove('active');
  els.viewAuth.hidden = true;
  els.viewDashboard.hidden = false;
  els.viewDashboard.classList.add('active');
  els.btnSignout.hidden = false;
  updateStats();
}

function updateStats() {
  els.statTotal.textContent = state.totalScanned ? formatNumber(state.totalScanned) : '—';
  els.statSenders.textContent = state.senders.length ? formatNumber(state.senders.length) : '—';
  els.statDeleted.textContent = formatNumber(state.totalDeleted);
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function showModal() { els.modalOverlay.hidden = false; }
function closeModal() { els.modalOverlay.hidden = true; }

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimeout;
function showToast(message, type = 'default') {
  clearTimeout(toastTimeout);
  els.toast.textContent = message;
  els.toast.className = `toast toast-${type} visible`;
  els.toast.hidden = false;
  toastTimeout = setTimeout(() => {
    els.toast.classList.remove('visible');
    setTimeout(() => { els.toast.hidden = true; }, 240);
  }, 3500);
}

// ─── Messaging helper ─────────────────────────────────────────────────────────

function sendToBackground(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function googleButtonHtml() {
  return `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M43.6 20.2H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.1 8 3l5.7-5.7C34.5 6.5 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.8z" fill="#FFC107"/><path d="M6.3 14.7l6.6 4.8C14.7 16.1 19 13 24 13c3.1 0 5.9 1.1 8 3l5.7-5.7C34.5 6.5 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" fill="#FF3D00"/><path d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.4 26.7 36 24 36c-5.3 0-9.7-3.3-11.4-8l-6.5 5C9.5 39.5 16.3 44 24 44z" fill="#4CAF50"/><path d="M43.6 20.2H42V20H24v8h11.3c-.8 2.2-2.3 4.1-4.2 5.5l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.6-.4-3.8z" fill="#1976D2"/></svg> Connect with Google`;
}
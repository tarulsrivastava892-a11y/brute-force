const config = window.CLEAN_BUDDY_CONFIG || {};
let createClient = null;
if (config.supabaseUrl?.startsWith('https://') && config.supabaseAnonKey && !config.supabaseAnonKey.includes('YOUR_')) {
  try {
    ({ createClient } = await import('https://esm.sh/@supabase/supabase-js@2'));
  } catch (error) {
    console.warn('CLEAN BUDDY is opening in prototype mode because its account service is unavailable.', error);
  }
}
const authView = document.querySelector('#auth-view');
const awarenessView = document.querySelector('#awareness-view');
const appView = document.querySelector('#app-view');
const form = document.querySelector('#auth-form');
const notice = document.querySelector('#form-notice');
const emailInput = document.querySelector('#email');
const passwordInput = document.querySelector('#password');
const dialog = document.querySelector('#action-dialog');
const dialogTitle = document.querySelector('#dialog-title');
const dialogCopy = document.querySelector('#dialog-copy');
const dialogFields = document.querySelector('#dialog-fields');
const dialogMessage = document.querySelector('#dialog-message');
const dialogSubmit = document.querySelector('#dialog-submit');
const supabase = createClient ? createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
let registerMode = false;
let verifyingSignup = false;
let currentAction = '';
let demoMode = !supabase;
let activeUserId = null;
let scannerStream = null;
let scannerPhotoUrl = null;
let visionModelPromise = null;
const aiScriptPromises = new Map();
const SCAN_DB_NAME = 'clean-buddy-local-db';
const SCAN_STORE_NAME = 'scan_history';
const SCAN_HISTORY_FALLBACK_KEY = 'clean-buddy-scan-history-v1';
let scanDbPromise = null;

if (!supabase) {
  document.querySelector('.fine-print').textContent = 'Prototype mode: use any valid email and a password with 8+ characters.';
}

const DEMO_KEY = 'clean-buddy-demo-v1';
function readDemoData() {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY)) || { name: 'Aanya', reports: [], pickups: [], feedback: [], reminders: [] };
  } catch {
    return { name: 'Aanya', reports: [], pickups: [], feedback: [], reminders: [] };
  }
}
function writeDemoData(data) {
  localStorage.setItem(DEMO_KEY, JSON.stringify(data));
}
function enterDemoAwareness(displayName) {
  demoMode = true;
  const data = readDemoData();
  const name = displayName || data.name || 'Aanya';
  data.name = name;
  writeDemoData(data);
  document.querySelector('#user-name').textContent = name;
  document.querySelector('#user-avatar').textContent = name[0].toUpperCase();
  document.querySelector('#admin-action').hidden = false;
  document.querySelector('#action-count').textContent = '7 dashboard actions';
  activeUserId = 'demo';
  authView.hidden = true;
  awarenessView.hidden = false;
  appView.hidden = true;
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.hidden = false;
}
function clearNotice() {
  notice.hidden = true;
  notice.classList.remove('error');
  document.querySelectorAll('.error').forEach((el) => { el.textContent = ''; });
}
function emailOk(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function showConfigHelp() {
  showNotice('Connect your Supabase project in config.js and run supabase-setup.sql before using account features.', true);
}
function friendlyError(error) {
  if (/invalid login credentials/i.test(error.message)) return 'Email or password is incorrect, or your email has not been verified.';
  if (/email not confirmed/i.test(error.message)) return 'Verify your email with the code we sent, then log in.';
  if (/rate limit|too many requests/i.test(error.message)) return 'Too many attempts. Please wait a little before trying again.';
  return error.message || 'Something went wrong. Please try again.';
}
function enterAwareness(user) {
  demoMode = false;
  activeUserId = user.id;
  const name = (user.user_metadata?.full_name || user.email?.split('@')[0] || 'friend').trim().split(/\s+/)[0];
  document.querySelector('#user-name').textContent = name;
  document.querySelector('#user-avatar').textContent = name[0].toUpperCase();
  const isAdmin = user.app_metadata?.role === 'admin';
  document.querySelector('#admin-action').hidden = !isAdmin;
  document.querySelector('#action-count').textContent = isAdmin ? '7 dashboard actions' : '6 ways to help';
  authView.hidden = true;
  awarenessView.hidden = false;
  appView.hidden = true;
}
async function showDashboard() {
  authView.hidden = true;
  awarenessView.hidden = true;
  appView.hidden = false;
  await refreshDashboard();
}

document.querySelector('#toggle-password').addEventListener('click', (event) => {
  const visible = passwordInput.type === 'password';
  passwordInput.type = visible ? 'text' : 'password';
  event.currentTarget.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
});
document.querySelector('#generate-password').addEventListener('click', () => {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@$%';
  const bytes = crypto.getRandomValues(new Uint32Array(18));
  passwordInput.value = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  passwordInput.type = 'text';
  passwordInput.focus();
  showNotice('A strong password is ready. Save it somewhere safe before continuing.');
});
document.querySelector('#register-toggle').addEventListener('click', () => {
  registerMode = !registerMode;
  verifyingSignup = false;
  clearNotice();
  document.querySelector('#otp-field').hidden = true;
  document.querySelector('#name-field').hidden = !registerMode;
  document.querySelector('#login-options').hidden = registerMode;
  document.querySelector('#form-kicker').textContent = registerMode ? 'JOIN THE COMMUNITY' : 'WELCOME BACK';
  document.querySelector('#auth-title').innerHTML = registerMode ? 'Let’s get you <em>started.</em>' : 'Let’s get you <em>in.</em>';
  document.querySelector('#auth-subtitle').textContent = registerMode ? 'Create an account and make your first good move.' : 'Sign in to keep your good work going.';
  document.querySelector('#submit-label').textContent = registerMode ? 'Create account' : 'Log in with email';
  document.querySelector('#register-toggle').textContent = registerMode ? 'Log in' : 'Register';
  document.querySelector('#switch-auth').firstChild.textContent = registerMode ? 'Already have an account? ' : 'Don’t have an account? ';
  passwordInput.autocomplete = registerMode ? 'new-password' : 'current-password';
});
document.querySelector('#forgot-password').addEventListener('click', async () => {
  const email = emailInput.value.trim().toLowerCase();
  if (!emailOk(email)) { showNotice('Enter a valid email address first.', true); emailInput.focus(); return; }
  if (!supabase) { showConfigHelp(); return; }
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  showNotice(error ? friendlyError(error) : 'If an account exists for this address, a password reset email is on its way.', !!error);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice();
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  const name = document.querySelector('#name').value.trim();
  if (!emailOk(email)) { document.querySelector('#email-error').textContent = 'Enter a valid email address.'; emailInput.focus(); return; }
  if (!verifyingSignup && password.length < 8) { document.querySelector('#password-error').textContent = 'Use at least 8 characters.'; passwordInput.focus(); return; }
  if (registerMode && !name) { showNotice('Add your name so we know what to call you.', true); document.querySelector('#name').focus(); return; }
  if (!supabase) {
    enterDemoAwareness(registerMode ? name : undefined);
    return;
  }
  const submit = document.querySelector('#submit-button');
  submit.disabled = true;
  try {
    if (verifyingSignup) {
      const token = document.querySelector('#otp-code').value.trim();
      if (!/^\d{6}$/.test(token)) { document.querySelector('#otp-error').textContent = 'Enter the 6-digit code from your email.'; return; }
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
      if (error) throw error;
      verifyingSignup = false;
      enterAwareness(data.user);
      return;
    }
    if (registerMode) {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } });
      if (error) throw error;
      if (data.session) { enterAwareness(data.user); return; }
      verifyingSignup = true;
      document.querySelector('#otp-field').hidden = false;
      document.querySelector('#submit-label').textContent = 'Verify email';
      showNotice('We sent a 6-digit verification code to your email. Enter it here to finish creating your account.');
      document.querySelector('#otp-code').focus();
      return;
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    enterAwareness(data.user);
  } catch (error) {
    showNotice(friendlyError(error), true);
  } finally { submit.disabled = false; }
});
document.querySelector('#resend-otp').addEventListener('click', async () => {
  if (!supabase) { showConfigHelp(); return; }
  const email = emailInput.value.trim().toLowerCase();
  const { error } = await supabase.auth.resend({ type: 'signup', email });
  showNotice(error ? friendlyError(error) : 'A new verification code has been sent.', !!error);
});

function setDialog({ title, copy, fields = '', action, button = 'Continue' }) {
  currentAction = action;
  dialog.classList.toggle('admin-dialog', action === 'admin');
  dialog.classList.toggle('scan-dialog', action === 'scan');
  dialogTitle.textContent = title;
  dialogCopy.textContent = copy;
  dialogFields.innerHTML = fields;
  dialogMessage.hidden = true;
  dialogMessage.classList.remove('error');
  dialogSubmit.innerHTML = `${button} <span>↗</span>`;
  dialog.showModal();
}
function inputField(label, id, placeholder, type = 'text') {
  return `<div class="dialog-field"><label for="${id}">${label}</label><input class="dialog-input" id="${id}" type="${type}" placeholder="${placeholder}"></div>`;
}
function areaField(label, id, placeholder) {
  return `<div class="dialog-field"><label for="${id}">${label}</label><textarea class="dialog-textarea" id="${id}" placeholder="${placeholder}"></textarea></div>`;
}
function selectField(label, id, options) {
  if (Array.isArray(id)) { options = id; id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
  return `<div class="dialog-field"><label for="${id}">${label}</label><select class="dialog-select" id="${id}">${options.map((o) => `<option>${o}</option>`).join('')}</select></div>`;
}
function scannerFields() {
  const items = ['Plastic bottle', 'Plastic bag or wrapper', 'Paper or cardboard', 'Metal can', 'Glass bottle or jar', 'Food scraps', 'Garden waste', 'Battery', 'Electronic device', 'Medicine or medical waste', 'Chemical or paint', 'Other'];
  return `<div class="scanner-workspace"><div class="scanner-frame"><div class="scanner-placeholder" id="scan-placeholder"><span aria-hidden="true">▦</span><strong>Frame one item in good light</strong><small>Keep the item centered and use a plain background.</small></div><video id="scan-video" autoplay playsinline muted hidden aria-label="Live camera preview"></video><img id="scan-photo" alt="Selected waste item" hidden><canvas id="scan-canvas" hidden></canvas></div><div class="scanner-controls"><button class="scanner-secondary" id="scan-camera" type="button">Open camera</button><label class="scanner-secondary upload-control" for="scan-upload">Choose photo<input id="scan-upload" type="file" accept="image/*" capture="environment"></label><button class="scanner-primary" id="scan-ai" type="button" disabled>Identify with AI</button></div><p class="scanner-status" id="scan-status" role="status" aria-live="polite">AI guesses run on this device. Your photo stays here; the model loads the first time you scan.</p><div class="scanner-result" id="scan-result" role="status" aria-live="polite" hidden></div><details class="scanner-manual"><summary>Or choose the item yourself</summary>${selectField('Item type', 'scan-item', items)}<button class="scanner-secondary manual-check" id="scan-manual" type="button">Show suitable bin</button></details><section class="scanner-history" aria-labelledby="scan-history-title"><h3 id="scan-history-title">Recent scans <small>Saved on this device</small></h3><div id="scan-history-list" aria-live="polite"><p class="scan-history-empty">Loading saved scans…</p></div></section></div>`;
}
function openAction(action) {
  const actions = {
    report: { title: 'Report a waste issue', copy: 'Help your neighborhood team find and fix a waste problem.', fields: `${selectField('Issue type', 'issue-type', ['Litter on the street', 'Overflowing bin', 'Illegal dumping', 'Other'])}${inputField('Location', 'issue-location', 'Street or nearby landmark')}${areaField('Add a note', 'issue-note', 'What did you notice?')}`, button: 'Submit report' },
    track: { title: 'Track your reports', copy: 'Your reports and the latest available status updates.', fields: '<div>Loading your reports…</div>', button: 'Close' },
    pickup: { title: 'Request a pickup', copy: 'Tell us what you need collected and choose a convenient day.', fields: `${selectField('Waste type', 'pickup-type', ['Dry recyclables', 'E-waste', 'Garden waste', 'Other'])}${inputField('Pickup location', 'pickup-location', 'Address or nearby landmark')}${inputField('Preferred date', 'pickup-date', '', 'date')}`, button: 'Request pickup' },
    hotspots: { title: 'Community hotspots', copy: 'Recent locations reported by CLEAN BUDDY members.', fields: '<div>Loading community hotspots…</div>', button: 'Close' },
    feedback: { title: 'Share your feedback', copy: 'Your ideas help us make CLEAN BUDDY better.', fields: `${selectField('How was your experience?', ['Great', 'Good', 'Could be better'])}${areaField('Your feedback', 'feedback-text', 'Tell us what you think...')}`, button: 'Send feedback' },
    reminder: { title: 'Set a reminder', copy: 'Give yourself a friendly nudge to keep your green habits going.', fields: `${inputField('Reminder', 'reminder-text', 'e.g. Put recycling out')}${inputField('Date', 'reminder-date', '', 'date')}${inputField('Time', 'reminder-time', '', 'time')}`, button: 'Save reminder' },
    admin: { title: 'Admin dashboard', copy: 'Community reports, pickup requests, and resident feedback.', fields: '<div class="dialog-message">Loading the community overview…</div>', button: 'Close' },
    scan: { title: 'AI bin scanner', copy: 'Scan an item with your camera or choose a photo. We’ll suggest the right collection bin.', fields: scannerFields(), button: 'Close scanner' },
    settings: demoMode
      ? { title: 'Your settings', copy: 'Make this dashboard feel like yours.', fields: `${inputField('Your name', 'demo-name', 'What should we call you?')}<div class="dialog-message">This prototype saves your activity in this browser.</div>`, button: 'Save settings' }
      : { title: 'Your settings', copy: 'Manage your CLEAN BUDDY account.', fields: '<div class="dialog-message">Your account and activity are stored securely with your signed-in account.</div>', button: 'Log out' }
  };
  setDialog({ ...actions[action], action });
  if (action === 'settings' && demoMode) document.querySelector('#demo-name').value = readDemoData().name || '';
  if (action === 'track') loadReports();
  if (action === 'hotspots') loadHotspots();
  if (action === 'admin') loadAdminDashboard();
  if (action === 'scan') setupScanner();
}
document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.section !== 'home') openAction(button.dataset.section);
}));
document.querySelector('#scan-button').addEventListener('click', () => openAction('scan'));
document.querySelector('#settings-button').addEventListener('click', () => openAction('settings'));
document.querySelector('#mobile-settings').addEventListener('click', () => openAction('settings'));
document.querySelectorAll('[data-enter-dashboard]').forEach((button) => button.addEventListener('click', showDashboard));

function safeText(value) {
  const span = document.createElement('span');
  span.textContent = value ?? '';
  return span.innerHTML;
}
async function refreshDashboard() {
  if (demoMode) {
    const data = readDemoData();
    const count = data.reports.length + data.pickups.length;
    document.querySelector('#impact-count').textContent = count;
    document.querySelector('#points-total').textContent = 120 + count * 10;
    return;
  }
  if (!supabase) return;
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) return;
  const [reports, pickups] = await Promise.all([
    supabase.from('reports').select('id', { count: 'exact', head: true }),
    supabase.from('pickup_requests').select('id', { count: 'exact', head: true })
  ]);
  if (!reports.error && !pickups.error) {
    const count = (reports.count || 0) + (pickups.count || 0);
    document.querySelector('#impact-count').textContent = count;
    document.querySelector('#points-total').textContent = 120 + count * 10;
  }
}
async function loadReports() {
  if (demoMode) {
    const reports = readDemoData().reports;
    dialogFields.innerHTML = reports.length ? reports.map((row) => `<div class="dialog-message"><b>#${safeText(row.reference)}</b> · ${safeText(row.location)}<br>${safeText(row.issue_type)} · <b>Status: ${safeText(row.status)}</b></div>`).join('') : '<div class="dialog-message">No reports yet. Submitted reports will appear here.</div>';
    return;
  }
  const { data, error } = await supabase.from('reports').select('reference, issue_type, location, status, created_at').order('created_at', { ascending: false }).limit(20);
  if (currentAction !== 'track') return;
  dialogFields.innerHTML = error ? `<div class="dialog-message error">${safeText(friendlyError(error))}</div>` : data.length ? data.map((row) => `<div class="dialog-message"><b>#${safeText(row.reference)}</b> · ${safeText(row.location)}<br>${safeText(row.issue_type)} · <b>Status: ${safeText(row.status)}</b></div>`).join('') : '<div class="dialog-message">No reports yet. Your submitted reports will appear here.</div>';
}
async function loadHotspots() {
  if (demoMode) {
    const reports = readDemoData().reports;
    const counts = reports.reduce((result, report) => {
      const location = report.location || 'Nearby';
      result[location] = (result[location] || 0) + 1;
      return result;
    }, {});
    dialogFields.innerHTML = Object.keys(counts).length ? Object.entries(counts).map(([location, count]) => `<div class="dialog-message">📍 ${safeText(location)} · ${count} recent report${count === 1 ? '' : 's'}</div>`).join('') : '<div class="dialog-message">No hotspots logged yet. Report an issue to help map community hotspots.</div>';
    return;
  }
  const { data, error } = await supabase.from('hotspots').select('location, report_count').limit(10);
  if (currentAction !== 'hotspots') return;
  dialogFields.innerHTML = error ? `<div class="dialog-message error">${safeText(friendlyError(error))}</div>` : data.length ? data.map((row) => `<div class="dialog-message">📍 ${safeText(row.location)} · ${row.report_count} recent reports</div>`).join('') : '<div class="dialog-message">No hotspots reported yet. Report a local issue to help the community.</div>';
}
function adminDate(value) {
  if (!value) return 'Date not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date not set' : date.toLocaleDateString();
}
function adminList(title, rows, emptyText, rowMarkup) {
  const items = rows.length ? rows.map(rowMarkup).join('') : `<p class="admin-empty">${emptyText}</p>`;
  return `<section class="admin-list"><h3>${title}</h3>${items}</section>`;
}
function renderAdminDashboard({ reports, pickups, feedback, reportCount, openCount, pickupCount, feedbackCount }) {
  const metrics = [
    ['All reports', reportCount],
    ['Open reports', openCount],
    ['Pickup requests', pickupCount],
    ['Feedback', feedbackCount]
  ];
  const reportList = adminList('Recent reports', reports, 'No reports have been submitted.', (row) => `<article class="admin-record"><strong>#${safeText(row.reference || 'Report')} · ${safeText(row.issue_type)}</strong><span>${safeText(row.location)} · ${safeText(row.status)}</span><small>${adminDate(row.created_at)}</small></article>`);
  const pickupList = adminList('Recent pickups', pickups, 'No pickup requests have been submitted.', (row) => `<article class="admin-record"><strong>${safeText(row.waste_type)} pickup</strong><span>${safeText(row.location)} · ${safeText(row.status)}</span><small>${adminDate(row.preferred_date || row.created_at)}</small></article>`);
  const feedbackList = adminList('Recent feedback', feedback, 'No feedback has been submitted.', (row) => `<article class="admin-record"><strong>${safeText(row.rating)}</strong><span>${safeText(row.message)}</span><small>${adminDate(row.created_at)}</small></article>`);
  dialogFields.innerHTML = `<div class="admin-metrics">${metrics.map(([label, count]) => `<div class="admin-metric"><span>${label}</span><strong>${count}</strong></div>`).join('')}</div><div class="admin-lists">${reportList}${pickupList}${feedbackList}</div>`;
}
async function loadAdminDashboard() {
  if (demoMode) {
    const data = readDemoData();
    const reports = data.reports || [];
    const pickups = data.pickups || [];
    const feedback = data.feedback || [];
    renderAdminDashboard({
      reports: reports.slice(0, 5), pickups: pickups.slice(0, 5), feedback: feedback.slice(0, 5),
      reportCount: reports.length, openCount: reports.filter((row) => row.status !== 'Resolved').length,
      pickupCount: pickups.length, feedbackCount: feedback.length
    });
    return;
  }
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (currentAction !== 'admin') return;
  if (userError || !user || user.app_metadata?.role !== 'admin') {
    dialogFields.innerHTML = '<div class="dialog-message error">Admin access is required. Ask your project administrator to assign the admin role to your account.</div>';
    return;
  }
  const [reportsResult, pickupsResult, feedbackResult, reportsCount, openCount, pickupsCount, feedbackCount] = await Promise.all([
    supabase.from('reports').select('reference, issue_type, location, status, created_at').order('created_at', { ascending: false }).limit(5),
    supabase.from('pickup_requests').select('waste_type, location, preferred_date, status, created_at').order('created_at', { ascending: false }).limit(5),
    supabase.from('feedback').select('rating, message, created_at').order('created_at', { ascending: false }).limit(5),
    supabase.from('reports').select('id', { count: 'exact', head: true }),
    supabase.from('reports').select('id', { count: 'exact', head: true }).neq('status', 'Resolved'),
    supabase.from('pickup_requests').select('id', { count: 'exact', head: true }),
    supabase.from('feedback').select('id', { count: 'exact', head: true })
  ]);
  if (currentAction !== 'admin') return;
  const error = reportsResult.error || pickupsResult.error || feedbackResult.error || reportsCount.error || openCount.error || pickupsCount.error || feedbackCount.error;
  if (error) {
    dialogFields.innerHTML = `<div class="dialog-message error">${safeText(friendlyError(error))} Run the latest admin policies from supabase-setup.sql.</div>`;
    return;
  }
  renderAdminDashboard({
    reports: reportsResult.data || [], pickups: pickupsResult.data || [], feedback: feedbackResult.data || [],
    reportCount: reportsCount.count || 0, openCount: openCount.count || 0,
    pickupCount: pickupsCount.count || 0, feedbackCount: feedbackCount.count || 0
  });
}
function stopScannerCamera() {
  if (scannerStream) scannerStream.getTracks().forEach((track) => track.stop());
  scannerStream = null;
  const video = document.querySelector('#scan-video');
  if (video) video.srcObject = null;
}
function clearScannerPhoto() {
  if (scannerPhotoUrl) URL.revokeObjectURL(scannerPhotoUrl);
  scannerPhotoUrl = null;
}
dialog.addEventListener('close', () => {
  stopScannerCamera();
  clearScannerPhoto();
  const photo = document.querySelector('#scan-photo');
  const upload = document.querySelector('#scan-upload');
  if (photo) { photo.removeAttribute('src'); photo.hidden = true; }
  if (upload) upload.value = '';
});
function openScanDatabase() {
  if (!window.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable.'));
  if (!scanDbPromise) {
    scanDbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(SCAN_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SCAN_STORE_NAME)) {
          const store = database.createObjectStore(SCAN_STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the local scan database.'));
      request.onblocked = () => reject(new Error('The local scan database is blocked by another tab.'));
    }).catch((error) => {
      scanDbPromise = null;
      throw error;
    });
  }
  return scanDbPromise;
}
function fallbackScanHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(SCAN_HISTORY_FALLBACK_KEY));
    return Array.isArray(history) ? history : [];
  }
  catch { return []; }
}
async function readRecentScans(limit = 5) {
  try {
    const database = await openScanDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(SCAN_STORE_NAME, 'readonly');
      const request = transaction.objectStore(SCAN_STORE_NAME).index('createdAt').openCursor(null, 'prev');
      const rows = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && rows.length < limit) {
          rows.push(cursor.value);
          cursor.continue();
        } else resolve(rows);
      };
      request.onerror = () => reject(request.error || new Error('Could not read saved scans.'));
    });
  } catch {
    return fallbackScanHistory().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
  }
}
async function renderScanHistory() {
  const list = document.querySelector('#scan-history-list');
  if (!list) return;
  const rows = await readRecentScans();
  if (!rows.length) {
    list.innerHTML = '<p class="scan-history-empty">Your saved scan results will appear here.</p>';
    return;
  }
  list.innerHTML = rows.map((row) => {
    const date = new Date(row.createdAt);
    const dateLabel = Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    const match = row.source === 'AI' ? `AI${Number.isFinite(row.confidence) ? ` · ${Math.round(row.confidence * 100)}%` : ''}` : 'Manual';
    return `<article class="scan-history-row"><div><strong>${safeText(row.item)}</strong><span>${safeText(row.bin)}</span><small>${safeText(row.guidance)}</small></div><time>${safeText(match)}${dateLabel ? ` · ${safeText(dateLabel)}` : ''}</time></article>`;
  }).join('');
}
async function saveScanRecord(record) {
  const savedRecord = { ...record, createdAt: new Date().toISOString() };
  try {
    const database = await openScanDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(SCAN_STORE_NAME, 'readwrite');
      transaction.objectStore(SCAN_STORE_NAME).add(savedRecord);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not save this scan.'));
      transaction.onabort = () => reject(transaction.error || new Error('The scan save was cancelled.'));
    });
  } catch {
    try {
      const rows = fallbackScanHistory();
      rows.unshift({ ...savedRecord, id: `${Date.now()}-${Math.random()}` });
      localStorage.setItem(SCAN_HISTORY_FALLBACK_KEY, JSON.stringify(rows.slice(0, 50)));
    } catch {
      return false;
    }
  }
  await renderScanHistory();
  return true;
}
function setupScanner() {
  const video = document.querySelector('#scan-video');
  const photo = document.querySelector('#scan-photo');
  const placeholder = document.querySelector('#scan-placeholder');
  const cameraButton = document.querySelector('#scan-camera');
  const upload = document.querySelector('#scan-upload');
  const aiButton = document.querySelector('#scan-ai');
  const status = document.querySelector('#scan-status');
  const result = document.querySelector('#scan-result');
  const canvas = document.querySelector('#scan-canvas');
  renderScanHistory();

  cameraButton.addEventListener('click', async () => {
    cameraButton.disabled = true;
    status.textContent = 'Waiting for camera permission…';
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable here. Choose a photo instead, or open the site on localhost or HTTPS.');
      stopScannerCamera();
      clearScannerPhoto();
      photo.hidden = true;
      scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = scannerStream;
      await video.play();
      video.hidden = false;
      placeholder.hidden = true;
      aiButton.disabled = false;
      status.textContent = 'Camera is ready. Center one item, then choose Identify with AI.';
      result.hidden = true;
    } catch (error) {
      stopScannerCamera();
      video.hidden = true;
      photo.hidden = true;
      placeholder.hidden = false;
      aiButton.disabled = true;
      status.textContent = error.message || 'Could not open the camera. Choose a photo or use the manual item list.';
    } finally {
      cameraButton.disabled = false;
    }
  });

  upload.addEventListener('change', () => {
    const file = upload.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      status.textContent = 'Choose an image file to scan.';
      upload.value = '';
      return;
    }
    stopScannerCamera();
    clearScannerPhoto();
    scannerPhotoUrl = URL.createObjectURL(file);
    photo.onload = () => {
      photo.hidden = false;
      video.hidden = true;
      placeholder.hidden = true;
      aiButton.disabled = false;
      status.textContent = 'Photo ready. Choose Identify with AI to get a bin suggestion.';
      result.hidden = true;
    };
    photo.onerror = () => { status.textContent = 'That photo could not be opened. Try another image.'; };
    photo.src = scannerPhotoUrl;
  });

  aiButton.addEventListener('click', async () => {
    aiButton.disabled = true;
    status.textContent = 'Loading the on-device vision model… this may take a moment the first time.';
    result.hidden = true;
    try {
      const source = !photo.hidden ? photo : video;
      const sourceWidth = !photo.hidden ? photo.naturalWidth : video.videoWidth;
      const sourceHeight = !photo.hidden ? photo.naturalHeight : video.videoHeight;
      if (!sourceWidth || !sourceHeight) throw new Error('The image is not ready yet. Wait for the camera or photo preview to load.');
      const scale = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight));
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, canvas.width, canvas.height);
      const model = await loadVisionModel();
      status.textContent = 'Looking at the item…';
      const predictions = await model.classify(canvas, 5);
      if (currentAction !== 'scan') return;
      const match = predictions.find((prediction) => prediction.probability >= 0.12 && wasteRecommendation(prediction.className));
      if (match) {
        const recommendation = wasteRecommendation(match.className);
        showScannerResult(`AI guess: ${match.className}`, recommendation.bin, recommendation.guidance, `${Math.round(match.probability * 100)}% model match`);
        const saved = await saveScanRecord({ item: match.className, bin: recommendation.bin, guidance: recommendation.guidance, confidence: match.probability, source: 'AI' });
        status.textContent = `Check local collection rules before disposal, especially for plastic and hazardous waste.${saved ? ' Result saved on this device.' : ' Could not save this result in browser storage.'}`;
      } else {
        const guess = predictions[0];
        showScannerResult('I’m not sure what this item is', 'Choose an item type below', 'The camera model could not confidently match this image to a waste category. Try a clearer photo or use the manual list.', guess ? `Closest visual match: ${guess.className} (${Math.round(guess.probability * 100)}%)` : 'No visual match was returned.');
        const saved = await saveScanRecord({ item: guess?.className || 'Unknown item', bin: 'Needs manual choice', guidance: 'The AI could not confidently map this image to a waste category.', confidence: guess?.probability ?? null, source: 'AI' });
        status.textContent = `Try a clearer photo, or choose the closest item type manually.${saved ? ' Scan saved on this device.' : ' Could not save this result in browser storage.'}`;
      }
    } catch (error) {
      status.textContent = error.message || 'AI scanning is unavailable right now. You can still choose the item manually.';
    } finally {
      aiButton.disabled = false;
    }
  });

  document.querySelector('#scan-manual').addEventListener('click', async () => {
    const selected = document.querySelector('#scan-item').value;
    const recommendation = wasteRecommendation(selected);
    const bin = recommendation?.bin || 'Check local waste guidance';
    const guidance = recommendation?.guidance || 'This item may need a special collection point. Ask your local waste team before putting it in a regular bin.';
    showScannerResult(`Selected item: ${selected}`, bin, guidance, 'Manual selection');
    const saved = await saveScanRecord({ item: selected, bin, guidance, confidence: null, source: 'Manual' });
    status.textContent = `Bin guidance is a general suggestion. Local rules can vary.${saved ? ' Result saved on this device.' : ' Could not save this result in browser storage.'}`;
  });
}
async function loadExternalScript(src, globalName) {
  if (window[globalName]) return;
  if (!aiScriptPromises.has(globalName)) {
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.aiLibrary = globalName;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load the AI model library. Check your internet connection and try again.'));
      document.head.appendChild(script);
    }).catch((error) => {
      aiScriptPromises.delete(globalName);
      throw error;
    });
    aiScriptPromises.set(globalName, promise);
  }
  await aiScriptPromises.get(globalName);
  if (!window[globalName]) throw new Error('The AI library loaded without its browser API. Try reloading the page.');
}
function loadVisionModel() {
  if (!visionModelPromise) {
    visionModelPromise = (async () => {
      await loadExternalScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js', 'tf');
      await loadExternalScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1', 'mobilenet');
      return window.mobilenet.load({ version: 2, alpha: 0.5 });
    })().catch((error) => {
      visionModelPromise = null;
      throw error;
    });
  }
  return visionModelPromise;
}
function wasteRecommendation(value) {
  const item = String(value || '').toLowerCase();
  if (/battery|medicine|pill|syringe|medical|chemical|paint|pesticide|aerosol|lighter|gasoline/.test(item)) {
    return { bin: 'Special hazardous-waste collection', guidance: 'Keep it out of regular bins. Use a local battery, e-waste, pharmacy, or hazardous-waste drop-off appropriate for the item.' };
  }
  if (/cellular telephone|mobile phone|smartphone|computer|laptop|keyboard|computer mouse|remote control|television|monitor|electronic device|electronics|radio|printer|camera/.test(item)) {
    return { bin: 'E-waste collection point', guidance: 'Take electronic items to an authorized e-waste collection point. Remove batteries only if it is safe and easy to do.' };
  }
  if (/food|banana|apple|orange|lemon|fruit|vegetable|broccoli|carrot|potato|onion|mushroom|pizza|bread|meat|fish|egg|garden waste|leaves|grass|compost/.test(item)) {
    return { bin: 'Green / wet-waste or compost bin', guidance: 'Keep food and suitable garden waste separate. Compost it where local services allow.' };
  }
  if (/paper|cardboard|carton|newspaper|envelope|book|notebook|magazine|comic/.test(item)) {
    return { bin: 'Blue / dry-recycling bin', guidance: 'Keep paper and cardboard clean and dry. Check local rules for coated cartons and tissues.' };
  }
  if (/wine bottle|beer bottle|glass bottle|glass jar|jar|drinking glass/.test(item)) {
    return { bin: 'Glass collection or recycling bin', guidance: 'Use a dedicated glass collection point if available. Wrap broken glass securely and follow local rules.' };
  }
  if (/metal can|tin can|soda can|pop can|aluminum can|aluminium can/.test(item)) {
    return { bin: 'Blue / dry-recycling bin', guidance: 'Empty and rinse the can first. Confirm that your local service accepts metal packaging.' };
  }
  if (/plastic bag|shopping bag|wrapper|plastic film/.test(item)) {
    return { bin: 'Soft-plastic collection point', guidance: 'Plastic bags and wrappers often need a separate store or community drop-off; do not assume they belong in curbside recycling.' };
  }
  if (/plastic bottle|water bottle|pop bottle|plastic container|shampoo bottle/.test(item)) {
    return { bin: 'Blue / dry-recycling bin if locally accepted', guidance: 'Empty and rinse it. Check local rules for plastic types and caps; recycling programs vary.' };
  }
  return null;
}
function showScannerResult(title, bin, guidance, confidence) {
  const result = document.querySelector('#scan-result');
  if (!result) return;
  result.innerHTML = `<strong>${safeText(title)}</strong><span class="scan-confidence">${safeText(confidence)}</span><b>${safeText(bin)}</b><p>${safeText(guidance)}</p>`;
  result.hidden = false;
}
function resultMessage(message, isError = false) {
  dialogMessage.textContent = message;
  dialogMessage.classList.toggle('error', isError);
  dialogMessage.hidden = false;
}
dialogSubmit.addEventListener('click', async () => {
  if (currentAction === 'done') { dialog.close(); return; }
  if (currentAction === 'settings') {
    if (demoMode) {
      const data = readDemoData();
      const name = document.querySelector('#demo-name').value.trim();
      if (!name) { resultMessage('Add your name before saving.', true); return; }
      data.name = name;
      writeDemoData(data);
      document.querySelector('#user-name').textContent = name;
      document.querySelector('#user-avatar').textContent = name[0].toUpperCase();
      resultMessage('Your settings are saved.');
      dialogSubmit.innerHTML = 'Done <span>✓</span>';
      currentAction = 'done';
      return;
    }
    const { error } = await supabase.auth.signOut();
    if (error) { resultMessage(friendlyError(error), true); return; }
    dialog.close();
    appView.hidden = true;
    awarenessView.hidden = true;
    activeUserId = null;
    authView.hidden = false;
    form.reset();
    if (registerMode) document.querySelector('#register-toggle').click();
    document.querySelector('#otp-field').hidden = true;
    verifyingSignup = false;
    return;
  }
  if (currentAction === 'track' || currentAction === 'hotspots' || currentAction === 'admin' || currentAction === 'scan') { dialog.close(); return; }
  if (demoMode) {
    const data = readDemoData();
    const reference = `CB-${String(Date.now()).slice(-6)}`;
    if (currentAction === 'report') {
      const location = document.querySelector('#issue-location').value.trim();
      if (!location) { resultMessage('Add a location so the team knows where to go.', true); return; }
      data.reports.unshift({ reference, issue_type: document.querySelector('#issue-type').value, location, status: 'Received', created_at: new Date().toISOString() });
    } else if (currentAction === 'pickup') {
      const location = document.querySelector('#pickup-location').value.trim();
      if (!location) { resultMessage('Add a pickup location to continue.', true); return; }
      data.pickups.unshift({ reference, waste_type: document.querySelector('#pickup-type').value, location, preferred_date: document.querySelector('#pickup-date').value, status: 'Requested', created_at: new Date().toISOString() });
    } else if (currentAction === 'feedback') {
      const message = document.querySelector('#feedback-text').value.trim();
      if (!message) { resultMessage('Add a little feedback before sending.', true); return; }
      data.feedback.unshift({ message, rating: document.querySelector('#how-was-your-experience-').value, created_at: new Date().toISOString() });
    } else if (currentAction === 'reminder') {
      const title = document.querySelector('#reminder-text').value.trim();
      if (!title) { resultMessage('Give your reminder a name first.', true); return; }
      data.reminders.unshift({ title, date: document.querySelector('#reminder-date').value, time: document.querySelector('#reminder-time').value });
    }
    writeDemoData(data);
    const messages = { report: 'Your report is saved in this prototype.', pickup: 'Your pickup request is saved.', feedback: 'Thanks for sharing your thoughts!', reminder: 'Your reminder is saved.' };
    dialogFields.innerHTML = '';
    dialogCopy.textContent = messages[currentAction] || 'Saved.';
    dialogMessage.hidden = true;
    dialogSubmit.innerHTML = 'Done <span>✓</span>';
    currentAction = 'done';
    await refreshDashboard();
    return;
  }
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) { resultMessage('Your session has expired. Please log in again.', true); return; }
  let table;
  let row;
  if (currentAction === 'report') {
    const location = document.querySelector('#issue-location').value.trim();
    if (!location) { resultMessage('Add a location so the team knows where to go.', true); return; }
    table = 'reports';
    row = { user_id: user.id, issue_type: document.querySelector('#issue-type').value, location, note: document.querySelector('#issue-note').value.trim() };
  } else if (currentAction === 'pickup') {
    const location = document.querySelector('#pickup-location').value.trim();
    if (!location) { resultMessage('Add a pickup location to continue.', true); return; }
    table = 'pickup_requests';
    row = { user_id: user.id, waste_type: document.querySelector('#pickup-type').value, location, preferred_date: document.querySelector('#pickup-date').value || null };
  } else if (currentAction === 'feedback') {
    const message = document.querySelector('#feedback-text').value.trim();
    if (!message) { resultMessage('Add a little feedback before sending.', true); return; }
    table = 'feedback';
    row = { user_id: user.id, rating: document.querySelector('#how-was-your-experience-').value, message };
  } else if (currentAction === 'reminder') {
    const title = document.querySelector('#reminder-text').value.trim();
    if (!title) { resultMessage('Give your reminder a name first.', true); return; }
    table = 'reminders';
    row = { user_id: user.id, title, remind_at: document.querySelector('#reminder-date').value ? new Date(`${document.querySelector('#reminder-date').value}T${document.querySelector('#reminder-time').value || '09:00'}:00`).toISOString() : null };
  }
  const { error } = await supabase.from(table).insert(row);
  if (error) { resultMessage(friendlyError(error), true); return; }
  const messages = { report: 'Thanks! Your report has been saved.', pickup: 'Your pickup request has been saved.', feedback: 'Thanks for sharing your thoughts!', reminder: 'Your reminder has been saved.' };
  dialogFields.innerHTML = '';
  dialogCopy.textContent = messages[currentAction] || 'Saved.';
  dialogMessage.hidden = true;
  dialogSubmit.innerHTML = 'Done <span>✓</span>';
  currentAction = 'done';
  await refreshDashboard();
});

supabase?.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    appView.hidden = true;
    awarenessView.hidden = true;
    activeUserId = null;
    authView.hidden = false;
  } else if (event === 'SIGNED_IN' && session?.user && session.user.id !== activeUserId) {
    queueMicrotask(() => {
      if (session.user.id !== activeUserId) enterAwareness(session.user);
    });
  }
});
if (supabase) {
  supabase.auth.getSession().then(({ data: { session } }) => { if (session?.user) enterAwareness(session.user); });
}

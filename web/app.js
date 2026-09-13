const $ = (id) => document.getElementById(id);
const nativeDashboard = new URLSearchParams(location.search).get('client') === 'ios' &&
  typeof window.webkit?.messageHandlers?.questline?.postMessage === 'function';
let appliedAppLink = null;
const preferenceKeys = ['sales', 'renewals', 'trials', 'refunds', 'refundReversals', 'autoRenewDisabled', 'autoRenewEnabled', 'billingIssues', 'expirations', 'otherUpdates', 'sandbox', 'hideAmounts'];
const state = {
  config: null,
  user: null,
  epoch: 0,
  section: 'apps',
  apps: [],
  appsLoaded: false,
  appsBusy: false,
  openAppId: null,
  lookupIconUrl: null,
  setupProgress: new Map(),
  events: [],
  nextCursor: null,
  eventFilters: { appId: '', environment: 'Production' },
  eventsLoaded: false,
  eventsBusy: false,
  eventRequest: 0,
  settingsLoaded: false,
  settingsBusy: false,
  preferencesDirty: false,
};
let fieldSequence = 0;
const appLookup = { timer: null, controller: null, generation: 0, lastInput: null };
const pairing = {
  current: null, status: 'idle', generation: 0, starting: false,
  task: null, cancellation: null, timer: null, countdown: null, controller: null, suspended: false,
};

// All remote strings enter the page as text, never markup or executable URLs.
function element(tag, attributes = {}, children = []) {
  const result = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined && value !== false) {
      result.setAttribute(name, value === true ? '' : String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== null && child !== undefined) {
      result.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return result;
}

function message(target, text = '', type = '') {
  const container = typeof target === 'string' ? $(target) : target;
  container.textContent = text;
  container.hidden = !text;
  container.classList.toggle('error', type === 'error');
  container.classList.toggle('success', type === 'success');
}

function notify(text, type = '') {
  message('global-message', text, type);
}

async function api(path, { method = 'GET', data, allowUnauthorized = false, signal, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const epoch = state.epoch;
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: data === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && !allowUnauthorized && state.user && epoch === state.epoch) {
        showSignedOut();
        notify('Your session ended. Sign in again to continue.', 'error');
      }
      const error = new Error(typeof body?.error === 'string' ? body.error : `The server returned an error (${response.status}). Try again.`);
      error.status = response.status;
      throw error;
    }
    if (epoch !== state.epoch) throw new Error('Your session changed while this request was running. Refresh this view.');
    if (!body || typeof body !== 'object') throw new Error('The server returned an unexpected response. Try again.');
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The server took too long to respond. Check your connection and try again.');
    if (error instanceof TypeError) throw new Error('Cannot reach the server. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function clearPairingTimers() {
  clearTimeout(pairing.timer);
  clearInterval(pairing.countdown);
  pairing.timer = null;
  pairing.countdown = null;
}

function clearPairingImage(placeholder = 'This QR code is no longer active.') {
  $('pairing-qr').hidden = true;
  $('pairing-qr').removeAttribute('src');
  $('pairing-placeholder').hidden = false;
  $('pairing-placeholder').textContent = placeholder;
  $('pairing-code').textContent = '—';
  $('pairing-expiry').textContent = '';
  $('pairing-copy').disabled = true;
  $('pairing-simulator').open = false;
}

function pairingControls() {
  const busy = pairing.starting || ['starting', 'redeeming'].includes(pairing.status) || Boolean(pairing.cancellation);
  $('pairing-regenerate').disabled = busy;
  $('pairing-cancel').disabled = busy || !pairing.current || !['pending', 'approved'].includes(pairing.status);
  $('pairing-copy').disabled = busy || pairing.status !== 'pending' || !pairing.current || Date.parse(pairing.current.expiresAt) <= Date.now();
}

function resetPairing() {
  pairing.generation += 1;
  clearPairingTimers();
  pairing.controller?.abort();
  pairing.current = null;
  pairing.status = 'idle';
  clearPairingImage('Preparing your QR code…');
  pairingControls();
}

function finishPairing(status, text, type = '') {
  pairing.generation += 1;
  clearPairingTimers();
  if (pairing.status !== 'redeeming') pairing.controller?.abort();
  pairing.status = status;
  clearPairingImage(status === 'expired' ? 'QR code expired' : 'QR sign-in is not active');
  message('pairing-status', text, type);
  pairingControls();
}

function pairingTask(operation) {
  const task = operation();
  pairing.task = task;
  const finished = () => { if (pairing.task === task) pairing.task = null; };
  task.then(finished, finished);
  return task;
}

// Drain a possible redemption before cancelling or regenerating its QR.
function cancelPairing() {
  pairing.generation += 1;
  clearPairingTimers();
  if (pairing.status !== 'redeeming') pairing.controller?.abort();
  clearPairingImage();
  if (pairing.cancellation) return pairing.cancellation;
  const cancellation = (async () => {
    await pairing.task?.catch(() => {});
    const current = pairing.current;
    if (current) {
      try {
        await api('/api/pairing/cancel', { method: 'POST', data: { id: current.id }, allowUnauthorized: true });
      } catch (error) {
        // An expired or replaced browser cookie means this request is already
        // unavailable to this tab; it must not block creating a fresh code.
        if (error.status !== 404) throw error;
      }
      if (pairing.current === current) pairing.current = null;
    }
    pairing.status = 'cancelled';
  })();
  pairing.cancellation = cancellation;
  pairingControls();
  const finished = () => {
    if (pairing.cancellation === cancellation) pairing.cancellation = null;
    pairingControls();
  };
  cancellation.then(finished, finished);
  return cancellation;
}

function pairingIsVisible() {
  return Boolean(state.config) && !$('auth-view').hidden && !state.user &&
    !pairing.suspended && document.visibilityState === 'visible';
}

function updatePairingExpiry() {
  if (!pairing.current || !['pending', 'approved'].includes(pairing.status)) return;
  const remaining = Math.ceil((Date.parse(pairing.current.expiresAt) - Date.now()) / 1000);
  if (remaining <= 0) {
    finishPairing('expired', 'This QR code expired. Get a new QR code and scan it again.');
    return;
  }
  $('pairing-expiry').textContent = `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}. One use only.`;
}

function resumePairing() {
  if (!pairingIsVisible()) return;
  if (!pairing.current && ['idle', 'paused'].includes(pairing.status)) {
    void startPairing();
    return;
  }
  if (!['pending', 'approved'].includes(pairing.status)) return;
  clearPairingTimers();
  updatePairingExpiry();
  if (!['pending', 'approved'].includes(pairing.status)) return;
  pairing.countdown = setInterval(updatePairingExpiry, 1000);
  // Never poll faster than two seconds, even if a server response requests it.
  const interval = Math.max(2000, Math.min(10000, Number(pairing.current.pollIntervalMs) || 2000));
  pairing.timer = setTimeout(() => void pollPairing(), interval);
}

async function recoverExistingSession(generation) {
  try {
    const { user } = await api('/api/auth/me', { allowUnauthorized: true });
    if (user && generation === pairing.generation && pairingIsVisible()) {
      await showSignedIn(user);
      return true;
    }
  } catch { /* The pairing error below remains the actionable state. */ }
  return false;
}

async function startPairing() {
  if (pairing.starting) return;
  pairing.starting = true;
  pairingControls();
  try {
    await performStartPairing();
  } finally {
    pairing.starting = false;
    pairingControls();
  }
}

async function performStartPairing() {
  if (state.user || pairing.status === 'starting') return;
  if (!pairingIsVisible()) {
    pairing.status = 'paused';
    return;
  }
  try {
    await cancelPairing();
  } catch (error) {
    finishPairing('error', `${error.message} Retry with “Get new QR code”.`, 'error');
    return;
  }
  if (!pairingIsVisible()) return;
  const generation = ++pairing.generation;
  pairing.status = 'starting';
  pairing.controller = new AbortController();
  clearPairingImage('Preparing your QR code…');
  message('pairing-status', 'Preparing a one-time sign-in request…');
  pairingControls();
  await pairingTask(async () => {
    try {
      const result = await api('/api/pairing/start', { method: 'POST', data: {}, allowUnauthorized: true, signal: pairing.controller.signal });
      const current = result.pairing;
      if (!current || typeof current.id !== 'string' || !/^\d{6}$/.test(current.code) ||
          !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(current.qrImageUrl) ||
          typeof current.qrUrl !== 'string' || !current.qrUrl.startsWith('iapnotifications://pair?') ||
          typeof current.publicUrl !== 'string' ||
          !Number.isFinite(Date.parse(current.expiresAt))) throw new Error('The server returned an invalid sign-in code.');
      pairing.current = current;
      if (generation !== pairing.generation || !pairingIsVisible()) return;
      pairing.status = 'pending';
      $('pairing-qr').src = current.qrImageUrl;
      $('pairing-qr').hidden = false;
      $('pairing-placeholder').hidden = true;
      $('pairing-code').textContent = current.code;
      $('pairing-server').textContent = `Signing in to ${current.publicUrl}`;
      message('pairing-network-help', current.publicUrl.startsWith('http://')
        ? 'Local development: your phone must be able to reach this server. A localhost address works only with local simulator testing, not a separate physical iPhone.' : '');
      message('pairing-status', 'Waiting for you to scan and approve on your iPhone.');
      resumePairing();
    } catch (error) {
      if (generation !== pairing.generation) return;
      if (pairing.controller.signal.aborted && !pairingIsVisible()) {
        pairing.status = 'paused';
        return;
      }
      if (error.status === 409 && await recoverExistingSession(generation)) return;
      finishPairing('error', `${error.message} Get a new QR code to try again.`, 'error');
    } finally {
      pairingControls();
    }
  });
}

async function pollPairing() {
  if (!pairingIsVisible() || !pairing.current || !['pending', 'approved'].includes(pairing.status)) return;
  if (pairing.task) { resumePairing(); return; }
  updatePairingExpiry();
  if (pairing.status === 'expired') return;
  const generation = pairing.generation;
  const current = pairing.current;
  pairing.controller = new AbortController();
  await pairingTask(async () => {
    try {
      const result = await api(`/api/pairing/status?id=${encodeURIComponent(current.id)}`, { allowUnauthorized: true, signal: pairing.controller.signal });
      if (generation !== pairing.generation || !pairingIsVisible()) return;
      if (result.status === 'pending') {
        message('pairing-status', 'Waiting for you to scan and approve on your iPhone.');
      } else if (result.status === 'approved') {
        pairing.status = 'redeeming';
        clearPairingTimers();
        message('pairing-status', 'Approved on your iPhone. Signing in…', 'success');
        pairingControls();
        const { user } = await api('/api/pairing/redeem', { method: 'POST', data: { id: current.id }, allowUnauthorized: true });
        if (generation === pairing.generation) await showSignedIn(user);
      } else {
        const descriptions = {
          denied: 'Sign-in was declined on your iPhone. Get a new QR code if you want to try again.',
          expired: 'This QR code expired. Get a new QR code and scan it again.',
          consumed: 'This QR code has already been used. Get a new QR code to continue.',
          cancelled: 'This sign-in request was cancelled. Get a new QR code to continue.',
        };
        if (result.status === 'consumed' && await recoverExistingSession(generation)) return;
        finishPairing(result.status, descriptions[result.status] || 'This sign-in request is no longer available. Get a new QR code to continue.');
      }
    } catch (error) {
      if (generation !== pairing.generation) return;
      if (pairing.controller.signal.aborted && !pairingIsVisible()) return;
      if (error.status === 409 && await recoverExistingSession(generation)) return;
      finishPairing('error', `${error.message} Checking has stopped. Get a new QR code to try again.`, 'error');
    } finally {
      if (generation === pairing.generation) resumePairing();
      pairingControls();
    }
  });
}

function actionButton(label, action, className = '') {
  const control = element('button', { type: 'button', ...(className ? { class: className } : {}) }, label);
  control.addEventListener('click', async () => {
    if (control.disabled) return;
    const epoch = state.epoch;
    control.disabled = true;
    try {
      await action();
    } catch (error) {
      if (epoch === state.epoch) notify(error.message, 'error');
    } finally {
      if (control.isConnected) control.disabled = false;
    }
  });
  return control;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Time unavailable';
}

function formatAmount(event) {
  if (typeof event.amountMilliunits !== 'number' || !Number.isFinite(event.amountMilliunits) || !/^[A-Z]{3}$/.test(event.currency || '')) {
    return event.isMonetary ? 'Amount unavailable' : null;
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: event.currency, currencyDisplay: 'code', maximumFractionDigits: 3,
    }).format(event.amountMilliunits / 1000);
  } catch {
    return `${(event.amountMilliunits / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${event.currency}`;
  }
}

function copyField(label, value) {
  const id = `copy-field-${++fieldSequence}`;
  const input = element('input', { id, type: 'text', readonly: true, value, spellcheck: 'false' });
  const control = actionButton('Copy', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      notify(`${label} copied.`, 'success');
    } catch {
      input.focus();
      input.select();
      notify('Automatic copying is unavailable here. The address is selected; use your browser’s Copy command.');
    }
  });
  control.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
  return element('div', { class: 'endpoint' }, [
    element('label', { for: id }, label),
    element('div', { class: 'input-action' }, [input, control]),
  ]);
}

function showSignedOut() {
  cancelAppLookup();
  appliedAppLink = null;
  resetPairing();
  $('pairing-panel').hidden = false;
  state.epoch += 1;
  state.user = null;
  state.apps = [];
  state.events = [];
  state.appsLoaded = false;
  state.eventsLoaded = false;
  state.settingsLoaded = false;
  state.appsBusy = false;
  state.eventsBusy = false;
  state.settingsBusy = false;
  state.preferencesDirty = false;
  state.eventRequest += 1;
  state.openAppId = null;
  state.setupProgress.clear();
  state.lookupIconUrl = null;
  state.nextCursor = null;
  state.eventFilters = { appId: '', environment: 'Production' };
  $('event-environment').value = 'Production';
  $('auto-refresh').checked = false;
  $('session-email').textContent = '';
  for (const id of ['app-list', 'event-list', 'device-list', 'delivery-list', 'server-address']) $(id).replaceChildren();
  $('add-app-form').reset();
  resetAppDetails();
  $('lookup-form').reset();
  $('add-app-section').hidden = true;
  $('show-add-app').setAttribute('aria-expanded', 'false');
  updateSourceHelp();
  for (const id of ['lookup-message', 'add-app-message', 'apps-message', 'events-message', 'preferences-message', 'devices-message', 'deliveries-message']) message(id);
  $('preferences-form').reset();
  $('preferences-fields').disabled = true;
  $('save-preferences').disabled = true;
  $('loading-view').hidden = true;
  $('unavailable-view').hidden = true;
  $('workspace').hidden = true;
  $('session').hidden = true;
  $('auth-view').hidden = false;
  if (nativeDashboard) {
    $('pairing-panel').hidden = true;
    $('auth-title').textContent = 'Return to Questline';
    $('auth-view').querySelector(':scope > p.help').textContent = 'Your session ended. Close this view and sign in again in the app.';
    window.webkit.messageHandlers.questline.postMessage('authenticationRequired');
    return;
  }
  void startPairing();
}

async function showSignedIn(user) {
  resetPairing();
  state.epoch += 1;
  state.user = user;
  $('session-email').textContent = user.email;
  $('auth-view').hidden = true;
  $('loading-view').hidden = true;
  $('unavailable-view').hidden = true;
  $('workspace').hidden = false;
  $('session').hidden = false;
  $('logout-button').hidden = nativeDashboard;
  notify('');
  await loadApps();
  if (state.user) await selectSection(sectionFromHash(), false);
}

function sectionFromHash() {
  const section = location.hash.slice(1).split('?')[0];
  return ['apps', 'activity', 'settings'].includes(section) ? section : 'apps';
}

async function selectSection(section, focus = true) {
  if (!state.user) return;
  state.section = section;
  for (const name of ['apps', 'activity', 'settings']) {
    $(`${name}-view`).hidden = name !== section;
    const link = document.querySelector(`[data-section="${name}"]`);
    if (name === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (focus) $(`${section}-title`).focus();
  if (section === 'activity' && !state.eventsLoaded) await loadEvents();
  if (section === 'settings' && !state.settingsLoaded) await loadSettings();
  if (section === 'apps') applyAppLink();
}

// Quick links carry only a destination, never account credentials. Resolve app IDs
// against this signed-in account after loading, including after a network retry.
function applyAppLink() {
  if (!state.user || !state.appsLoaded || sectionFromHash() !== 'apps' || appliedAppLink === location.hash) return;
  appliedAppLink = location.hash;
  const query = new URLSearchParams(location.hash.split('?').slice(1).join('?'));
  if (query.get('add') === '1') {
    toggleAddApp(true);
    $('add-app-section').scrollIntoView({ block: 'start' });
  } else if (query.has('app')) {
    const id = query.get('app');
    if (!state.apps.some(app => app.id === id)) {
      notify('This app is no longer available in your account. Choose an app below.', 'error');
      return;
    }
    state.openAppId = id;
    renderApps();
    $(`setup-${id}`)?.scrollIntoView({ block: 'start' });
  }
}

function updateAppFilter() {
  const selected = state.eventFilters.appId;
  $('event-app').replaceChildren(element('option', { value: '' }, 'All apps'));
  for (const app of state.apps) $('event-app').append(element('option', { value: app.id }, app.name));
  if (state.apps.some((app) => app.id === selected)) $('event-app').value = selected;
  else {
    state.eventFilters.appId = '';
    $('event-app').value = '';
    if (selected) state.eventsLoaded = false;
  }
}

function connectionStatus(label, date) {
  return element('p', {}, [
    element('span', { class: 'connection-label' }, label),
    date ? `Signed Apple event received ${formatDate(date)}` : 'Waiting for Apple · No signed event received',
  ]);
}

// UI progress is scoped to the signed-in session, separate from verified connection status.
function setupStep(app, key, title, { completed = '', open = true, verified = false, number, hint = '' } = {}) {
  const id = `${app.id}:${key}`;
  const saved = state.setupProgress.get(id);
  const done = completed || saved?.completed || '';
  const label = element('span', { class: 'step-status' }, done || hint);
  const newlyVerified = verified && !saved?.verified;
  const summary = element('summary', {}, [
    number ? element('span', { class: 'step-number', 'aria-hidden': 'true' }, number) : null,
    element('span', { class: 'step-heading' }, [element('h3', {}, title), label]),
  ]);
  const details = element('details', { class: 'setup-step', 'data-step': key, 'data-completed': String(Boolean(done)), open: newlyVerified ? false : saved?.open ?? (!(saved?.completed || completed) && open) }, summary);
  details.addEventListener('toggle', () => {
    state.setupProgress.set(id, { completed: details.dataset.completed === 'true' ? label.textContent : '', open: details.open, verified });
  });
  const complete = (text) => {
    label.textContent = text;
    details.dataset.completed = 'true';
    state.setupProgress.set(id, { completed: text, open: false, verified });
    const hadFocus = details.contains(document.activeElement);
    details.open = false;
    if (hadFocus) summary.focus();
    details.dispatchEvent(new CustomEvent('setupcomplete', { bubbles: true, detail: { key, advance: hadFocus } }));
  };
  return { details, complete };
}

function appleConnectionTest(app, history = false) {
  const { details, complete } = setupStep(app, history ? 'apple-history' : 'apple-test', history ? 'Import past notifications' : 'Optional: test your Apple connection', { open: false });
  details.classList.add('connection-test');
  const status = element('p', { class: 'form-message', role: 'status', 'aria-live': 'polite' });
  const field = (label, control) => element('div', { class: 'field' }, [element('label', { for: control.id }, label), control]);
  const environment = element('select', { id: `${history ? 'history' : 'test'}-environment-${app.id}` }, [element('option', { value: 'Sandbox' }, 'Sandbox'), element('option', { value: 'Production' }, 'Production')]);
  const keyId = element('input', { id: `${history ? 'history' : 'test'}-key-id-${app.id}`, required: true, maxlength: 10, pattern: '[A-Z0-9]{10}', autocomplete: 'off', spellcheck: 'false' });
  const issuerId = element('input', { id: `${history ? 'history' : 'test'}-issuer-id-${app.id}`, required: true, maxlength: 36, autocomplete: 'off', spellcheck: 'false' });
  const keyFile = element('input', { id: `${history ? 'history' : 'test'}-key-file-${app.id}`, type: 'file', accept: '.p8', required: true });
  if (history) environment.value = 'Production';
  const submit = element('button', { type: 'submit' }, history ? 'Import past notifications' : 'Test Apple connection');
  const cancel = element('button', { type: 'button', hidden: true }, history ? 'Stop import' : 'Cancel test');
  const fields = element('fieldset', {}, [
    element('div', { class: 'form-grid' }, [field(history ? 'Import environment' : 'Test environment', environment), field(history ? 'Import Key ID' : 'Key ID', keyId), field(history ? 'Import Issuer ID' : 'Issuer ID', issuerId), field(history ? 'Import private key (.p8)' : 'In-App Purchase private key (.p8)', keyFile)]), submit,
  ]);
  const form = element('form', { autocomplete: 'off' }, [fields, cancel, status]);
  details.append(
    element('p', { class: 'help' }, history ? 'Imports all available notifications from the past 180 days in production or 30 days in sandbox. Duplicates are skipped and no phone alerts are sent. Only notifications Apple previously attempted to send are available.' : 'Request a signed test from Apple without making a purchase. Save your webhook URL first. This verifies only the selected environment; it does not send an iPhone alert.'),
    element('p', { class: 'help' }, 'In App Store Connect, open Users and Access → Integrations → In-App Purchase. Generate a key, download its .p8 file, and copy the Key ID and Issuer ID.'),
    element('p', {}, element('a', {
      class: 'button-link',
      href: 'https://appstoreconnect.apple.com/access/integrations/api/subs',
      target: '_blank', rel: 'noopener noreferrer',
      'aria-label': history ? 'Open integrations for history import (opens in a new tab)' : 'Open In-App Purchase integrations (opens in a new tab)',
    }, 'Open In-App Purchase integrations')),
    element('p', { class: 'help' }, 'Quest uses the key only for this operation. It is not saved to your account or browser storage, and is cleared when the operation ends or is cancelled.'), form);
  let controller = null;
  cancel.addEventListener('click', () => controller?.abort());
  details.addEventListener('toggle', () => { if (!details.open) { controller?.abort(); keyFile.value = ''; } });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (controller) return;
    const file = keyFile.files[0];
    if (!file || file.size > 8192) { message(status, 'Choose an In-App Purchase .p8 file smaller than 8 KB.', 'error'); return; }
    controller = new AbortController();
    const signal = controller.signal;
    const epoch = state.epoch;
    let credentials = null;
    let imported = 0, duplicates = 0, skipped = 0;
    let failed = false;
    const stop = () => controller?.abort();
    const observer = new MutationObserver(() => {
      if (!form.isConnected || form.closest('.setup-section')?.hidden || state.epoch !== epoch) stop();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('hashchange', stop);
    window.addEventListener('pagehide', stop);
    fields.disabled = true;
    cancel.hidden = false;
    submit.textContent = history ? 'Importing…' : 'Testing…';
    message(status, history ? 'Requesting notification history from Apple. This may take up to 30 seconds per page…' : 'Requesting a test from Apple…');
    try {
      credentials = { environment: environment.value, keyId: keyId.value.trim(), issuerId: issuerId.value.trim(), privateKey: await file.text() };
      keyFile.value = '';
      if (signal.aborted) throw new Error('Cancelled');
      if (history) {
        let cursor;
        do {
          if (signal.aborted) throw new Error('Cancelled');
          const page = await api(`/api/apps/${encodeURIComponent(app.id)}/import-history`, { method: 'POST', data: { ...credentials, ...(cursor ? { cursor } : {}) }, signal, timeoutMs: 55000 });
          imported += page.imported; duplicates += page.duplicates; skipped += page.skipped;
          cursor = page.cursor;
          message(status, `Imported ${imported} notifications. Skipped ${duplicates} duplicates and ${skipped} connection tests.${cursor ? ' Loading more…' : ''}`);
          if (cursor) await new Promise(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, 600);
            signal.addEventListener('abort', done, { once: true });
            if (signal.aborted) done();
          });
        } while (cursor);
        message(status, imported + duplicates + skipped === 0
          ? 'No past notifications are available from Apple for this environment.'
          : `Import complete. Added ${imported} notifications; skipped ${duplicates} duplicates and ${skipped} connection tests. View them in Activity. No phone alerts were sent.`);
        return;
      }
      const result = await api(`/api/apps/${encodeURIComponent(app.id)}/apple-test`, { method: 'POST', data: credentials, signal });
      message(status, 'Apple accepted the request. Waiting for the signed notification to reach Quest…');
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 3000);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
        if (signal.aborted) throw new Error('Cancelled');
        const check = await api(`/api/apps/${encodeURIComponent(app.id)}/apple-test/status`, { method: 'POST', data: { ...credentials, testNotificationToken: result.testNotificationToken }, signal });
        if (check.state === 'received') {
          complete(`${credentials.environment} verified`);
          notify(`${credentials.environment} Apple test received and verified for “${app.name}”. No purchase was created.`, 'success');
          await loadApps();
          return;
        }
        if (check.appleDelivery) message(status, `Waiting for Quest to receive the test. Apple delivery result: ${check.appleDelivery}. ${app.source === 'revenuecat' ? 'Check RevenueCat forwarding if the test does not arrive.' : 'Check that App Store Connect has this app’s Quest webhook URL.'}`);
      }
      message(status, 'No matching test received within one minute. Apple may still deliver it. Check the saved URL and Activity, then retry if needed.', 'error');
    } catch (error) {
      failed = true;
      if (epoch === state.epoch && form.isConnected) {
        const description = history
          ? `${signal.aborted ? 'Import stopped.' : error.message} ${imported ? `${imported} notifications confirmed imported.` : 'No notifications confirmed imported.'} Choose your .p8 file again, then select “Retry import”. Any unfinished request may still complete; duplicates are skipped.`
          : signal.aborted ? 'Test check cancelled. Apple may still deliver the requested notification.' : error.message;
        message(status, description, signal.aborted ? '' : 'error');
      }
    } finally {
      if (credentials) credentials.privateKey = '';
      keyFile.value = '';
      fields.disabled = false;
      submit.textContent = history ? (failed ? 'Retry import' : 'Import past notifications') : 'Test Apple connection';
      cancel.hidden = true;
      observer.disconnect();
      window.removeEventListener('hashchange', stop);
      window.removeEventListener('pagehide', stop);
      controller = null;
    }
  });
  return details;
}

function phoneTestAlert(app) {
  const { details: section, complete } = setupStep(app, 'phone-test', 'Test iPhone delivery', { number: 2, open: Boolean(app.lastProductionEventAt || state.setupProgress.get(`${app.id}:urls`)?.completed), hint: state.config.apnsConfigured ? 'Send a test alert to your phone' : 'Unavailable · Server setup needed' });
  section.classList.add('phone-test');
  const status = element('p', { class: 'form-message', role: 'status', 'aria-live': 'polite' });
  const select = element('select', { id: `test-phone-${app.id}` });
  const choice = element('div', { class: 'field', hidden: true }, [element('label', { for: select.id }, 'iPhone for test alert'), select]);
  const button = actionButton('Send test alert', async () => {
    const epoch = state.epoch;
    try {
      message(status, 'Checking registered iPhones…');
      const { devices } = await api('/api/devices');
      if (epoch !== state.epoch || !section.isConnected) return;
      const active = devices.filter((device) => device.active);
      if (!active.length) { message(status, 'No iPhones registered. Sign in to Quest on your iPhone and enable notifications, then try again.'); return; }
      let device = active.find((item) => item.id === select.value);
      if (active.length === 1) device = active[0];
      if (!device) {
        select.replaceChildren(...active.map((item) => element('option', { value: item.id }, item.name)));
        choice.hidden = false;
        message(status, 'Choose an iPhone, then select Send test alert.');
        return;
      }
      const result = await api(`/api/devices/${encodeURIComponent(device.id)}/test`, { method: 'POST' });
      if (!result.queued) throw new Error('The server did not confirm the test alert was queued.');
      if (epoch === state.epoch && section.isConnected) {
        message(status, `Test alert queued for “${device.name}”. Check your iPhone. Delivery attempts are in Settings; queued does not mean displayed.`, 'success');
        complete('Test queued · Check iPhone');
      }
    } catch (error) { if (epoch === state.epoch) message(status, error.message, 'error'); }
  });
  button.disabled = !state.config.apnsConfigured;
  section.append(
    element('p', { class: 'help' }, 'Send a test alert from Quest to your iPhone. This works independently of Apple webhook setup and does not verify the Apple connection.'), choice, button, status);
  if (!state.config.apnsConfigured) message(status, 'iPhone alerts are not configured on this server yet. APNs setup is required before a test can be sent.');
  return section;
}

function forwardingSettings(app) {
  const configured = app.forwarding?.productionUrl || app.forwarding?.sandboxUrl;
  const section = element('details', { class: 'setup-step forwarding-settings', open: !!configured });
  const disclosure = element('span', { class: 'forwarding-disclosure' }, configured ? 'Close settings' : 'Open settings');
  section.append(element('summary', {}, [
    element('span', { class: 'forwarding-heading' }, [
      element('strong', {}, 'Forward to your existing server'),
      element('span', { class: 'forwarding-caution' }, 'Before replacing existing URLs: save them here so your current server keeps receiving notifications.'),
    ]),
    disclosure,
  ]));
  section.addEventListener('toggle', () => { disclosure.textContent = section.open ? 'Close settings' : 'Open settings'; });
  const helpId = `forward-help-${app.id}`;
  section.append(element('p', { class: 'help', id: helpId }, 'Already have server URLs in App Store Connect? Save them here first, then replace them in App Store Connect with Quest’s URLs below. Your server will receive the original signed Apple V2 notifications, including connection tests.'));
  const form = element('form');
  const inputs = {};
  for (const environment of ['production', 'sandbox']) {
    const id = `forward-${environment}-${app.id}`;
    inputs[environment] = element('input', { id, type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', maxlength: 2048,
      value: app.forwarding?.[`${environment}Url`] || '', placeholder: `https://your-server.com/apple/${environment}`, 'aria-describedby': helpId });
    form.append(element('div', { class: 'field' }, [element('label', { for: id }, `Existing ${environment} server URL`), inputs[environment]]));
  }
  form.append(element('p', { class: 'help' }, 'Each URL is optional. Use a public HTTPS endpoint that accepts Apple V2 notifications. Leave an environment blank to turn its forwarding off; sandbox never falls back to production.'));
  const save = element('button', { type: 'submit' }, 'Save forwarding');
  const status = element('p', { class: 'form-message', role: 'status', 'aria-live': 'polite', hidden: true });
  form.append(save, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const epoch = state.epoch;
    save.disabled = true;
    message(status, 'Saving forwarding URLs…');
    try {
      const { app: updated } = await api(`/api/apps/${encodeURIComponent(app.id)}/forwarding`, { method: 'PUT', data: {
        productionUrl: inputs.production.value.trim() || null, sandboxUrl: inputs.sandbox.value.trim() || null,
      } });
      if (epoch !== state.epoch || !section.isConnected) return;
      state.apps = state.apps.map((current) => current.id === updated.id ? updated : current);
      for (const environment of ['production', 'sandbox']) inputs[environment].value = updated.forwarding?.[`${environment}Url`] || '';
      message(status, updated.forwarding?.productionUrl || updated.forwarding?.sandboxUrl
        ? 'Forwarding saved. You can now copy Quest’s URLs into App Store Connect. Check forwarding deliveries after your next Apple event or connection test.'
        : 'Forwarding is off. Quest will continue receiving notifications at its own URLs.', 'success');
    } catch (error) { if (epoch === state.epoch && section.isConnected) message(status, error.message, 'error'); }
    finally { save.disabled = false; }
  });
  section.append(form,
    element('p', { class: 'help' }, 'Delivery retries for up to 24 hours. Your server must handle duplicates and verify Apple’s signature. Changing or clearing a URL cancels its queued deliveries; a request already in progress may finish. Demo events and history imports are not forwarded.'),
    element('h4', {}, 'Forwarding deliveries'));
  const deliveryStatus = element('p', { class: 'form-message', role: 'status', 'aria-live': 'polite' }, 'Check delivery after a signed Apple event reaches Quest.');
  const list = element('ul', { class: 'forwarding-deliveries' });
  section.append(actionButton('Refresh forwarding deliveries', async () => {
    const epoch = state.epoch;
    message(deliveryStatus, 'Checking forwarding deliveries…');
    try {
      const { deliveries } = await api(`/api/apps/${encodeURIComponent(app.id)}/forwarding/deliveries`);
      if (epoch !== state.epoch || !section.isConnected) return;
      const labels = { pending: 'Queued for retry or delivery', processing: 'Sending', sent: 'Accepted by your server', failed: 'Failed', cancelled: 'Cancelled' };
      list.replaceChildren(...deliveries.map((delivery) => element('li', {}, [
        element('p', {}, `${delivery.environment} · ${labels[delivery.state] || delivery.state} · ${delivery.attempts} attempt${delivery.attempts === 1 ? '' : 's'}`),
        element('p', { class: 'metadata' }, `${new Date(delivery.createdAt).toLocaleString()}${delivery.statusCode ? ` · HTTP ${delivery.statusCode}` : ''}${delivery.lastError ? ` · ${delivery.lastError}` : ''}`),
      ])));
      message(deliveryStatus, deliveries.length ? 'Showing the latest forwarding deliveries from the past 7 days.' : 'No forwarding deliveries yet. Save a destination and run an Apple connection test, or wait for a new signed Apple event.');
    } catch (error) { if (epoch === state.epoch && section.isConnected) message(deliveryStatus, error.message, 'error'); }
  }), deliveryStatus, list);
  return section;
}

function setupDetails(app) {
  const section = element('section', { class: 'setup-section', 'aria-label': `Setup for ${app.name}` });
  const progress = element('p', { class: 'setup-progress', role: 'status', 'aria-live': 'polite' });
  section.append(element('div', { class: 'setup-heading' }, [
    element('h2', {}, 'Set up notifications'), progress,
  ]));
  const { details: connection, complete: completeConnection } = setupStep(app, 'urls', 'Connect Apple notifications', {
    completed: app.lastProductionEventAt ? 'Production verified' : '',
    verified: !!app.lastProductionEventAt, number: 1, hint: 'Save your notification URLs',
  });
  if (app.lastProductionEventAt) {
    const title = connection.querySelector('summary h3');
    const updateTitle = () => { title.textContent = connection.open ? 'Hide connection details' : 'Show connection details'; };
    updateTitle();
    connection.addEventListener('toggle', updateTitle);
  }
  section.append(connection);
  if (app.source === 'revenuecat') {
    connection.append(element('p', { class: 'notice' }, 'Keep RevenueCat’s existing Apple production and sandbox URLs in App Store Connect. Do not replace them with this service’s URLs.'));
    connection.append(element('ol', {}, [
      element('li', {}, 'Open this app’s settings in RevenueCat and find Apple Server Notifications forwarding.'),
      element('li', {}, 'Set the forwarding URL below in RevenueCat. It accepts both production and sandbox notifications and verifies their environment.'),
      element('li', {}, 'Wait for a signed notification from Apple through RevenueCat. A demo push does not verify this connection.'),
    ]));
    if (app.forwardingUrl) connection.append(copyField('RevenueCat Apple forwarding URL', app.forwardingUrl));
    else connection.append(element('p', { class: 'notice error' }, 'This server did not return a RevenueCat forwarding URL. Refresh the page or update the server before continuing; do not substitute a production-only URL.'));
    connection.append(element('p', {}, element('a', {
      href: 'https://www.revenuecat.com/docs/platform-resources/server-notifications/apple-server-notifications', target: '_blank', rel: 'noopener noreferrer',
    }, 'RevenueCat Apple notification setup guide')));
  } else {
    connection.append(element('p', {}, element('a', {
      class: 'button-link',
      href: `https://appstoreconnect.apple.com/apps/${encodeURIComponent(app.appleId)}/distribution/info#:~:text=App%20Store%20Server%20Notifications`,
      target: '_blank', rel: 'noopener noreferrer',
      'aria-label': 'Open App Store Connect (opens in a new tab)',
    }, 'Open App Store Connect')));
    connection.append(element('p', { class: 'help' }, 'In App Information → App Store Server Notifications, choose Version 2. Save the production URL, then the sandbox URL for testing. App Store Connect opens in a new tab.'));
    connection.append(forwardingSettings(app));
    connection.append(copyField('Production webhook URL', app.webhookUrls.production));
    connection.append(copyField('Sandbox webhook URL', app.webhookUrls.sandbox));

  }
  if (!state.config.publicUrl.startsWith('https://')) {
    connection.append(element('p', { class: 'notice error' }, 'This server is using HTTP/local development. Apple requires a publicly reachable HTTPS endpoint. Configure PUBLIC_URL and HTTPS hosting before expecting Apple notifications.'));
  }
  const connectionHelp = element('details', { class: 'connection-help' }, [
    element('summary', {}, 'How is the connection verified?'),
    element('p', { class: 'help' }, 'Your connection is verified when a signed Apple event arrives. To check it now, use a sandbox purchase or the optional Apple connection test below. Production and sandbox are verified separately.'),
    element('p', { class: 'help' }, 'Keep webhook addresses private. They identify this connection; Apple signatures are still required. This service does not respond to refund-consumption requests or manage customer entitlements.'),
    element('p', {}, element('a', {
      href: 'https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications/', target: '_blank', rel: 'noopener noreferrer',
    }, 'Apple’s notification setup guide')),
  ]);
  connection.append(connectionHelp);
  if (!app.lastProductionEventAt) connection.append(element('div', { class: 'step-actions' }, [
    actionButton('URLs saved', () => completeConnection('URLs saved'), 'primary'),
    element('span', { class: 'help' }, 'Continue to iPhone delivery. Apple verification happens when a signed event arrives.'),
  ]));
  section.append(phoneTestAlert(app));
  const optional = element('div', { class: 'optional-tools' }, [
    element('h3', {}, 'Optional tools'),
    element('p', { class: 'help' }, state.config.demoEnabled ? 'Check your Apple connection, import history, or explore with demo activity.' : 'Check your Apple connection or import notification history.'),
  ]);
  optional.append(appleConnectionTest(app), appleConnectionTest(app, true));
  if (state.config.demoEnabled) {
    const { details: demo, complete } = setupStep(app, 'demo', 'Try a labelled demo', { open: false });
    demo.append(element('p', { class: 'help' }, 'Creates synthetic activity and may queue a demo push. It does not contact Apple, record real revenue, or mark this app connected.'));
    const runDemo = async (kind) => { await createDemo(app, kind); complete('Demo created'); };
    demo.append(element('div', { class: 'actions' }, [
      actionButton('Create demo sale', () => runDemo('sale')),
      actionButton('Create demo refund', () => runDemo('refund')),
    ]));
    optional.append(demo);
  }
  section.append(optional);
  const management = element('details', { class: 'connection-management' }, element('summary', {}, 'Connection management'));
  management.append(element('p', { class: 'help' }, 'Replace this app’s webhook URLs or remove the app and its history.'));
  management.append(element('div', { class: 'actions' }, [
    actionButton('Rotate webhook URLs', async () => {
      if (!window.confirm(`Rotate webhook URLs for “${app.name}”? The old URLs stop working immediately. Update ${app.source === 'revenuecat' ? 'RevenueCat forwarding' : 'App Store Connect'} after rotating to continue receiving events.`)) return;
      const { app: updated } = await api(`/api/apps/${encodeURIComponent(app.id)}/rotate-webhook`, { method: 'POST' });
      state.setupProgress.delete(`${app.id}:urls`);
      state.setupProgress.delete(`${app.id}:apple-test`);
      state.apps = state.apps.map((current) => current.id === updated.id ? updated : current);
      state.openAppId = updated.id;
      renderApps();
      notify('Webhook URLs rotated. Copy the new address into your provider now; the previous address no longer accepts events.', 'success');
    }),
    actionButton('Remove app', async () => {
      if (!window.confirm(`Remove “${app.name}”? This permanently deletes this app’s event history and queued pushes, and stops its webhook URLs. This cannot be undone.`)) return;
      await api(`/api/apps/${encodeURIComponent(app.id)}`, { method: 'DELETE' });
      state.openAppId = null;
      state.events = [];
      state.eventsLoaded = false;
      state.settingsLoaded = false;
      await loadApps();
      notify(`Removed “${app.name}” and its stored events and queued pushes. This cannot be recovered from this service.`, 'success');
    }, 'danger'),
  ]));
  section.append(management);
  const updateProgress = () => {
    const connected = connection.dataset.completed === 'true';
    const tested = section.querySelector('[data-step="phone-test"]').dataset.completed === 'true';
    progress.textContent = !connected ? 'Start with your Apple connection.'
      : !tested ? 'URLs saved. Next, test delivery to your iPhone.'
      : 'Test alert queued. Check your iPhone to confirm delivery.';
    if (app.lastProductionEventAt && !tested) progress.textContent = 'Production connected. Next, test delivery to your iPhone.';
  };
  section.addEventListener('setupcomplete', (event) => {
    updateProgress();
    if (event.detail.key === 'urls') {
      const next = section.querySelector('[data-step="phone-test"]');
      next.open = true;
      if (event.detail.advance) next.querySelector('summary').focus();
    }
  });
  updateProgress();
  return section;
}

function renderApps() {
  const list = $('app-list');
  list.replaceChildren();
  if (!state.apps.length) {
    list.append(element('div', { class: 'empty-state' }, [
      element('h2', {}, 'No apps connected yet'),
      element('p', {}, 'Add your app, connect Apple notifications, then send a test to your iPhone. No changes to your app’s code are needed.'),
      actionButton('Add your first app', () => toggleAddApp(true)),
    ]));
    return;
  }
  for (const app of state.apps) {
    const item = element('article', { class: 'app-item' });
    const detailsId = `setup-${app.id}`;
    const open = state.openAppId === app.id;
    const toggle = element('button', { type: 'button', 'aria-expanded': String(open), 'aria-controls': detailsId }, open ? 'Hide setup' : 'Show setup');
    const details = setupDetails(app);
    details.id = detailsId;
    details.hidden = !open;
    toggle.addEventListener('click', () => {
      const willOpen = details.hidden;
      details.hidden = !willOpen;
      toggle.textContent = willOpen ? 'Hide setup' : 'Show setup';
      toggle.setAttribute('aria-expanded', String(willOpen));
      state.openAppId = willOpen ? app.id : null;
    });
    item.append(element('div', { class: 'item-heading' }, [
      element('div', {}, [
        element('h2', {}, app.name),
        element('p', { class: 'metadata' }, `${app.bundleId} · Apple ID ${app.appleId} · ${app.source === 'revenuecat' ? 'RevenueCat forwarding' : 'Direct Apple'}`),
      ]), toggle,
    ]));
    item.append(element('div', { class: 'connection-list' }, [
      connectionStatus('Production', app.lastProductionEventAt),
      connectionStatus('Sandbox', app.lastSandboxEventAt),
    ]));
    item.append(details);
    list.append(item);
  }
}

async function loadApps() {
  if (state.appsBusy || !state.user) return;
  const epoch = state.epoch;
  state.appsBusy = true;
  $('refresh-apps').disabled = true;
  message('apps-message', 'Loading app connections…');
  try {
    const { apps } = await api('/api/apps');
    if (epoch !== state.epoch) return;
    state.apps = apps;
    state.appsLoaded = true;
    updateAppFilter();
    renderApps();
    message('apps-message');
    applyAppLink();
  } catch (error) {
    if (epoch === state.epoch) message('apps-message', error.message, 'error');
  } finally {
    if (epoch === state.epoch) {
      state.appsBusy = false;
      $('refresh-apps').disabled = false;
    }
  }
}

function toggleAddApp(show) {
  if (!show) cancelAppLookup();
  if (show && appSetupStep !== 'find') setAppSetupStep(appSetupStep, false);
  $('add-app-section').hidden = !show;
  $('show-add-app').setAttribute('aria-expanded', String(show));
  if (show) $(appSetupStep === 'find' ? 'add-app-title' : 'app-details-title').focus();
  else $('show-add-app').focus();
}

async function createDemo(app, kind) {
  await api(`/api/apps/${encodeURIComponent(app.id)}/demo`, { method: 'POST', data: { kind } });
  state.eventFilters = { appId: app.id, environment: 'Demo' };
  $('event-app').value = app.id;
  $('event-environment').value = 'Demo';
  state.eventsLoaded = false;
  if (location.hash !== '#activity') location.hash = 'activity';
  else await selectSection('activity');
  notify('Demo activity created. It is synthetic and does not verify the Apple connection.', 'success');
}

function renderEvents() {
  const list = $('event-list');
  list.replaceChildren();
  if (!state.events.length) {
    const environment = state.eventFilters.environment;
    const explanation = environment === 'Demo'
      ? 'Create a labelled demo from an app’s setup to test this activity feed.'
      : `No ${environment === 'all' ? '' : `${environment.toLowerCase()} `}events match these filters. Check your app’s setup; signed Apple events appear here after they arrive.`;
    list.append(element('li', { class: 'empty-state' }, [element('h2', {}, 'No activity yet'), element('p', {}, explanation)]));
  }
  for (const event of state.events) {
    const tag = element('span', { class: `tag${event.environment === 'Demo' ? ' demo' : ''}` }, event.environment === 'Demo' ? 'Demo · synthetic' : event.environment);
    const heading = element('div', { class: 'event-title' }, [element('h2', {}, event.title), tag]);
    const amount = formatAmount(event);
    const titleRow = element('div', { class: 'item-heading' }, [heading]);
    if (amount) titleRow.append(element('span', { class: 'amount' }, amount));
    const attributes = element('dl', { class: 'event-details' });
    const fields = [
      ['Apple event', event.notificationType + (event.subtype ? ` / ${event.subtype}` : '')],
      ['Product', event.productId || 'Not provided'],
      ['Transaction', event.transactionId || 'Not provided'],
      ['Occurred', formatDate(event.occurredAt)],
      ['Received by server', formatDate(event.receivedAt)],
    ];
    for (const [label, value] of fields) attributes.append(element('dt', {}, label), element('dd', {}, value));
    list.append(element('li', { class: 'event-item' }, [
      titleRow,
      element('p', { class: 'metadata' }, `${event.appName} · ${formatDate(event.occurredAt)}`),
      element('p', {}, event.detail),
      element('details', {}, [element('summary', {}, 'Event details'), attributes]),
    ]));
  }
  $('load-more-events').hidden = !state.nextCursor;
}

async function loadEvents({ append = false, quiet = false } = {}) {
  if (!state.user || (quiet && state.eventsBusy)) return;
  const epoch = state.epoch;
  const request = ++state.eventRequest;
  state.eventsBusy = true;
  $('refresh-events').disabled = true;
  $('load-more-events').disabled = true;
  const query = new URLSearchParams({ environment: state.eventFilters.environment, limit: '50' });
  if (state.eventFilters.appId) query.set('appId', state.eventFilters.appId);
  if (append && state.nextCursor) query.set('before', state.nextCursor);
  if (!quiet) message('events-message', append ? 'Loading older activity…' : 'Loading activity…');
  try {
    const { events, nextCursor } = await api(`/api/events?${query}`);
    if (epoch !== state.epoch || request !== state.eventRequest) return;
    const combined = append ? [...state.events, ...events] : events;
    state.events = [...new Map(combined.map((event) => [event.id, event])).values()];
    state.nextCursor = nextCursor;
    state.eventsLoaded = true;
    renderEvents();
    message('events-message');
    $('events-updated').textContent = `Updated ${new Date().toLocaleTimeString()}. Times use ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time zone'}.`;
  } catch (error) {
    if (epoch === state.epoch && request === state.eventRequest) message('events-message', error.message, 'error');
  } finally {
    if (epoch === state.epoch && request === state.eventRequest) {
      state.eventsBusy = false;
      $('refresh-events').disabled = false;
      $('load-more-events').disabled = false;
    }
  }
}

function renderServerConfig() {
  const config = state.config;
  $('server-address').replaceChildren(copyField('Server address for the iPhone app', config.publicUrl));
  const status = config.apnsConfigured
    ? 'APNs credentials are configured on the server. Connect an iPhone and send a test push to check delivery.'
    : 'iPhone push delivery is not configured. The server operator must set APNS_TEAM_ID, APNS_KEY_ID, APNS_TOPIC, and APNS_PRIVATE_KEY_PATH, then restart the server. Event history still works.';
  message('apns-status', status, config.apnsConfigured ? '' : 'error');
  if (!config.publicUrl.startsWith('https://')) {
    $('server-address').append(element('p', { class: 'help' }, 'This is a local HTTP address. A physical iPhone needs a reachable HTTPS server for normal use; localhost on the phone refers to the phone itself.'));
  }
}

function renderDevices(devices) {
  const list = $('device-list');
  list.replaceChildren();
  if (!devices.length) {
    list.append(element('p', { class: 'empty-state' }, 'No iPhones registered. Sign in from the iPhone app and allow notifications to register this device.'));
    return;
  }
  for (const device of devices) {
    const actions = element('div', { class: 'actions' });
    if (device.active) {
      const test = actionButton('Send test alert', async () => {
        const result = await api(`/api/devices/${encodeURIComponent(device.id)}/test`, { method: 'POST' });
        if (!result.queued) throw new Error('The server did not confirm that the test push was queued.');
        notify(`Test push queued for “${device.name}”. Check the phone and refresh delivery attempts; queued does not mean displayed.`, 'success');
        await loadDeliveries();
      });
      test.disabled = !state.config.apnsConfigured;
      if (test.disabled) test.title = 'Configure the server’s APNs credentials first.';
      actions.append(test);
      actions.append(actionButton('Disconnect', async () => {
        if (!window.confirm(`Disconnect “${device.name}”? It will stop receiving pushes, and pending pushes for it will be cancelled. You can reconnect from the iPhone app.`)) return;
        await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
        await Promise.all([loadDevices(), loadDeliveries()]);
        notify(`Disconnected “${device.name}” and cancelled its pending pushes.`, 'success');
      }, 'danger'));
    }
    list.append(element('article', { class: 'device-item' }, [
      element('div', { class: 'item-heading' }, [
        element('div', {}, [element('h3', {}, device.name), element('p', { class: 'metadata' }, `${device.active ? 'Active' : 'Disconnected'} · APNs ${device.environment} · Last registration ${formatDate(device.lastSeenAt)}`)]),
        actions,
      ]),
    ]));
  }
}

async function loadDevices() {
  const epoch = state.epoch;
  message('devices-message', 'Loading connected iPhones…');
  try {
    const { devices } = await api('/api/devices');
    if (epoch !== state.epoch) return;
    renderDevices(devices);
    message('devices-message');
  } catch (error) {
    if (epoch === state.epoch) message('devices-message', error.message, 'error');
  }
}

async function loadDeliveries() {
  const epoch = state.epoch;
  message('deliveries-message', 'Loading push delivery attempts…');
  try {
    const { deliveries } = await api('/api/deliveries?limit=30');
    if (epoch !== state.epoch) return;
    const labels = { pending: 'Queued', processing: 'Sending', sent: 'Accepted by APNs', failed: 'Failed', cancelled: 'Cancelled' };
    const list = $('delivery-list');
    list.replaceChildren();
    if (!deliveries.length) list.append(element('p', { class: 'empty-state' }, 'No push delivery attempts yet. Register an iPhone and send a test push, or wait for an enabled event.'));
    for (const delivery of deliveries) {
      const item = element('article', { class: 'delivery-item' }, [
        element('div', { class: 'item-heading' }, [
          element('h3', {}, delivery.deviceName || 'Disconnected device'),
          element('span', { class: `tag ${['sent', 'failed'].includes(delivery.state) ? delivery.state : ''}` }, labels[delivery.state] || delivery.state),
        ]),
        element('p', { class: 'metadata' }, `${delivery.attempts} attempt${delivery.attempts === 1 ? '' : 's'} · Updated ${formatDate(delivery.updatedAt)}`),
      ]);
      if (delivery.lastError) item.append(element('p', { class: 'form-message error' }, delivery.lastError));
      list.append(item);
    }
    message('deliveries-message');
  } catch (error) {
    if (epoch === state.epoch) message('deliveries-message', error.message, 'error');
  }
}

async function loadPreferences() {
  const epoch = state.epoch;
  message('preferences-message', 'Loading preferences…');
  $('preferences-fields').disabled = true;
  $('save-preferences').disabled = true;
  try {
    const { preferences } = await api('/api/preferences');
    if (epoch !== state.epoch) return;
    for (const key of preferenceKeys) $('preferences-form').elements.namedItem(key).checked = Boolean(preferences[key]);
    state.preferencesDirty = false;
    $('preferences-fields').disabled = false;
    $('save-preferences').disabled = false;
    message('preferences-message');
  } catch (error) {
    if (epoch === state.epoch) message('preferences-message', error.message, 'error');
  }
}

async function loadSettings() {
  if (state.settingsBusy || !state.user) return;
  if (state.preferencesDirty && !window.confirm('Discard your unsaved push preference changes and reload settings?')) return;
  const epoch = state.epoch;
  state.settingsBusy = true;
  $('refresh-settings').disabled = true;
  renderServerConfig();
  try {
    await Promise.all([loadPreferences(), loadDevices(), loadDeliveries()]);
    if (epoch === state.epoch) state.settingsLoaded = true;
  } finally {
    if (epoch === state.epoch) {
      state.settingsBusy = false;
      $('refresh-settings').disabled = false;
    }
  }
}

async function start() {
  $('loading-view').hidden = false;
  $('unavailable-view').hidden = true;
  $('auth-view').hidden = true;
  $('retry-startup').disabled = true;
  try {
    state.config = await api('/api/config', { allowUnauthorized: true });
    const name = state.config.serviceName || 'IAP Notifications';
    $('service-name').textContent = name;
    document.title = name;
    let user;
    try {
      ({ user } = await api('/api/auth/me', { allowUnauthorized: true }));
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    if (user) await showSignedIn(user);
    else showSignedOut();
  } catch (error) {
    $('loading-view').hidden = true;
    $('unavailable-view').hidden = false;
    $('unavailable-detail').textContent = error.message;
  } finally {
    $('retry-startup').disabled = false;
  }
}

$('retry-startup').addEventListener('click', start);
$('pairing-regenerate').addEventListener('click', () => void startPairing());
$('pairing-cancel').addEventListener('click', async () => {
  try {
    await cancelPairing();
    finishPairing('cancelled', 'Sign-in cancelled. Get a new QR code when you are ready.');
  } catch (error) {
    finishPairing('error', `${error.message} Get a new QR code to retry safely, or use email sign-in.`, 'error');
  }
});
$('pairing-copy').addEventListener('click', async () => {
  updatePairingExpiry();
  if (!pairing.current || pairing.status !== 'pending' || $('pairing-copy').disabled) return;
  const generation = pairing.generation;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(pairing.current.qrUrl);
    if (generation === pairing.generation) notify('One-use QR link copied. Keep it private and open it only in your own simulator.');
  } catch {
    if (generation === pairing.generation) message('pairing-status', 'Clipboard access is unavailable here. Scan this QR code from Settings in the iPhone app.', 'error');
  }
});

function pausePairing() {
  clearPairingTimers();
  // A redemption already approved by the phone must settle before another
  // authentication flow begins. Only idle polling and code creation are aborted.
  if (pairing.status !== 'redeeming') pairing.controller?.abort();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumePairing();
  else pausePairing();
});
window.addEventListener('pagehide', () => {
  pairing.suspended = true;
  pausePairing();
});
window.addEventListener('pageshow', () => {
  pairing.suspended = false;
  resumePairing();
});

$('logout-button').addEventListener('click', async () => {
  const control = $('logout-button');
  control.disabled = true;
  try {
    await api('/api/auth/logout', { method: 'POST' });
    showSignedOut();
    notify('Signed out of this browser. Connected iPhones keep their own sessions.');
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    control.disabled = false;
  }
});

window.addEventListener('hashchange', () => { appliedAppLink = null; void selectSection(sectionFromHash()); });
$('show-add-app').addEventListener('click', () => toggleAddApp($('add-app-section').hidden));
$('cancel-add-app').addEventListener('click', () => toggleAddApp(false));
$('refresh-apps').addEventListener('click', loadApps);
function updateSourceHelp() {
  $('source-help').textContent = $('app-source').value === 'revenuecat'
    ? 'Keep RevenueCat’s Apple URLs in App Store Connect. We will provide a separate Apple notification forwarding URL for RevenueCat.'
    : 'Already have server URLs in App Store Connect? After adding your app, save those URLs in forwarding so your existing server keeps receiving notifications through Quest.';
}
$('app-source').addEventListener('change', updateSourceHelp);

let appSetupStep = 'find';
let importedApp = null;
function setAppSetupStep(step, focus = true) {
  appSetupStep = step;
  $('app-find-step').hidden = step !== 'find';
  $('app-details').hidden = step === 'find';
  $('app-confirm-step').hidden = step !== 'confirm';
  $('app-connect-step').hidden = step !== 'connect';
  for (const name of ['find', 'confirm', 'connect']) {
    if (step === name) $(`app-step-${name}`).setAttribute('aria-current', 'step');
    else $(`app-step-${name}`).removeAttribute('aria-current');
  }
  $('app-details-title').textContent = step === 'connect' ? 'Connect sales alerts' : importedApp ? 'Confirm your app' : 'Enter app details';
  $('app-step-back').textContent = step === 'connect' ? 'Back to app details' : 'Back to search';
  $('add-app-submit').textContent = step === 'connect' ? 'Add app & show connection steps' : 'Continue';
  if (focus) {
    const heading = $(step === 'find' ? 'add-app-title' : 'app-details-title');
    heading.focus();
    heading.scrollIntoView({ block: 'start' });
  }
}
function appIdentityArtwork(app) {
  const image = element('img', { src: app.iconUrl, alt: '', class: 'lookup-icon', loading: 'lazy' });
  image.addEventListener('error', () => image.remove(), { once: true });
  return image;
}
function renderAppIdentity() {
  const name = $('app-name').value.trim();
  const identity = $('app-identity');
  identity.replaceChildren();
  identity.hidden = !name;
  const sameApp = importedApp?.bundleId === $('app-bundle-id').value.trim() && String(importedApp?.appleId) === $('app-apple-id').value.trim();
  if (sameApp && state.lookupIconUrl) identity.append(appIdentityArtwork({ iconUrl: state.lookupIconUrl }));
  identity.append(element('div', {}, [
    element('strong', {}, name),
    element('p', { class: 'help' }, (sameApp && importedApp?.developer) || $('app-bundle-id').value.trim()),
  ]));
}
function showAppDetails(imported = false) {
  $('app-identity-fields').hidden = imported;
  $('edit-app-details').hidden = !imported;
  $('edit-app-details').setAttribute('aria-expanded', 'false');
  renderAppIdentity();
  setAppSetupStep('confirm');
}
function resetAppDetails() {
  importedApp = null;
  $('app-find-help').open = false;
  $('app-identity').replaceChildren();
  $('app-identity').hidden = true;
  setAppSetupStep('find', false);
}
$('edit-app-details').addEventListener('click', () => {
  const show = $('app-identity-fields').hidden;
  $('app-identity-fields').hidden = !show;
  $('edit-app-details').setAttribute('aria-expanded', String(show));
  if (show) $('app-name').focus();
});
$('app-step-back').addEventListener('click', () => {
  cancelAppLookup();
  message('add-app-message');
  setAppSetupStep(appSetupStep === 'connect' ? 'confirm' : 'find');
});
$('enter-app-manually').addEventListener('click', () => {
  cancelAppLookup();
  importedApp = null;
  state.lookupIconUrl = null;
  showAppDetails();
  $('app-name').focus();
});
$('paste-app-link').addEventListener('click', async () => {
  const epoch = state.epoch;
  const control = $('paste-app-link');
  const generation = appLookup.generation;
  control.disabled = true;
  try {
    const text = await navigator.clipboard.readText();
    if (epoch !== state.epoch || generation !== appLookup.generation || $('add-app-section').hidden || appSetupStep !== 'find') return;
    if (!text.trim()) {
      message('lookup-message', 'Copy your app’s link first, then tap Paste copied link.', 'error');
      return;
    }
    $('lookup-url').value = text.trim();
    $('lookup-form').requestSubmit();
  } catch {
    if (epoch !== state.epoch || generation !== appLookup.generation || $('add-app-section').hidden || appSetupStep !== 'find') return;
    message('lookup-message', 'Paste your link into the search field, or touch and hold it and choose Paste.', 'error');
    $('lookup-url').focus();
  } finally { control.disabled = $('lookup-button').disabled; }
});
function cancelAppLookup() {
  clearTimeout(appLookup.timer);
  appLookup.controller?.abort();
  appLookup.controller = null;
  appLookup.generation += 1;
  appLookup.lastInput = null;
  $('lookup-button').disabled = false;
  $('paste-app-link').disabled = false;
  message('lookup-message');
  $('lookup-results').replaceChildren();
  $('lookup-results').hidden = true;
}

function isAppReference(input) {
  if (/^\d{1,15}$/.test(input)) return true;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return (url.hostname === 'apps.apple.com' && /\/id\d{1,15}(?:\/|$)/.test(url.pathname)) ||
      (url.hostname === 'appstoreconnect.apple.com' && /\/apps\/\d{1,15}(?:\/|$)/.test(url.pathname));
  } catch { return false; }
}

function isAppTitle(input) {
  return input.length >= 2 && input.length <= 100 && !/^\d+$/.test(input) &&
    !/^(?:[a-z][a-z\d+.-]*:|www\.|apps\.apple\.com|appstoreconnect\.apple\.com)/i.test(input);
}

$('lookup-url').addEventListener('input', (event) => {
  cancelAppLookup();
  const input = $('lookup-url').value.trim();
  if (!event.isComposing && (isAppReference(input) || isAppTitle(input))) {
    appLookup.timer = setTimeout(() => void lookUpApp(true), 650);
  }
});
$('lookup-form').addEventListener('reset', cancelAppLookup);
$('lookup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void lookUpApp();
});

function fillAppDetails(result, initialValues) {
  const fields = ['app-name', 'app-bundle-id', 'app-apple-id'];
  const values = [result.name, result.bundleId, result.appleId];
  fields.forEach((id, index) => {
    if (!initialValues || $(id).value === initialValues[index]) $(id).value = values[index] || '';
  });
  state.lookupIconUrl = $('app-bundle-id').value === result.bundleId && $('app-apple-id').value === String(result.appleId)
    ? result.iconUrl || null : null;
  importedApp = result;
  message('lookup-message');
  showAppDetails(true);
}

function showAppMatches(apps, generation) {
  const list = $('lookup-results');
  list.replaceChildren();
  list.hidden = !apps.length;
  for (const app of apps) {
    const control = element('button', { type: 'button', class: 'lookup-result' }, [
      ...(app.iconUrl ? [appIdentityArtwork(app)] : []),
      element('span', {}, [
        element('strong', {}, app.name),
        element('span', { class: 'help' }, app.developer || 'Developer not listed'),
        element('span', { class: 'help' }, app.bundleId),
      ]),
      element('span', { class: 'lookup-select' }, 'Choose'),
    ]);
    control.addEventListener('click', () => {
      if (generation !== appLookup.generation) return;
      cancelAppLookup();
      $('lookup-url').value = app.appStoreUrl;
      fillAppDetails(app);
    });
    list.append(element('li', {}, control));
  }
  if (!apps.length) $('app-find-help').open = true;
  message('lookup-message', apps.length
    ? `Choose your app (${apps.length} ${apps.length === 1 ? 'match' : 'matches'}).`
    : 'No matching apps found in the US App Store. Try another title, paste an App Store link, or enter details manually.');
}

async function lookUpApp(automatic = false) {
  clearTimeout(appLookup.timer);
  const url = $('lookup-url').value.trim();
  if (!url) {
    message('lookup-message', 'Enter an app title, App Store URL, or numeric Apple ID, or fill in the app details manually.', 'error');
    return;
  }
  const control = $('lookup-button');
  if (control.disabled || (automatic && appLookup.lastInput === url)) return;
  appLookup.lastInput = url;
  const controller = new AbortController();
  appLookup.controller = controller;
  const generation = ++appLookup.generation;
  const fields = ['app-name', 'app-bundle-id', 'app-apple-id'];
  const initialValues = fields.map(id => $(id).value);
  const titleSearch = !isAppReference(url) && isAppTitle(url);
  control.disabled = true;
  $('paste-app-link').disabled = true;
  $('lookup-results').replaceChildren();
  $('lookup-results').hidden = true;
  message('lookup-message', titleSearch ? 'Searching the US App Store…' : 'Looking up public app details…');
  const epoch = state.epoch;
  try {
    const result = await api(titleSearch ? '/api/apps/search' : '/api/apps/lookup', {
      method: 'POST', data: titleSearch ? { term: url } : { url }, signal: controller.signal,
    });
    if (epoch !== state.epoch || generation !== appLookup.generation) return;
    if (titleSearch) showAppMatches(result.apps, generation);
    else fillAppDetails(result, initialValues);
  } catch (error) {
    if (epoch === state.epoch && generation === appLookup.generation) {
      $('app-find-help').open = true;
      message('lookup-message', `${error.message} Try again, paste a link, or enter details manually.`, 'error');
    }
  } finally {
    if (generation === appLookup.generation) {
      appLookup.controller = null;
      control.disabled = false;
      $('paste-app-link').disabled = false;
    }
  }
}

$('add-app-form').noValidate = true;
$('add-app-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const invalidField = ['app-name', 'app-bundle-id', 'app-apple-id'].map($).find(field => !field.checkValidity());
  if (invalidField) {
    setAppSetupStep('confirm', false);
    $('app-identity-fields').hidden = false;
    $('edit-app-details').setAttribute('aria-expanded', 'true');
    invalidField.reportValidity();
    return;
  }
  if (appSetupStep === 'confirm') {
    renderAppIdentity();
    updateSourceHelp();
    setAppSetupStep('connect');
    return;
  }
  const control = $('add-app-submit');
  if (control.disabled) return;
  control.disabled = true;
  cancelAppLookup();
  const epoch = state.epoch;
  message('add-app-message', 'Adding app…');
  try {
    const { app } = await api('/api/apps', {
      method: 'POST', data: {
        name: $('app-name').value.trim(), bundleId: $('app-bundle-id').value.trim(),
        appleId: $('app-apple-id').value.trim(), source: $('app-source').value,
        ...(state.lookupIconUrl && importedApp?.bundleId === $('app-bundle-id').value.trim() && String(importedApp?.appleId) === $('app-apple-id').value.trim() ? { iconUrl: state.lookupIconUrl } : {}),
      },
    });
    if (epoch !== state.epoch) return;
    state.openAppId = app.id;
    state.apps = [...state.apps.filter((current) => current.id !== app.id), app];
    state.appsLoaded = true;
    updateAppFilter();
    renderApps();
    $('add-app-form').reset();
    resetAppDetails();
    updateSourceHelp();
    $('lookup-form').reset();
    state.lookupIconUrl = null;
    message('add-app-message');
    message('lookup-message');
    toggleAddApp(false);
    notify(`Added “${app.name}”. Complete its setup below; it is waiting for a signed Apple event.`, 'success');
    $(`setup-${app.id}`)?.scrollIntoView({ block: 'nearest' });
  } catch (error) {
    if (epoch === state.epoch) message('add-app-message', error.message, 'error');
  } finally {
    control.disabled = false;
  }
});

$('event-filters').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.eventFilters = { appId: $('event-app').value, environment: $('event-environment').value };
  state.events = [];
  state.nextCursor = null;
  $('event-list').replaceChildren();
  $('load-more-events').hidden = true;
  await loadEvents();
});
$('refresh-events').addEventListener('click', () => loadEvents());
$('load-more-events').addEventListener('click', () => {
  if ($('auto-refresh').checked) {
    $('auto-refresh').checked = false;
    notify('Auto-refresh paused while you browse older activity. You can turn it on again to return to the latest events.');
  }
  loadEvents({ append: true });
});
$('auto-refresh').addEventListener('change', () => {
  if ($('auto-refresh').checked) loadEvents({ quiet: true });
});
setInterval(() => {
  if (state.user && state.section === 'activity' && $('auto-refresh').checked && document.visibilityState === 'visible') {
    loadEvents({ quiet: true });
  }
}, 15000);

$('refresh-settings').addEventListener('click', loadSettings);
$('preferences-form').addEventListener('change', () => {
  state.preferencesDirty = true;
  message('preferences-message', 'You have unsaved preference changes.');
});
$('preferences-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const control = $('save-preferences');
  if (control.disabled) return;
  control.disabled = true;
  $('preferences-fields').disabled = true;
  const epoch = state.epoch;
  message('preferences-message', 'Saving preferences…');
  const preferences = Object.fromEntries(preferenceKeys.map((key) => [key, $('preferences-form').elements.namedItem(key).checked]));
  try {
    await api('/api/preferences', { method: 'PATCH', data: preferences });
    if (epoch !== state.epoch) return;
    state.preferencesDirty = false;
    message('preferences-message', 'Preferences saved.', 'success');
  } catch (error) {
    if (epoch === state.epoch) message('preferences-message', error.message, 'error');
  } finally {
    if (epoch === state.epoch) {
      control.disabled = false;
      $('preferences-fields').disabled = false;
    }
  }
});

start();

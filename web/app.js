'use strict';
/* The app page: Chat, Tests, Results and Settings. Plain browser JavaScript, no build step. The desktop shell calls
   showTab, refresh, appInfo and useEnvironment; keep those global. */

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (['value', 'checked', 'disabled', 'hidden', 'open'].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat())
    if (child !== undefined && child !== null && child !== false)
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
};
const store = {
  get: (k, d = '') => {
    try {
      return localStorage.getItem('d365fo.' + k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem('d365fo.' + k, v);
    } catch {
      /* private mode */
    }
  },
};
const OUTCOME_ICON = { passed: '✓', failed: '✕', blocked: '!', skipped: '–' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const duration = (ms) => {
  if (!ms && ms !== 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const when = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
};

/* ---------- Feedback ---------- */

function toast(message, bad = false) {
  const node = el(
    'div',
    { class: 'toast' + (bad ? ' bad' : ''), role: bad ? 'alert' : 'status' },
    el('p', {}, message),
    el('button', { class: 'ghost icon', 'aria-label': 'Dismiss', onclick: () => node.remove() }, '✕'),
  );
  $('toasts').append(node);
  // Errors stay until dismissed; confirmations go away by themselves.
  if (!bad) setTimeout(() => node.remove(), 4500);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}
const notice = toast;
const fail = (error) => toast(error?.message || String(error), true);

/** Runs `fn` with the button showing a spinner and disabled; errors become a toast. */
async function busy(button, fn) {
  if (button) {
    button.disabled = true;
    button.classList.add('busy');
  }
  try {
    return await fn();
  } catch (e) {
    fail(e);
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('busy');
    }
  }
}

function question(message, initial) {
  return new Promise((resolve) => {
    const dialog = $('question'),
      input = $('questionInput');
    $('questionText').textContent = message;
    input.hidden = initial === undefined;
    input.value = initial || '';
    dialog.returnValue = 'cancel';
    dialog.addEventListener(
      'close',
      () => {
        const ok = dialog.returnValue === 'ok';
        resolve(initial === undefined ? ok : ok ? input.value.trim() : null);
      },
      { once: true },
    );
    dialog.showModal();
    (input.hidden ? $('questionOk') : input).focus();
  });
}
const confirmAction = (message) => question(message);
const promptText = (message, initial = '') => question(message, initial);

async function api(path, method = 'GET', body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'd365fo-ui' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('The app could not be reached. Your entries are kept; check that the app is still running.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || data?.error || data?.detail || `Request failed (${res.status}).`);
  return data;
}

/* ---------- App state and navigation ---------- */

let state = { profiles: [], active: null, catalog: [], categoryHints: {} };
let currentTab = 'chat';

/** For the desktop shell's side strip: the environment in use, all environments and whether a run is going. */
function appInfo() {
  return { active: state.active, profiles: state.profiles.map((p) => p.name), busy: run.current?.status === 'running' };
}
/** Tells the desktop shell to re-read appInfo. */
const appChanged = () => console.log('d365fo:app-changed');

async function refreshState() {
  state = await api('/api/state');
  const env = $('environment');
  env.textContent = state.active ? state.active : 'No environment';
  env.className = 'chip ' + (state.active ? 'accent' : 'warn');
  env.title = state.active ? 'Environment in use' : 'Choose an environment in Settings';
  appChanged();
}

async function showTab(id) {
  if (!['chat', 'cases', 'results', 'settings'].includes(id)) return;
  for (const tab of ['chat', 'cases', 'results', 'settings']) $('tab-' + tab).hidden = tab !== id;
  for (const b of document.querySelectorAll('[data-tab]'))
    if (b.dataset.tab === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  currentTab = id;
  if (id === 'chat') await window.chatPage?.show();
  else window.chatPage?.hide();
  if (id === 'results') await loadResults().catch(fail);
  if (id === 'cases') tests.autoload();
  if (id === 'settings') renderEnvGrid();
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab);

async function refresh() {
  await refreshState();
  renderEnvGrid();
  await loadAi();
  if (settings.editing) await openEditor(settings.editing).catch(() => closeEditor(true));
}

async function useEnvironment(name) {
  await api('/api/active', 'POST', { name });
  await refreshState();
  renderEnvGrid();
  toast(`Using ${name}.`);
}

/* ---------- Settings: AI connection ---------- */

const settings = { editing: null, entries: [], snapshot: '[]', aiSnapshot: '[]' };

function values(root) {
  return [...$(root).querySelectorAll('[data-key]')].map((i) => ({ key: i.dataset.key, value: i.value }));
}
function field(spec, value, opts = {}) {
  const id = 'f_' + spec.key;
  const props = { id, 'data-key': spec.key };
  if (spec.key === 'LLM_MODEL') props.list = 'modelOptions';
  const labels = spec.key === 'LLM_API_FORMAT'
    ? { '': 'Claude (Anthropic)', openai: 'Local or OpenAI-compatible' }
    : { '': 'Default', 'azure-cli': 'Microsoft account', pat: 'Personal access token' };
  const input = spec.options
    ? el('select', props, spec.options.map((o) => el('option', { value: o }, labels[o] || o)))
    : el('input', {
        ...props,
        type: spec.secret ? 'password' : spec.type === 'url' ? 'url' : 'text',
        placeholder: spec.placeholder || '',
        autocomplete: spec.secret ? 'new-password' : 'off',
        spellcheck: 'false',
      });
  input.value = value || '';
  return el(
    'div',
    { class: 'field' + (opts.stack ? ' stack' : '') },
    el('label', { for: id }, spec.label),
    input,
    spec.help ? el('small', { class: 'help' }, spec.help) : null,
  );
}
const spec = (key) => state.catalog.find((s) => s.key === key) || { key, label: key };

async function loadAi() {
  const { entries } = await api('/api/ai');
  const map = new Map(entries.map((e) => [e.key, e.value]));
  const box = $('aiFields');
  const specs = state.catalog.filter((s) => s.group === 'AI model');
  box.replaceChildren(
    ...specs.filter((s) => !s.advanced).map((s) => field(s, map.get(s.key))),
    el(
      'details',
      { class: 'section' },
      el('summary', {}, 'Model and company gateway'),
      ...specs.filter((s) => s.advanced).map((s) => field(s, map.get(s.key))),
    ),
  );
  settings.aiSnapshot = JSON.stringify(values('aiFields'));
  renderAiBadge();
  updateDirty();
  if ($('f_LLM_API_FORMAT')?.value === 'openai' && $('f_ANTHROPIC_BASE_URL')?.value.trim()) {
    discoverModels(true).catch(() => {});
  }
}
function renderAiBadge() {
  const local = $('f_LLM_API_FORMAT')?.value === 'openai';
  $('aiBadge').replaceChildren(
    el('span', { class: 'dot ' + (state.aiConfigured ? 'good' : 'warn') }),
    el('span', { class: 'muted' }, state.aiConfigured ? 'Configured' : local ? 'Needs an API URL' : 'Needs an API key'),
  );
}

/* Asks the endpoint which models it serves, and offers them on the model field. */
async function discoverModels(quiet = false) {
  const status = $('aiStatus');
  if (!quiet) {
    status.textContent = 'Looking for models…';
    status.className = 'muted';
  }
  const r = await api('/api/ai/models', 'POST', { entries: values('aiFields') });
  const models = Array.isArray(r.models) ? r.models : [];
  $('modelOptions').replaceChildren(...models.map((m) => el('option', { value: m })));
  const input = $('f_LLM_MODEL');
  if (input && models.length && !input.value.trim()) input.value = models[0];
  renderAiBadge();
  updateDirty();
  if (!quiet) {
    status.textContent = models.length ? `${r.detail}: ${models.slice(0, 6).join(', ')}${models.length > 6 ? ', …' : ''}` : r.detail;
    status.className = r.reachable && r.authorized && models.length ? 'good' : 'bad';
  }
  return models;
}
async function saveAi() {
  const entries = values('aiFields');
  await api('/api/ai', 'PUT', { entries });
  settings.aiSnapshot = JSON.stringify(entries);
  await refreshState();
  renderAiBadge();
  updateDirty();
  $('aiStatus').textContent = '';
  toast('AI connection saved.');
}
$('aiForm').onsubmit = (e) => {
  e.preventDefault();
  busy($('saveAi'), async () => {
    await saveAi();
    if ($('f_LLM_API_FORMAT')?.value === 'openai') await discoverModels(true).catch(() => {});
  });
};
$('discoverModels').onclick = () =>
  busy($('discoverModels'), async () => {
    await discoverModels();
  });
$('aiForm').addEventListener('change', (e) => {
  const key = e.target?.dataset?.key;
  if ((key === 'LLM_API_FORMAT' || key === 'ANTHROPIC_BASE_URL') && $('f_LLM_API_FORMAT')?.value === 'openai' && $('f_ANTHROPIC_BASE_URL')?.value.trim()) {
    discoverModels(true).catch(() => {});
  }
});
$('checkAi').onclick = () =>
  busy($('checkAi'), async () => {
    if (JSON.stringify(values('aiFields')) !== settings.aiSnapshot) await saveAi();
    $('aiStatus').textContent = 'Testing…';
    $('aiStatus').className = 'muted';
    const r = await api('/api/ai/check', 'POST');
    $('aiStatus').textContent = r.detail;
    $('aiStatus').className = r.ok ? 'good' : 'bad';
  });

function updateDirty() {
  $('saveAi').disabled = JSON.stringify(values('aiFields')) === settings.aiSnapshot;
  if (settings.editing) $('saveProfile').disabled = JSON.stringify(values('profileFields')) === settings.snapshot;
}
$('aiForm').oninput = $('aiForm').onchange = updateDirty;
$('profileForm').oninput = $('profileForm').onchange = updateDirty;
function dirty() {
  return (
    tests.editorDirty ||
    JSON.stringify(values('aiFields')) !== settings.aiSnapshot ||
    (settings.editing && JSON.stringify(values('profileFields')) !== settings.snapshot)
  );
}

/* ---------- Settings: environment cards ---------- */

const SIGN_IN = { session: 'Browser session (MFA)', password: 'Username and password', none: 'Sign-in not set' };

function renderEnvGrid() {
  const cards = state.profiles.map((p) => {
    const check = p.check
      ? el(
          'span',
          { class: 'chip ' + (p.check.ok ? 'good' : 'bad'), title: 'Last checked ' + new Date(p.check.at).toLocaleString() },
          p.check.ok ? 'Setup OK' : 'Setup needs attention',
        )
      : el('span', { class: 'chip' }, 'Not checked');
    return el(
      'div',
      { class: 'env-card' + (p.active ? ' active' : '') + (settings.editing === p.name ? ' editing' : '') },
      el('div', { class: 'row tight' }, el('span', { class: 'name grow', title: p.name }, p.name), p.active ? el('span', { class: 'chip accent' }, 'In use') : null),
      el('div', { class: 'host', title: p.host }, p.host || 'No F&O address yet'),
      el(
        'div',
        { class: 'facts' },
        p.company ? el('span', { class: 'chip' }, p.company) : null,
        p.type ? el('span', { class: 'chip' + (p.type === 'production' ? ' bad' : '') }, p.type) : null,
        el('span', { class: 'chip' + (p.signIn === 'none' ? ' warn' : '') }, SIGN_IN[p.signIn] || SIGN_IN.none),
        p.devops ? el('span', { class: 'chip' }, 'Azure DevOps') : null,
        check,
      ),
      el(
        'div',
        { class: 'card-actions' },
        p.active
          ? null
          : el('button', { class: 'primary', 'data-use': p.name, onclick: (e) => busy(e.currentTarget, () => useEnvironment(p.name)), disabled: run.current?.status === 'running' }, 'Use'),
        el('button', { 'data-edit': p.name, onclick: () => openEditor(p.name).catch(fail) }, 'Edit'),
        el(
          'button',
          {
            'data-check': p.name,
            onclick: (e) =>
              busy(e.currentTarget, async () => {
                const r = await api('/api/profiles/' + encodeURIComponent(p.name) + '/check', 'POST');
                await refreshState();
                renderEnvGrid();
                if (r.exitCode === 0) toast(`${p.name}: setup is OK.`);
                else {
                  await openEditor(p.name);
                  $('setupOutput').textContent = r.output || 'No output.';
                  toast(`${p.name}: setup needs attention. See the details below.`, true);
                }
              }),
          },
          'Check',
        ),
        el('span', { class: 'spacer' }),
        el(
          'details',
          { class: 'menu' },
          el('summary', { 'aria-label': 'More actions for ' + p.name, title: 'More' }, '⋯'),
          el(
            'div',
            {},
            el('button', { onclick: (e) => menuAction(e, () => renameEnvironment(p.name)) }, 'Rename'),
            el('button', { onclick: (e) => menuAction(e, () => duplicateEnvironment(p.name)) }, 'Duplicate'),
            el('button', { class: 'danger', onclick: (e) => menuAction(e, () => deleteEnvironment(p.name)) }, 'Delete'),
          ),
        ),
      ),
    );
  });
  cards.push(
    el(
      'button',
      { class: 'env-card add', id: 'addEnvironment', onclick: () => openWizard() },
      el('span', { style: 'font-size:22px' }, '+'),
      'Add environment',
    ),
  );
  $('envGrid').replaceChildren(...cards);
}
function menuAction(e, fn) {
  e.currentTarget.closest('details').open = false;
  Promise.resolve(fn()).catch(fail);
}
document.addEventListener('click', (e) => {
  for (const m of document.querySelectorAll('details.menu[open]')) if (!m.contains(e.target)) m.open = false;
});

async function renameEnvironment(name) {
  const to = await promptText('New name for ' + name, name);
  if (!to || to === name) return;
  await api('/api/profiles/' + encodeURIComponent(name), 'PATCH', { name: to });
  if (settings.editing === name) settings.editing = to;
  await refreshState();
  renderEnvGrid();
  if (settings.editing === to) $('editorTitle').textContent = to;
  toast(`Renamed to ${to}.`);
}
async function duplicateEnvironment(name) {
  const to = await promptText('Name of the copy', name + ' copy');
  if (!to) return;
  await api('/api/profiles', 'POST', { name: to, copyFrom: name });
  await refreshState();
  renderEnvGrid();
  await openEditor(to);
  toast(`Created ${to}.`);
}
async function deleteEnvironment(name) {
  if (!(await confirmAction(`Delete the environment "${name}"? Its saved settings are removed; its earlier results stay.`))) return;
  await api('/api/profiles/' + encodeURIComponent(name), 'DELETE');
  if (settings.editing === name) closeEditor(true);
  await refreshState();
  renderEnvGrid();
  toast(`Deleted ${name}.`);
}

/* ---------- Settings: environment editor ---------- */

function signInMethod(map) {
  return map.get('D365_STORAGE_STATE') ? 'session' : 'password';
}
function signInChoice(name, method, onChange) {
  const option = (value, title, help) =>
    el(
      'label',
      { class: 'choice' },
      el('input', { type: 'radio', name, value, checked: method === value, onchange: () => onChange(value) }),
      el('span', {}, el('strong', {}, title), el('br'), el('span', { class: 'help' }, help)),
    );
  return el(
    'div',
    { role: 'radiogroup', 'aria-label': 'Sign-in method' },
    option('session', 'Sign in with a browser', 'Recommended, and required with MFA. You sign in once; the session is saved for runs.'),
    option('password', 'Username and password', 'A test account without MFA.'),
  );
}

async function openEditor(name) {
  if (settings.editing && settings.editing !== name && JSON.stringify(values('profileFields')) !== settings.snapshot)
    if (!(await confirmAction('Discard the unsaved environment changes?'))) return;
  const profile = await api('/api/profiles/' + encodeURIComponent(name));
  settings.editing = profile.name;
  settings.entries = profile.entries;
  const map = new Map(profile.entries.map((e) => [e.key, e.value]));
  let method = signInMethod(map);
  const box = $('profileFields');
  const pw = el('div', {}, field(spec('D365_USERNAME'), map.get('D365_USERNAME')), field(spec('D365_PASSWORD'), map.get('D365_PASSWORD')));
  const session = el(
    'div',
    {},
    field({ ...spec('D365_STORAGE_STATE'), help: 'Filled in when you sign in with the button below.' }, map.get('D365_STORAGE_STATE')),
    el(
      'div',
      { class: 'field' },
      el('span'),
      el(
        'div',
        { class: 'row' },
        el('button', { type: 'button', id: 'sessionLogin', onclick: (e) => busy(e.currentTarget, () => browserSignIn(settings.editing)) }, 'Sign in with browser…'),
        el('span', { class: 'help' }, 'A browser opens; sign in, wait for the dashboard, then close it.'),
      ),
    ),
    el(
      'div',
      { class: 'field' },
      el('span'),
      el(
        'div',
        { class: 'row' },
        el('button', { type: 'button', id: 'dataLogin', onclick: (e) => busy(e.currentTarget, () => profileCommand('d365-data-login')) }, 'Sign in for data access…'),
        el('span', { class: 'help' }, 'Optional, once: lets the agent read F&O data (read only) to check prerequisites. MFA is fine.'),
      ),
    ),
  );
  const show = () => {
    pw.hidden = method !== 'password';
    session.hidden = method !== 'session';
  };
  const devopsSpecs = state.catalog.filter((s) => s.group === 'Azure DevOps');
  box.replaceChildren(
    el('h3', {}, 'Dynamics 365 F&O'),
    field(spec('D365_BASE_URL'), map.get('D365_BASE_URL')),
    field(spec('D365_COMPANY'), map.get('D365_COMPANY')),
    el('h3', { style: 'margin-top:16px' }, 'Sign-in'),
    signInChoice('signInMethod', method, (m) => {
      method = m;
      if (m === 'password') {
        const ss = $('f_D365_STORAGE_STATE');
        if (ss) ss.value = '';
      }
      show();
      updateDirty();
    }),
    pw,
    session,
    el(
      'details',
      { class: 'section', open: Boolean(map.get('AZDO_ORG_URL')) },
      el('summary', {}, 'Azure DevOps (optional)'),
      ...devopsSpecs.filter((s) => !s.advanced).map((s) => field(s, map.get(s.key))),
      el(
        'div',
        { class: 'field' },
        el('span'),
        el('div', {}, el('button', { type: 'button', id: 'devopsLogin', onclick: (e) => busy(e.currentTarget, () => profileCommand('devops-login')) }, 'Sign in with Microsoft…')),
      ),
      el('details', { class: 'section' }, el('summary', {}, 'Advanced'), ...devopsSpecs.filter((s) => s.advanced).map((s) => field(s, map.get(s.key)))),
    ),
    el('details', { class: 'section' }, el('summary', {}, 'Advanced'), field(spec('D365_ENVIRONMENT_TYPE'), map.get('D365_ENVIRONMENT_TYPE')), field(spec('D365_ODATA_AUTH'), map.get('D365_ODATA_AUTH')), field(spec('AGENT_PREFLIGHT'), map.get('AGENT_PREFLIGHT')), field(spec('AGENT_IGNORE_USER_ROLE'), map.get('AGENT_IGNORE_USER_ROLE')), field(spec('AGENT_FILL_FROM_ERP'), map.get('AGENT_FILL_FROM_ERP')), field(spec('AGENT_RECORD_TESTS'), map.get('AGENT_RECORD_TESTS')), field(spec('AGENT_REPLAY_DIR'), map.get('AGENT_REPLAY_DIR'))),
  );
  show();
  $('editorTitle').textContent = profile.name;
  $('envEditor').hidden = false;
  $('setupOutput').textContent = '';
  $('profileStatus').textContent = '';
  settings.snapshot = JSON.stringify(values('profileFields'));
  updateDirty();
  renderEnvGrid();
  $('envEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function closeEditor(force = false) {
  if (!force && settings.editing && JSON.stringify(values('profileFields')) !== settings.snapshot)
    if (!(await confirmAction('Discard the unsaved environment changes?'))) return;
  settings.editing = null;
  $('envEditor').hidden = true;
  $('profileFields').replaceChildren();
  renderEnvGrid();
}
$('closeEditor').onclick = () => closeEditor().catch(fail);

async function saveProfile() {
  if (!settings.editing) throw new Error('Choose an environment first.');
  const form = values('profileFields');
  const keys = new Set(form.map((e) => e.key));
  const entries = [...settings.entries.filter((e) => !keys.has(e.key)), ...form];
  try {
    await api('/api/profiles/' + encodeURIComponent(settings.editing), 'PUT', { entries });
  } catch (e) {
    $('profileStatus').textContent = 'Not saved';
    throw e;
  }
  settings.entries = entries;
  settings.snapshot = JSON.stringify(form);
  updateDirty();
  $('profileStatus').textContent = 'Saved';
  await refreshState().catch(() => undefined);
  renderEnvGrid();
  toast('Environment saved.');
}
const saveProfileIfDirty = async () => {
  if (JSON.stringify(values('profileFields')) !== settings.snapshot) await saveProfile();
};
$('profileForm').onsubmit = (e) => {
  e.preventDefault();
  busy($('saveProfile'), saveProfile);
};

async function profileCommand(command) {
  if (!settings.editing) throw new Error('Choose an environment first.');
  await saveProfileIfDirty();
  $('setupOutput').textContent = command === 'check' ? 'Checking…' : 'Finish the Microsoft sign-in in your browser…';
  const r = await api('/api/profiles/' + encodeURIComponent(settings.editing) + '/' + command, 'POST');
  $('setupOutput').textContent = r.output || 'No output.';
  if (command === 'check') {
    await refreshState();
    renderEnvGrid();
  }
  if (r.exitCode !== 0) toast(command === 'check' ? 'The setup needs attention; see the details.' : 'Sign-in did not finish; see the details.', true);
  else toast(command === 'check' ? 'Setup is OK.' : 'Signed in.');
  return r;
}
$('checkSetup').onclick = () => busy($('checkSetup'), () => profileCommand('check'));

async function browserSignIn(name) {
  if (settings.editing === name) await saveProfileIfDirty();
  toast('A browser window opens. Sign in, wait for the F&O dashboard, then close the window.');
  const r = await api('/api/profiles/' + encodeURIComponent(name) + '/session-login', 'POST');
  if (!r.saved) {
    if (settings.editing === name) $('setupOutput').textContent = r.output || 'No output.';
    throw new Error('No session was saved. Sign in and wait for the dashboard before closing the browser.');
  }
  if (settings.editing === name) {
    const ss = $('f_D365_STORAGE_STATE');
    if (ss) ss.value = r.saved;
    settings.entries = settings.entries.filter((e) => e.key !== 'D365_STORAGE_STATE').concat({ key: 'D365_STORAGE_STATE', value: r.saved });
    settings.snapshot = JSON.stringify(values('profileFields'));
    updateDirty();
  }
  await refreshState();
  renderEnvGrid();
  toast('Signed in; the session is saved for runs.');
  return r;
}

/* ---------- Settings: new-environment wizard ---------- */

const wizard = { step: 0, data: {}, created: null, result: null };
const WIZARD_STEPS = ['address', 'signin', 'company', 'ai', 'check'];

function openWizard() {
  wizard.step = 0;
  wizard.data = { name: '', url: '', method: 'session', username: '', password: '', company: '', apiKey: '' };
  wizard.created = null;
  wizard.result = null;
  renderWizard();
  $('wizard').showModal();
}
function wizardSteps() {
  return WIZARD_STEPS.filter((s) => s !== 'ai' || !state.aiConfigured || wizard.data.askedAi);
}
function wizardInput(key, props = {}) {
  return el('input', {
    id: 'w_' + key,
    value: wizard.data[key] || '',
    oninput: (e) => (wizard.data[key] = e.target.value),
    autocomplete: props.type === 'password' ? 'new-password' : 'off',
    spellcheck: 'false',
    style: 'width:100%',
    ...props,
  });
}
function renderWizard() {
  const steps = wizardSteps();
  const step = steps[wizard.step];
  $('wizardSteps').replaceChildren(...steps.map((_, i) => el('span', { class: i <= wizard.step ? 'done' : '' })));
  const page = $('wizardPage');
  const label = (forId, text) => el('label', { for: forId, style: 'display:block;font-weight:500;margin:12px 0 4px' }, text);
  if (step === 'address') {
    page.replaceChildren(
      el('p', { class: 'muted' }, 'Which F&O sandbox should the tests run against?'),
      label('w_url', 'F&O address'),
      wizardInput('url', { type: 'url', placeholder: 'https://contoso.sandbox.operations.dynamics.com' }),
      label('w_name', 'Name'),
      wizardInput('name', { placeholder: 'For example UAT or Test' }),
      el('p', { class: 'help' }, 'Production environments stay protected: runs refuse them.'),
    );
    $('w_url').addEventListener('change', () => {
      if (wizard.data.name) return;
      try {
        const host = new URL(wizard.data.url).host.split('.')[0];
        wizard.data.name = host;
        $('w_name').value = host;
      } catch {
        /* not a URL yet */
      }
    });
  } else if (step === 'signin') {
    const creds = el(
      'div',
      { hidden: wizard.data.method !== 'password' },
      label('w_username', 'Username'),
      wizardInput('username', { placeholder: 'test.user@contoso.com' }),
      label('w_password', 'Password'),
      wizardInput('password', { type: 'password' }),
    );
    page.replaceChildren(
      el('p', { class: 'muted' }, 'How should runs sign in to F&O?'),
      signInChoice('wizardMethod', wizard.data.method, (m) => {
        wizard.data.method = m;
        creds.hidden = m !== 'password';
      }),
      creds,
    );
  } else if (step === 'company') {
    page.replaceChildren(
      el('p', { class: 'muted' }, 'Which legal entity do the cases use? Cases can still name their own.'),
      label('w_company', 'Legal entity'),
      wizardInput('company', { placeholder: 'USMF' }),
      el('p', { class: 'help' }, 'Azure DevOps and other options can be added later with Edit.'),
    );
  } else if (step === 'ai') {
    wizard.data.askedAi = true;
    page.replaceChildren(
      el('p', { class: 'muted' }, 'Chat and every test run use one Claude connection.'),
      label('w_apiKey', 'Claude API key'),
      wizardInput('apiKey', { type: 'password', placeholder: 'sk-ant-…' }),
      el('p', { class: 'help' }, 'A company gateway can be set later under Settings → AI connection.'),
    );
  } else {
    page.replaceChildren(el('p', {}, el('span', { class: 'spinner' }), ' Saving and checking the setup…'), el('pre', { id: 'wizardOutput' }));
  }
  $('wizardBack').hidden = wizard.step === 0 || step === 'check';
  $('wizardNext').textContent = step === 'check' ? (wizard.result ? 'Done' : 'Working…') : steps[wizard.step + 1] === 'check' ? 'Save and check' : 'Next';
  $('wizardNext').disabled = step === 'check' && !wizard.result;
  $('wizardCancel').textContent = step === 'check' && wizard.result ? 'Close' : 'Cancel';
  page.querySelector('input')?.focus();
  if (step === 'check' && !wizard.result) finishWizard().catch((e) => wizardDone(false, e.message));
}
function wizardValidate(step) {
  const d = wizard.data;
  if (step === 'address') {
    try {
      const u = new URL(d.url.trim());
      if (u.protocol !== 'https:') return 'The F&O address starts with https://.';
    } catch {
      return 'Enter the F&O address, for example https://contoso.sandbox.operations.dynamics.com.';
    }
    if (!d.name.trim()) return 'Give the environment a name.';
    if (state.profiles.some((p) => p.name.toLowerCase() === d.name.trim().toLowerCase())) return `An environment named ${d.name.trim()} already exists.`;
  }
  if (step === 'signin' && d.method === 'password' && (!d.username.trim() || !d.password)) return 'Enter the username and password, or choose browser sign-in.';
  if (step === 'ai' && !d.apiKey.trim()) return 'Enter the Claude API key.';
  return '';
}
async function finishWizard() {
  const d = wizard.data;
  const out = (text) => {
    const pre = $('wizardOutput');
    if (pre) pre.textContent = text;
  };
  if (!wizard.created) {
    const entries = [
      { key: 'D365_BASE_URL', value: d.url.trim() },
      ...(d.company.trim() ? [{ key: 'D365_COMPANY', value: d.company.trim() }] : []),
      ...(d.method === 'password'
        ? [
            { key: 'D365_USERNAME', value: d.username.trim() },
            { key: 'D365_PASSWORD', value: d.password },
          ]
        : []),
    ];
    await api('/api/profiles', 'POST', { name: d.name.trim(), entries });
    wizard.created = d.name.trim();
  }
  if (d.apiKey.trim()) {
    const ai = (await api('/api/ai')).entries.filter((e) => e.key !== 'ANTHROPIC_API_KEY');
    await api('/api/ai', 'PUT', { entries: [...ai, { key: 'ANTHROPIC_API_KEY', value: d.apiKey.trim() }] });
    d.apiKey = '';
  }
  if (run.current?.status !== 'running') await api('/api/active', 'POST', { name: wizard.created });
  await refreshState();
  renderEnvGrid();
  if (d.method === 'session') {
    out('A browser window opens. Sign in to F&O (MFA included), wait for the dashboard, then close the window.');
    const r = await api('/api/profiles/' + encodeURIComponent(wizard.created) + '/session-login', 'POST');
    if (!r.saved) return wizardDone(false, (r.output || '') + '\n\nNo session was saved. Use Edit → Sign in with browser to try again.');
  }
  out('Checking the setup…');
  const r = await api('/api/profiles/' + encodeURIComponent(wizard.created) + '/check', 'POST');
  wizardDone(r.exitCode === 0, r.output || 'No output.');
}
function wizardDone(ok, output) {
  wizard.result = { ok, output };
  $('wizardPage').replaceChildren(
    el(
      'div',
      { class: 'callout ' + (ok ? 'good' : '') },
      ok ? `${wizard.created} is ready and in use.` : wizard.created ? `${wizard.created} was saved, but the setup needs attention.` : 'The environment could not be saved.',
    ),
    el('details', { class: 'section', open: !ok }, el('summary', {}, 'Check details'), el('pre', {}, output)),
  );
  $('wizardNext').disabled = false;
  $('wizardNext').textContent = 'Done';
  $('wizardCancel').textContent = 'Close';
  refreshState()
    .then(renderEnvGrid)
    .catch(() => undefined);
}
$('wizardNext').onclick = () => {
  const steps = wizardSteps();
  const step = steps[wizard.step];
  if (step === 'check') {
    $('wizard').close();
    if (wizard.created && !wizard.result?.ok) openEditor(wizard.created).catch(fail);
    else if (wizard.result?.ok) showTab('cases');
    return;
  }
  const problem = wizardValidate(step);
  if (problem) return toast(problem, true);
  wizard.step++;
  renderWizard();
};
$('wizardBack').onclick = () => {
  wizard.step = Math.max(0, wizard.step - 1);
  renderWizard();
};
$('wizardCancel').onclick = () => $('wizard').close();
$('wizard').addEventListener('cancel', (e) => {
  if (wizardSteps()[wizard.step] === 'check' && !wizard.result) e.preventDefault();
});
$('wizardPage').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    e.preventDefault();
    $('wizardNext').click();
  }
});

/* ---------- Tests ---------- */

const tests = {
  source: store.get('source', 'local'),
  cases: [],
  selected: new Set(),
  loadedKey: '',
  editing: null,
  editorDirty: false,
  plans: null,
  autoload() {
    if (this.loadedKey || this.loading) return;
    if (this.source === 'local' && $('caseDir').value.trim()) loadCases().catch(fail);
    if (this.source === 'devops') {
      loadPlans();
      if ($('plan').value.trim() && $('suite').value.trim()) loadCases().catch(fail);
    }
  },
};
$('caseDir').value = store.get('caseDir', 'examples/testcases');
$('plan').value = store.get('plan');
$('suite').value = store.get('suite');

function setSource(source) {
  tests.source = source;
  store.set('source', source);
  for (const b of document.querySelectorAll('[data-source]')) b.setAttribute('aria-pressed', String(b.dataset.source === source));
  $('localSource').hidden = source !== 'local';
  $('devopsSource').hidden = source !== 'devops';
  tests.cases = [];
  tests.selected.clear();
  tests.loadedKey = '';
  renderCases();
  if (currentTab === 'cases') tests.autoload();
}
for (const b of document.querySelectorAll('[data-source]')) b.onclick = () => b.dataset.source !== tests.source && setSource(b.dataset.source);

function sourceQuery() {
  if (tests.source === 'devops') return new URLSearchParams({ plan: $('plan').value.trim(), suite: $('suite').value.trim() });
  return new URLSearchParams({ local: $('caseDir').value.trim() });
}

async function loadPlans() {
  if (tests.plans || !state.active) return;
  tests.plans = [];
  try {
    const { plans } = await api('/api/devops/plans');
    tests.plans = plans;
    $('planList').replaceChildren(...plans.map((p) => el('option', { value: p.id }, `${p.name}${p.state ? ' · ' + p.state : ''}`)));
    $('devopsHint').textContent = plans.length ? '' : 'No test plans found.';
    if ($('plan').value.trim()) loadSuites();
  } catch (e) {
    tests.plans = null;
    $('devopsHint').textContent = e.message.includes('Azure DevOps') ? 'Sign in to Azure DevOps under Settings → Edit to list plans.' : '';
  }
}
async function loadSuites() {
  const plan = $('plan').value.trim();
  if (!/^\d+$/.test(plan)) return;
  try {
    const { suites } = await api('/api/devops/plans/' + plan + '/suites');
    $('suiteList').replaceChildren(...suites.map((s) => el('option', { value: s.id }, s.name)));
    const known = tests.plans?.find((p) => p.id === plan);
    if (!$('suite').value.trim() && known?.rootSuiteId) $('suite').value = known.rootSuiteId;
  } catch {
    $('suiteList').replaceChildren();
  }
}
$('plan').addEventListener('change', loadSuites);

async function loadCases() {
  if (tests.editorDirty && !(await confirmAction('Discard unsaved test-case edits?'))) return;
  const query = sourceQuery();
  if (tests.source === 'devops' && (!query.get('plan') || !query.get('suite'))) throw new Error('Enter the test plan and suite.');
  if (tests.source === 'local') store.set('caseDir', query.get('local'));
  else {
    store.set('plan', query.get('plan'));
    store.set('suite', query.get('suite'));
  }
  tests.loading = true;
  $('caseList').replaceChildren(el('div', { class: 'empty' }, el('span', { class: 'spinner' }), ' Loading cases…'));
  try {
    tests.cases = await api('/api/cases?' + query);
  } catch (e) {
    tests.cases = [];
    tests.loadedKey = '';
    renderCases(e.message);
    throw e;
  } finally {
    tests.loading = false;
  }
  tests.loadedKey = query.toString();
  const ids = new Set(tests.cases.filter((c) => !c.error).map((c) => c.id));
  const remembered = (store.get('selected:' + tests.loadedKey) || '').split('\n').filter((id) => ids.has(id));
  tests.selected = new Set(remembered.length ? remembered : ids);
  closeDrawer(true);
  renderCases();
}
const rememberSelection = () => store.set('selected:' + tests.loadedKey, [...tests.selected].join('\n'));
$('loadCases').onclick = () => busy($('loadCases'), loadCases);
$('loadDevops').onclick = () => busy($('loadDevops'), loadCases);
$('caseDir').addEventListener('keydown', (e) => e.key === 'Enter' && $('loadCases').click());
for (const id of ['plan', 'suite']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && $('loadDevops').click());
$('caseSearch').oninput = () => renderCases();

function renderCases(error) {
  const list = $('caseList');
  const loaded = Boolean(tests.loadedKey);
  $('caseTools').hidden = !loaded || !tests.cases.length;
  $('runActions').hidden = !loaded || !tests.cases.length;
  if (!loaded) {
    list.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, error ? 'The cases could not be loaded' : 'No cases loaded'),
        error || (tests.source === 'local' ? 'Choose a folder of test-case files and press Load cases.' : 'Enter an Azure DevOps test plan and suite, then press Load cases.'),
      ),
    );
    return;
  }
  if (!tests.cases.length) {
    list.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, 'No test cases here'),
        tests.source === 'local' ? 'Create one with New case.' : 'This suite has no test cases.',
      ),
    );
    return;
  }
  const q = $('caseSearch').value.trim().toLowerCase();
  const shown = tests.cases.filter((c) => !q || `${c.id} ${c.title}`.toLowerCase().includes(q));
  const selectable = shown.filter((c) => !c.error);
  const allOn = selectable.length > 0 && selectable.every((c) => tests.selected.has(c.id));
  const head = el(
    'div',
    { class: 'case-row head' },
    el('input', {
      type: 'checkbox',
      'aria-label': 'Select all shown cases',
      checked: allOn,
      onchange: (e) => {
        for (const c of selectable) e.target.checked ? tests.selected.add(c.id) : tests.selected.delete(c.id);
        rememberSelection();
        renderCases();
      },
    }),
    el('span', {}, 'ID'),
    el('span', {}, 'Title'),
    el('span', {}, 'Steps'),
  );
  const rows = shown.map((c) =>
    el(
      'div',
      { class: 'case-row' + (c.error ? ' disabled' : '') },
      el('input', {
        type: 'checkbox',
        checked: tests.selected.has(c.id),
        disabled: Boolean(c.error),
        'aria-label': 'Select ' + c.id,
        onchange: (e) => {
          e.target.checked ? tests.selected.add(c.id) : tests.selected.delete(c.id);
          rememberSelection();
          updateRunButton();
        },
      }),
      el('span', { class: 'id', title: c.id }, c.id),
      el('button', { class: 'link title', title: c.title, onclick: () => openCase(c).catch(fail) }, c.title || '(untitled)'),
      el('span', { class: 'meta' }, c.error ? el('span', { class: 'chip bad', title: c.error }, 'Invalid file') : el('span', { class: 'muted' }, Array.isArray(c.steps) ? c.steps.length : c.steps)),
    ),
  );
  list.replaceChildren(el('div', { class: 'case-list' }, head, ...(rows.length ? rows : [el('div', { class: 'empty' }, 'No case matches the filter.')])));
  $('caseCount').textContent = q ? `${shown.length} of ${tests.cases.length}` : plural(tests.cases.length, 'case');
  updateRunButton();
}
function updateRunButton() {
  const n = tests.selected.size;
  const running = run.current?.status === 'running';
  $('selectedCount').textContent = n ? `${plural(n, 'case')} selected` : 'Select the cases to run';
  $('runSelected').textContent = running ? 'A run is in progress' : n ? `Run ${plural(n, 'case')}` : 'Run';
  $('runSelected').disabled = !n || running;
}

$('runSelected').onclick = () =>
  busy($('runSelected'), async () => {
    if (!state.active) {
      await showTab('settings');
      throw new Error('Choose an environment to run in first.');
    }
    if (tests.editorDirty) throw new Error('Save your test-case edits before running.');
    const ids = tests.cases.filter((c) => tests.selected.has(c.id)).map((c) => c.id);
    const diagnostic = $('dryRun').checked;
    const allIterations = $('allIterations').checked;
    const selectedCases = tests.cases.filter((c) => tests.selected.has(c.id));
    const rows = allIterations ? selectedCases.reduce((n, c) => n + Math.max(1, c.parameters?.rows || 1), 0) : ids.length;
    const list = ids.length > 6 ? ids.slice(0, 6).join(', ') + ` and ${ids.length - 6} more` : ids.join(', ');
    const scope = `${plural(ids.length, 'case')}${allIterations ? `, ${plural(rows, 'iteration')}` : ' (first data row of each)'}`;
    if (!(await confirmAction(`${diagnostic ? 'Diagnostic run (no clicks or typing)' : 'Run'} ${scope} in ${state.active}?\n\n${list}`))) return;
    await startRun({ source: tests.source, cases: ids, dryRun: diagnostic, allIterations, ...Object.fromEntries(sourceQuery()) });
  });

async function startRun(body) {
  const r = await api('/api/run', 'POST', body);
  if (r.error) throw new Error(r.error);
  run.hidden = false;
  await refreshRun();
}

/* Drawer: view or edit one case */

function closeDrawer(force = false) {
  if (!force && tests.editorDirty) {
    return confirmAction('Discard unsaved test-case edits?').then((ok) => ok && closeDrawer(true));
  }
  tests.editing = null;
  tests.editorDirty = false;
  $('drawer').hidden = true;
  $('drawerBackdrop').hidden = true;
  return Promise.resolve(true);
}
$('drawerBackdrop').onclick = () => closeDrawer();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('drawer').hidden && !document.querySelector('dialog[open]')) closeDrawer();
});

async function openCase(c) {
  if (tests.editorDirty && !(await confirmAction('Discard unsaved test-case edits?'))) return;
  const remote = tests.source === 'devops';
  const dir = $('caseDir').value.trim();
  const draft = remote ? c : await api('/api/testcases?' + new URLSearchParams({ dir, file: c.file }));
  tests.editing = { file: c.file, dir, draft, remote };
  renderEditor();
}
$('newCase').onclick = async () => {
  if (tests.editorDirty && !(await confirmAction('Discard unsaved test-case edits?'))) return;
  tests.editing = { dir: $('caseDir').value.trim(), draft: { id: '', title: '', steps: [{ action: '', expected: '' }] }, remote: false, isNew: true };
  renderEditor();
};

function renderEditor() {
  const { draft, remote } = tests.editing;
  const drawer = $('drawer');
  const markDirty = () => (tests.editorDirty = true);
  const id = el('input', { id: 'caseId', value: draft.id || '', disabled: remote, placeholder: 'TC-001', 'aria-label': 'Case ID', style: 'width:100%' });
  const title = el('input', { id: 'caseTitle', value: draft.title || '', disabled: remote, placeholder: 'What the case checks', 'aria-label': 'Case title', style: 'width:100%' });
  const stepBox = el('div', { id: 'steps' });
  const renumber = () => [...stepBox.children].forEach((row, i) => (row.querySelector('.num').textContent = i + 1));
  function stepRow(s) {
    const row = el(
      'div',
      { class: 'step-edit' },
      el('span', { class: 'num' }),
      el(
        'div',
        {},
        el('textarea', { 'data-action': '', placeholder: 'Action', 'aria-label': 'Step action', value: s.action || '', disabled: remote }),
        el('textarea', { 'data-expected': '', placeholder: 'Expected result (checked against the page)', 'aria-label': 'Expected result', value: s.expected || '', disabled: remote }),
      ),
      remote
        ? el('span')
        : el(
            'div',
            { class: 'tools' },
            el('button', { type: 'button', class: 'ghost icon', title: 'Move up', 'aria-label': 'Move step up', onclick: () => { if (row.previousElementSibling) { stepBox.insertBefore(row, row.previousElementSibling); renumber(); markDirty(); } } }, '↑'),
            el('button', { type: 'button', class: 'ghost icon', title: 'Move down', 'aria-label': 'Move step down', onclick: () => { if (row.nextElementSibling) { stepBox.insertBefore(row.nextElementSibling, row); renumber(); markDirty(); } } }, '↓'),
            el('button', { type: 'button', class: 'ghost icon danger', title: 'Remove step', 'aria-label': 'Remove step', onclick: () => { row.remove(); renumber(); markDirty(); } }, '✕'),
          ),
    );
    return row;
  }
  for (const s of draft.steps || []) stepBox.append(stepRow(s));
  renumber();
  const foot = remote
    ? [el('span', { class: 'help grow' }, 'Azure DevOps cases are edited in Azure DevOps.'), el('button', { onclick: () => closeDrawer() }, 'Close')]
    : [
        el('button', { class: 'primary', id: 'saveCase', onclick: (e) => busy(e.currentTarget, saveCase) }, 'Save'),
        el(
          'button',
          {
            onclick: () => {
              stepBox.append(stepRow({}));
              renumber();
              markDirty();
              stepBox.lastElementChild.querySelector('textarea').focus();
            },
          },
          'Add step',
        ),
        el('span', { class: 'spacer' }),
        tests.editing.file
          ? el(
              'button',
              {
                onclick: async () => {
                  const name = await promptText('ID of the copy', (draft.id || 'TC') + '-COPY');
                  if (!name) return;
                  tests.editing.file = undefined;
                  id.value = name;
                  markDirty();
                  await busy(null, saveCase);
                },
              },
              'Duplicate',
            )
          : null,
        tests.editing.file
          ? el(
              'button',
              {
                class: 'danger',
                onclick: async () => {
                  if (!(await confirmAction('Delete this test-case file?'))) return;
                  await busy(null, async () => {
                    await api('/api/testcases?' + new URLSearchParams({ dir: tests.editing.dir, file: tests.editing.file }), 'DELETE');
                    await closeDrawer(true);
                    tests.loadedKey = '';
                    await loadCases();
                    toast('Test case deleted.');
                  });
                },
              },
              'Delete',
            )
          : null,
      ];
  drawer.replaceChildren(
    el('div', { class: 'drawer-head' }, el('h2', { class: 'grow', style: 'margin:0' }, remote ? 'Azure DevOps case' : tests.editing.isNew ? 'New test case' : 'Edit test case'), el('button', { class: 'ghost icon', 'aria-label': 'Close', onclick: () => closeDrawer() }, '✕')),
    el(
      'div',
      { class: 'drawer-body' },
      el('label', { for: 'caseId', class: 'help' }, 'ID'),
      id,
      el('label', { for: 'caseTitle', class: 'help', style: 'display:block;margin-top:10px' }, 'Title'),
      title,
      draft.preconditions ? el('div', { class: 'callout info' }, el('strong', {}, 'Preconditions: '), draft.preconditions) : null,
      el('h3', { style: 'margin-top:18px' }, 'Steps'),
      stepBox,
    ),
    el('div', { class: 'drawer-foot' }, ...foot),
  );
  drawer.oninput = markDirty;
  tests.editorDirty = false;
  drawer.hidden = false;
  $('drawerBackdrop').hidden = false;
  (remote ? drawer.querySelector('button') : tests.editing.isNew ? id : title).focus();
}

async function saveCase() {
  const testCase = {
    ...tests.editing.draft,
    id: $('caseId').value.trim(),
    title: $('caseTitle').value.trim(),
    steps: [...$('steps').children].map((row) => ({ action: row.querySelector('[data-action]').value, expected: row.querySelector('[data-expected]').value })),
  };
  if (!testCase.id) throw new Error('Give the case an ID.');
  const q = new URLSearchParams({ dir: tests.editing.dir });
  if (tests.editing.file) q.set('file', tests.editing.file);
  const oldId = tests.editing.draft.id;
  const saved = await api('/api/testcases?' + q, 'PUT', { testCase });
  tests.editing.file = saved.file;
  tests.editing.draft = testCase;
  tests.editing.isNew = false;
  tests.editorDirty = false;
  toast('Test case saved.');
  if (tests.source === 'local' && $('caseDir').value.trim() === tests.editing.dir) {
    tests.cases = await api('/api/cases?' + sourceQuery());
    tests.loadedKey = sourceQuery().toString();
    if (tests.selected.delete(oldId) || !oldId) tests.selected.add(testCase.id);
    rememberSelection();
    renderCases();
  }
  renderEditor();
}

/* ---------- Run bar ---------- */

const run = { current: null, lines: [], lineCount: 0, hidden: false, lastStatus: null, logOpen: store.get('logOpen') === '1' };

async function refreshRun() {
  const since = run.current && run.current.id === run.lastId ? run.lineCount : undefined;
  const r = await api('/api/run' + (since !== undefined ? '?since=' + since : ''));
  applyRun(r, since !== undefined);
}
function applyRun(r, incremental) {
  const wasRunning = run.current?.status === 'running';
  run.current = r;
  if (!r) {
    $('runBar').hidden = true;
    updateRunButton();
    return;
  }
  if (r.id !== run.lastId) {
    run.lastId = r.id;
    run.lines = [];
    run.hidden = false;
    incremental = false;
  }
  if (r.lines) {
    if (incremental && r.from === run.lineCount) run.lines.push(...r.lines);
    else run.lines = r.lines.slice();
    if (run.lines.length > 2000) run.lines.splice(0, run.lines.length - 2000);
    run.lineCount = r.lineCount ?? run.lines.length;
  }
  renderRun();
  if (wasRunning && r.status !== 'running') onRunEnded(r);
  if (wasRunning !== (r.status === 'running')) {
    appChanged();
    updateRunButton();
    renderEnvGrid();
  }
}
function renderRun() {
  const r = run.current;
  $('runBar').hidden = !r || run.hidden;
  if (!r) return;
  const running = r.status === 'running' || !r.settled;
  const p = r.progress;
  const kind = r.kind === 'upload' ? 'Upload' : r.args?.includes('--dry-run') ? 'Diagnostic run' : 'Run';
  const chip = $('runChip');
  chip.textContent = running ? (r.status === 'running' ? 'Running' : 'Saving') : { passed: 'Finished', failed: 'Finished with failures', stopped: 'Stopped' }[r.status] || r.status;
  chip.className = 'chip ' + (running ? 'running' : r.status === 'passed' ? 'passed' : r.status === 'stopped' ? 'warn' : 'failed');
  let title = `${kind} · ${r.profile || 'no environment'}`;
  if (p && running && p.current) title += ` · ${p.current}`;
  if (p && p.total !== undefined) title += ` · ${p.finished} of ${p.total} done`;
  $('runTitle').textContent = title;
  $('runEta').textContent = running && p?.remainingSeconds ? `about ${duration(p.remainingSeconds * 1000)} left` : !running && r.finishedAt ? `took ${duration(new Date(r.finishedAt) - new Date(r.startedAt))}` : '';
  const bar = $('runProgress');
  const known = p && p.total;
  bar.classList.toggle('indeterminate', running && !known);
  bar.firstElementChild.style.width = known ? `${Math.round((p.finished / p.total) * 100)}%` : running ? '' : '100%';
  $('stopRun').hidden = r.status !== 'running';
  $('openRunResults').hidden = r.kind !== 'run' || running;
  $('dismissRun').hidden = running;
  $('runLog').hidden = !run.logOpen;
  $('toggleLog').textContent = run.logOpen ? 'Hide log' : 'Show log';
  $('toggleLog').setAttribute('aria-expanded', String(run.logOpen));
  if (run.logOpen) {
    const log = $('runLog');
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.textContent = run.lines.join('\n');
    if (atEnd) log.scrollTop = log.scrollHeight;
  }
}
async function onRunEnded(r) {
  if (r.kind === 'upload') {
    toast(r.status === 'passed' ? 'Upload finished.' : 'Upload did not finish; see the log.', r.status !== 'passed');
    if (currentTab === 'results') loadResults().catch(() => undefined);
    return;
  }
  if (r.savedAs) results.selected = r.savedAs;
  const t = r.savedAs ? (await api('/api/history').catch(() => [])).find((m) => m.id === r.savedAs)?.totals : undefined;
  const msg = t ? `Run finished: ${t.passed} passed, ${t.failed} failed, ${t.blocked} blocked.` : r.status === 'stopped' ? 'Run stopped.' : 'Run finished.';
  toast(msg, Boolean(t && (t.failed || t.blocked)) || (!t && r.status === 'failed'));
  if (currentTab === 'results') loadResults().catch(() => undefined);
}
$('toggleLog').onclick = () => {
  run.logOpen = !run.logOpen;
  store.set('logOpen', run.logOpen ? '1' : '0');
  renderRun();
};
$('stopRun').onclick = () =>
  busy($('stopRun'), async () => {
    if (!(await confirmAction('Stop the run? The case in progress is recorded as interrupted.'))) return;
    await api('/api/run/stop', 'POST');
    await refreshRun();
  });
$('openRunResults').onclick = () => {
  if (run.current?.savedAs) results.selected = run.current.savedAs;
  showTab('results');
};
$('dismissRun').onclick = () => {
  run.hidden = true;
  renderRun();
};

/* Live updates: the server pushes each log line, progress and status. Polling is only the fallback. */
let events;
let fallbackTimer;
function connectEvents() {
  events = new EventSource('/api/run/events');
  events.addEventListener('line', (e) => {
    const d = JSON.parse(e.data);
    if (!run.current || d.id !== run.current.id || d.n !== run.lineCount) return void refreshRun().catch(() => undefined);
    run.lines.push(d.line);
    if (run.lines.length > 2000) run.lines.shift();
    run.lineCount++;
    if (run.logOpen && !run.hidden) scheduleRender();
  });
  events.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    if (run.current && d.id === run.current.id) {
      run.current.progress = d.progress;
      scheduleRender();
    }
  });
  events.addEventListener('status', () => refreshRun().catch(() => undefined));
  events.onopen = () => {
    clearInterval(fallbackTimer);
    fallbackTimer = undefined;
    refreshRun().catch(() => undefined);
  };
  events.onerror = () => {
    if (!fallbackTimer) fallbackTimer = setInterval(() => refreshRun().catch(() => undefined), 3000);
  };
}
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderRun();
  });
}

/* ---------- Results ---------- */

const results = { selected: '', history: [], rows: null, filter: 'all', comparison: null };

async function loadResults() {
  results.history = await api('/api/history');
  if (!results.history.some((m) => m.id === results.selected)) results.selected = results.history[0]?.id || '';
  renderRunList();
  await renderResults();
}
function totalsChips(t) {
  if (!t) return [];
  return [
    t.passed ? el('span', { class: 'chip passed' }, `${t.passed} passed`) : null,
    t.failed ? el('span', { class: 'chip failed' }, `${t.failed} failed`) : null,
    t.blocked ? el('span', { class: 'chip blocked' }, `${t.blocked} blocked`) : null,
    t.skipped ? el('span', { class: 'chip' }, `${t.skipped} skipped`) : null,
  ];
}
function renderRunList() {
  const list = $('runList');
  if (!results.history.length) {
    list.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'No runs yet'), 'Runs from Tests and chat appear here.'));
    return;
  }
  list.replaceChildren(
    ...results.history.map((m) =>
      el(
        'button',
        {
          class: 'run-item',
          'aria-current': m.id === results.selected ? 'true' : undefined,
          onclick: () => {
            results.selected = m.id;
            results.filter = 'all';
            renderRunList();
            renderResults().catch(fail);
          },
        },
        el('div', { class: 'when' }, when(m.startedAt)),
        el('div', { class: 'sub' }, [m.profile || 'No environment', m.mode === 'dry-run' ? 'diagnostic' : null, m.origin === 'cli' ? 'terminal' : null].filter(Boolean).join(' · ')),
        el('div', { class: 'chips' }, ...(m.totals?.total ? totalsChips(m.totals) : [el('span', { class: 'chip' + (m.status === 'stopped' ? ' warn' : ' bad') }, m.status === 'stopped' ? 'Stopped' : 'No results')]), m.upload ? el('span', { class: 'chip accent', title: 'Uploaded to Azure DevOps' }, 'Uploaded') : null),
      ),
    ),
  );
}

async function renderResults() {
  const box = $('resultDetail');
  const meta = results.history.find((m) => m.id === results.selected);
  const q = results.selected ? '?run=' + encodeURIComponent(results.selected) : '';
  if (!meta && results.history.length) return void box.replaceChildren();
  box.replaceChildren(el('div', { class: 'empty' }, el('span', { class: 'spinner' }), ' Loading…'));
  const rows = (await api('/api/results' + q)) || [];
  results.rows = rows;
  results.comparison = null;
  const head = el(
    'div',
    { class: 'row' },
    el('div', { class: 'grow' }, el('h2', { style: 'margin:0' }, meta ? new Date(meta.startedAt).toLocaleString() : 'Latest results'), meta ? el('div', { class: 'muted' }, [meta.profile || 'No environment', meta.mode === 'dry-run' ? 'Diagnostic run' : 'Live run', meta.finishedAt ? `took ${duration(new Date(meta.finishedAt) - new Date(meta.startedAt))}` : null].filter(Boolean).join(' · ')) : null),
  );
  const failedCount = rows.filter((r) => r.interrupted || (r.outcome !== 'passed' && r.outcome !== 'skipped')).length;
  const actions = el(
    'div',
    { class: 'actions' },
    meta && failedCount ? el('button', { class: 'primary', onclick: (e) => busy(e.currentTarget, () => rerunFailed(meta)) }, `Rerun ${plural(failedCount, 'failed case')}`) : null,
    meta && rows.length ? el('button', { onclick: (e) => busy(e.currentTarget, () => compareRun(meta)) }, 'Compare with previous') : null,
    meta && rows.length ? el('button', { onclick: () => uploadRun(meta).catch(fail) }, meta.upload ? 'Upload again' : 'Upload to Azure DevOps') : null,
    el('span', { class: 'spacer' }),
    rows.length ? el('a', { href: '/report' + q, target: '_blank', rel: 'noopener' }, 'HTML report') : null,
    rows.length ? el('a', { href: '/download/results.json' + q }, 'JSON') : null,
    rows.length ? el('a', { href: '/download/results.junit.xml' + q }, 'JUnit') : null,
    meta
      ? el(
          'details',
          { class: 'menu' },
          el('summary', { 'aria-label': 'More actions', title: 'More' }, '⋯'),
          el('div', {}, el('button', { class: 'danger', onclick: (e) => menuAction(e, () => deleteRun(meta)) }, 'Delete run')),
        )
      : null,
  );
  const upload = meta?.upload?.url ? el('div', { class: 'callout info' }, 'Uploaded to Azure DevOps ', el('a', { href: meta.upload.url, target: '_blank', rel: 'noopener' }, meta.upload.runId ? `run #${meta.upload.runId}` : 'run'), ` on ${new Date(meta.upload.at).toLocaleString()}.`) : null;
  // Values the agent chose from F&O for parameters the case leaves unset, in cases that passed with them.
  const suggested = meta ? rows.filter((r) => !r.interrupted && r.outcome === 'passed' && /^\d+$/.test(r.testCaseId) && r.suggestedParameters?.length) : [];
  const params = suggested.length
    ? el(
        'div',
        { class: 'callout info' },
        el('strong', {}, 'The agent chose values for parameters the test case leaves unset'),
        el('div', {}, 'These cases passed with them. Save them to the test case parameters so the next run needs no lookup. Only parameters without a value are filled; nothing else is changed.'),
        ...suggested.map((r) => el('div', { class: 'muted' }, `Case ${r.testCaseId}: ` + r.suggestedParameters.map((p) => `@${p.name} = ${p.value}`).join(', '))),
        el('div', { style: 'margin-top:8px' }, el('button', { onclick: (e) => busy(e.currentTarget, () => saveParameters(meta, suggested)) }, 'Save to test case parameters…')),
      )
    : null;
  if (!rows.length) {
    box.replaceChildren(head, actions, el('div', { class: 'empty' }, el('strong', {}, 'No test results in this run'), meta?.status === 'stopped' ? 'It was stopped before a case finished.' : 'It ended before a case finished; the run log has the reason.'));
    return;
  }
  const counts = {};
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  const filters = el(
    'div',
    { class: 'row tight', role: 'group', 'aria-label': 'Filter by outcome', style: 'margin:14px 0 4px' },
    ...[['all', `All ${rows.length}`], ...['failed', 'blocked', 'passed', 'skipped'].filter((o) => counts[o]).map((o) => [o, `${counts[o]} ${o}`])].map(([key, label]) =>
      el(
        'button',
        {
          class: 'chip ' + (key === 'all' ? '' : key),
          'aria-pressed': String(results.filter === key),
          onclick: () => {
            results.filter = key;
            renderCaseResults();
          },
        },
        label,
      ),
    ),
  );
  box.replaceChildren(head, actions, upload, params, el('div', { id: 'comparison' }), filters, el('div', { id: 'caseResults' }));
  renderCaseResults();
}
function renderCaseResults() {
  const rows = results.rows || [];
  for (const b of document.querySelectorAll('#resultDetail [aria-pressed]')) b.setAttribute('aria-pressed', String(b.textContent.toLowerCase().includes(results.filter) || (results.filter === 'all' && b.textContent.startsWith('All'))));
  const shown = rows.filter((r) => results.filter === 'all' || r.outcome === results.filter);
  const order = { failed: 0, blocked: 1, skipped: 3, passed: 4 };
  shown.sort((a, b) => (order[a.outcome] ?? 2) - (order[b.outcome] ?? 2));
  $('caseResults').replaceChildren(...shown.map(caseResult));
}
function caseResult(r) {
  const bad = r.outcome !== 'passed' && r.outcome !== 'skipped';
  const hint = r.failureCategory && bad ? state.categoryHints?.[r.failureCategory] : '';
  const usage = r.usage;
  return el(
    'details',
    { class: 'result-case', open: bad && (results.rows?.length ?? 0) <= 12 },
    el(
      'summary',
      {},
      el('span', { class: 'icon-status ' + r.outcome, 'aria-label': r.outcome }, OUTCOME_ICON[r.outcome] || '?'),
      el('span', { class: 'grow' }, el('strong', {}, r.testCaseId), ' ', r.title),
      r.interrupted ? el('span', { class: 'chip warn' }, 'interrupted') : null,
      r.failureCategory && bad ? el('span', { class: 'chip' }, r.failureCategory.replace(/_/g, ' ')) : null,
      el('span', { class: 'muted' }, duration(r.durationMs)),
    ),
    el(
      'div',
      { class: 'body' },
      r.errorMessage && bad ? el('div', { class: 'callout' }, r.errorMessage, hint ? el('div', { class: 'help', style: 'margin-top:4px' }, 'What to do: ', hint) : null) : null,
      ...(r.steps || []).map((s) =>
        el(
          'div',
          { class: 'result-step' },
          el('span', { class: 'icon-status ' + s.status, 'aria-label': s.status }, OUTCOME_ICON[s.status] || '?'),
          el('span', { class: 'n' }, `#${s.index}`),
          el(
            'div',
            {},
            s.observed ? el('div', {}, s.observed) : null,
            s.errorMessage ? el('div', { class: 'bad' }, s.errorMessage) : null,
            s.status === 'passed' && s.verified === false ? el('div', { class: 'help' }, 'Expected result not verified.') : null,
            !s.observed && !s.errorMessage ? el('div', { class: 'muted' }, s.status) : null,
          ),
        ),
      ),
      r.data && Object.keys(r.data).length ? el('div', { style: 'margin-top:10px' }, el('h3', {}, 'Recorded values'), el('dl', { class: 'kv' }, ...Object.entries(r.data).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))) : null,
      r.policyBlocks?.length ? el('details', { class: 'section' }, el('summary', {}, plural(r.policyBlocks.length, 'action') + ' refused by the guardrails'), el('pre', {}, r.policyBlocks.join('\n'))) : null,
      r.timeouts?.length ? el('details', { class: 'section' }, el('summary', {}, plural(r.timeouts.length, 'timeout')), el('pre', {}, r.timeouts.join('\n'))) : null,
      el(
        'div',
        { class: 'stats', style: 'margin-top:10px' },
        el('span', {}, `${r.steps?.length ?? 0} steps reported`),
        r.artifacts?.length ? el('span', {}, plural(r.artifacts.length, 'evidence file') + ' (in the HTML report)') : null,
        usage ? el('span', { title: 'Model turns and tokens used' }, `${plural(usage.turns, 'model turn')} · ${Math.round(((usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)) / 1000)}k tokens in, ${Math.round((usage.outputTokens || 0) / 1000)}k out${usage.cacheReadTokens ? ` · ${Math.round((usage.cacheReadTokens / Math.max(1, (usage.inputTokens || 0) + usage.cacheReadTokens + (usage.cacheWriteTokens || 0))) * 100)}% cached` : ''}`) : null,
      ),
    ),
  );
}

async function rerunFailed(meta) {
  if (!state.active) throw new Error('Choose an environment in Settings first.');
  const ids = (results.rows || []).filter((r) => r.interrupted || (r.outcome !== 'passed' && r.outcome !== 'skipped')).map((r) => r.testCaseId);
  if (!(await confirmAction(`Rerun ${plural(ids.length, 'case')} in ${state.active}?\n\n${ids.join(', ')}`))) return;
  const r = await api('/api/history/' + meta.id + '/rerun', 'POST', { dryRun: meta.mode === 'dry-run' });
  if (r.error) throw new Error(r.error);
  run.hidden = false;
  await refreshRun();
  toast(`Rerunning ${plural(r.cases?.length ?? ids.length, 'case')}.`);
}
async function compareRun(meta) {
  const c = await api('/api/history/' + meta.id + '/compare');
  const prev = results.history.find((m) => m.id === c.previous);
  const line = (label, ids, cls) => (ids.length ? el('div', {}, el('span', { class: 'chip ' + cls }, `${ids.length} ${label}`), ' ', ids.join(', ')) : null);
  $('comparison').replaceChildren(
    el(
      'div',
      { class: 'callout info' },
      el('strong', {}, 'Compared with ', prev ? when(prev.startedAt) : c.previous),
      line('fixed', c.fixed, 'passed'),
      line('regressed', c.regressed, 'failed'),
      line('still failing', c.stillFailing, 'blocked'),
      line('new', c.added, 'accent'),
      c.unchanged ? el('div', { class: 'muted' }, `${c.unchanged} unchanged`) : null,
    ),
  );
}
async function uploadRun(meta) {
  const plan = await promptText(`Upload this run to Azure DevOps using ${meta.profile || 'its environment'}. Test plan ID:`, meta.args?.[meta.args.indexOf('--plan') + 1] || (tests.source === 'devops' ? $('plan').value.trim() : ''));
  if (!plan) return;
  const r = await api('/api/history/' + meta.id + '/upload', 'POST', { plan });
  if (r.error) throw new Error(r.error);
  run.hidden = false;
  await refreshRun();
}
async function saveParameters(meta, suggested) {
  const list = suggested.map((r) => `Case ${r.testCaseId}: ` + r.suggestedParameters.map((p) => `@${p.name} = ${p.value}`).join(', ')).join('\n');
  if (!(await confirmAction(`Save these values to the Azure DevOps test case parameters (${meta.profile || 'its environment'})? Only parameters without a value are filled.\n\n${list}`))) return;
  const r = await api('/api/history/' + meta.id + '/parameters', 'POST', {});
  if (r.error) throw new Error(r.error);
  run.hidden = false;
  await refreshRun();
}
async function deleteRun(meta) {
  if (!(await confirmAction('Delete this run and its reports?'))) return;
  await api('/api/history/' + meta.id, 'DELETE');
  results.selected = '';
  await loadResults();
  toast('Run deleted.');
}
$('refreshResults').onclick = () => busy($('refreshResults'), loadResults);

/* ---------- Start ---------- */

window.addEventListener('beforeunload', (e) => {
  if (dirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    if (!$('drawer').hidden && tests.editing && !tests.editing.remote) {
      e.preventDefault();
      busy($('saveCase'), saveCase);
    } else if (currentTab === 'settings' && settings.editing && !$('saveProfile').disabled) {
      e.preventDefault();
      $('saveProfile').click();
    }
  }
});

setSource(tests.source);
connectEvents();
refresh()
  .then(async () => {
    if (!state.profiles.length) {
      await showTab('settings');
      openWizard();
    } else if (!state.active || !state.aiConfigured) await showTab('settings');
    else await showTab(currentTab);
  })
  .catch(fail);

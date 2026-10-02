/** The whole UI: one self-contained page (no build step, no external assets). Data is rendered with textContent only. */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>D365 F&amp;O Agent</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --line:#dde1e6; --text:#1f2328; --muted:#656d76; --accent:#0969da; --ok:#1a7f37; --bad:#cf222e; --warn:#9a6700; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --card:#161b22; --line:#30363d; --text:#e6edf3; --muted:#8d96a0; --accent:#4493f8; --ok:#3fb950; --bad:#f85149; --warn:#d29922; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
  header { display:flex; align-items:center; gap:24px; padding:10px 20px; background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:1; }
  header h1 { font-size:16px; margin:0; }
  nav button { background:none; border:0; padding:8px 12px; color:var(--muted); font:inherit; cursor:pointer; border-bottom:2px solid transparent; }
  nav button.active { color:var(--text); border-bottom-color:var(--accent); font-weight:600; }
  #summary { margin-left:auto; color:var(--muted); font-size:12px; }
  main { max-width:1100px; margin:20px auto; padding:0 20px; }
  section { display:none; } section.active { display:block; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
  .card h2 { font-size:15px; margin:0 0 12px; }
  .grid { display:grid; grid-template-columns: 220px 1fr; gap:8px 16px; align-items:center; }
  .grid label { color:var(--muted); }
  .help { grid-column:2; color:var(--muted); font-size:12px; margin-top:-4px; }
  input, select { width:100%; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); font:inherit; }
  input[type=checkbox] { width:auto; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .row > * { flex:0 0 auto; }
  button.btn { padding:6px 14px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--text); font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--bad); }
  button:disabled { opacity:.5; cursor:default; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; max-height:520px; white-space:pre-wrap; word-break:break-word; font:12px/1.4 ui-monospace, Menlo, monospace; margin:0; }
  .msg { padding:8px 12px; border-radius:6px; margin-bottom:12px; border:1px solid var(--line); }
  .msg.bad { border-color:var(--bad); color:var(--bad); } .msg.ok { border-color:var(--ok); color:var(--ok); } .msg.warn { border-color:var(--warn); color:var(--warn); }
  .tag { font-size:11px; padding:1px 6px; border-radius:10px; border:1px solid var(--line); color:var(--muted); margin-left:6px; }
  .passed { color:var(--ok); } .failed, .blocked { color:var(--bad); } .skipped { color:var(--muted); }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  .secret-row { display:flex; gap:8px; align-items:center; }
</style>
</head>
<body>
<header>
  <h1>D365 F&amp;O Agent</h1>
  <nav>
    <button data-tab="run" class="active">Run</button>
    <button data-tab="settings">Settings</button>
    <button data-tab="results">Results</button>
  </nav>
  <div id="summary"></div>
</header>
<main>
  <section id="tab-run" class="active">
    <div class="card">
      <h2>Test cases</h2>
      <div class="grid">
        <label>Source</label>
        <div class="row">
          <label><input type="radio" name="source" value="local" checked> Local folder</label>
          <label><input type="radio" name="source" value="devops"> Azure DevOps</label>
        </div>
        <label for="local">Folder</label><input id="local" value="examples/testcases">
        <label for="plan">Plan / suite</label>
        <div class="row"><input id="plan" placeholder="plan id (default from settings)" style="width:220px"><input id="suite" placeholder="suite id" style="width:220px"></div>
        <label for="caseId">Case</label>
        <div class="row"><select id="caseId" style="width:520px"><option value="">All cases</option></select><button class="btn" id="load">Load cases</button></div>
        <label>Options</label>
        <div class="row">
          <label><input type="checkbox" id="dryRun"> Dry run (no clicks/typing that change data)</label>
          <label><input type="checkbox" id="upload"> Upload results to Azure DevOps</label>
          <label>Retries <input id="retries" type="number" min="0" max="10" placeholder="default" style="width:90px"></label>
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="start">Run</button>
        <button class="btn danger" id="stop" disabled>Stop</button>
        <span id="runStatus"></span>
      </div>
    </div>
    <div class="card"><h2>Live log</h2><pre id="log">No run yet.</pre></div>
  </section>

  <section id="tab-settings">
    <div id="settingsMsg"></div>
    <div id="settingsForm"></div>
    <div class="card">
      <div class="row">
        <button class="btn primary" id="save">Save to .env</button>
        <button class="btn" id="doctor">Run doctor</button>
        <span style="color:var(--muted)" id="envPath"></span>
      </div>
      <p style="color:var(--muted);margin:10px 0 0">Changes apply to the next run; no rebuild or restart needed. Secret fields are never shown. Leave them empty to keep the current value.</p>
      <pre id="doctorOut" style="margin-top:12px;display:none"></pre>
    </div>
  </section>

  <section id="tab-results">
    <div class="card">
      <div class="row"><h2 style="margin:0">Latest run</h2><button class="btn" id="refreshResults">Refresh</button><a href="/report" target="_blank" rel="noopener">Open full HTML report ↗</a></div>
      <div id="results" style="margin-top:12px"></div>
    </div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok && !(data && data.problems)) throw new Error((data && data.error) || data || res.statusText);
  return data;
}
function msg(target, kind, lines) {
  target.replaceChildren();
  if (!lines.length) return;
  const box = el('div', { className: 'msg ' + kind });
  for (const l of lines) box.append(el('div', { textContent: l }));
  target.append(box);
}

document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'results') loadResults();
  if (b.dataset.tab === 'settings') loadSettings();
});

// ── Settings ──
let fields = [];
async function loadSettings() {
  const data = await api('/api/settings');
  fields = data.fields;
  $('summary').textContent = data.summary;
  $('envPath').textContent = data.envPath + (data.exists ? '' : ' (will be created)');
  msg($('settingsMsg'), data.problems.length ? 'warn' : 'ok', data.problems.length ? data.problems : ['Configuration looks valid.']);
  const form = $('settingsForm');
  form.replaceChildren();
  const groups = {};
  for (const f of fields) (groups[f.group] ||= []).push(f);
  for (const [name, list] of Object.entries(groups)) {
    const grid = el('div', { className: 'grid' });
    for (const f of list) {
      const label = el('label', { htmlFor: 'f_' + f.key, textContent: f.label, title: f.key });
      if (f.shadowed) label.append(el('span', { className: 'tag', textContent: 'set in shell', title: 'A shell variable overrides the .env value' }));
      let input;
      if (f.options) {
        input = el('select', { id: 'f_' + f.key });
        const opts = f.options.includes(f.value) ? f.options : [f.value, ...f.options];
        for (const o of opts) input.append(el('option', { value: o, textContent: o === '' ? '(not set)' : o }));
        input.value = f.value;
      } else if (f.secret) {
        input = el('input', { id: 'f_' + f.key, type: 'password', autocomplete: 'new-password', placeholder: f.set ? '•••••••• set (leave empty to keep)' : 'not set' });
        const clear = el('button', { className: 'btn', textContent: 'Clear', type: 'button', disabled: !f.set });
        clear.onclick = () => { input.dataset.clear = '1'; input.value = ''; input.placeholder = 'will be cleared on save'; };
        input = el('div', { className: 'secret-row' }, input, clear);
      } else {
        input = el('input', { id: 'f_' + f.key, value: f.value, placeholder: f.placeholder || '' });
      }
      grid.append(label, input);
      if (f.help) grid.append(el('div', { className: 'help', textContent: f.help }));
    }
    form.append(el('div', { className: 'card' }, el('h2', { textContent: name }), grid));
  }
}
$('save').onclick = async () => {
  const values = {}, clear = [];
  for (const f of fields) {
    const input = $('f_' + f.key);
    if (f.secret && input.dataset.clear) clear.push(f.key);
    else if (f.secret) { if (input.value) values[f.key] = input.value; }
    else if (input.value !== f.value) values[f.key] = input.value;
  }
  try {
    const res = await api('/api/settings', 'PUT', { values, clear });
    if (!res.ok) return msg($('settingsMsg'), 'bad', ['Not saved:', ...res.problems]);
    await loadSettings();
    const note = res.changed.length ? 'Saved ' + res.changed.join(', ') + '.' : 'Nothing changed.';
    $('settingsMsg').prepend(el('div', { className: 'msg ok', textContent: note }));
  } catch (e) { msg($('settingsMsg'), 'bad', [String(e.message || e)]); }
};
$('doctor').onclick = async () => {
  const out = $('doctorOut');
  out.style.display = 'block'; out.textContent = 'Running doctor…';
  const res = await api('/api/doctor', 'POST', {});
  out.textContent = res.output;
};

// ── Run ──
const source = () => document.querySelector('input[name=source]:checked').value;
$('load').onclick = async () => {
  const q = source() === 'local' ? 'local=' + encodeURIComponent($('local').value) : 'plan=' + encodeURIComponent($('plan').value) + '&suite=' + encodeURIComponent($('suite').value);
  const sel = $('caseId');
  sel.replaceChildren(el('option', { value: '', textContent: 'Loading…' }));
  try {
    const cases = await api('/api/cases?' + q);
    sel.replaceChildren(el('option', { value: '', textContent: 'All cases (' + cases.length + ')' }));
    for (const c of cases) sel.append(el('option', { value: c.id, textContent: '[' + c.id + '] ' + c.title + ' — ' + c.steps + ' step(s)' }));
  } catch (e) { sel.replaceChildren(el('option', { value: '', textContent: 'Error: ' + (e.message || e) })); }
};
$('start').onclick = async () => {
  const body = { source: source(), local: $('local').value, plan: $('plan').value, suite: $('suite').value, caseId: $('caseId').value, dryRun: $('dryRun').checked, upload: $('upload').checked, retries: $('retries').value };
  try {
    $('log').textContent = '';
    const res = await api('/api/run', 'POST', body);
    if (res.error) { $('log').textContent = res.error; return; }
    showStatus(res.run);
  } catch (e) { $('log').textContent = String(e.message || e); }
};
$('stop').onclick = () => api('/api/run/stop', 'POST', {});
function showStatus(r) {
  const running = r && r.status === 'running';
  $('start').disabled = running; $('stop').disabled = !running;
  $('runStatus').className = r ? r.status : '';
  $('runStatus').textContent = !r ? '' : running ? 'Running…' : r.status === 'passed' ? 'Finished' : r.status === 'stopped' ? 'Stopped' : 'Finished with failures (exit ' + r.exitCode + ')';
  if (r && !running) loadResults();
}
function appendLog(line) {
  const log = $('log');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(line + '\\n');
  if (stick) log.scrollTop = log.scrollHeight;
}
async function initRun() {
  const r = await api('/api/run');
  if (r) { $('log').textContent = ''; r.lines.forEach(appendLog); showStatus(r); }
  const es = new EventSource('/api/run/events');
  es.addEventListener('line', (e) => appendLog(JSON.parse(e.data).line));
  es.addEventListener('status', (e) => showStatus(JSON.parse(e.data)));
}

// ── Results ──
async function loadResults() {
  const box = $('results');
  const results = await api('/api/results');
  if (!results || !results.length) { box.textContent = 'No results yet.'; return; }
  const table = el('table', {}, el('tr', {}, ...['Case', 'Outcome', 'Attempts', 'Duration', 'Details'].map((h) => el('th', { textContent: h }))));
  for (const r of results) {
    const details = el('div');
    if (r.errorMessage) details.append(el('div', { textContent: r.errorMessage }));
    for (const s of r.steps || []) {
      details.append(el('div', {}, el('span', { className: s.status, textContent: 'Step ' + s.index + ' ' + s.status + (s.verified ? ' ✓' : '') + ': ' }), (s.observed || s.errorMessage || '')));
    }
    for (const p of r.policyBlocks || []) details.append(el('div', { className: 'blocked', textContent: 'Guardrail: ' + p }));
    table.append(el('tr', {},
      el('td', { textContent: '[' + r.testCaseId + '] ' + r.title }),
      el('td', { className: r.outcome, textContent: r.outcome }),
      el('td', { textContent: String(r.attemptCount || 1) }),
      el('td', { textContent: (r.durationMs / 1000).toFixed(1) + 's' }),
      el('td', {}, details)));
  }
  box.replaceChildren(table);
}
$('refreshResults').onclick = loadResults;

api('/api/settings').then((d) => { $('summary').textContent = d.summary; }).catch(() => {});
initRun();
</script>
</body>
</html>`;

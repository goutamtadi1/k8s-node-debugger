'use strict';

/* ── state ─────────────────────────────────────────────────────────────── */
let session = null;
let activePanel = 'overview';
const probeCache = {}; // id → { output, error, command, ok }
let termHistory = [];
let termHistIdx = -1;
let wsRunning = false;

/* ── xterm ──────────────────────────────────────────────────────────────── */
const term = new Terminal({
  theme: {
    background: '#0a0d12',
    foreground: '#c9d4e2',
    cursor: '#4f9dff',
    selectionBackground: '#2a3a55',
  },
  fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.45,
  convertEol: true,
  scrollback: 10000,
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('term'));
fitAddon.fit();
window.addEventListener('resize', () => fitAddon.fit());

/* ── WebSocket terminal ────────────────────────────────────────────────── */
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term`;
let ws = null;

function wsConnect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => term.writeln('\x1b[2m[connected]\x1b[0m');
  ws.onclose = () => {
    term.writeln('\x1b[31m[disconnected — reload to reconnect]\x1b[0m');
    setRunning(false);
  };
  ws.onerror = () => term.writeln('\x1b[31m[ws error]\x1b[0m');
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
      case 'started':
        setRunning(true);
        term.writeln(`\x1b[2m$ ${msg.data}\x1b[0m`);
        break;
      case 'stdout':
        term.write(msg.data);
        break;
      case 'stderr':
        term.write(`\x1b[33m${msg.data}\x1b[0m`);
        break;
      case 'exit':
        setRunning(false);
        term.writeln(`\x1b[2m[exit ${msg.data}]\x1b[0m`);
        break;
    }
  };
}

function setRunning(v) {
  wsRunning = v;
  document.getElementById('term-run').disabled = v;
  document.getElementById('term-stop').disabled = !v;
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function runTermCmd(cmd) {
  if (!cmd) return;
  if (termHistory[0] !== cmd) termHistory.unshift(cmd);
  if (termHistory.length > 100) termHistory.pop();
  termHistIdx = -1;
  if (activePanel !== 'terminal') showPanel('terminal');
  wsSend({ type: 'run', command: cmd });
}

document.getElementById('term-run').addEventListener('click', () => {
  const input = document.getElementById('term-input');
  runTermCmd(input.value.trim());
  input.value = '';
});

document.getElementById('term-stop').addEventListener('click', () =>
  wsSend({ type: 'signal', signal: 'SIGINT' })
);
document.getElementById('term-clear').addEventListener('click', () => term.clear());

const termInput = document.getElementById('term-input');
termInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    runTermCmd(termInput.value.trim());
    termInput.value = '';
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    termHistIdx = Math.min(termHistIdx + 1, termHistory.length - 1);
    termInput.value = termHistory[termHistIdx] || '';
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    termHistIdx = Math.max(termHistIdx - 1, -1);
    termInput.value = termHistIdx < 0 ? '' : termHistory[termHistIdx];
  } else if (e.key === 'c' && e.ctrlKey) {
    wsSend({ type: 'signal', signal: 'SIGINT' });
  }
});

setRunning(false);
wsConnect();

/* ── navigation ─────────────────────────────────────────────────────────── */
function showPanel(id) {
  activePanel = id;
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.panel === id);
  });
  let el = document.getElementById(id + '-panel');
  if (!el) {
    // probe panels live inside #probe-panels container
    el = document.getElementById('probe-' + id);
  }
  if (el) el.classList.add('active');
}

/* ── overview ────────────────────────────────────────────────────────────── */
function renderOverview(nodes) {
  const card = document.getElementById('node-card');
  if (!session) return;

  // session info
  const sessionDiv = document.getElementById('session');
  sessionDiv.innerHTML =
    `<span class="pill">ctx: <b>${esc(session.context || 'default')}</b></span>` +
    `<span class="pill">node: <b>${esc(session.node)}</b></span>` +
    `<span class="pill">pod: <b>${esc(session.namespace)}/${esc(session.podName)}</b></span>` +
    `<span class="pill">image: <b>${esc(session.image)}</b></span>`;

  const n = nodes.find((x) => x.name === session.node);
  if (!n) {
    card.innerHTML = `<div class="kv"><span class="k">Node</span><span class="v">${esc(session.node)}</span></div>`;
    return;
  }

  card.innerHTML = `
    <div class="kv">
      <span class="k">Name</span><span class="v">${esc(n.name)}</span>
      <span class="k">Status</span><span class="v" style="color:${n.ready ? 'var(--ok)' : 'var(--err)'}">
        ${n.ready ? '● Ready' : '○ Not Ready'}</span>
      <span class="k">Roles</span><span class="v">${esc(n.roles.join(', ') || '—')}</span>
      <span class="k">Internal IP</span><span class="v">${esc(n.internalIP || '—')}</span>
      <span class="k">OS</span><span class="v">${esc(n.os || '—')}</span>
      <span class="k">Kernel</span><span class="v">${esc(n.kernel || '—')}</span>
      <span class="k">Container runtime</span><span class="v">${esc(n.runtime || '—')}</span>
      <span class="k">Kubelet</span><span class="v">${esc(n.kubelet || '—')}</span>
    </div>
  `;
}

/* ── sidebar ─────────────────────────────────────────────────────────────── */
function buildSidebar(probes) {
  const nav = document.getElementById('sidebar');
  nav.innerHTML = '';

  const overviewItem = navItem('overview', 'Overview', 'overview');
  overviewItem.querySelector('.dot').style.display = 'none';
  nav.appendChild(overviewItem);

  // group probes
  const groups = {};
  for (const p of probes) {
    (groups[p.group] = groups[p.group] || []).push(p);
  }
  for (const [grp, items] of Object.entries(groups)) {
    const hdr = document.createElement('div');
    hdr.className = 'nav-group';
    hdr.textContent = grp;
    nav.appendChild(hdr);
    for (const p of items) nav.appendChild(navItem(p.id, p.label, 'probe'));
  }

  const termHdr = document.createElement('div');
  termHdr.className = 'nav-group';
  termHdr.textContent = 'Terminal';
  nav.appendChild(termHdr);
  const termItem = navItem('terminal', 'Terminal', 'terminal');
  termItem.querySelector('.dot').style.display = 'none';
  nav.appendChild(termItem);
}

function navItem(id, label, type) {
  const el = document.createElement('div');
  el.className = 'nav-item';
  el.dataset.panel = id;
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.id = 'dot-' + id;
  el.appendChild(document.createTextNode(label));
  el.appendChild(dot);
  el.addEventListener('click', () => {
    showPanel(id);
    if (type === 'probe' && !probeCache[id]) runProbe(id);
  });
  return el;
}

/* ── probe panels ────────────────────────────────────────────────────────── */

// Probes that get a rich custom renderer instead of a plain <pre>.
const FANCY_PROBES = new Set(['iptables', 'iptables-nat']);

function buildProbePanel(probe) {
  const container = document.getElementById('probe-panels');
  const section = document.createElement('section');
  section.id = 'probe-' + probe.id;
  section.className = 'panel';
  const fancy = FANCY_PROBES.has(probe.id);
  section.innerHTML = `
    <h2>${esc(probe.label)}</h2>
    <div class="probe-head">
      <span class="desc">${esc(probe.desc)}</span>
      <button id="run-btn-${esc(probe.id)}">↻ Re-run</button>
    </div>
    <div id="probe-cmd-${esc(probe.id)}" class="probe-head" style="margin-bottom:8px;"></div>
    ${fancy
      ? `<div id="probe-out-${esc(probe.id)}" class="ipt-container"></div>`
      : `<pre id="probe-out-${esc(probe.id)}" class="output"><span class="empty">Not yet loaded.</span></pre>`
    }
  `;
  container.appendChild(section);
  section.querySelector(`#run-btn-${probe.id}`).addEventListener('click', () => runProbe(probe.id));
}

async function runProbe(id) {
  const dot = document.getElementById('dot-' + id);
  const out = document.getElementById('probe-out-' + id);
  const cmdEl = document.getElementById('probe-cmd-' + id);
  if (!out) return;
  if (dot) dot.className = 'dot loading';
  out.innerHTML = '<span class="empty" style="padding:12px;display:block">Running…</span>';
  cmdEl.innerHTML = '';

  try {
    const r = await api('/api/probe/' + id);
    probeCache[id] = r;
    if (cmdEl) cmdEl.innerHTML = `<span class="cmd">$ ${esc(r.command)}</span>`;

    if (r.ok && r.output.trim()) {
      if (FANCY_PROBES.has(id) && typeof renderIptablesView === 'function') {
        renderIptablesView(r.output, out);
      } else {
        out.className = 'output';
        out.textContent = r.output;
      }
      if (dot) dot.className = 'dot ok';
    } else {
      const text = r.error || r.output || '(no output)';
      out.className = 'output error';
      out.textContent = text;
      if (dot) dot.className = 'dot err';
    }
  } catch (err) {
    out.className = 'output error';
    out.textContent = String(err);
    if (dot) dot.className = 'dot err';
  }
}

function runAllProbes() {
  if (!session) return;
  for (const p of session.probes) runProbe(p.id);
}

document.getElementById('refresh-all').addEventListener('click', runAllProbes);

/* ── helpers ─────────────────────────────────────────────────────────────── */
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── init ────────────────────────────────────────────────────────────────── */
async function init() {
  session = await api('/api/session');
  const nodes = await api('/api/nodes');

  buildSidebar(session.probes);
  for (const p of session.probes) buildProbePanel(p);

  renderOverview(nodes);
  showPanel('overview');

  // auto-run all probes on load
  runAllProbes();
}

init().catch((err) => {
  document.getElementById('main').innerHTML = `<div style="color:var(--err);padding:24px">
    Failed to connect: ${esc(String(err))}. Make sure the server is running.
  </div>`;
});

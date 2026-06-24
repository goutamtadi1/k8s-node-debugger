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

  const groups = {};
  for (const p of probes) {
    (groups[p.group] = groups[p.group] || []).push(p);
  }

  for (const [grp, items] of Object.entries(groups)) {
    const hdr = document.createElement('div');
    hdr.className = 'nav-group';
    hdr.textContent = grp;
    nav.appendChild(hdr);

    if (grp === 'Health') {
      // All health probes collapsed into a single "Node Health" nav item
      const item = document.createElement('div');
      item.className = 'nav-item';
      item.dataset.panel = 'health';
      item.textContent = 'Node Health';
      item.addEventListener('click', () => {
        showPanel('health');
        const uncached = items.filter(p => !probeCache[p.id]);
        if (uncached.length) uncached.forEach(p => runProbe(p.id));
      });
      nav.appendChild(item);
    } else {
      for (const p of items) nav.appendChild(navItem(p.id, p.label, 'probe'));
    }
  }

  // Connectivity (not a probe group — special panel)
  const connHdr = document.createElement('div');
  connHdr.className = 'nav-group';
  connHdr.textContent = 'Connectivity';
  nav.appendChild(connHdr);
  const connItem = navItem('connectivity', 'Connectivity prober', 'connectivity');
  connItem.querySelector('.dot').style.display = 'none';
  nav.appendChild(connItem);

  // Terminal
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

// Display order for the combined health page
const HEALTH_ORDER = ['cpu-stat', 'mem-info', 'disk-usage', 'mem-pressure', 'oom-kills', 'kubelet-logs'];

// Probes that get a rich custom renderer instead of a plain <pre>.
const FANCY_PROBES = new Set([
  'iptables', 'iptables-nat',
  'conntrack', 'conntrack-stats', 'conntrack-count',
  'mem-info', 'mem-pressure', 'oom-kills', 'kubelet-logs', 'disk-usage', 'cpu-stat',
]);

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

function buildHealthPanel(healthProbes) {
  const container = document.getElementById('probe-panels');
  const section = document.createElement('section');
  section.id = 'probe-health';
  section.className = 'panel';

  // Sort probes into the preferred display order
  const ordered = HEALTH_ORDER
    .map(id => healthProbes.find(p => p.id === id))
    .filter(Boolean)
    .concat(healthProbes.filter(p => !HEALTH_ORDER.includes(p.id)));

  section.innerHTML = `
    <div class="hp-header">
      <h2>Node Health</h2>
      <button id="run-btn-health">↻ Refresh all</button>
    </div>
    <div class="hp-sections">
      ${ordered.map(p => `
        <div class="hp-section" id="hsec-${esc(p.id)}">
          <div class="hp-section-hdr">
            <span class="hp-section-title">${esc(p.label)}</span>
            <span class="hp-section-desc">${esc(p.desc)}</span>
            <div id="probe-cmd-${esc(p.id)}" class="hp-section-cmd"></div>
            <button class="hp-section-rerun" data-probe="${esc(p.id)}" title="Re-run">↻</button>
          </div>
          <div class="hp-section-body">
            <div id="probe-out-${esc(p.id)}" class="ipt-container">
              <span class="empty" style="padding:12px;display:block">Loading…</span>
            </div>
          </div>
        </div>`).join('')}
    </div>`;

  container.appendChild(section);

  section.querySelector('#run-btn-health').addEventListener('click', () => {
    for (const p of ordered) runProbe(p.id);
  });
  section.querySelectorAll('.hp-section-rerun').forEach(btn => {
    btn.addEventListener('click', () => runProbe(btn.dataset.probe));
  });
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
      const rendered = tryFancyRender(id, r.output, out);
      if (!rendered) {
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

/* ── fancy renderer dispatch ─────────────────────────────────────────────── */
function tryFancyRender(id, output, container) {
  const renderers = {
    'iptables':        () => renderIptablesView(output, container),
    'iptables-nat':    () => renderIptablesView(output, container),
    'conntrack':       () => renderConntrackView(output, container),
    'conntrack-stats': () => renderConntrackStats(output, container),
    'conntrack-count': () => renderConntrackCount(output, container),
    'mem-info':        () => renderMemInfoView(output, container),
    'mem-pressure':    () => renderMemPressureView(output, container),
    'oom-kills':       () => renderOomKillsView(output, container),
    'kubelet-logs':    () => renderKubeletLogsView(output, container),
    'disk-usage':      () => renderDiskView(output, container),
    'cpu-stat':        () => renderCpuView(output, container),
  };
  if (!renderers[id]) return false;
  try { renderers[id](); return true; } catch (e) { console.error('[fancy render]', id, e); return false; }
}

function runAllProbes() {
  if (!session) return;
  for (const p of session.probes) runProbe(p.id);
}

document.getElementById('refresh-all').addEventListener('click', runAllProbes);

/* ── connectivity prober ─────────────────────────────────────────────────── */
function initConnectivity() {
  const runBtn   = document.getElementById('conn-run');
  const targetEl = document.getElementById('conn-target');
  const portEl   = document.getElementById('conn-port');
  const protoEl  = document.getElementById('conn-proto');
  const resultsEl= document.getElementById('conn-results');
  if (!runBtn) return;

  async function runConnTest() {
    const target   = targetEl.value.trim();
    const port     = portEl.value.trim();
    const protocol = protoEl.value;
    if (!target) { targetEl.focus(); return; }

    runBtn.disabled = true;
    resultsEl.innerHTML = '<div class="conn-loading">Running tests…</div>';

    try {
      const data = await apiPost('/api/connectivity', { target, port, protocol });
      renderConnResults(data, resultsEl);
    } catch (err) {
      resultsEl.innerHTML = `<div class="conn-error">${esc(String(err))}</div>`;
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', runConnTest);
  targetEl.addEventListener('keydown', e => { if (e.key === 'Enter') runConnTest(); });
}

function renderConnResults(data, container) {
  const { target, port, protocol, results } = data;

  function statusBadge(ok, label) {
    return `<span class="conn-badge ${ok ? 'conn-ok' : 'conn-fail'}">${ok ? '✔' : '✖'} ${esc(label)}</span>`;
  }

  function section(title, ok, output) {
    if (!output && output !== '') return '';
    return `
      <div class="conn-section">
        <div class="conn-sec-title">${statusBadge(ok, title)}</div>
        ${output.trim() ? `<pre class="conn-output">${esc(output.trim())}</pre>` : ''}
      </div>`;
  }

  container.innerHTML = `
    <div class="conn-target-line">Testing: <code>${esc(target)}${port ? ':' + esc(port) : ''}</code> via <b>${esc(protocol.toUpperCase())}</b></div>
    ${section('Ping (ICMP reachability)', results.ping?.ok, results.ping?.output || '')}
    ${results.nc   ? section(`TCP connect :${port}`, results.nc.ok,   results.nc.output   || '') : ''}
    ${results.curl ? section(`HTTP ${results.curl.url}`, results.curl.ok, results.curl.output || '') : ''}
    ${section('DNS resolution', results.dns?.ok, results.dns?.output || '')}
    ${section('Traceroute', results.traceroute?.ok, results.traceroute?.output || '')}
    ${results.conntrack?.output?.trim()
      ? `<div class="conn-section"><div class="conn-sec-title"><span class="conn-badge conn-info">⬡ Matching conntrack entries</span></div><pre class="conn-output">${esc(results.conntrack.output.trim())}</pre></div>`
      : '<div class="conn-section conn-no-ct">No matching conntrack entries — connection may not have been attempted or was rejected before tracking.</div>'}
  `;
}

/* ── snapshot export ─────────────────────────────────────────────────────── */
function downloadSnapshot() {
  const snap = {
    exported_at: new Date().toISOString(),
    session: {
      node:      session?.node,
      pod:       session?.podName,
      namespace: session?.namespace,
      context:   session?.context,
      image:     session?.image,
    },
    probes: Object.fromEntries(
      Object.entries(probeCache).map(([id, r]) => [id, {
        id, label: r.label, command: r.command,
        ok: r.ok, output: r.output, error: r.error,
      }])
    ),
  };

  const node = session?.node?.replace(/[^a-z0-9-]/gi, '-') || 'node';
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `node-debug-${node}-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── helpers ─────────────────────────────────────────────────────────────── */
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

  const healthProbes = session.probes.filter(p => p.group === 'Health');
  const otherProbes  = session.probes.filter(p => p.group !== 'Health');

  buildSidebar(session.probes);
  for (const p of otherProbes) buildProbePanel(p);
  buildHealthPanel(healthProbes);

  renderOverview(nodes);
  showPanel('overview');

  initConnectivity();
  document.getElementById('snapshot-btn')?.addEventListener('click', downloadSnapshot);

  // auto-run all probes on load
  runAllProbes();
}

init().catch((err) => {
  document.getElementById('main').innerHTML = `<div style="color:var(--err);padding:24px">
    Failed to connect: ${esc(String(err))}. Make sure the server is running.
  </div>`;
});

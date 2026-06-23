'use strict';

/* ══════════════════════════════════════════════════════════════════════════
 * k8s-node-debugger — rich iptables renderer
 * Parses iptables-save output and renders it as an interactive table UI.
 * Exposed as window.renderIptablesView(raw, containerEl).
 * ══════════════════════════════════════════════════════════════════════════ */
(function () {

/* ── Port → human name ───────────────────────────────────────────────── */
const PORT_NAMES = {
  20:'FTP-data', 21:'FTP', 22:'SSH', 23:'Telnet', 25:'SMTP',
  53:'DNS', 67:'DHCP', 68:'DHCP', 80:'HTTP', 110:'POP3',
  111:'RPC', 123:'NTP', 143:'IMAP', 161:'SNMP', 162:'SNMP-trap',
  179:'BGP', 389:'LDAP', 443:'HTTPS', 465:'SMTPS', 514:'Syslog',
  587:'SMTP/TLS', 636:'LDAPS', 853:'DNS-TLS', 993:'IMAPS', 995:'POP3S',
  1194:'OpenVPN', 1883:'MQTT', 2379:'etcd', 2380:'etcd-peer',
  3000:'Grafana', 3306:'MySQL', 4789:'VXLAN/Flannel', 5432:'Postgres',
  5601:'Kibana', 5671:'AMQP-TLS', 5672:'AMQP', 6379:'Redis',
  6443:'k8s-API', 7472:'MetalLB-BGP', 7946:'MetalLB-member',
  8080:'HTTP-alt', 8443:'HTTPS-alt', 8472:'VXLAN/Flannel',
  9090:'Prometheus', 9091:'Pushgateway', 9093:'Alertmanager',
  9100:'node-exporter', 9200:'Elasticsearch', 9300:'ES-cluster',
  10248:'kubelet-healthz', 10249:'kube-proxy-metrics',
  10250:'kubelet', 10251:'kube-scheduler-insecure',
  10252:'kube-ctrl-mgr-insecure', 10255:'kubelet-readonly',
  10256:'kube-proxy', 10257:'kube-ctrl-mgr', 10259:'kube-scheduler',
};

const NODEPORT_MIN = 30000, NODEPORT_MAX = 32767;

function portLabel(p) {
  if (!p) return null;
  if (p.includes(':')) {
    const [a, b] = p.split(':').map(Number);
    if (a >= NODEPORT_MIN && b <= NODEPORT_MAX) return `${p} (NodePort range)`;
    const aName = PORT_NAMES[a], bName = PORT_NAMES[b];
    return aName ? `${p} (${aName}…)` : p;
  }
  const n = parseInt(p);
  return PORT_NAMES[n] ? `${p} (${PORT_NAMES[n]})` : p;
}

function humanBytes(b) {
  if (!b) return null;
  const u = ['B','KB','MB','GB','TB'];
  const i = b > 0 ? Math.min(Math.floor(Math.log(b) / Math.log(1024)), 4) : 0;
  return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
}

/* ── HTML escape ─────────────────────────────────────────────────────── */
function h(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════════════════════════════════
 * PARSER — iptables-save format
 * ══════════════════════════════════════════════════════════════════════ */

function parseIptablesSave(raw) {
  const tables = {};
  let cur = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === 'COMMIT' || line.startsWith('#')) continue;

    if (line[0] === '*') {
      cur = line.slice(1).trim();
      if (!tables[cur]) tables[cur] = { name: cur, chains: {}, order: [] };
    } else if (line[0] === ':' && cur) {
      const m = line.match(/^:(\S+)\s+(\S+)(?:\s+\[(\d+):(\d+)\])?/);
      if (!m) continue;
      const [, name, policy, pkts = '0', bytes = '0'] = m;
      tables[cur].chains[name] = {
        name, policy,
        packets: +pkts, bytes: +bytes,
        rules: [], builtin: true,
      };
      tables[cur].order.push(name);
    } else if (line.startsWith('-A') && cur) {
      const m = line.match(/^-A\s+(\S+)\s*(.*)/);
      if (!m) continue;
      const [, chain, rest] = m;
      if (!tables[cur].chains[chain]) {
        tables[cur].chains[chain] = {
          name: chain, policy: '-',
          packets: 0, bytes: 0,
          rules: [], builtin: false,
        };
        tables[cur].order.push(chain);
      }
      tables[cur].chains[chain].rules.push(parseRule(rest, line));
    }
  }
  return tables;
}

function parseRule(flags, raw) {
  const rule = {
    raw, target: null, protocol: null,
    src: null, dst: null, inIface: null, outIface: null,
    dstPort: null, srcPort: null, state: null, comment: null,
    natDest: null, natSrc: null, natPort: null,
    mark: null, icmpType: null,
    neg: {},      // which fields are negated
    extra: [],
  };

  // Tokenise, respecting quotes
  const tokens = [];
  let tok = '', inQ = false;
  for (const ch of flags + ' ') {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ' ' && !inQ) { if (tok) { tokens.push(tok); tok = ''; } }
    else tok += ch;
  }

  let neg = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '!') { neg = true; continue; }
    const n = neg; neg = false;

    switch (t) {
      case '-j': case '-g': rule.target = tokens[++i]; break;
      case '-p':  rule.protocol = tokens[++i]; if (n) rule.neg.protocol = true; break;
      case '-s':  rule.src = tokens[++i];      if (n) rule.neg.src = true; break;
      case '-d':  rule.dst = tokens[++i];      if (n) rule.neg.dst = true; break;
      case '-i':  rule.inIface = tokens[++i];  if (n) rule.neg.inIface = true; break;
      case '-o':  rule.outIface = tokens[++i]; if (n) rule.neg.outIface = true; break;
      case '--dport': case '--destination-port': rule.dstPort = tokens[++i]; break;
      case '--sport': case '--source-port':       rule.srcPort = tokens[++i]; break;
      case '--state': case '--ctstate':           rule.state = tokens[++i]; break;
      case '--comment':       rule.comment = tokens[++i]; break;
      case '--to-destination': rule.natDest = tokens[++i]; break;
      case '--to-source':      rule.natSrc  = tokens[++i]; break;
      case '--to-ports':       rule.natPort = tokens[++i]; break;
      case '--set-xmark': case '--set-mark': rule.mark = tokens[++i]; break;
      case '--icmp-type': rule.icmpType = tokens[++i]; break;
      // skip known noise
      case '-m': i++; break;
      case '--tcp-flags':    i += 2; break;
      case '--uid-owner': case '--gid-owner':
      case '--physdev-in': case '--physdev-out':
      case '--match-set': i++; break;
      default: rule.extra.push(t);
    }
  }
  return rule;
}

/* ══════════════════════════════════════════════════════════════════════
 * HUMAN DESCRIPTION
 * ══════════════════════════════════════════════════════════════════════ */

const STATE_LABELS = {
  ESTABLISHED: 'established', RELATED: 'related',
  NEW: 'new', INVALID: 'invalid', UNTRACKED: 'untracked',
};

function ruleDesc(rule) {
  const parts = [], tags = [];

  if (rule.state) {
    const s = rule.state.split(',').map(x => STATE_LABELS[x] || x.toLowerCase()).join('/');
    parts.push(s + ' connections');
    tags.push({ text: 'state:' + rule.state, kind: 'state' });
  }
  if (rule.inIface) {
    parts.push('in ' + (rule.neg.inIface ? '≠ ' : '') + rule.inIface);
    tags.push({ text: 'in:' + rule.inIface, kind: 'iface' });
  }
  if (rule.outIface) {
    parts.push('out ' + (rule.neg.outIface ? '≠ ' : '') + rule.outIface);
    tags.push({ text: 'out:' + rule.outIface, kind: 'iface' });
  }
  const anyIP = v => !v || v === '0.0.0.0/0' || v === '::/0';
  if (!anyIP(rule.src)) {
    parts.push('from ' + (rule.neg.src ? '≠ ' : '') + rule.src);
    tags.push({ text: 'src:' + rule.src, kind: 'addr' });
  }
  if (!anyIP(rule.dst)) {
    parts.push('to ' + (rule.neg.dst ? '≠ ' : '') + rule.dst);
    tags.push({ text: 'dst:' + rule.dst, kind: 'addr' });
  }
  if (rule.dstPort) {
    parts.push('port ' + portLabel(rule.dstPort));
    tags.push({ text: 'dport:' + rule.dstPort, kind: 'port' });
  }
  if (rule.srcPort) {
    parts.push('src-port ' + portLabel(rule.srcPort));
  }
  if (rule.protocol && rule.protocol !== 'all') {
    tags.push({ text: rule.protocol.toUpperCase(), kind: 'proto' });
  }
  if (rule.icmpType) {
    parts.push('ICMP type ' + rule.icmpType);
  }
  if (rule.natDest) parts.push('→ ' + rule.natDest);
  if (rule.natSrc)  parts.push('src-nat → ' + rule.natSrc);
  if (rule.natPort) parts.push('redirect-port → ' + rule.natPort);
  if (rule.mark)    parts.push('mark ' + rule.mark);
  if (rule.comment) tags.push({ text: rule.comment, kind: 'comment' });

  return {
    summary: parts.length ? parts.join(' · ') : 'all traffic',
    tags,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * TARGET STYLING
 * ══════════════════════════════════════════════════════════════════════ */

function targetKind(target) {
  const t = (target || '').toUpperCase();
  if (t === 'ACCEPT')     return 'accept';
  if (t === 'DROP')       return 'drop';
  if (t === 'REJECT')     return 'reject';
  if (t === 'LOG')        return 'log';
  if (t === 'MASQUERADE') return 'masq';
  if (t === 'DNAT' || t === 'SNAT') return 'nat';
  if (t === 'REDIRECT')   return 'redirect';
  if (t === 'RETURN')     return 'return';
  if (t === 'MARK' || t === 'CONNMARK') return 'mark';
  if (t.startsWith('KUBE-') || t.startsWith('kube-')) return 'k8s';
  if (t.startsWith('DOCKER')) return 'docker';
  return 'jump'; // user-defined chain jump
}

const TARGET_TOOLTIP = {
  accept:   'Allow the packet through.',
  drop:     'Silently discard the packet. Sender gets no response.',
  reject:   'Discard and send an error reply (ICMP or TCP RST) to the sender.',
  log:      'Write a log entry for the packet, then continue to next rule.',
  masq:     'Source-NAT the packet to the outgoing interface IP (used for pods reaching the internet).',
  nat:      'Rewrite the packet destination (DNAT) or source (SNAT) address.',
  redirect: 'Redirect the packet to a local port.',
  return:   'Stop traversing this chain; return to the calling chain.',
  mark:     'Set a netfilter mark on the packet (used for routing policy or later rules).',
  k8s:      'Jump to a Kubernetes-managed chain (kube-proxy or CNI).',
  docker:   'Jump to a Docker-managed chain.',
  jump:     'Jump to a user-defined chain for further processing.',
};

/* ══════════════════════════════════════════════════════════════════════
 * CHAIN CATEGORISATION
 * ══════════════════════════════════════════════════════════════════════ */

// Chains that are "noisy" k8s detail chains — collapsed by default
function isDetailChain(name) {
  return /^KUBE-(SVC|SEP|FW|XLB)-/.test(name);
}

function chainBadges(name) {
  const badges = [];
  if (name.startsWith('KUBE-')) badges.push({ text: 'k8s', cls: 'badge-k8s' });
  else if (name.startsWith('DOCKER')) badges.push({ text: 'docker', cls: 'badge-docker' });
  return badges;
}

/* ══════════════════════════════════════════════════════════════════════
 * RENDERER
 * ══════════════════════════════════════════════════════════════════════ */

function renderIptablesView(raw, container) {
  let tables;
  try { tables = parseIptablesSave(raw); }
  catch (e) {
    container.textContent = raw;
    return;
  }

  const tableNames = Object.keys(tables);
  if (!tableNames.length) {
    container.innerHTML = '<div class="ipt-empty">No iptables data found.</div>';
    return;
  }

  // Total stats
  let totalChains = 0, totalRules = 0;
  for (const t of Object.values(tables)) {
    for (const c of Object.values(t.chains)) {
      totalChains++;
      totalRules += c.rules.length;
    }
  }

  // Root element
  const wrap = document.createElement('div');
  wrap.className = 'ipt-wrap';

  // ── Top bar ────────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'ipt-bar';
  bar.innerHTML = `
    <span class="ipt-stats">
      <span class="ipt-stat"><b>${tableNames.length}</b> table${tableNames.length !== 1 ? 's' : ''}</span>
      <span class="ipt-sep">·</span>
      <span class="ipt-stat"><b>${totalChains}</b> chain${totalChains !== 1 ? 's' : ''}</span>
      <span class="ipt-sep">·</span>
      <span class="ipt-stat"><b>${totalRules}</b> rule${totalRules !== 1 ? 's' : ''}</span>
    </span>
    <input class="ipt-search" placeholder="🔍  filter rules, IPs, ports…" type="text" />
    <div class="ipt-bar-actions">
      <button class="ipt-btn ipt-collapse-k8s" title="Toggle KUBE-SVC-* / KUBE-SEP-* chains">K8s chains ▼</button>
      <button class="ipt-btn ipt-raw-toggle">Raw</button>
    </div>
  `;
  wrap.appendChild(bar);

  // Raw pre (hidden by default)
  const rawPre = document.createElement('pre');
  rawPre.className = 'output ipt-raw-view';
  rawPre.style.display = 'none';
  rawPre.textContent = raw;
  wrap.appendChild(rawPre);

  // ── Table tabs ────────────────────────────────────────────────────
  const tabs = document.createElement('div');
  tabs.className = 'ipt-tabs';
  wrap.appendChild(tabs);

  // ── Table body ────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'ipt-body';
  wrap.appendChild(body);

  // ── Legend ────────────────────────────────────────────────────────
  const legend = document.createElement('div');
  legend.className = 'ipt-legend';
  legend.innerHTML = [
    ['accept','ACCEPT'],['drop','DROP'],['reject','REJECT'],
    ['log','LOG'],['masq','MASQUERADE'],['nat','DNAT/SNAT'],
    ['redirect','REDIRECT'],['return','RETURN'],['mark','MARK'],
    ['k8s','→ k8s chain'],['jump','→ user chain'],
  ].map(([k,l]) => `<span class="ipt-target ipt-target-${k}">${l}</span>`).join('');
  wrap.appendChild(legend);

  // Render a table into body
  let activeTable = tableNames[0];
  function showTable(name) {
    activeTable = name;
    tabs.querySelectorAll('.ipt-tab').forEach(t => t.classList.toggle('active', t.dataset.t === name));
    body.innerHTML = '';
    renderTable(tables[name], body);
    // Re-apply search filter
    applyFilter(bar.querySelector('.ipt-search').value);
  }

  for (const name of tableNames) {
    const t = tables[name];
    const rCount = Object.values(t.chains).reduce((s, c) => s + c.rules.length, 0);
    const tab = document.createElement('button');
    tab.className = 'ipt-tab' + (name === activeTable ? ' active' : '');
    tab.dataset.t = name;
    tab.innerHTML = `${h(name)} <small>${rCount}</small>`;
    tab.title = `${Object.keys(t.chains).length} chains, ${rCount} rules`;
    tab.addEventListener('click', () => showTable(name));
    tabs.appendChild(tab);
  }
  showTable(activeTable);

  // ── Search ────────────────────────────────────────────────────────
  function applyFilter(q) {
    const ql = (q || '').toLowerCase();
    body.querySelectorAll('.ipt-rule').forEach(row => {
      row.style.display = (!ql || (row.dataset.s || '').includes(ql)) ? '' : 'none';
    });
    body.querySelectorAll('.ipt-chain').forEach(chain => {
      if (!ql) { chain.style.display = ''; return; }
      const vis = chain.querySelectorAll('.ipt-rule:not([style*="none"])').length;
      chain.style.display = vis > 0 ? '' : 'none';
    });
  }
  bar.querySelector('.ipt-search').addEventListener('input', e => applyFilter(e.target.value));

  // ── Toggle raw ────────────────────────────────────────────────────
  bar.querySelector('.ipt-raw-toggle').addEventListener('click', e => {
    const show = rawPre.style.display !== 'none';
    rawPre.style.display = show ? 'none' : 'block';
    tabs.style.display  = show ? '' : 'none';
    body.style.display  = show ? '' : 'none';
    legend.style.display = show ? '' : 'none';
    e.target.textContent = show ? 'Raw' : 'Fancy';
  });

  // ── Collapse/expand k8s detail chains ────────────────────────────
  let k8sExpanded = false;
  bar.querySelector('.ipt-collapse-k8s').addEventListener('click', e => {
    k8sExpanded = !k8sExpanded;
    body.querySelectorAll('.ipt-chain[data-detail]').forEach(c => {
      c.classList.toggle('collapsed', !k8sExpanded);
      c.querySelector('.ipt-chain-chevron').textContent = k8sExpanded ? '▼' : '▶';
    });
    e.target.textContent = `K8s chains ${k8sExpanded ? '▲' : '▼'}`;
  });

  container.innerHTML = '';
  container.className = '';   // remove "output" class — we own the layout now
  container.appendChild(wrap);
}

/* ── Chain renderer ────────────────────────────────────────────────── */
function renderTable(table, container) {
  for (const name of table.order) {
    const chain = table.chains[name];
    const detail = isDetailChain(name);
    const collapsed = detail;

    const el = document.createElement('div');
    el.className = 'ipt-chain' + (collapsed ? ' collapsed' : '');
    if (detail) el.dataset.detail = '1';

    const badges = chainBadges(name);
    const policyClass = chain.policy === 'ACCEPT' ? 'accept' : chain.policy === 'DROP' ? 'drop' : 'other';
    const counters = chain.bytes > 0
      ? `<span class="ipt-chain-counter">${humanBytes(chain.bytes)} · ${chain.packets.toLocaleString()} pkts</span>`
      : '';

    const hdr = document.createElement('div');
    hdr.className = 'ipt-chain-hdr';
    hdr.innerHTML = `
      <span class="ipt-chain-chevron">${collapsed ? '▶' : '▼'}</span>
      <span class="ipt-chain-name">${h(name)}</span>
      ${badges.map(b => `<span class="ipt-badge ${b.cls}">${b.text}</span>`).join('')}
      ${chain.policy !== '-' ? `<span class="ipt-policy ipt-policy-${policyClass}" title="Default policy">policy: ${h(chain.policy)}</span>` : ''}
      <span class="ipt-chain-rcount">${chain.rules.length} rule${chain.rules.length !== 1 ? 's' : ''}</span>
      ${counters}
    `;
    hdr.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      hdr.querySelector('.ipt-chain-chevron').textContent = el.classList.contains('collapsed') ? '▶' : '▼';
    });
    el.appendChild(hdr);

    // Rules container (hidden when collapsed via CSS)
    const rulesWrap = document.createElement('div');
    rulesWrap.className = 'ipt-chain-body';

    if (!chain.rules.length) {
      rulesWrap.innerHTML = `<div class="ipt-no-rules">No rules — ${chain.policy !== '-' ? 'default <b>' + chain.policy + '</b> policy applies' : 'empty chain'}.</div>`;
    } else {
      const tbl = document.createElement('table');
      tbl.className = 'ipt-rules';
      tbl.innerHTML = `<thead><tr>
        <th class="col-num">#</th>
        <th class="col-target">Target</th>
        <th class="col-desc">Match &amp; Action</th>
        <th class="col-proto">Proto</th>
        <th class="col-addr">Source</th>
        <th class="col-addr">Destination</th>
      </tr></thead>`;
      const tbody = document.createElement('tbody');

      chain.rules.forEach((rule, i) => {
        const kind = targetKind(rule.target);
        const desc = ruleDesc(rule);
        const tooltip = TARGET_TOOLTIP[kind] || '';
        const proto = rule.protocol && rule.protocol !== 'all'
          ? `<span class="ipt-proto ipt-proto-${rule.protocol}">${h(rule.protocol.toUpperCase())}</span>`
          : '<span class="dim">—</span>';

        const anyIP = v => !v || v === '0.0.0.0/0' || v === '::/0';
        const srcCell = anyIP(rule.src)
          ? '<span class="dim">any</span>'
          : `<code>${h((rule.neg.src ? '≠ ' : '') + rule.src)}</code>`;
        const dstCell = anyIP(rule.dst)
          ? '<span class="dim">any</span>'
          : `<code>${h((rule.neg.dst ? '≠ ' : '') + rule.dst)}</code>`;

        const tagHtml = desc.tags.map(tag =>
          `<span class="ipt-tag ipt-tag-${tag.kind}">${h(tag.text)}</span>`
        ).join('');

        const tr = document.createElement('tr');
        tr.className = 'ipt-rule';
        // Searchable text: everything useful
        tr.dataset.s = [
          rule.raw, rule.target, rule.protocol, rule.src, rule.dst,
          rule.dstPort, rule.srcPort, rule.state, rule.comment,
          rule.inIface, rule.outIface, rule.natDest, rule.natSrc,
        ].filter(Boolean).join(' ').toLowerCase();

        tr.innerHTML = `
          <td class="col-num ipt-rule-num">${i + 1}</td>
          <td class="col-target">
            <span class="ipt-target ipt-target-${kind}" title="${h(tooltip)}">${h(rule.target || '?')}</span>
          </td>
          <td class="col-desc">
            <div class="ipt-rule-summary">${h(desc.summary)}</div>
            <div class="ipt-rule-tags">${tagHtml}</div>
            <div class="ipt-rule-raw">${h(rule.raw)}</div>
          </td>
          <td class="col-proto">${proto}</td>
          <td class="col-addr">${srcCell}</td>
          <td class="col-addr">${dstCell}</td>
        `;

        // Click → toggle raw rule
        tr.addEventListener('click', () => {
          const raw = tr.querySelector('.ipt-rule-raw');
          raw.classList.toggle('visible');
        });
        tbody.appendChild(tr);
      });

      tbl.appendChild(tbody);
      rulesWrap.appendChild(tbl);
    }

    el.appendChild(rulesWrap);
    container.appendChild(el);
  }
}

/* ── Export ──────────────────────────────────────────────────────── */
window.renderIptablesView = renderIptablesView;

})(); // end IIFE

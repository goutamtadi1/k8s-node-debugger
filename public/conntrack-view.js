'use strict';

/* ══════════════════════════════════════════════════════════════════════════
 * k8s-node-debugger — conntrack rich renderer
 * Handles three probe outputs:
 *   renderConntrackView(raw, el)   — conntrack -L (connection table)
 *   renderConntrackStats(raw, el)  — conntrack -S (per-CPU stats)
 *   renderConntrackCount(raw, el)  — nf_conntrack_count / max gauge
 * ══════════════════════════════════════════════════════════════════════════ */
(function () {

  /* ── micro helpers ──────────────────────────────────────────────────── */
  function h(s)  { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function N(n)  { return Number(n).toLocaleString(); }
  function pct(a, total) { return total ? Math.round(a / total * 100) : 0; }

  function hBytes(b) {
    if (!b || b < 1) return null;
    const u = ['B','KB','MB','GB'];
    const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
    return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
  }

  const PNAMES = {
    22:'SSH',25:'SMTP',53:'DNS',67:'DHCP',80:'HTTP',110:'POP3',
    123:'NTP',143:'IMAP',443:'HTTPS',465:'SMTPS',587:'SMTP/TLS',
    636:'LDAPS',853:'DNS/TLS',993:'IMAPS',995:'POP3S',
    2379:'etcd',2380:'etcd-peer',3000:'Grafana',3306:'MySQL',
    4789:'VXLAN',5432:'PgSQL',6379:'Redis',6443:'k8s-API',
    8080:'HTTP-alt',8443:'HTTPS-alt',9090:'Prometheus',
    9200:'ES',10250:'kubelet',10256:'kube-proxy',10257:'ctrl-mgr',10259:'scheduler',
  };
  function pLabel(p) { return PNAMES[p] ? `${p} (${PNAMES[p]})` : String(p ?? ''); }

  /* ── TCP state catalogue ────────────────────────────────────────────── */
  const TCP_STATE_SET = new Set([
    'ESTABLISHED','SYN_SENT','SYN_SENT2','SYN_RECV',
    'FIN_WAIT','TIME_WAIT','CLOSE','CLOSE_WAIT','LAST_ACK','LISTEN','NONE',
  ]);

  const STATE_KIND = {
    ESTABLISHED:'est', TIME_WAIT:'tw', SYN_SENT:'syn', SYN_SENT2:'syn',
    SYN_RECV:'syn', FIN_WAIT:'fin', CLOSE_WAIT:'cw',
    LAST_ACK:'close', CLOSE:'close', LISTEN:'listen', NONE:'none',
  };

  const STATE_DISPLAY = {
    ESTABLISHED:'ESTABLISHED', TIME_WAIT:'TIME_WAIT', SYN_SENT:'SYN_SENT',
    SYN_SENT2:'SYN_SENT2', SYN_RECV:'SYN_RECV', FIN_WAIT:'FIN_WAIT',
    CLOSE_WAIT:'CLOSE_WAIT', LAST_ACK:'LAST_ACK', CLOSE:'CLOSE',
    LISTEN:'LISTEN', NONE:'NONE',
  };

  /* ══════════════════════════════════════════════════════════════════════
   * Parser — handles conntrack -L and /proc/net/nf_conntrack
   * ══════════════════════════════════════════════════════════════════════ */
  function parseConntrackOutput(raw) {
    const entries = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const e = parseCTLine(t);
      if (e) entries.push(e);
    }
    return entries;
  }

  function parseCTLine(line) {
    // Strip "ipv4  2 " or "ipv6  10 " prefix from /proc/net/nf_conntrack
    let rest = line.replace(/^ip(?:v4|v6)\s+\d+\s+/, '');

    const parts = rest.split(/\s+/);
    if (parts.length < 3) return null;

    let i = 0;
    const proto = parts[i++].toLowerCase();
    if (!proto || /^\d/.test(proto)) return null;

    const protoNum = +parts[i++];
    if (isNaN(protoNum)) return null;

    // TTL
    let ttl = null;
    if (i < parts.length && /^\d+$/.test(parts[i])) ttl = +parts[i++];

    // TCP state (optional)
    let state = null;
    if (i < parts.length && TCP_STATE_SET.has(parts[i])) state = parts[i++];

    const e = {
      proto, protoNum, ttl, state,
      orig: {}, reply: {},
      assured: false, unreplied: false,
      mark: null,
      origBytes: null, origPkts: null,
      replyBytes: null, replyPkts: null,
    };

    // Counters to disambiguate first vs second occurrence of src/dst/sport/dport
    const nc = { src:0, dst:0, sport:0, dport:0, bytes:0, packets:0, type:0, code:0, id:0 };

    for (; i < parts.length; i++) {
      const p = parts[i];
      if (p === '[ASSURED]')   { e.assured   = true; continue; }
      if (p === '[UNREPLIED]') { e.unreplied = true; continue; }
      if (p.startsWith('['))   continue;

      const eq = p.indexOf('=');
      if (eq < 0) continue;
      const k = p.slice(0, eq), v = p.slice(eq + 1);

      switch (k) {
        case 'src':    nc.src++   === 0 ? (e.orig.src    = v)  : (e.reply.src    = v);  break;
        case 'dst':    nc.dst++   === 0 ? (e.orig.dst    = v)  : (e.reply.dst    = v);  break;
        case 'sport':  nc.sport++ === 0 ? (e.orig.sport  = +v) : (e.reply.sport  = +v); break;
        case 'dport':  nc.dport++ === 0 ? (e.orig.dport  = +v) : (e.reply.dport  = +v); break;
        case 'bytes':  nc.bytes++ === 0 ? (e.origBytes   = +v) : (e.replyBytes   = +v); break;
        case 'packets':nc.packets++===0 ? (e.origPkts    = +v) : (e.replyPkts    = +v); break;
        case 'type':   nc.type++  === 0 ? (e.orig.type   = +v) : (e.reply.type   = +v); break;
        case 'code':   nc.code++  === 0 ? (e.orig.code   = +v) : (e.reply.code   = +v); break;
        case 'id':     nc.id++    === 0 ? (e.orig.id     = +v) : (e.reply.id     = +v); break;
        case 'mark':   e.mark = +v; break;
      }
    }
    return e;
  }

  /* ── Aggregate statistics ───────────────────────────────────────────── */
  function computeStats(entries) {
    const byProto = {}, byState = {}, byDport = {}, bySrcIP = {};
    let totalBytes = 0, totalPkts = 0, hasBytes = false;

    for (const e of entries) {
      byProto[e.proto] = (byProto[e.proto] || 0) + 1;
      if (e.state) byState[e.state] = (byState[e.state] || 0) + 1;
      if (e.orig.dport) byDport[e.orig.dport] = (byDport[e.orig.dport] || 0) + 1;
      if (e.orig.src)   bySrcIP[e.orig.src]   = (bySrcIP[e.orig.src]  || 0) + 1;
      if (e.origBytes)  { totalBytes += e.origBytes + (e.replyBytes || 0); hasBytes = true; }
      if (e.origPkts)   { totalPkts  += e.origPkts  + (e.replyPkts  || 0); }
    }

    return {
      total: entries.length, byProto, byState, byDport, bySrcIP,
      totalBytes, totalPkts, hasBytes,
      tcpEstab:    byState['ESTABLISHED'] || 0,
      tcpTimeWait: byState['TIME_WAIT']   || 0,
      udp:   byProto['udp']  || 0,
      tcp:   byProto['tcp']  || 0,
      icmp:  (byProto['icmp'] || 0) + (byProto['icmpv6'] || 0),
      topSrcIPs: sortTop(bySrcIP, 8),
      topDports:  sortTop(byDport, 8),
    };
  }

  function sortTop(obj, n) {
    return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Sub-renderers
   * ══════════════════════════════════════════════════════════════════════ */

  function renderStatCards(s) {
    const other = s.total - s.tcp - s.udp - s.icmp;
    const cards = [
      { label: 'Total connections', value: N(s.total), cls: 'ct-card-total' },
      { label: 'TCP ESTABLISHED',   value: N(s.tcpEstab),    cls: 'ct-card-estab' },
      { label: 'TCP TIME_WAIT',     value: N(s.tcpTimeWait), cls: 'ct-card-tw' },
      { label: 'UDP',               value: N(s.udp),         cls: 'ct-card-udp' },
      { label: 'ICMP',              value: N(s.icmp),        cls: 'ct-card-icmp' },
    ];
    if (other > 0) cards.push({ label: 'Other', value: N(other), cls: 'ct-card-other' });
    if (s.hasBytes) cards.push({ label: 'Total bytes', value: hBytes(s.totalBytes) || '0 B', cls: 'ct-card-bytes' });

    const div = document.createElement('div');
    div.className = 'ct-cards';
    div.innerHTML = cards.map(c => `
      <div class="ct-card ${c.cls}">
        <div class="ct-card-val">${h(c.value)}</div>
        <div class="ct-card-lbl">${h(c.label)}</div>
      </div>
    `).join('');
    return div;
  }

  function renderDistBars(s) {
    const div = document.createElement('div');
    div.className = 'ct-dist';

    // Protocol bar
    const protoSegs = Object.entries(s.byProto)
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => ({ label: p.toUpperCase(), n, pct: pct(n, s.total), cls: `ct-seg-${p}` }));

    // TCP state bar (only if there are TCP connections)
    const stateSegs = Object.entries(s.byState)
      .sort((a, b) => b[1] - a[1])
      .map(([st, n]) => ({ label: st.replace('_',' '), n, pct: pct(n, s.tcp), cls: `ct-seg-state-${STATE_KIND[st] || 'none'}` }));

    div.innerHTML = `
      <div class="ct-dist-row">
        <span class="ct-dist-label">Protocol</span>
        <div class="ct-segbar">
          ${protoSegs.map(sg => `
            <div class="ct-seg ${sg.cls}" style="width:${sg.pct}%" title="${sg.label}: ${N(sg.n)} (${sg.pct}%)">
            </div>`).join('')}
        </div>
        <div class="ct-seglegend">
          ${protoSegs.map(sg =>
            `<span class="ct-segleg"><span class="ct-segdot ${sg.cls}"></span>${h(sg.label)} <b>${N(sg.n)}</b> <em>${sg.pct}%</em></span>`
          ).join('')}
        </div>
      </div>
      ${s.tcp > 0 ? `
      <div class="ct-dist-row">
        <span class="ct-dist-label">TCP state</span>
        <div class="ct-segbar">
          ${stateSegs.map(sg => `
            <div class="ct-seg ${sg.cls}" style="width:${sg.pct}%" title="${sg.label}: ${N(sg.n)} (${sg.pct}% of TCP)">
            </div>`).join('')}
        </div>
        <div class="ct-seglegend">
          ${stateSegs.map(sg =>
            `<span class="ct-segleg"><span class="ct-segdot ${sg.cls}"></span>${h(sg.label)} <b>${N(sg.n)}</b></span>`
          ).join('')}
        </div>
      </div>` : ''}
    `;
    return div;
  }

  function renderTopTables(s) {
    const wrap = document.createElement('div');
    wrap.className = 'ct-tops';

    const ipRows = s.topSrcIPs.map(([ip, n]) =>
      `<tr><td><code>${h(ip)}</code></td><td class="ct-top-n">${N(n)}</td></tr>`
    ).join('');

    const portRows = s.topDports.map(([port, n]) =>
      `<tr><td><code>${h(pLabel(+port))}</code></td><td class="ct-top-n">${N(n)}</td></tr>`
    ).join('');

    wrap.innerHTML = `
      <div class="ct-top-box">
        <div class="ct-top-title">Top source IPs</div>
        <table class="ct-mini-table"><tbody>${ipRows || '<tr><td class="ct-empty">—</td></tr>'}</tbody></table>
      </div>
      <div class="ct-top-box">
        <div class="ct-top-title">Top destination ports</div>
        <table class="ct-mini-table"><tbody>${portRows || '<tr><td class="ct-empty">—</td></tr>'}</tbody></table>
      </div>
    `;
    return wrap;
  }

  /* ── Connection table (paginated) ───────────────────────────────────── */
  const PAGE = 200;

  function buildConnRow(e) {
    const stateKind  = e.state ? (STATE_KIND[e.state] || 'none') : '';
    const stateBadge = e.state
      ? `<span class="ct-state ct-state-${stateKind}">${h(STATE_DISPLAY[e.state] || e.state)}</span>`
      : '';

    const flagBadge = e.assured
      ? '<span class="ct-flag ct-flag-assured" title="ASSURED: connection seen in both directions">✔</span>'
      : e.unreplied
        ? '<span class="ct-flag ct-flag-unr" title="UNREPLIED: only seen in one direction">⚡</span>'
        : '';

    const protoBadge = `<span class="ct-proto ct-proto-${e.proto}">${h(e.proto.toUpperCase())}</span>`;

    // Original direction
    let origCell = '';
    if (e.proto === 'icmp' || e.proto === 'icmpv6') {
      origCell = `<code>${h(e.orig.src)}</code> → <code>${h(e.orig.dst)}</code>`
               + (e.orig.type != null ? ` <small>type ${e.orig.type} code ${e.orig.code ?? 0}</small>` : '');
    } else if (e.orig.src) {
      const dportLabel = e.orig.dport ? pLabel(e.orig.dport) : '';
      origCell = `<code>${h(e.orig.src)}:${e.orig.sport ?? '?'}</code>`
               + ` <span class="ct-arrow">→</span> `
               + `<code>${h(e.orig.dst)}:${e.orig.dport ?? '?'}</code>`
               + (PNAMES[e.orig.dport] ? ` <small class="ct-svc">${h(PNAMES[e.orig.dport])}</small>` : '');
    } else {
      origCell = '<span class="ct-empty">—</span>';
    }

    // Reply direction (only show if src differs from expected — indicates NAT)
    let natTag = '';
    if (e.reply.src && e.reply.src !== e.orig.dst) {
      natTag = `<span class="ct-nat" title="NAT: reply src differs from original dst">NAT↔${h(e.reply.src)}</span>`;
    }

    const ttlCell = e.ttl != null ? `<span class="ct-ttl" title="TTL (seconds)">${N(e.ttl)}s</span>` : '—';

    const bytesCell = e.origBytes != null
      ? `${hBytes(e.origBytes) || '0B'} <span class="ct-dir">↑</span> ${hBytes(e.replyBytes) || '0B'} <span class="ct-dir">↓</span>`
      : '';

    // Searchable string stored as dataset
    const search = [
      e.proto, e.state, e.orig.src, e.orig.dst,
      e.orig.sport, e.orig.dport, e.reply.src, e.reply.dst,
    ].filter(Boolean).join(' ').toLowerCase();

    return `<tr class="ct-row" data-s="${h(search)}">
      <td>${stateBadge}${flagBadge}</td>
      <td>${protoBadge}</td>
      <td class="ct-orig">${origCell}${natTag}</td>
      <td class="ct-ttl-cell">${ttlCell}</td>
      ${bytesCell ? `<td class="ct-bytes">${bytesCell}</td>` : ''}
    </tr>`;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Main view — conntrack -L
   * ══════════════════════════════════════════════════════════════════════ */
  function renderConntrackView(raw, container) {
    const entries = parseConntrackOutput(raw);
    if (!entries.length) {
      container.innerHTML = '<div class="ct-empty-msg">No conntrack entries found.</div>';
      return;
    }

    const stats  = computeStats(entries);
    const hasBytes = entries.some(e => e.origBytes != null);

    const wrap = document.createElement('div');
    wrap.className = 'ct-wrap';

    wrap.appendChild(renderStatCards(stats));
    wrap.appendChild(renderDistBars(stats));
    wrap.appendChild(renderTopTables(stats));

    // ── Filter controls ──────────────────────────────────────────────
    const filterEl = document.createElement('div');
    filterEl.className = 'ct-filter';

    const protos = ['all', 'tcp', 'udp', 'icmp'];
    const hasOther = stats.total - stats.tcp - stats.udp - stats.icmp > 0;
    if (hasOther) protos.push('other');

    const tcpStateList = Object.keys(stats.byState).sort((a, b) => (stats.byState[b] - stats.byState[a]));

    filterEl.innerHTML = `
      <input class="ct-search" placeholder="🔍  IP, port, state…" type="text" />
      <div class="ct-filter-group">
        ${protos.map(p =>
          `<button class="ct-filter-btn${p === 'all' ? ' active' : ''}" data-proto="${p}">${p.toUpperCase()}</button>`
        ).join('')}
      </div>
      ${tcpStateList.length > 0 ? `
      <div class="ct-filter-group">
        <button class="ct-filter-btn active" data-state="all">All states</button>
        ${tcpStateList.map(s =>
          `<button class="ct-filter-btn ct-filter-state-${STATE_KIND[s]||'none'}" data-state="${s}">${h(s.replace('_',' '))}</button>`
        ).join('')}
      </div>` : ''}
    `;
    wrap.appendChild(filterEl);

    // ── Connection table ─────────────────────────────────────────────
    const tableWrap = document.createElement('div');
    tableWrap.className = 'ct-table-wrap';

    const footer = document.createElement('div');
    footer.className = 'ct-footer';

    wrap.appendChild(tableWrap);
    wrap.appendChild(footer);

    // State
    let protoFilter = 'all', stateFilter = 'all', query = '', page = 1;

    function getFiltered() {
      const q = query.toLowerCase();
      return entries.filter(e => {
        if (protoFilter !== 'all') {
          if (protoFilter === 'other') {
            if (['tcp','udp','icmp','icmpv6'].includes(e.proto)) return false;
          } else if (e.proto !== protoFilter) return false;
        }
        if (stateFilter !== 'all' && e.state !== stateFilter) return false;
        if (q && !(
          (e.orig.src  || '').includes(q) ||
          (e.orig.dst  || '').includes(q) ||
          String(e.orig.sport || '').includes(q) ||
          String(e.orig.dport || '').includes(q) ||
          (e.state  || '').toLowerCase().includes(q) ||
          e.proto.includes(q) ||
          (e.reply.src || '').includes(q) ||
          (e.reply.dst || '').includes(q)
        )) return false;
        return true;
      });
    }

    function render() {
      const filtered = getFiltered();
      const shown    = filtered.slice(0, page * PAGE);
      const hasMore  = shown.length < filtered.length;

      tableWrap.innerHTML = `
        <table class="ct-table">
          <thead><tr>
            <th>State &amp; flag</th>
            <th>Proto</th>
            <th>Connection</th>
            <th>TTL</th>
            ${hasBytes ? '<th>Bytes ↑↓</th>' : ''}
          </tr></thead>
          <tbody>${shown.map(buildConnRow).join('')}</tbody>
        </table>`;

      footer.innerHTML = `
        <span class="ct-footer-count">
          Showing <b>${N(shown.length)}</b> of <b>${N(filtered.length)}</b>
          (${N(entries.length)} total)
        </span>
        ${hasMore
          ? `<button class="ct-showmore">Show ${Math.min(PAGE, filtered.length - shown.length)} more</button>`
          : ''}
      `;
      footer.querySelector('.ct-showmore')?.addEventListener('click', () => { page++; render(); });
    }

    // Filter wiring
    filterEl.querySelectorAll('[data-proto]').forEach(btn => {
      btn.addEventListener('click', () => {
        protoFilter = btn.dataset.proto;
        page = 1;
        filterEl.querySelectorAll('[data-proto]').forEach(b => b.classList.toggle('active', b === btn));
        render();
      });
    });
    filterEl.querySelectorAll('[data-state]').forEach(btn => {
      btn.addEventListener('click', () => {
        stateFilter = btn.dataset.state;
        page = 1;
        filterEl.querySelectorAll('[data-state]').forEach(b => b.classList.toggle('active', b === btn));
        render();
      });
    });
    filterEl.querySelector('.ct-search').addEventListener('input', e => {
      query = e.target.value;
      page  = 1;
      render();
    });

    render();

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * conntrack -S — per-CPU stats
   * ══════════════════════════════════════════════════════════════════════ */
  function renderConntrackStats(raw, container) {
    // Parse: "cpu=0    found=0 invalid=0 ignore=174 ..."
    const rows = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const row = {};
      for (const part of t.split(/\s+/)) {
        const eq = part.indexOf('=');
        if (eq >= 0) row[part.slice(0, eq)] = +part.slice(eq + 1);
      }
      if (row.cpu != null) rows.push(row);
    }
    if (!rows.length) { container.textContent = raw; return; }

    // Compute totals
    const KEYS = ['found','invalid','ignore','insert','insert_failed','drop','early_drop','error','search_restart'];
    const totals = { cpu: 'TOTAL' };
    for (const k of KEYS) totals[k] = rows.reduce((s, r) => s + (r[k] || 0), 0);

    const BAD = new Set(['drop','early_drop','error','insert_failed','invalid']);

    const headerCells = ['CPU', ...KEYS].map(k => `<th>${h(k.replace(/_/g,' '))}</th>`).join('');
    const toRow = (r, isTot) => `<tr class="${isTot ? 'ct-stats-total' : ''}">
      <td><b>${h(r.cpu)}</b></td>
      ${KEYS.map(k => {
        const v = r[k] || 0;
        const bad = BAD.has(k) && v > 0;
        return `<td class="${bad ? 'ct-stats-bad' : v > 0 ? 'ct-stats-nonzero' : ''}">${N(v)}</td>`;
      }).join('')}
    </tr>`;

    const wrap = document.createElement('div');
    wrap.className = 'ct-stats-wrap';
    wrap.innerHTML = `
      <div class="ct-stats-note">
        Non-zero <span class="ct-stats-bad">drops, errors, or insert_failed</span> indicate conntrack pressure or misconfiguration.
      </div>
      <div style="overflow-x:auto">
        <table class="ct-stats-table">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>
            ${rows.map(r => toRow(r, false)).join('')}
            ${toRow(totals, true)}
          </tbody>
        </table>
      </div>`;

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * conntrack count / max — capacity gauge
   * ══════════════════════════════════════════════════════════════════════ */
  function renderConntrackCount(raw, container) {
    const countM = raw.match(/count:\s*(\d+)/i);
    const maxM   = raw.match(/max:\s*(\d+)/i);

    if (!countM || !maxM) { container.textContent = raw; return; }

    const count = +countM[1], max = +maxM[1];
    const used  = pct(count, max);
    const cls   = used >= 80 ? 'ct-gauge-crit' : used >= 50 ? 'ct-gauge-warn' : 'ct-gauge-ok';
    const msg   = used >= 80
      ? '⚠ High usage — risk of dropped connections above 100%.'
      : used >= 50
        ? '↗ Moderate usage — monitor for spikes.'
        : '✔ Healthy — plenty of capacity.';

    const wrap = document.createElement('div');
    wrap.className = 'ct-gauge-wrap';
    wrap.innerHTML = `
      <div class="ct-gauge-row">
        <span class="ct-gauge-count">${N(count)}</span>
        <span class="ct-gauge-sep">/</span>
        <span class="ct-gauge-max">${N(max)}</span>
        <span class="ct-gauge-pct ${cls}">${used}%</span>
      </div>
      <div class="ct-gauge-bar">
        <div class="ct-gauge-fill ${cls}" style="width:${Math.min(used,100)}%"></div>
      </div>
      <div class="ct-gauge-labels">
        <span>0</span>
        <span>${N(Math.round(max/4))}</span>
        <span>${N(Math.round(max/2))}</span>
        <span>${N(Math.round(max*3/4))}</span>
        <span>${N(max)}</span>
      </div>
      <div class="ct-gauge-msg ${cls}">${msg}</div>
      <div class="ct-gauge-meta">
        <span>Used: <b>${N(count)}</b> entries</span>
        <span>Free: <b>${N(max - count)}</b> entries</span>
        <span>Max: <b>${N(max)}</b></span>
      </div>
    `;

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ── Exports ────────────────────────────────────────────────────────── */
  window.renderConntrackView  = renderConntrackView;
  window.renderConntrackStats = renderConntrackStats;
  window.renderConntrackCount = renderConntrackCount;

})();

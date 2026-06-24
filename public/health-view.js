'use strict';
/* ══════════════════════════════════════════════════════════════════════════
 * k8s-node-debugger — Node Health renderers
 * Exposes: renderMemInfoView, renderMemPressureView, renderOomKillsView,
 *          renderKubeletLogsView, renderDiskView, renderCpuView
 * ══════════════════════════════════════════════════════════════════════════ */
(function () {

  function h(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function N(n) { return Number(n).toLocaleString(); }

  function hBytes(kb) {
    if (!kb || kb < 1) return '0 B';
    const mb = kb / 1024, gb = mb / 1024;
    if (gb >= 1) return gb.toFixed(2) + ' GB';
    if (mb >= 1) return mb.toFixed(1) + ' MB';
    return kb + ' KB';
  }

  function pct(a, b) { return b ? Math.min(Math.round(a / b * 100), 100) : 0; }

  function gauge(value, max, { cls = '', label = '', sub = '' } = {}) {
    const p = pct(value, max);
    const color = p >= 90 ? 'hv-gauge-crit' : p >= 70 ? 'hv-gauge-warn' : 'hv-gauge-ok';
    return `
      <div class="hv-gauge">
        <div class="hv-gauge-head">
          <span class="hv-gauge-label">${h(label)}</span>
          <span class="hv-gauge-pct ${color}">${p}%</span>
        </div>
        <div class="hv-gauge-bar">
          <div class="hv-gauge-fill ${color}" style="width:${p}%"></div>
        </div>
        <div class="hv-gauge-sub">${h(sub)}</div>
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Memory — /proc/meminfo
   * ══════════════════════════════════════════════════════════════════════ */
  function renderMemInfoView(raw, container) {
    const kv = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) kv[m[1]] = +m[2]; // values in kB
    }
    if (!Object.keys(kv).length) { container.textContent = raw; return; }

    const total     = kv.MemTotal     || 0;
    const avail     = kv.MemAvailable || 0;
    const free      = kv.MemFree      || 0;
    const buffers   = kv.Buffers      || 0;
    const cached    = (kv.Cached || 0) + (kv.SReclaimable || 0) - (kv.Shmem || 0);
    const used      = total - avail;
    const swapTotal = kv.SwapTotal    || 0;
    const swapFree  = kv.SwapFree     || 0;
    const swapUsed  = swapTotal - swapFree;

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    wrap.innerHTML = `
      <div class="hv-gauges">
        ${gauge(used, total, {
          label: 'RAM used',
          sub: `${hBytes(used)} used of ${hBytes(total)} — ${hBytes(avail)} available`,
        })}
        ${swapTotal > 0 ? gauge(swapUsed, swapTotal, {
          label: 'Swap used',
          sub: `${hBytes(swapUsed)} used of ${hBytes(swapTotal)}`,
        }) : ''}
      </div>
      <div class="hv-grid">
        ${[
          ['Total RAM',   hBytes(total)],
          ['Used',        hBytes(used)],
          ['Available',   hBytes(avail)],
          ['Free',        hBytes(free)],
          ['Buffers',     hBytes(buffers)],
          ['Page cache',  hBytes(cached)],
          ['Swap total',  swapTotal ? hBytes(swapTotal) : '—'],
          ['Swap used',   swapTotal ? hBytes(swapUsed)  : '—'],
          ['Hugepages',   kv.HugePages_Total ? `${kv.HugePages_Total} × ${hBytes(kv.Hugepagesize||0)}` : '—'],
        ].map(([k,v]) => `<div class="hv-kv"><span class="hv-k">${h(k)}</span><span class="hv-v">${h(v)}</span></div>`).join('')}
      </div>
    `;

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * PSI pressure — /proc/pressure/{cpu,memory,io}
   * ══════════════════════════════════════════════════════════════════════ */
  function renderMemPressureView(raw, container) {
    // Format: "=cpu=\nsome avg10=X avg60=X avg300=X total=N\n=memory=\n..."
    const sections = {};
    let cur = null;
    for (const line of raw.split('\n')) {
      const sec = line.match(/^=(\w+)=$/);
      if (sec) { cur = sec[1]; sections[cur] = []; continue; }
      if (cur && line.trim()) sections[cur].push(line.trim());
    }

    function parsePSI(lines) {
      const result = {};
      for (const line of lines) {
        const type = line.match(/^(some|full)/)?.[1];
        if (!type) continue;
        const avg10  = parseFloat(line.match(/avg10=([0-9.]+)/)?.[1]  || '0');
        const avg60  = parseFloat(line.match(/avg60=([0-9.]+)/)?.[1]  || '0');
        const avg300 = parseFloat(line.match(/avg300=([0-9.]+)/)?.[1] || '0');
        result[type] = { avg10, avg60, avg300 };
      }
      return result;
    }

    function psiColor(v) {
      return v >= 20 ? 'hv-psi-crit' : v >= 5 ? 'hv-psi-warn' : 'hv-psi-ok';
    }

    function renderSection(name, lines) {
      if (!lines || !lines.length || lines[0] === 'n/a') {
        return `<div class="hv-psi-box hv-psi-na"><div class="hv-psi-name">${h(name.toUpperCase())}</div><div class="hv-psi-unavail">PSI not available</div></div>`;
      }
      const data = parsePSI(lines);
      const rows = Object.entries(data).map(([type, d]) => `
        <div class="hv-psi-row">
          <span class="hv-psi-type">${h(type)}</span>
          <span class="hv-psi-val ${psiColor(d.avg10)}" title="10-second average">${d.avg10.toFixed(2)}<small>avg10</small></span>
          <span class="hv-psi-val ${psiColor(d.avg60)}" title="60-second average">${d.avg60.toFixed(2)}<small>avg60</small></span>
          <span class="hv-psi-val ${psiColor(d.avg300)}" title="300-second average">${d.avg300.toFixed(2)}<small>avg300</small></span>
        </div>`).join('');

      const maxAvg10 = Math.max(...Object.values(data).map(d => d.avg10), 0);
      const status = maxAvg10 >= 20 ? 'hv-psi-crit' : maxAvg10 >= 5 ? 'hv-psi-warn' : 'hv-psi-ok';
      return `
        <div class="hv-psi-box ${status}">
          <div class="hv-psi-name">${h(name.toUpperCase())}</div>
          ${rows}
        </div>`;
    }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';
    wrap.innerHTML = `
      <div class="hv-psi-note">
        PSI avg10 ≥ 5% = moderate pressure, ≥ 20% = severe. <em>some</em> = at least one task stalled; <em>full</em> = all tasks stalled.
      </div>
      <div class="hv-psi-grid">
        ${renderSection('cpu',    sections.cpu)}
        ${renderSection('memory', sections.memory)}
        ${renderSection('io',     sections.io)}
      </div>`;

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * OOM kills — dmesg
   * ══════════════════════════════════════════════════════════════════════ */
  function renderOomKillsView(raw, container) {
    const lines = raw.split('\n').filter(l => l.trim());

    if (!lines.length) {
      container.innerHTML = '<div class="hv-oom-empty">✔ No OOM kill events found since last boot.</div>';
      container.className = '';
      return;
    }

    // Group consecutive lines into events (lines within ~1s of each other, or that share a process)
    const events = [];
    let cur = [];
    for (const line of lines) {
      cur.push(line);
      if (/killed process|oom_kill_process/i.test(line)) {
        events.push(cur);
        cur = [];
      }
    }
    if (cur.length) events.push(cur);

    function parseEvent(evLines) {
      const full = evLines.join('\n');
      const proc    = full.match(/Killed process \d+ \(([^)]+)\)/i)?.[1]
                   || full.match(/oom_kill_process.*?"([^"]+)"/)?.[1];
      const pid     = full.match(/Killed process (\d+)/i)?.[1];
      const reqKb   = full.match(/anon-rss:(\d+)kB/i)?.[1] || full.match(/rss:(\d+)kB/i)?.[1];
      const totalKb = full.match(/total-vm:(\d+)kB/i)?.[1];
      const ts      = evLines[0].match(/^\[?([^\]]+)\]?/)?.[1]?.trim();
      return { proc, pid, reqKb: reqKb ? +reqKb : null, totalKb: totalKb ? +totalKb : null, ts, raw: full };
    }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    const header = document.createElement('div');
    header.className = 'hv-oom-header';
    header.innerHTML = `<span class="hv-oom-count">${events.length} OOM event${events.length !== 1 ? 's' : ''} found</span>`;
    wrap.appendChild(header);

    for (const evLines of [...events].reverse()) {
      const ev = parseEvent(evLines);
      const card = document.createElement('div');
      card.className = 'hv-oom-card';
      card.innerHTML = `
        <div class="hv-oom-title">
          <span class="hv-oom-badge">OOM KILL</span>
          <span class="hv-oom-proc">${h(ev.proc || 'unknown process')}${ev.pid ? ` <small>PID ${ev.pid}</small>` : ''}</span>
          ${ev.ts ? `<span class="hv-oom-ts">${h(ev.ts)}</span>` : ''}
        </div>
        ${ev.reqKb || ev.totalKb ? `
        <div class="hv-oom-mem">
          ${ev.reqKb   ? `<span class="hv-oom-memval">RSS: <b>${hBytes(ev.reqKb)}</b></span>` : ''}
          ${ev.totalKb ? `<span class="hv-oom-memval">Total-VM: <b>${hBytes(ev.totalKb)}</b></span>` : ''}
        </div>` : ''}
        <pre class="hv-oom-raw">${h(ev.raw)}</pre>
      `;
      wrap.appendChild(card);
    }

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Kubelet logs — journalctl
   * ══════════════════════════════════════════════════════════════════════ */
  function renderKubeletLogsView(raw, container) {
    const lines = raw.split('\n');

    const LEVEL_RE = /\b(error|err|warning|warn|fatal|panic)\b/i;
    const EVICT_RE = /evict|threshold|pressure|diskpressure|memorypressure|nodecondition|notready|imagegarbage/i;

    function lineClass(line) {
      const l = line.toLowerCase();
      if (/\berror\b|\bfatal\b|\bpanic\b/.test(l)) return 'hv-log-error';
      if (/\bwarn/.test(l)) return 'hv-log-warn';
      if (EVICT_RE.test(l)) return 'hv-log-evict';
      return '';
    }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    const errorCount = lines.filter(l => /\berror\b|\bfatal\b/i.test(l)).length;
    const warnCount  = lines.filter(l => /\bwarn/i.test(l)).length;
    const evictCount = lines.filter(l => EVICT_RE.test(l)).length;

    wrap.innerHTML = `
      <div class="hv-log-summary">
        <span class="hv-log-pill hv-log-error">${errorCount} errors</span>
        <span class="hv-log-pill hv-log-warn">${warnCount} warnings</span>
        <span class="hv-log-pill hv-log-evict">${evictCount} eviction/pressure events</span>
      </div>`;

    const pre = document.createElement('pre');
    pre.className = 'hv-log-pre';
    pre.innerHTML = lines.map(line => {
      const cls = lineClass(line);
      return `<span class="${cls}">${h(line)}</span>`;
    }).join('\n');
    wrap.appendChild(pre);

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Disk usage — df -h
   * ══════════════════════════════════════════════════════════════════════ */
  function renderDiskView(raw, container) {
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length < 2) { container.textContent = raw; return; }

    // Skip pure tmpfs/devtmpfs/overlay unless they're interesting
    const SKIP = /^(tmpfs|devtmpfs|udev|none)\s/;
    const rows = [];

    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      // df -h columns: Filesystem  Size  Used  Avail  Use%  Mounted
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;
      const [fs, size, used, avail, usePct, ...mountParts] = parts;
      const mount = mountParts.join(' ');
      const p = parseInt(usePct);
      if (SKIP.test(line) && p < 50) continue; // hide boring tmpfs
      rows.push({ fs, size, used, avail, usePct: p, mount });
    }

    if (!rows.length) { container.textContent = raw; return; }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    // Critical mounts for kubelet eviction
    const CRITICAL = ['/var/lib/kubelet', '/var/lib/containerd', '/var/lib/docker', '/'];

    wrap.innerHTML = `
      <div class="hv-disk-note">
        Kubelet triggers disk-pressure eviction when <code>/</code>, <code>/var/lib/kubelet</code>, or <code>/var/lib/containerd</code> exceeds the threshold (default 85%).
      </div>
      <div class="hv-disk-rows">
        ${rows.map(r => {
          const color = r.usePct >= 90 ? 'hv-gauge-crit' : r.usePct >= 75 ? 'hv-gauge-warn' : 'hv-gauge-ok';
          const important = CRITICAL.some(m => r.mount === m || r.mount.startsWith(m));
          return `
          <div class="hv-disk-row${important ? ' hv-disk-important' : ''}">
            <div class="hv-disk-meta">
              <span class="hv-disk-mount">${h(r.mount)}${important ? ' <span class="hv-disk-star" title="kubelet watches this path">★</span>' : ''}</span>
              <span class="hv-disk-fs">${h(r.fs)}</span>
              <span class="hv-disk-pct ${color}">${r.usePct}%</span>
            </div>
            <div class="hv-gauge-bar">
              <div class="hv-gauge-fill ${color}" style="width:${r.usePct}%"></div>
            </div>
            <div class="hv-disk-sub">${h(r.used)} used · ${h(r.avail)} free · ${h(r.size)} total</div>
          </div>`;
        }).join('')}
      </div>`;

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * CPU & load average
   * ══════════════════════════════════════════════════════════════════════ */
  function renderCpuView(raw, container) {
    const sections = {};
    let cur = null;
    for (const line of raw.split('\n')) {
      const sec = line.match(/^=(\w+)=$/);
      if (sec) { cur = sec[1]; sections[cur] = []; continue; }
      if (cur) sections[cur].push(line);
    }

    const loadavgLine = (sections.loadavg || []).find(l => l.trim());
    const nprocLine   = (sections.nproc    || []).find(l => l.trim());
    const modelLine   = (sections.cpumodel || []).find(l => l.trim());
    const statLine    = (sections.procstat || []).find(l => l.startsWith('cpu '));
    const procLines   = (sections.topproc  || []).filter(l => l.trim()).slice(1); // skip header

    const nproc = nprocLine ? parseInt(nprocLine) : 1;

    let load1 = 0, load5 = 0, load15 = 0;
    if (loadavgLine) {
      [load1, load5, load15] = loadavgLine.trim().split(' ').slice(0, 3).map(Number);
    }

    function loadColor(v) {
      const ratio = v / nproc;
      return ratio >= 2 ? 'hv-gauge-crit' : ratio >= 1 ? 'hv-gauge-warn' : 'hv-gauge-ok';
    }

    // Parse /proc/stat cpu line: cpu user nice system idle iowait irq softirq steal
    let steal = null;
    if (statLine) {
      const parts = statLine.split(/\s+/);
      const [,user, nice, system, idle, iowait, irq, softirq, stealVal] = parts.map(Number);
      const total = user + nice + system + idle + iowait + irq + softirq + (stealVal || 0);
      steal = total > 0 ? ((stealVal || 0) / total * 100).toFixed(2) : null;
    }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    wrap.innerHTML = `
      <div class="hv-cpu-meta">
        <span>${h(modelLine?.trim() || 'Unknown CPU')}</span>
        <span><b>${nproc}</b> core${nproc !== 1 ? 's' : ''}</span>
        ${steal !== null ? `<span class="hv-cpu-steal ${parseFloat(steal) > 5 ? 'hv-psi-warn' : ''}">CPU steal: <b>${steal}%</b></span>` : ''}
      </div>
      <div class="hv-load-cards">
        <div class="hv-load-card">
          <div class="hv-load-val ${loadColor(load1)}">${load1.toFixed(2)}</div>
          <div class="hv-load-lbl">1-min load</div>
        </div>
        <div class="hv-load-card">
          <div class="hv-load-val ${loadColor(load5)}">${load5.toFixed(2)}</div>
          <div class="hv-load-lbl">5-min load</div>
        </div>
        <div class="hv-load-card">
          <div class="hv-load-val ${loadColor(load15)}">${load15.toFixed(2)}</div>
          <div class="hv-load-lbl">15-min load</div>
        </div>
        <div class="hv-load-card hv-load-card-dim">
          <div class="hv-load-val">${nproc}</div>
          <div class="hv-load-lbl">CPU cores</div>
        </div>
      </div>
      <div class="hv-load-note">
        Load ${load1 > nproc * 2 ? '⚠ critically high (> 2× core count)' : load1 > nproc ? '↗ above core count — some queueing' : '✔ normal'}.
        Values above <b>${nproc}</b> (core count) mean processes are waiting for CPU time.
      </div>
      ${procLines.length ? `
      <div class="hv-proctable-title">Top processes by CPU</div>
      <table class="hv-proctable">
        <thead><tr><th>USER</th><th>PID</th><th>%CPU</th><th>%MEM</th><th>VSZ</th><th>RSS</th><th>COMMAND</th></tr></thead>
        <tbody>${procLines.slice(0, 12).map(line => {
          const p = line.trim().split(/\s+/);
          const [user, pid, cpu, mem, vsz, rss, ...cmd] = p;
          const highCpu = parseFloat(cpu) > 50;
          return `<tr class="${highCpu ? 'hv-proc-high' : ''}">
            <td>${h(user)}</td><td>${h(pid)}</td>
            <td class="${highCpu ? 'hv-psi-warn' : ''}">${h(cpu)}%</td>
            <td>${h(mem)}%</td>
            <td>${h(vsz)}</td><td>${h(rss)}</td>
            <td class="hv-proc-cmd">${h(cmd.join(' '))}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : ''}
    `;

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ── Exports ─────────────────────────────────────────────────────────── */
  window.renderMemInfoView     = renderMemInfoView;
  window.renderMemPressureView = renderMemPressureView;
  window.renderOomKillsView    = renderOomKillsView;
  window.renderKubeletLogsView = renderKubeletLogsView;
  window.renderDiskView        = renderDiskView;
  window.renderCpuView         = renderCpuView;

})();

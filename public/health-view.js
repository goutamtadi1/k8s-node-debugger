'use strict';
/* ══════════════════════════════════════════════════════════════════════════
 * k8s-node-debugger — Node Health renderers
 * Exposes: renderMemInfoView, renderMemPressureView, renderOomKillsView,
 *          renderKubeletLogsView, renderDiskView, renderCpuView
 * ══════════════════════════════════════════════════════════════════════════ */
(function () {

  function h(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function hBytes(kb) {
    if (!kb || kb < 1) return '0 B';
    const mb = kb / 1024, gb = mb / 1024;
    if (gb >= 1) return gb.toFixed(2) + ' GiB';
    if (mb >= 1) return mb.toFixed(1) + ' MiB';
    return kb + ' KiB';
  }

  function pct(used, total) {
    return total ? Math.min(Math.round(used / total * 100), 100) : 0;
  }

  function colorCls(p) {
    return p >= 90 ? 'hv-crit' : p >= 70 ? 'hv-warn' : 'hv-ok';
  }

  function gauge(used, total, label, subText) {
    const p = pct(used, total);
    const cls = colorCls(p);
    return `
      <div class="hv-gauge-wrap">
        <div class="hv-gauge-hdr">
          <span class="hv-gauge-title">${h(label)}</span>
          <span class="hv-gauge-pct-lbl ${cls}">${p}%</span>
        </div>
        <div class="hv-gauge-bar"><div class="hv-gauge-fill ${cls}" style="width:${p}%"></div></div>
        <div class="hv-gauge-labels"><span>${h(subText)}</span></div>
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Memory — /proc/meminfo
   * ══════════════════════════════════════════════════════════════════════ */
  function renderMemInfoView(raw, container) {
    const kv = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) kv[m[1]] = +m[2];
    }
    if (!Object.keys(kv).length) { container.textContent = raw; return; }

    const total     = kv.MemTotal     || 0;
    const avail     = kv.MemAvailable || 0;
    const free      = kv.MemFree      || 0;
    const buffers   = kv.Buffers      || 0;
    const cached    = Math.max((kv.Cached || 0) + (kv.SReclaimable || 0) - (kv.Shmem || 0), 0);
    const used      = total - avail;
    const swapTotal = kv.SwapTotal || 0;
    const swapFree  = kv.SwapFree  || 0;
    const swapUsed  = swapTotal - swapFree;

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    wrap.innerHTML = `
      <div class="hv-gauges">
        ${gauge(used, total, 'RAM used',
          `${hBytes(used)} used  ·  ${hBytes(avail)} available  ·  ${hBytes(total)} total`)}
        ${swapTotal > 0 ? gauge(swapUsed, swapTotal, 'Swap used',
          `${hBytes(swapUsed)} used  ·  ${hBytes(swapFree)} free  ·  ${hBytes(swapTotal)} total`) : ''}
      </div>
      <div class="hv-grid">
        ${[
          ['Total RAM',  hBytes(total)],
          ['Used',       hBytes(used)],
          ['Available',  hBytes(avail)],
          ['Free',       hBytes(free)],
          ['Buffers',    hBytes(buffers)],
          ['Page cache', hBytes(cached)],
          ['Swap total', swapTotal ? hBytes(swapTotal) : '—'],
          ['Swap used',  swapTotal ? hBytes(swapUsed)  : '—'],
          ['Hugepages',  kv.HugePages_Total
            ? `${kv.HugePages_Total} × ${hBytes(kv.Hugepagesize || 0)}`
            : '—'],
        ].map(([k, v]) => `
          <div class="hv-grid-item">
            <div class="hv-grid-label">${h(k)}</div>
            <div class="hv-grid-val">${h(v)}</div>
          </div>`).join('')}
      </div>`;

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * PSI pressure — /proc/pressure/{cpu,memory,io}
   * ══════════════════════════════════════════════════════════════════════ */
  function renderMemPressureView(raw, container) {
    const sections = {};
    let cur = null;
    for (const line of raw.split('\n')) {
      const sec = line.match(/^=(\w+)=$/);
      if (sec) { cur = sec[1]; sections[cur] = []; continue; }
      if (cur && line.trim()) sections[cur].push(line.trim());
    }

    function parsePSI(lines) {
      const out = {};
      for (const line of lines) {
        const type = line.match(/^(some|full)/)?.[1];
        if (!type) continue;
        out[type] = {
          avg10:  parseFloat(line.match(/avg10=([0-9.]+)/)?.[1]  || '0'),
          avg60:  parseFloat(line.match(/avg60=([0-9.]+)/)?.[1]  || '0'),
          avg300: parseFloat(line.match(/avg300=([0-9.]+)/)?.[1] || '0'),
        };
      }
      return out;
    }

    function psiValColor(v) {
      return v >= 20 ? 'hv-crit' : v >= 5 ? 'hv-warn' : 'hv-ok';
    }

    function renderBox(name, lines) {
      if (!lines || !lines.length || lines[0] === 'n/a') {
        return `
          <div class="hv-psi-box">
            <div class="hv-psi-title">${h(name.toUpperCase())}</div>
            <div class="hv-psi-na">Not available on this kernel</div>
          </div>`;
      }
      const data = parsePSI(lines);
      const maxAvg10 = Math.max(...Object.values(data).map(d => d.avg10), 0);
      const boxCls = maxAvg10 >= 20 ? 'hv-psi-box-crit' : maxAvg10 >= 5 ? 'hv-psi-box-warn' : 'hv-psi-box-ok';

      const rows = Object.entries(data).map(([type, d]) => `
        <div class="hv-psi-row">
          <span class="hv-psi-key">${h(type)}</span>
          <span class="hv-psi-val ${psiValColor(d.avg10)}"  title="10-second window">avg10 = ${d.avg10.toFixed(2)}%</span>
          <span class="hv-psi-val ${psiValColor(d.avg60)}"  title="60-second window">avg60 = ${d.avg60.toFixed(2)}%</span>
          <span class="hv-psi-val ${psiValColor(d.avg300)}" title="300-second window">avg300 = ${d.avg300.toFixed(2)}%</span>
        </div>`).join('');

      return `
        <div class="hv-psi-box ${boxCls}">
          <div class="hv-psi-title">${h(name.toUpperCase())}</div>
          <div class="hv-psi-rows">${rows}</div>
        </div>`;
    }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';
    wrap.innerHTML = `
      <div class="hv-info-note">
        <b>PSI (Pressure Stall Information)</b> — % of time tasks were stalled waiting for this resource.
        avg10 ≥ 5% = moderate contention · ≥ 20% = severe.
        <em>some</em> = at least one task stalled; <em>full</em> = all tasks stalled (CPU only has <em>some</em>).
      </div>
      <div class="hv-psi-boxes">
        ${renderBox('cpu',    sections.cpu)}
        ${renderBox('memory', sections.memory)}
        ${renderBox('io',     sections.io)}
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
    container.innerHTML = '';
    container.className = '';

    if (!lines.length) {
      container.innerHTML = '<div class="hv-oom-ok">✔ No OOM kill events found since last boot.</div>';
      return;
    }

    // Group into events: flush when we hit a "Killed process" line
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
      return {
        proc:    full.match(/Killed process \d+ \(([^)]+)\)/i)?.[1]
               || full.match(/oom_kill_process.*?"([^"]+)"/)?.[1] || null,
        pid:     full.match(/Killed process (\d+)/i)?.[1] || null,
        reqKb:   +(full.match(/anon-rss:(\d+)kB/i)?.[1] || full.match(/rss:(\d+)kB/i)?.[1] || 0),
        totalKb: +(full.match(/total-vm:(\d+)kB/i)?.[1] || 0),
        ts:      evLines[0].match(/^\[?([^\]]+)\]?/)?.[1]?.trim() || '',
        raw:     full,
      };
    }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';
    wrap.innerHTML = `<div class="hv-oom-count-badge">⚠ ${events.length} OOM kill event${events.length !== 1 ? 's' : ''} found since last boot</div>`;

    const list = document.createElement('div');
    list.className = 'hv-oom-list';

    for (const evLines of [...events].reverse()) {
      const ev = parseEvent(evLines);
      const card = document.createElement('div');
      card.className = 'hv-oom-event';
      card.innerHTML = `
        <div class="hv-oom-header">
          <span class="hv-oom-process">${h(ev.proc || 'unknown process')}</span>
          ${ev.pid ? `<span class="hv-oom-pid">PID ${h(ev.pid)}</span>` : ''}
          ${ev.ts  ? `<span class="hv-oom-ts">${h(ev.ts)}</span>` : ''}
        </div>
        ${ev.reqKb || ev.totalKb ? `
          <div class="hv-oom-mems">
            ${ev.reqKb   ? `<div class="hv-oom-mem-item"><span class="hv-oom-mem-label">RSS </span><span class="hv-oom-mem-val">${hBytes(ev.reqKb)}</span></div>` : ''}
            ${ev.totalKb ? `<div class="hv-oom-mem-item"><span class="hv-oom-mem-label">Total-VM </span><span class="hv-oom-mem-val">${hBytes(ev.totalKb)}</span></div>` : ''}
          </div>` : ''}
        <pre class="hv-oom-raw">${h(ev.raw)}</pre>`;
      list.appendChild(card);
    }

    wrap.appendChild(list);
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Kubelet logs — journalctl
   * ══════════════════════════════════════════════════════════════════════ */
  function renderKubeletLogsView(raw, container) {
    const EVICT_RE = /evict|threshold|pressure|diskpressure|memorypressure|nodecondition|notready|imagegarbage/i;

    function lineLevel(line) {
      const l = line.toLowerCase();
      if (/\berror\b|\bfatal\b|\bpanic\b/.test(l)) return 'error';
      if (/\bwarn/.test(l)) return 'warn';
      if (EVICT_RE.test(l)) return 'evict';
      return 'normal';
    }

    const counts = { error: 0, warn: 0, evict: 0 };
    const classified = raw.split('\n').map(line => {
      const level = lineLevel(line);
      if (level !== 'normal') counts[level]++;
      return { line, level };
    });

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    const pills = [
      counts.error > 0
        ? `<span class="hv-log-pill hv-log-pill-error">${counts.error} error${counts.error !== 1 ? 's' : ''}</span>`
        : `<span class="hv-log-pill hv-log-pill-ok">0 errors</span>`,
      counts.warn  > 0 ? `<span class="hv-log-pill hv-log-pill-warn">${counts.warn} warning${counts.warn !== 1 ? 's' : ''}</span>` : '',
      counts.evict > 0 ? `<span class="hv-log-pill hv-log-pill-evict">${counts.evict} eviction/pressure event${counts.evict !== 1 ? 's' : ''}</span>` : '',
    ].filter(Boolean).join('');

    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'hv-log-summary';
    summaryDiv.innerHTML = pills;
    wrap.appendChild(summaryDiv);

    const logDiv = document.createElement('div');
    logDiv.className = 'hv-log-lines';
    logDiv.innerHTML = classified.map(({ line, level }) =>
      `<div class="hv-log-line hv-log-${level}">${h(line)}</div>`
    ).join('');
    wrap.appendChild(logDiv);

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

    const SKIP = /^(tmpfs|devtmpfs|udev|none)\s/;
    const CRITICAL = new Set(['/var/lib/kubelet', '/var/lib/containerd', '/var/lib/docker', '/']);

    const rows = [];
    for (const line of lines.slice(1)) {
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;
      const [fs, size, used, avail, usePct, ...rest] = parts;
      const mount = rest.join(' ');
      const p = parseInt(usePct);
      if (SKIP.test(line) && p < 50) continue;
      rows.push({ fs, size, used, avail, pct: p, mount });
    }

    if (!rows.length) { container.textContent = raw; return; }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    const rowsHtml = rows.map(r => {
      const cls = colorCls(r.pct);
      const critical = CRITICAL.has(r.mount);
      return `
        <div class="hv-disk-row">
          <div class="hv-disk-header">
            <span class="hv-disk-mount">${h(r.mount)}${critical ? ' <span class="hv-disk-star">kubelet</span>' : ''}</span>
            <span class="hv-disk-fs">${h(r.fs)}</span>
            <div class="hv-disk-sizes">
              <span class="hv-disk-pct ${cls}">${r.pct}%</span>
              <span class="hv-disk-nums">${h(r.used)} used · ${h(r.avail)} free · ${h(r.size)} total</span>
            </div>
          </div>
          <div class="hv-disk-bar"><div class="hv-disk-fill ${cls}" style="width:${r.pct}%"></div></div>
        </div>`;
    }).join('');

    wrap.innerHTML = `
      <div class="hv-info-note">
        Kubelet triggers <b>disk-pressure eviction</b> when <code>/</code>, <code>/var/lib/kubelet</code>,
        or <code>/var/lib/containerd</code> exceeds the eviction threshold (default 85%).
        Paths marked <b>kubelet</b> are watched.
      </div>
      <div class="hv-disk-list">${rowsHtml}</div>`;

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

    const loadavgLine = (sections.loadavg  || []).find(l => l.trim());
    const nprocLine   = (sections.nproc    || []).find(l => l.trim());
    const modelLine   = (sections.cpumodel || []).find(l => l.trim());
    const statLine    = (sections.procstat || []).find(l => l.startsWith('cpu '));
    // ps aux: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    const procLines   = (sections.topproc  || []).filter(l => l.trim()).slice(1);

    const nproc = nprocLine ? parseInt(nprocLine) : 1;
    let load1 = 0, load5 = 0, load15 = 0;
    if (loadavgLine) [load1, load5, load15] = loadavgLine.trim().split(' ').slice(0, 3).map(Number);

    function loadColor(v) {
      const r = v / nproc;
      return r >= 2 ? 'hv-crit' : r >= 1 ? 'hv-warn' : 'hv-ok';
    }
    function loadCardCls(v) {
      const r = v / nproc;
      return r >= 2 ? 'hv-load-card-crit' : r >= 1 ? 'hv-load-card-warn' : 'hv-load-card-ok';
    }

    let stealPct = null;
    if (statLine) {
      const [, user, nice, system, idle, iowait, irq, softirq, steal = 0] = statLine.split(/\s+/).map(Number);
      const total = user + nice + system + idle + iowait + irq + softirq + steal;
      if (total > 0) stealPct = (steal / total * 100).toFixed(2);
    }

    const loadRatio = load1 / nproc;
    const loadStatus = loadRatio >= 2
      ? `⚠ Critically high — load is ${loadRatio.toFixed(1)}× core count. Processes are queuing for CPU.`
      : loadRatio >= 1
      ? `↗ Above core count — some CPU queueing (${loadRatio.toFixed(1)}× cores). Worth investigating.`
      : `✔ Normal — load is ${(loadRatio * 100).toFixed(0)}% of core capacity.`;
    const loadNoteCls = loadRatio >= 2 ? 'hv-note-crit' : loadRatio >= 1 ? 'hv-note-warn' : 'hv-note-ok';

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    const metaHtml = (modelLine || stealPct !== null) ? `
      <div class="hv-cpu-info">
        ${modelLine ? `<span>${h(modelLine.trim())}</span>` : ''}
        <span><b>${nproc}</b> logical CPU${nproc !== 1 ? 's' : ''}</span>
        ${stealPct !== null
          ? `<span class="hv-steal-val ${parseFloat(stealPct) > 5 ? 'hv-warn' : 'hv-ok'}">CPU steal: <b>${stealPct}%</b>${parseFloat(stealPct) > 5 ? ' ⚠' : ''}</span>`
          : ''}
      </div>` : '';

    const cardsHtml = `
      <div class="hv-load-cards">
        ${[['1-min', load1], ['5-min', load5], ['15-min', load15]].map(([lbl, v]) => `
          <div class="hv-load-card ${loadCardCls(v)}">
            <div class="hv-load-val ${loadColor(v)}">${v.toFixed(2)}</div>
            <div class="hv-load-lbl">${lbl} load avg</div>
          </div>`).join('')}
        <div class="hv-load-card hv-load-card-ok">
          <div class="hv-load-val">${nproc}</div>
          <div class="hv-load-lbl">CPU cores</div>
        </div>
      </div>
      <div class="hv-load-note ${loadNoteCls}">${h(loadStatus)}</div>`;

    let tableHtml = '';
    if (procLines.length) {
      const tableRows = procLines.slice(0, 12).map(line => {
        const p = line.trim().split(/\s+/);
        // ps aux: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND...
        const [user, pid, cpu, mem, vsz, rss, tty, stat, start, time, ...cmdParts] = p;
        const cmd = cmdParts.join(' ');
        const highCpu = parseFloat(cpu) > 50;
        return `<tr>
          <td>${h(user)}</td>
          <td>${h(pid)}</td>
          <td class="${highCpu ? 'hv-warn' : ''}" style="font-weight:${highCpu ? 700 : 400}">${h(cpu)}%</td>
          <td>${h(mem)}%</td>
          <td>${h(rss)}</td>
          <td class="hv-proc-cmd">${h(cmd)}</td>
        </tr>`;
      }).join('');

      tableHtml = `
        <div class="hv-top-table-wrap">
          <table class="hv-top-table">
            <thead><tr><th>USER</th><th>PID</th><th>%CPU</th><th>%MEM</th><th>RSS</th><th>COMMAND</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>`;
    }

    wrap.innerHTML = metaHtml + cardsHtml + tableHtml;
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

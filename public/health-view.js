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

  /* ══════════════════════════════════════════════════════════════════════
   * GPU status — nvidia-smi plain text table
   * ══════════════════════════════════════════════════════════════════════ */
  function renderGpuInfoView(raw, container) {
    if (!raw.includes('NVIDIA-SMI')) { container.className = 'output'; container.textContent = raw; return; }

    const lines = raw.split('\n');

    // Version header
    const verLine   = lines.find(l => l.includes('NVIDIA-SMI')) || '';
    const smiVer    = verLine.match(/NVIDIA-SMI\s+(\S+)/)?.[1]       || '—';
    const driverVer = verLine.match(/Driver Version:\s+(\S+)/)?.[1]  || '—';
    const cudaVer   = verLine.match(/CUDA Version:\s+(\S+)/)?.[1]    || '—';

    // Collect GPU data: groups of 3 content lines between |====| ... +---+
    const gpus = [];
    let inGpu = false, buf = [];
    for (const line of lines) {
      if (/^\|[=]+\|?$/.test(line.trim())) { inGpu = true; buf = []; continue; }
      if (inGpu && line.startsWith('+')) {
        if (buf.length >= 2) {
          const g = parseNvidiaSmiGpuBlock(buf);
          if (g) gpus.push(g);
        }
        inGpu = false; buf = []; continue;
      }
      if (inGpu && line.startsWith('|') && !line.includes('Processes:') &&
          !line.includes('No running') && !line.includes('GPU   GI') && !line.includes('GPU  GI')) {
        buf.push(line);
      }
    }

    // Processes
    let noProcs = raw.includes('No running processes found');
    const procs = [];
    if (!noProcs) {
      const procRe = /\|\s+(\d+)\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(.*?)\s+(\d+)MiB\s+\|/;
      let inP = false;
      for (const line of lines) {
        if (line.includes('Processes:')) { inP = true; continue; }
        if (inP && /^\|[=]+/.test(line)) continue;
        if (inP && line.startsWith('+')) break;
        if (inP) {
          if (line.includes('No running')) { noProcs = true; break; }
          const m = line.match(procRe);
          if (m) procs.push({ gpu: m[1], pid: m[2], type: m[3], name: m[4].trim(), mem: m[5] });
        }
      }
    }

    function tempCls(t)  { return t >= 85 ? 'hv-crit' : t >= 70 ? 'hv-warn' : 'hv-ok'; }
    function pctCls(v)   { return v >= 90 ? 'hv-crit' : v >= 70 ? 'hv-warn' : 'hv-ok'; }
    function powerCls2(d,c) { if (!c) return 'hv-ok'; const r=d/c; return r>=0.95?'hv-crit':r>=0.80?'hv-warn':'hv-ok'; }

    function memBar(used, total) {
      if (!total) return '';
      const pct = Math.min(Math.round(used/total*100),100);
      const cls = pctCls(pct);
      return `<div class="gpu-health-metric">
        <div class="gpu-health-metric-hdr">
          <span class="gpu-health-lbl">Memory</span>
          <span class="gpu-health-val ${cls}">${pct}%</span>
        </div>
        <div class="hv-gauge-bar gpu-health-bar"><div class="hv-gauge-fill ${cls}" style="width:${pct}%"></div></div>
        <div class="gpu-health-sub">${used} MiB used · ${total} MiB total</div>
      </div>`;
    }

    function pwrBar(draw, cap) {
      if (!cap) return '';
      const pct = Math.min(Math.round(draw/cap*100),100);
      const cls = powerCls2(draw, cap);
      return `<div class="gpu-health-metric">
        <div class="gpu-health-metric-hdr">
          <span class="gpu-health-lbl">Power</span>
          <span class="gpu-health-val ${cls}">${draw} W / ${cap} W</span>
        </div>
        <div class="hv-gauge-bar gpu-health-bar"><div class="hv-gauge-fill ${cls}" style="width:${pct}%"></div></div>
      </div>`;
    }

    const gpuCards = gpus.map(g => `
      <div class="gpu-health-card">
        <div class="gpu-health-hdr">
          <span class="gpu-proc-idx">GPU ${h(g.index)}</span>
          <span class="gpu-health-name">${h(g.name)}</span>
        </div>
        <div class="gpu-health-row">
          <div class="gpu-health-cell">
            <span class="gpu-health-lbl">GPU Temp</span>
            <span class="gpu-health-val ${tempCls(g.temp)}">${g.temp}°C</span>
          </div>
          <div class="gpu-health-cell">
            <span class="gpu-health-lbl">Perf</span>
            <span class="gpu-health-val">${h(g.perf)}</span>
          </div>
          <div class="gpu-health-cell">
            <span class="gpu-health-lbl">GPU Util</span>
            <span class="gpu-health-val ${pctCls(g.utilGpu)}">${g.utilGpu}%</span>
          </div>
          <div class="gpu-health-cell">
            <span class="gpu-health-lbl">Fan</span>
            <span class="gpu-health-val">${g.fan !== null ? g.fan + '%' : '—'}</span>
          </div>
        </div>
        ${memBar(g.memUsed, g.memTotal)}
        ${pwrBar(g.pwrDraw, g.pwrCap)}
        <div class="gpu-info-meta">
          <div class="gpu-info-meta-row">
            <span class="gpu-health-lbl">Bus ID</span>
            <span class="gpu-info-meta-val">${h(g.busId)}</span>
          </div>
          <div class="gpu-info-meta-row">
            <span class="gpu-health-lbl">Persistence</span>
            <span class="gpu-info-meta-val ${g.persistence === 'On' ? 'hv-ok' : ''}">${h(g.persistence)}</span>
          </div>
          <div class="gpu-info-meta-row">
            <span class="gpu-health-lbl">Compute Mode</span>
            <span class="gpu-info-meta-val">${h(g.computeMode)}</span>
          </div>
          ${g.migMode ? `<div class="gpu-info-meta-row">
            <span class="gpu-health-lbl">MIG Mode</span>
            <span class="gpu-info-meta-val">${h(g.migMode)}</span>
          </div>` : ''}
        </div>
      </div>`).join('');

    const procsHtml = noProcs
      ? '<div class="gpu-info-no-procs">No running processes.</div>'
      : `<div class="hv-top-table-wrap"><table class="hv-top-table">
          <thead><tr><th>GPU</th><th>PID</th><th>Type</th><th>Process</th><th>GPU Mem</th></tr></thead>
          <tbody>${procs.map(p => `<tr>
            <td><span class="gpu-proc-idx">GPU ${h(p.gpu)}</span></td>
            <td class="gpu-proc-pid">${h(p.pid)}</td>
            <td><span class="gpu-proc-type gpu-proc-type-${h(p.type.toLowerCase())}">${h(p.type)}</span></td>
            <td class="gpu-proc-cmd">${h(p.name)}</td>
            <td class="gpu-proc-mem">${h(p.mem)} MiB</td>
          </tr>`).join('')}</tbody>
        </table></div>`;

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap gpu-health-grid';
    wrap.innerHTML = `
      <div class="gpu-info-versions">
        <div class="gpu-info-ver-item"><span class="gpu-health-lbl">NVIDIA-SMI</span><span class="gpu-info-ver-val">${h(smiVer)}</span></div>
        <div class="gpu-info-ver-item"><span class="gpu-health-lbl">Driver</span><span class="gpu-info-ver-val">${h(driverVer)}</span></div>
        <div class="gpu-info-ver-item"><span class="gpu-health-lbl">CUDA</span><span class="gpu-info-ver-val">${h(cudaVer)}</span></div>
      </div>
      ${gpuCards}
      <div class="gpu-info-procs-section">
        <div class="gpu-info-procs-title">Processes</div>
        ${procsHtml}
      </div>`;

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  function parseNvidiaSmiGpuBlock(lines) {
    // Line 0: |  idx  name  persistence  | bus_id  disp_a  |  ecc  |
    // Line 1: |  fan  tempC  perf  drawW/capW  |  usedMiB/totalMiB  |  util%  compute  |
    // Line 2: |  ...  |  ...  |  mig  |
    const l0 = lines[0] || '', l1 = lines[1] || '', l2 = lines[2] || '';
    const m0 = l0.match(/\|\s+(\d+)\s+(.*?)\s+(On|Off)\s+\|\s+(\S+)\s+(On|Off)\s+\|\s+(\S+)\s+\|/);
    const m1 = l1.match(/\|\s*(N\/A|\d+)\s+(\d+)C\s+(\S+)\s+(\d+)W\s*\/\s*(\d+)W\s+\|\s+(\d+)MiB\s*\/\s*(\d+)MiB\s+\|\s+(\d+)%\s+(\S+)\s+\|/);
    if (!m0 || !m1) return null;
    const m2 = l2.match(/\|\s*\|\s*\|\s+(\S+)\s+\|/);
    return {
      index:       m0[1],
      name:        m0[2].trim(),
      persistence: m0[3],
      busId:       m0[4],
      dispA:       m0[5],
      ecc:         m0[6],
      fan:         m1[1] === 'N/A' ? null : parseInt(m1[1]),
      temp:        parseInt(m1[2]),
      perf:        m1[3],
      pwrDraw:     parseInt(m1[4]),
      pwrCap:      parseInt(m1[5]),
      memUsed:     parseInt(m1[6]),
      memTotal:    parseInt(m1[7]),
      utilGpu:     parseInt(m1[8]),
      computeMode: m1[9],
      migMode:     m2?.[1] || null,
    };
  }

  /* ══════════════════════════════════════════════════════════════════════
   * GPU health — nvidia-smi --query-gpu CSV
   * Columns: index, name, temp.gpu, temp.mem, power.draw, power.limit,
   *          util.gpu, util.mem, mem.used, mem.free, mem.total,
   *          ecc.corrected, ecc.uncorrected, throttle_reasons
   * ══════════════════════════════════════════════════════════════════════ */
  function renderGpuHealthView(raw, container) {
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
    if (!lines.length) { container.textContent = raw; return; }

    const THROTTLE_REASONS = [
      [0x02,  'App Clock Setting'],
      [0x04,  'SW Power Cap'],
      [0x08,  'HW Slowdown'],
      [0x10,  'Sync Boost'],
      [0x20,  'SW Thermal Slowdown'],
      [0x40,  'HW Thermal Slowdown'],
      [0x80,  'HW Power Brake'],
      [0x100, 'Display Clock Setting'],
    ];

    function pn(s) { const n = parseFloat(s); return isNaN(n) ? null : n; }
    function strip(s, u) { return pn((s || '').replace(u, '')); }

    const gpus = lines.map(line => {
      const p = line.split(',').map(s => s.trim());
      return {
        index:          p[0],
        name:           p[1],
        tempGpu:        pn(p[2]),
        tempMem:        pn(p[3]),
        powerDraw:      strip(p[4], ' W'),
        powerLimit:     strip(p[5], ' W'),
        utilGpu:        strip(p[6], ' %'),
        utilMem:        strip(p[7], ' %'),
        memUsed:        strip(p[8], ' MiB'),
        memTotal:       strip(p[10], ' MiB'),
        eccCorrected:   pn(p[11]),
        eccUncorrected: pn(p[12]),
        throttleRaw:    (p[13] || '').trim(),
      };
    });

    function tempCls(t)    { return t === null ? '' : t >= 85 ? 'hv-crit' : t >= 70 ? 'hv-warn' : 'hv-ok'; }
    function pctCls(v)     { return v === null ? '' : v >= 90 ? 'hv-crit' : v >= 70 ? 'hv-warn' : 'hv-ok'; }
    function powerCls(d,l) { if (d === null || !l) return 'hv-ok'; const r = d/l; return r >= 0.95 ? 'hv-crit' : r >= 0.80 ? 'hv-warn' : 'hv-ok'; }

    function decodeThrottle(raw) {
      if (!raw || raw === 'N/A') return [];
      const val = parseInt(raw, 16);
      if (isNaN(val) || val === 0 || val === 1) return [];
      return THROTTLE_REASONS.filter(([mask]) => val & mask).map(([, name]) => name);
    }

    function bar(pct, cls) {
      return `<div class="hv-gauge-bar gpu-health-bar"><div class="hv-gauge-fill ${cls}" style="width:${pct}%"></div></div>`;
    }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap gpu-health-grid';

    wrap.innerHTML = gpus.map(g => {
      const memPct   = (g.memUsed !== null && g.memTotal) ? Math.min(Math.round(g.memUsed / g.memTotal * 100), 100) : null;
      const pwrPct   = (g.powerDraw !== null && g.powerLimit) ? Math.min(Math.round(g.powerDraw / g.powerLimit * 100), 100) : null;
      const memCls   = pctCls(memPct);
      const pwrCls   = powerCls(g.powerDraw, g.powerLimit);
      const throttled = decodeThrottle(g.throttleRaw);
      const eccBad   = g.eccUncorrected !== null && g.eccUncorrected > 0;
      const eccWarn  = !eccBad && g.eccCorrected !== null && g.eccCorrected > 0;

      return `
        <div class="gpu-health-card">
          <div class="gpu-health-hdr">
            <span class="gpu-proc-idx">GPU ${h(g.index)}</span>
            <span class="gpu-health-name">${h(g.name)}</span>
          </div>

          <div class="gpu-health-row">
            <div class="gpu-health-cell">
              <span class="gpu-health-lbl">GPU temp</span>
              <span class="gpu-health-val ${tempCls(g.tempGpu)}">${g.tempGpu !== null ? g.tempGpu + '°C' : '—'}</span>
            </div>
            <div class="gpu-health-cell">
              <span class="gpu-health-lbl">Mem temp</span>
              <span class="gpu-health-val ${tempCls(g.tempMem)}">${g.tempMem !== null ? g.tempMem + '°C' : '—'}</span>
            </div>
            <div class="gpu-health-cell">
              <span class="gpu-health-lbl">GPU util</span>
              <span class="gpu-health-val ${pctCls(g.utilGpu)}">${g.utilGpu !== null ? g.utilGpu + '%' : '—'}</span>
            </div>
            <div class="gpu-health-cell">
              <span class="gpu-health-lbl">Mem util</span>
              <span class="gpu-health-val ${pctCls(g.utilMem)}">${g.utilMem !== null ? g.utilMem + '%' : '—'}</span>
            </div>
          </div>

          <div class="gpu-health-metric">
            <div class="gpu-health-metric-hdr">
              <span class="gpu-health-lbl">Memory</span>
              <span class="gpu-health-val ${memCls}">${memPct !== null ? memPct + '%' : '—'}</span>
            </div>
            ${memPct !== null ? bar(memPct, memCls) : ''}
            <div class="gpu-health-sub">${g.memUsed !== null ? Math.round(g.memUsed) + ' MiB used' : ''} ${g.memTotal ? '· ' + Math.round(g.memTotal) + ' MiB total' : ''}</div>
          </div>

          <div class="gpu-health-metric">
            <div class="gpu-health-metric-hdr">
              <span class="gpu-health-lbl">Power</span>
              <span class="gpu-health-val ${pwrCls}">${g.powerDraw !== null ? g.powerDraw.toFixed(1) + ' W' : '—'}${g.powerLimit ? ' / ' + g.powerLimit.toFixed(0) + ' W' : ''}</span>
            </div>
            ${pwrPct !== null ? bar(pwrPct, pwrCls) : ''}
          </div>

          <div class="gpu-health-ecc ${eccBad ? 'gpu-health-ecc-bad' : eccWarn ? 'gpu-health-ecc-warn' : 'gpu-health-ecc-ok'}">
            <span class="gpu-health-lbl">ECC errors</span>
            <span class="gpu-health-ecc-vals">
              <span title="Corrected (volatile)">${g.eccCorrected ?? '—'} corrected</span>
              <span class="${eccBad ? 'hv-crit' : ''}" title="Uncorrected (volatile)">${g.eccUncorrected ?? '—'} uncorrected</span>
            </span>
          </div>

          ${throttled.length ? `
          <div class="gpu-health-throttle">
            <span class="gpu-health-lbl gpu-health-throttle-lbl">Clock throttled</span>
            <div class="gpu-health-throttle-tags">${throttled.map(r => `<span class="gpu-health-throttle-tag">${h(r)}</span>`).join('')}</div>
          </div>` : ''}
        </div>`;
    }).join('');

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * GPU processes — nvidia-smi pmon or --query-compute-apps
   * ══════════════════════════════════════════════════════════════════════ */
  function renderGpuProcessesView(raw, container) {
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
    if (!lines.length) { container.textContent = raw; return; }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    // pmon format: header lines start with '#'
    if (lines[0].startsWith('# gpu')) {
      const dataLines = lines.filter(l => !l.startsWith('#'));
      const active = dataLines.filter(l => {
        const parts = l.split(/\s+/);
        return parts[1] && parts[1] !== '-';
      });

      if (!active.length) {
        const idleHtml = dataLines.map(l => {
          const parts = l.split(/\s+/);
          return `<div class="gpu-proc-idle-row">
            <span class="gpu-proc-idx">GPU ${h(parts[0] || '?')}</span>
            <span class="gpu-proc-idle-lbl">No active processes</span>
          </div>`;
        }).join('');
        wrap.innerHTML = `<div class="gpu-proc-idle">${idleHtml}</div>`;
      } else {
        function metricCell(v) {
          const n = parseFloat(v);
          const cls = (!isNaN(n) && n > 0)
            ? (n >= 80 ? 'hv-crit' : n >= 40 ? 'hv-warn' : 'gpu-proc-active') : '';
          return `<td class="${cls}">${h(v === '-' ? '—' : v + '%')}</td>`;
        }
        const tableRows = active.map(l => {
          const [gpu, pid, type, sm, mem, enc, dec, , , ...cmdParts] = l.split(/\s+/);
          const cmd = cmdParts.join(' ') || '—';
          return `<tr>
            <td><span class="gpu-proc-idx">GPU ${h(gpu)}</span></td>
            <td class="gpu-proc-pid">${h(pid)}</td>
            <td><span class="gpu-proc-type gpu-proc-type-${h((type || '').toLowerCase())}">${h(type || '—')}</span></td>
            ${metricCell(sm)} ${metricCell(mem)} ${metricCell(enc)} ${metricCell(dec)}
            <td class="gpu-proc-cmd">${h(cmd)}</td>
          </tr>`;
        }).join('');
        wrap.innerHTML = `
          <div class="hv-top-table-wrap">
            <table class="hv-top-table">
              <thead><tr>
                <th>GPU</th><th>PID</th><th>Type</th>
                <th>SM %</th><th>Mem %</th><th>Enc %</th><th>Dec %</th>
                <th>Process</th>
              </tr></thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>`;
      }

    } else {
      // --query-compute-apps CSV: pid, used_gpu_memory, name
      const rows = lines
        .map(l => { const p = l.split(',').map(s => s.trim()); return { pid: p[0], mem: p[1], name: p[2] }; })
        .filter(r => r.pid && r.pid !== '-');

      if (!rows.length) {
        wrap.innerHTML = '<div class="gpu-proc-idle"><div class="gpu-proc-idle-row"><span class="gpu-proc-idle-lbl">No GPU compute processes running.</span></div></div>';
      } else {
        const tableRows = rows.map(r => `<tr>
          <td class="gpu-proc-pid">${h(r.pid)}</td>
          <td class="gpu-proc-mem">${h(r.mem)}</td>
          <td class="gpu-proc-cmd">${h(r.name)}</td>
        </tr>`).join('');
        wrap.innerHTML = `
          <div class="hv-top-table-wrap">
            <table class="hv-top-table">
              <thead><tr><th>PID</th><th>GPU Memory</th><th>Process</th></tr></thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>`;
      }
    }

    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Storage — Partition overview (filtered df -hT)
   * ══════════════════════════════════════════════════════════════════════ */
  function renderStoragePartitionsView(raw, container) {
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length < 2) { container.textContent = raw; return; }

    const rows = [];
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;
      const [fs, type, size, used, avail, usePct, ...rest] = parts;
      const mount = rest.join(' ');
      const p = parseInt(usePct);
      rows.push({ fs, type, size, used, avail, pct: isNaN(p) ? 0 : p, mount });
    }

    if (!rows.length) { container.textContent = raw; return; }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    const rowsHtml = rows.map(r => {
      const cls = colorCls(r.pct);
      return `
        <div class="hv-disk-row">
          <div class="hv-disk-header">
            <span class="hv-disk-mount">${h(r.mount)}</span>
            <span class="hv-disk-fs">${h(r.fs)} <span style="opacity:0.5;font-size:11px">${h(r.type)}</span></span>
            <div class="hv-disk-sizes">
              <span class="hv-disk-pct ${cls}">${r.pct}%</span>
              <span class="hv-disk-nums">${h(r.used)} used · ${h(r.avail)} free · ${h(r.size)} total</span>
            </div>
          </div>
          <div class="hv-disk-bar"><div class="hv-disk-fill ${cls}" style="width:${r.pct}%"></div></div>
        </div>`;
    }).join('');

    wrap.innerHTML = `<div class="hv-disk-list">${rowsHtml}</div>`;
    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Storage — du tree drill-down
   * ══════════════════════════════════════════════════════════════════════ */
  function renderStorageDuTreeView(raw, container) {
    const SECTION_LABELS = {
      stateful:  '/mnt/stateful_partition',
      var:       '/var',
      varlib:    '/var/lib',
      containerd: '/var/lib/containerd',
    };

    const sections = {};
    let cur = null;
    for (const line of raw.split('\n')) {
      const sec = line.match(/^=(stateful|var|varlib|containerd)=$/);
      if (sec) { cur = sec[1]; sections[cur] = []; continue; }
      if (cur && line.trim()) sections[cur].push(line.trim());
    }

    function parseHumanSize(s) {
      const m = (s || '').trim().match(/^([0-9.]+)\s*([KMGTP]?)/i);
      if (!m) return 0;
      const n = parseFloat(m[1]);
      const mul = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()] || 1;
      return n * mul;
    }

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    const order = ['stateful', 'var', 'varlib', 'containerd'];
    const sectionsHtml = order.filter(k => sections[k]?.length).map(key => {
      const entries = sections[key]
        .map(line => { const [size, ...pathParts] = line.split(/\t/); return { size: size.trim(), path: pathParts.join('\t').trim() }; })
        .filter(e => e.size && e.path);

      if (!entries.length) return '';

      const maxBytes = Math.max(...entries.map(e => parseHumanSize(e.size)), 1);

      const rowsHtml = entries.slice(0, 20).map(e => {
        const bytes = parseHumanSize(e.size);
        const pct = Math.min(Math.round(bytes / maxBytes * 100), 100);
        const cls = pct >= 80 ? 'hv-crit' : pct >= 50 ? 'hv-warn' : 'hv-ok';
        const name = e.path.replace(/^.*\//, '') || e.path;
        return `
          <div class="st-du-row">
            <div class="st-du-header">
              <span class="st-du-name" title="${h(e.path)}">${h(name)}</span>
              <span class="st-du-size ${pct >= 60 ? cls : ''}">${h(e.size)}</span>
            </div>
            <div class="hv-gauge-bar"><div class="hv-gauge-fill ${cls}" style="width:${pct}%"></div></div>
          </div>`;
      }).join('');

      return `
        <div class="st-du-section">
          <div class="st-du-section-title">${h(SECTION_LABELS[key] || key)}</div>
          <div class="st-du-rows">${rowsHtml}</div>
        </div>`;
    }).join('');

    wrap.innerHTML = sectionsHtml || '<div class="hv-info-note">No du data available — path may not exist on this node.</div>';
    container.innerHTML = '';
    container.className = '';
    container.appendChild(wrap);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Storage — Top containers by snapshot disk usage
   * Parses three sections from the compound command:
   *   =SNAPS=  du -d 1 …/snapshots  (bytes\tpath)
   *   =MOUNTS= mount | grep snapshots
   *   =CRICTL= crictl ps -a
   * ══════════════════════════════════════════════════════════════════════ */
  function renderStorageContainersView(raw, container) {
    const sections = {};
    let cur = null;
    for (const line of raw.split('\n')) {
      const sec = line.match(/^=(SNAPS|MOUNTS|CRICTL)=$/);
      if (sec) { cur = sec[1]; sections[cur] = []; continue; }
      if (cur && line.trim()) sections[cur].push(line);
    }

    // 1. Parse snapshot sizes: "1234567\t/path/snapshots/932" → snapId → KB
    const snapKb = new Map();
    for (const line of (sections.SNAPS || [])) {
      const m = line.match(/^(\d+)\s+.*\/(\d+)\s*$/);
      if (m) snapKb.set(m[2], parseInt(m[1]));
    }

    // 2. Build snapId → containerHash from overlay mount lines.
    //    Mount target contains: /k8s.io/{64-char-hash}/rootfs
    //    Mount options contain: snapshots/NNN/ references
    const snapToHash = new Map();
    for (const line of (sections.MOUNTS || [])) {
      const hashM = line.match(/\/k8s\.io\/([a-f0-9]{64})\//);
      if (!hashM) continue;
      const hash = hashM[1];
      for (const m of line.matchAll(/snapshots\/(\d+)\//g)) {
        if (!snapToHash.has(m[1])) snapToHash.set(m[1], hash);
      }
    }

    // 3. Parse crictl ps -a using header positions for fixed-width columns.
    const hashToInfo = new Map();
    const crictlLines = (sections.CRICTL || []).filter(l => l.trim());
    if (crictlLines.length > 1) {
      const header = crictlLines[0];
      const colStarts = {
        CONTAINER: header.indexOf('CONTAINER'),
        IMAGE:     header.indexOf('IMAGE'),
        STATE:     header.indexOf('STATE'),
        NAME:      header.indexOf('NAME'),
        POD:       header.lastIndexOf('POD'),
      };
      for (const line of crictlLines.slice(1)) {
        if (line.startsWith('CONTAINER')) continue;
        function col(start, end) {
          return end > start ? line.substring(start, end).trim() : line.substring(start).trim();
        }
        const id    = col(colStarts.CONTAINER, colStarts.IMAGE);
        const state = col(colStarts.STATE, colStarts.NAME);
        const name  = col(colStarts.NAME, colStarts.POD);
        const pod   = line.substring(colStarts.POD).trim();
        if (!id) continue;
        const info = { state, name, pod: pod || name };
        hashToInfo.set(id, info);
        if (id.length > 12) hashToInfo.set(id.substring(0, 12), info);
      }
    }

    // 4. Build ranked rows: snapId sorted by KB desc → join hash → join container info
    const rows = [...snapKb.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([snapId, kb]) => {
        const hash = snapToHash.get(snapId);
        const info = hash
          ? (hashToInfo.get(hash) || hashToInfo.get(hash.substring(0, 12)))
          : null;
        return { snapId, kb, hash, info };
      });

    const wrap = document.createElement('div');
    wrap.className = 'hv-wrap';

    if (!rows.length) {
      wrap.innerHTML = '<div class="hv-info-note">No containerd overlayfs snapshot data found. The snapshotter path may differ on this node.</div>';
      container.innerHTML = '';
      container.appendChild(wrap);
      return;
    }

    const totalKb = [...snapKb.values()].reduce((a, b) => a + b, 0);
    const mappedCount = rows.filter(r => r.info).length;
    const maxKb = rows[0].kb || 1;

    const listHtml = rows.map((r, i) => {
      const pct = Math.min(Math.round(r.kb / maxKb * 100), 100);
      const cls  = r.kb >= maxKb * 0.5 ? 'hv-crit' : r.kb >= maxKb * 0.2 ? 'hv-warn' : 'hv-ok';
      const stateCls = r.info?.state === 'Running' ? 'hv-ok' : r.info?.state ? 'hv-warn' : '';
      const podLabel  = r.info?.pod  || (r.hash ? r.hash.substring(0, 16) + '…' : '—');
      const nameLabel = r.info?.name || '';
      return `
        <div class="st-cont-row">
          <div class="st-cont-header">
            <span class="st-cont-rank">#${i + 1}</span>
            <div class="st-cont-names">
              <span class="st-cont-pod">${h(podLabel)}</span>
              ${nameLabel ? `<span class="st-cont-name">${h(nameLabel)}</span>` : ''}
            </div>
            ${r.info?.state ? `<span class="st-cont-state ${stateCls}">${h(r.info.state)}</span>` : ''}
            <span class="st-cont-size ${cls}">${hBytes(r.kb)}</span>
          </div>
          <div class="hv-gauge-bar st-cont-bar">
            <div class="hv-gauge-fill ${cls}" style="width:${pct}%"></div>
          </div>
          <div class="st-cont-meta">
            <span class="st-cont-meta-tag">snap #${h(r.snapId)}</span>
            ${r.hash ? `<span class="st-cont-meta-tag">${h(r.hash.substring(0, 20))}…</span>` : '<span class="st-cont-meta-unmapped">unmapped</span>'}
          </div>
        </div>`;
    }).join('');

    wrap.innerHTML = `
      <div class="hv-info-note">
        Containerd overlayfs snapshot layers ranked by disk usage. Active layers are mapped to pods via overlay mounts and crictl.
        Prune dangling images with: <code>nsenter -t 1 -m -u -i -n -p -- crictl rmi --prune</code>
      </div>
      <div class="st-summary">
        <div class="hv-grid-item">
          <div class="hv-grid-label">Snapshots tracked</div>
          <div class="hv-grid-val">${snapKb.size}</div>
        </div>
        <div class="hv-grid-item">
          <div class="hv-grid-label">Mapped to pods</div>
          <div class="hv-grid-val">${mappedCount} / ${rows.length}</div>
        </div>
        <div class="hv-grid-item">
          <div class="hv-grid-label">Total snapshot storage</div>
          <div class="hv-grid-val">${hBytes(totalKb)}</div>
        </div>
      </div>
      <div class="st-cont-list">${listHtml}</div>`;

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
  window.renderGpuInfoView              = renderGpuInfoView;
  window.renderGpuHealthView            = renderGpuHealthView;
  window.renderGpuProcessesView         = renderGpuProcessesView;
  window.renderStoragePartitionsView    = renderStoragePartitionsView;
  window.renderStorageDuTreeView        = renderStorageDuTreeView;
  window.renderStorageContainersView    = renderStorageContainersView;

})();

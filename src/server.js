'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const k8s = require('./k8s');
const { PROBES } = require('./probes');

/**
 * Builds and starts the debugger server. `session` holds the pod that was
 * created for the target node; everything in the UI operates against it.
 */
function createServer(session) {
  // session: { node, podName, namespace, context, kubeconfig }
  const podOpts = () => ({
    namespace: session.namespace,
    context: session.context,
    kubeconfig: session.kubeconfig,
  });

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/session', (req, res) => {
    res.json({
      node: session.node,
      podName: session.podName,
      namespace: session.namespace,
      context: session.context || null,
      image: k8s.DEBUG_IMAGE,
      probes: PROBES.map(({ id, label, group, desc }) => ({ id, label, group, desc })),
    });
  });

  app.get('/api/nodes', async (req, res) => {
    try {
      res.json(await k8s.listNodes(podOpts()));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run a single named probe (with built-in command fallbacks).
  app.get('/api/probe/:id', async (req, res) => {
    const probe = PROBES.find((p) => p.id === req.params.id);
    if (!probe) return res.status(404).json({ error: 'unknown probe' });

    let last = null;
    for (const command of probe.commands) {
      const result = await k8s.execInPod(session.podName, command, podOpts());
      last = { ...result, command };
      if (result.ok && result.stdout.trim()) break;
    }
    res.json({
      id: probe.id,
      label: probe.label,
      command: last.command,
      ok: last.ok,
      output: last.stdout || '',
      error: last.ok ? last.stderr : last.stderr || last.stdout,
    });
  });

  // Connectivity prober — runs nc/curl/ping from the debug pod and
  // correlates with conntrack entries for the target IP.
  app.post('/api/connectivity', async (req, res) => {
    const { target, port, protocol = 'tcp' } = req.body || {};
    if (!target) return res.status(400).json({ error: 'target required' });

    const opts = { ...podOpts(), timeout: 30000 };
    const portArg = port ? String(port) : '';
    const results = {};

    // Ping (ICMP reachability)
    const ping = await k8s.execInPod(session.podName,
      `ping -c 3 -W 2 ${target} 2>&1`, opts);
    results.ping = { ok: ping.ok, output: ping.stdout + ping.stderr };

    // TCP / HTTP / HTTPS
    if (protocol === 'http' || protocol === 'https') {
      const url = `${protocol}://${target}${portArg ? ':' + portArg : ''}`;
      const curl = await k8s.execInPod(session.podName,
        `curl -sv --connect-timeout 5 --max-time 10 "${url}" 2>&1 | head -80`, opts);
      results.curl = { ok: curl.ok, output: curl.stdout + curl.stderr, url };
    } else if (portArg) {
      const nc = await k8s.execInPod(session.podName,
        `nc -zv -w 5 ${target} ${portArg} 2>&1`, opts);
      results.nc = { ok: nc.ok, output: nc.stdout + nc.stderr };
    }

    // DNS resolution
    const dns = await k8s.execInPod(session.podName,
      `getent hosts ${target} 2>&1 || nslookup ${target} 2>&1 | head -20`, opts);
    results.dns = { ok: dns.ok, output: dns.stdout + dns.stderr };

    // Matching conntrack entries
    const ct = await k8s.execInPod(session.podName,
      `conntrack -L 2>/dev/null | grep -F "${target}" | head -20`, opts);
    results.conntrack = { ok: ct.ok, output: ct.stdout };

    // Trace route (best-effort)
    const tr = await k8s.execInPod(session.podName,
      `traceroute -n -m 10 -w 1 ${target} 2>&1 || tracepath -n ${target} 2>&1 | head -20`, opts);
    results.traceroute = { ok: tr.ok, output: tr.stdout + tr.stderr };

    res.json({ target, port: portArg || null, protocol, results });
  });

  // Arbitrary command execution from the UI.
  app.post('/api/exec', async (req, res) => {
    const command = (req.body && req.body.command || '').trim();
    if (!command) return res.status(400).json({ error: 'command required' });
    const result = await k8s.execInPod(session.podName, command, {
      ...podOpts(),
      timeout: 120000,
    });
    res.json({
      command,
      ok: result.ok,
      output: result.stdout || '',
      error: result.stderr || '',
    });
  });

  const server = http.createServer(app);

  // ---- Streaming terminal over WebSocket ----------------------------------
  // Each connection runs one command at a time; long-running commands
  // (tcpdump, conntrack -E, ping) stream until the client sends a signal.
  const wss = new WebSocketServer({ server, path: '/ws/term' });
  wss.on('connection', (ws) => {
    let current = null;

    const send = (type, data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
    };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'run') {
        const command = (msg.command || '').trim();
        if (!command) return;
        if (current) {
          send('stderr', '\r\n[a command is already running — interrupt it first]\r\n');
          return;
        }
        send('started', command);
        const child = k8s.streamInPod(session.podName, command, podOpts());
        current = child;
        child.stdout.on('data', (d) => send('stdout', d.toString()));
        child.stderr.on('data', (d) => send('stderr', d.toString()));
        child.on('close', (code) => {
          current = null;
          send('exit', code);
        });
        child.on('error', (err) => {
          current = null;
          send('stderr', `\r\n[exec error] ${err.message}\r\n`);
          send('exit', -1);
        });
      } else if (msg.type === 'signal') {
        if (current) {
          current.kill(msg.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGINT');
        }
      } else if (msg.type === 'stdin') {
        if (current && current.stdin.writable) current.stdin.write(msg.data);
      }
    });

    ws.on('close', () => {
      if (current) current.kill('SIGKILL');
    });
  });

  return server;
}

module.exports = { createServer };

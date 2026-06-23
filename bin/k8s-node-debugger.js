#!/usr/bin/env node
'use strict';

const k8s = require('../src/k8s');
const { createServer } = require('../src/server');

function parseArgs(argv) {
  const opts = { namespace: 'default', port: 7878, open: true };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-n':
      case '--namespace':
        opts.namespace = argv[++i];
        break;
      case '--context':
        opts.context = argv[++i];
        break;
      case '--kubeconfig':
        opts.kubeconfig = argv[++i];
        break;
      case '-p':
      case '--port':
        opts.port = parseInt(argv[++i], 10);
        break;
      case '--no-open':
        opts.open = false;
        break;
      case '--keep':
        opts.keep = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        positional.push(a);
    }
  }
  opts.node = positional[0];
  return opts;
}

function usage() {
  console.log(`
k8s-node-debugger — inspect a node's network stack from your browser.

Usage:
  k8s-node-debugger <node-name> [options]
  k8s-node-debugger --list                 # list nodes and exit

Options:
  -n, --namespace <ns>    Namespace for the debug pod      (default: default)
      --context <ctx>     kubeconfig context to use        (default: current)
      --kubeconfig <path> Explicit kubeconfig path
  -p, --port <port>       UI port                          (default: 7878)
      --no-open           Don't auto-open the browser
      --keep              Leave the debug pod running on exit
  -h, --help              Show this help

The active kubeconfig on your shell is used. A privileged pod
(${k8s.DEBUG_IMAGE}) is created on the target node with
hostNetwork/hostPID and the host root mounted at /host.
`);
}

async function openBrowser(url) {
  try {
    const open = (await import('open')).default;
    await open(url);
  } catch {
    /* optional dependency / headless env — ignore */
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) return usage();

  const baseOpts = {
    context: opts.context,
    kubeconfig: opts.kubeconfig,
    namespace: opts.namespace,
  };

  if (opts.node === '--list' || opts.list) {
    const nodes = await k8s.listNodes(baseOpts);
    console.log(`\nNodes (context: ${(await k8s.currentContext(baseOpts)) || 'n/a'}):\n`);
    for (const n of nodes) {
      console.log(
        `  ${n.ready ? '●' : '○'} ${n.name}` +
          `${n.roles.length ? `  [${n.roles.join(',')}]` : ''}` +
          `  ${n.internalIP || ''}  ${n.os || ''}`
      );
    }
    console.log('');
    return;
  }

  if (!opts.node) {
    usage();
    console.error('error: a node name is required (or use --list).\n');
    process.exit(1);
  }

  const ctx = (await k8s.currentContext(baseOpts)) || 'current';
  console.log(`\n▶ context: ${ctx}`);
  console.log(`▶ target node: ${opts.node}`);
  console.log(`▶ creating privileged debug pod (${k8s.DEBUG_IMAGE})...`);

  let session;
  try {
    const { podName, namespace } = await k8s.createDebugPod(opts.node, baseOpts);
    session = {
      node: opts.node,
      podName,
      namespace,
      context: opts.context,
      kubeconfig: opts.kubeconfig,
    };
    console.log(`▶ pod: ${namespace}/${podName} — waiting for Ready...`);
    await k8s.waitForPodReady(podName, baseOpts);
    console.log('▶ pod is Ready.');
  } catch (err) {
    console.error(`\n✖ failed to start debug pod: ${err.message}`);
    if (session && session.podName && !opts.keep) {
      await k8s.deletePod(session.podName, baseOpts);
    }
    process.exit(1);
  }

  const server = createServer(session);

  let cleaningUp = false;
  const cleanup = async (code = 0) => {
    if (cleaningUp) return;
    cleaningUp = true;
    server.close();
    if (!opts.keep) {
      console.log(`\n▶ deleting debug pod ${session.namespace}/${session.podName}...`);
      await k8s.deletePod(session.podName, baseOpts);
      console.log('▶ done.');
    } else {
      console.log(
        `\n▶ leaving pod ${session.namespace}/${session.podName} running ` +
          `(remove with: kubectl delete pod ${session.podName} -n ${session.namespace}).`
      );
    }
    process.exit(code);
  };

  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));

  server.listen(opts.port, () => {
    const url = `http://localhost:${opts.port}`;
    console.log(`\n✓ UI ready → ${url}`);
    console.log('  (press Ctrl-C to stop and clean up the pod)\n');
    if (opts.open) openBrowser(url);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

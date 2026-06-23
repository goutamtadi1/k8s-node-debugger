'use strict';

const { spawn, execFile } = require('child_process');

/**
 * Thin wrapper around the `kubectl` binary on the user's PATH. It deliberately
 * shells out to kubectl so the active kubeconfig / current-context (including
 * any exec auth plugins, e.g. EKS/GKE) is reused exactly as on the shell.
 */

const KUBECTL = process.env.KUBECTL_BIN || 'kubectl';
const DEBUG_IMAGE = process.env.DEBUGGER_IMAGE || 'nicolaka/netshoot:latest';

function kubectl(args, { input, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      KUBECTL,
      args,
      { timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          err.message = stderr?.trim() || err.message;
          return reject(err);
        }
        resolve({ stdout, stderr });
      }
    );
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function buildKubectlArgs(extra, { context, kubeconfig } = {}) {
  const args = [];
  if (kubeconfig) args.push('--kubeconfig', kubeconfig);
  if (context) args.push('--context', context);
  return args.concat(extra);
}

async function currentContext(opts = {}) {
  try {
    const { stdout } = await kubectl(
      buildKubectlArgs(['config', 'current-context'], opts)
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

async function listNodes(opts = {}) {
  const { stdout } = await kubectl(
    buildKubectlArgs(['get', 'nodes', '-o', 'json'], opts)
  );
  const data = JSON.parse(stdout);
  return (data.items || []).map((n) => {
    const addr = (n.status?.addresses || []).reduce((acc, a) => {
      acc[a.type] = a.address;
      return acc;
    }, {});
    const conditions = (n.status?.conditions || []).reduce((acc, c) => {
      acc[c.type] = c.status;
      return acc;
    }, {});
    return {
      name: n.metadata?.name,
      roles: Object.keys(n.metadata?.labels || {})
        .filter((l) => l.startsWith('node-role.kubernetes.io/'))
        .map((l) => l.replace('node-role.kubernetes.io/', '') || 'control-plane')
        .filter(Boolean),
      ready: conditions.Ready === 'True',
      internalIP: addr.InternalIP,
      hostname: addr.Hostname,
      os: n.status?.nodeInfo?.osImage,
      kernel: n.status?.nodeInfo?.kernelVersion,
      kubelet: n.status?.nodeInfo?.kubeletVersion,
      runtime: n.status?.nodeInfo?.containerRuntimeVersion,
    };
  });
}

function debugPodManifest(node, podName, namespace) {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace,
      labels: { app: 'k8s-node-debugger' },
    },
    spec: {
      nodeName: node,
      hostNetwork: true,
      hostPID: true,
      hostIPC: true,
      restartPolicy: 'Never',
      // Schedule onto control-plane / tainted nodes too.
      tolerations: [{ operator: 'Exists' }],
      containers: [
        {
          name: 'debugger',
          image: DEBUG_IMAGE,
          imagePullPolicy: 'IfNotPresent',
          command: ['sleep', 'infinity'],
          securityContext: {
            privileged: true,
            runAsUser: 0,
          },
          volumeMounts: [{ name: 'host-root', mountPath: '/host' }],
        },
      ],
      volumes: [{ name: 'host-root', hostPath: { path: '/' } }],
    },
  });
}

async function createDebugPod(node, { namespace = 'default', context, kubeconfig } = {}) {
  const suffix = node.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
  const podName = `node-debugger-${suffix}-${process.pid.toString(36)}`;
  const opts = { context, kubeconfig };
  const manifest = debugPodManifest(node, podName, namespace);
  await kubectl(
    buildKubectlArgs(['apply', '-n', namespace, '-f', '-'], opts),
    { input: manifest }
  );
  return { podName, namespace };
}

async function waitForPodReady(podName, { namespace = 'default', context, kubeconfig, timeout = 120 } = {}) {
  await kubectl(
    buildKubectlArgs(
      ['wait', '-n', namespace, `pod/${podName}`, '--for=condition=Ready', `--timeout=${timeout}s`],
      { context, kubeconfig }
    ),
    { timeout: (timeout + 10) * 1000 }
  );
}

async function deletePod(podName, { namespace = 'default', context, kubeconfig } = {}) {
  try {
    await kubectl(
      buildKubectlArgs(
        ['delete', 'pod', podName, '-n', namespace, '--ignore-not-found', '--wait=false'],
        { context, kubeconfig }
      )
    );
  } catch {
    /* best effort */
  }
}

/** Run a one-shot command inside the debug pod, returning combined output. */
async function execInPod(podName, command, { namespace = 'default', context, kubeconfig, timeout = 60000 } = {}) {
  const args = buildKubectlArgs(
    ['exec', '-n', namespace, podName, '--', 'sh', '-c', command],
    { context, kubeconfig }
  );
  try {
    const { stdout, stderr } = await kubectl(args, { timeout });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || String(err),
    };
  }
}

/**
 * Spawn a streaming command in the pod. Returns the ChildProcess so callers can
 * pipe stdout/stderr (e.g. tcpdump) over a websocket and kill it on demand.
 */
function streamInPod(podName, command, { namespace = 'default', context, kubeconfig } = {}) {
  const args = buildKubectlArgs(
    ['exec', '-i', '-n', namespace, podName, '--', 'sh', '-c', command],
    { context, kubeconfig }
  );
  return spawn(KUBECTL, args);
}

module.exports = {
  KUBECTL,
  DEBUG_IMAGE,
  currentContext,
  listNodes,
  createDebugPod,
  waitForPodReady,
  deletePod,
  execInPod,
  streamInPod,
};

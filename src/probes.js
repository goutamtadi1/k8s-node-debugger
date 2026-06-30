'use strict';

/**
 * Network-debug "probes". Because the debug pod runs with hostNetwork/hostPID,
 * commands like iptables-save / conntrack / ip run directly against the node's
 * host network namespace. Files that kubelet would otherwise override for the
 * pod (resolv.conf) are read from the mounted host root at /host.
 *
 * Each probe declares fallback commands tried in order until one succeeds, so a
 * single id works across legacy-iptables and nft-based nodes.
 */

const PROBES = [
  {
    id: 'iptables',
    label: 'iptables',
    group: 'Firewall',
    desc: 'Full iptables ruleset (host network namespace).',
    commands: ['iptables-save', 'iptables-legacy-save', 'iptables -S'],
  },
  {
    id: 'iptables-nat',
    label: 'iptables (nat)',
    group: 'Firewall',
    desc: 'NAT table — where kube-proxy / CNI install service & SNAT rules.',
    commands: ['iptables-save -t nat', 'iptables -t nat -S'],
  },
  {
    id: 'nftables',
    label: 'nftables',
    group: 'Firewall',
    desc: 'nftables ruleset (modern kube-proxy / firewalls).',
    commands: ['nft list ruleset'],
  },
  {
    id: 'ipvs',
    label: 'IPVS',
    group: 'Firewall',
    desc: 'IPVS virtual servers (kube-proxy ipvs mode).',
    commands: ['ipvsadm -ln', 'ipvsadm -L -n'],
  },
  {
    id: 'resolv',
    label: 'resolv.conf',
    group: 'DNS',
    desc: "The node's /etc/resolv.conf (enters host mount namespace via nsenter so symlinks resolve correctly).",
    // On many distros /etc/resolv.conf is a symlink (e.g. → /run/systemd/resolve/stub-resolv.conf).
    // `cat /host/etc/resolv.conf` fails because the kernel resolves that symlink against the
    // container root, not /host. nsenter --mount enters the host mount namespace, so all paths
    // and symlinks resolve exactly as they would on the node itself.
    commands: [
      'nsenter --mount=/proc/1/ns/mnt -- cat /etc/resolv.conf',
      'chroot /host cat /etc/resolv.conf',
      'cat /host/etc/resolv.conf',
    ],
  },
  {
    id: 'nsswitch',
    label: 'nsswitch.conf',
    group: 'DNS',
    desc: 'Host name-resolution order (/etc/nsswitch.conf).',
    commands: [
      'nsenter --mount=/proc/1/ns/mnt -- cat /etc/nsswitch.conf',
      'chroot /host cat /etc/nsswitch.conf',
      'cat /host/etc/nsswitch.conf',
    ],
  },
  {
    id: 'hosts',
    label: '/etc/hosts',
    group: 'DNS',
    desc: 'Static host entries on the node.',
    commands: [
      'nsenter --mount=/proc/1/ns/mnt -- cat /etc/hosts',
      'chroot /host cat /etc/hosts',
      'cat /host/etc/hosts',
    ],
  },
  {
    id: 'conntrack',
    label: 'conntrack table',
    group: 'Conntrack',
    desc: 'Live connection tracking table.',
    commands: ['conntrack -L', 'cat /host/proc/net/nf_conntrack'],
  },
  {
    id: 'conntrack-stats',
    label: 'conntrack stats',
    group: 'Conntrack',
    desc: 'Per-CPU conntrack counters (insert, drop, early_drop...).',
    commands: ['conntrack -S'],
  },
  {
    id: 'conntrack-count',
    label: 'conntrack count / max',
    group: 'Conntrack',
    desc: 'Current entry count and configured maximum.',
    commands: [
      'echo "count: $(cat /proc/sys/net/netfilter/nf_conntrack_count)"; echo "max:   $(cat /proc/sys/net/netfilter/nf_conntrack_max)"',
    ],
  },
  {
    id: 'routes',
    label: 'routes (v4)',
    group: 'Routing',
    desc: 'IPv4 routing table.',
    commands: ['ip route show', 'route -n'],
  },
  {
    id: 'routes6',
    label: 'routes (v6)',
    group: 'Routing',
    desc: 'IPv6 routing table.',
    commands: ['ip -6 route show'],
  },
  {
    id: 'rules',
    label: 'routing rules',
    group: 'Routing',
    desc: 'Policy routing rules (ip rule).',
    commands: ['ip rule show'],
  },
  {
    id: 'interfaces',
    label: 'interfaces',
    group: 'Interfaces',
    desc: 'All network interfaces and addresses.',
    commands: ['ip -d addr show', 'ip addr show'],
  },
  {
    id: 'links',
    label: 'links',
    group: 'Interfaces',
    desc: 'Link layer details and statistics.',
    commands: ['ip -s link show'],
  },
  {
    id: 'neigh',
    label: 'ARP / neighbors',
    group: 'Interfaces',
    desc: 'ARP / neighbor cache.',
    commands: ['ip neigh show'],
  },
  {
    id: 'sockets',
    label: 'listening sockets',
    group: 'Sockets',
    desc: 'TCP/UDP listening sockets with owning process.',
    commands: ['ss -tulpn', 'netstat -tulpn'],
  },
  {
    id: 'sockets-all',
    label: 'all sockets',
    group: 'Sockets',
    desc: 'All TCP/UDP sockets and their states.',
    commands: ['ss -tanp', 'netstat -tanp'],
  },
  {
    id: 'sysctl-net',
    label: 'net sysctls',
    group: 'Kernel',
    desc: 'Key networking sysctls (forwarding, rp_filter, conntrack...).',
    commands: [
      "sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.bridge.bridge-nf-call-iptables net.netfilter.nf_conntrack_max net.ipv4.tcp_syncookies 2>/dev/null",
    ],
  },

  // ── Health ──────────────────────────────────────────────────────────
  {
    id: 'mem-info',
    label: 'Memory',
    group: 'Health',
    desc: 'Node memory usage, buffers, cache, and swap from /proc/meminfo.',
    commands: ['cat /proc/meminfo'],
  },
  {
    id: 'mem-pressure',
    label: 'PSI pressure',
    group: 'Health',
    desc: 'Linux Pressure Stall Information (PSI) for CPU, memory, and I/O — non-zero avg10 indicates resource contention.',
    commands: [
      'echo "=cpu="; cat /proc/pressure/cpu 2>/dev/null || echo "n/a"; echo "=memory="; cat /proc/pressure/memory 2>/dev/null || echo "n/a"; echo "=io="; cat /proc/pressure/io 2>/dev/null || echo "n/a"',
    ],
  },
  {
    id: 'oom-kills',
    label: 'OOM kills',
    group: 'Health',
    desc: 'OOM kill events from the kernel ring buffer (dmesg). Empty means no OOM events since last boot.',
    commands: [
      'nsenter --mount=/proc/1/ns/mnt -- dmesg --time-format=iso 2>/dev/null | grep -iE "oom|out of memory|killed process|oom_kill" | tail -60',
      'nsenter --mount=/proc/1/ns/mnt -- dmesg 2>/dev/null | grep -iE "oom|out of memory|killed process|oom_kill" | tail -60',
      'dmesg | grep -iE "oom|out of memory|killed process|oom_kill" | tail -60',
    ],
  },
  {
    id: 'kubelet-logs',
    label: 'kubelet logs',
    group: 'Health',
    desc: 'Last 100 kubelet log lines — look for eviction events, node conditions, and errors.',
    commands: [
      'nsenter --mount=/proc/1/ns/mnt -- journalctl -u kubelet --no-pager -n 100 --output=short-iso 2>/dev/null',
      'nsenter --mount=/proc/1/ns/mnt -- journalctl -u kubelet --no-pager -n 100 2>/dev/null',
    ],
  },
  {
    id: 'disk-usage',
    label: 'Disk usage',
    group: 'Health',
    desc: 'Filesystem disk usage on the node (df -h). High /var/lib/kubelet or /var/lib/containerd usage triggers disk-pressure eviction.',
    commands: ['df -h', 'df -hT'],
  },
  {
    id: 'cpu-stat',
    label: 'CPU & load',
    group: 'Health',
    desc: 'Load averages, CPU count, and top CPU-consuming processes.',
    commands: [
      'echo "=loadavg="; cat /proc/loadavg; echo "=nproc="; nproc --all; echo "=cpumodel="; grep "model name" /proc/cpuinfo | head -1 | cut -d: -f2; echo "=procstat="; cat /proc/stat | head -1; echo "=topproc="; ps aux --sort=-%cpu | head -16',
    ],
  },

  // ── Storage ─────────────────────────────────────────────────────────
  {
    id: 'storage-partitions',
    label: 'Partitions',
    group: 'Storage',
    desc: 'Real physical host partitions (tmpfs, devtmpfs, shm, overlay filtered out). Identifies the true data-hosting disk.',
    commands: [
      "nsenter -t 1 -m -- df -hT 2>/dev/null | grep -vE '^tmpfs|^devtmpfs|^overlay|^shm'",
      "df -hT | grep -vE '^tmpfs|^devtmpfs|^overlay|^shm'",
    ],
  },
  {
    id: 'storage-du-tree',
    label: 'Folder drill-down',
    group: 'Storage',
    desc: 'Layered du drill-down — stateful partition → /var → /var/lib → containerd — to pinpoint space consumers at each level.',
    commands: [
      "echo '=stateful='; nsenter -t 1 -m -- du -h -d 1 /mnt/stateful_partition 2>/dev/null | sort -h -r; echo '=var='; nsenter -t 1 -m -- du -h -d 1 /mnt/stateful_partition/var 2>/dev/null | sort -h -r; echo '=varlib='; nsenter -t 1 -m -- du -h -d 1 /mnt/stateful_partition/var/lib 2>/dev/null | sort -h -r; echo '=containerd='; nsenter -t 1 -m -- du -h -d 1 /mnt/stateful_partition/var/lib/containerd 2>/dev/null | sort -h -r",
      "echo '=stateful='; du -h -d 1 /mnt/stateful_partition 2>/dev/null | sort -h -r; echo '=var='; du -h -d 1 /mnt/stateful_partition/var 2>/dev/null | sort -h -r; echo '=varlib='; du -h -d 1 /mnt/stateful_partition/var/lib 2>/dev/null | sort -h -r; echo '=containerd='; du -h -d 1 /mnt/stateful_partition/var/lib/containerd 2>/dev/null | sort -h -r",
      "echo '=varlib='; du -h -d 1 /var/lib 2>/dev/null | sort -h -r; echo '=containerd='; du -h -d 1 /var/lib/containerd 2>/dev/null | sort -h -r",
    ],
  },
  {
    id: 'storage-containers',
    label: 'Top containers',
    group: 'Storage',
    desc: 'Ranked list of containers by disk usage. Maps containerd snapshot sizes to pod names via overlay mounts and crictl.',
    commands: [
      "echo '=SNAPS='; nsenter -t 1 -m -- du -d 1 /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots 2>/dev/null | sort -rn | head -40; echo '=MOUNTS='; nsenter -t 1 -m -- mount 2>/dev/null | grep snapshots; echo '=CRICTL='; nsenter -t 1 -m -u -i -n -p -- crictl ps -a 2>/dev/null",
      "echo '=SNAPS='; du -d 1 /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots 2>/dev/null | sort -rn | head -40; echo '=MOUNTS='; mount 2>/dev/null | grep snapshots; echo '=CRICTL='; crictl ps -a 2>/dev/null",
    ],
  },

  // ── GPU ─────────────────────────────────────────────────────────────
  {
    id: 'gpu-info',
    label: 'GPU status',
    group: 'GPU',
    desc: 'NVIDIA GPU status via nvidia-smi. Only relevant on GPU-enabled nodes.',
    commands: [
      'nvidia-smi',
      'nsenter --mount=/proc/1/ns/mnt -- nvidia-smi 2>/dev/null',
      'echo "nvidia-smi not available — no GPU detected on this node."',
    ],
  },
  {
    id: 'gpu-processes',
    label: 'GPU processes',
    group: 'GPU',
    desc: 'Processes currently consuming GPU memory.',
    commands: [
      'nvidia-smi --query-compute-apps=pid,used_gpu_memory,name --format=csv,noheader 2>/dev/null | sort -t, -k2 -rn | head -30',
      'nsenter --mount=/proc/1/ns/mnt -- nvidia-smi --query-compute-apps=pid,used_gpu_memory,name --format=csv,noheader | sort -t, -k2 -rn | head -30',
      'nvidia-smi pmon -s u -c 1 2>/dev/null',
      'nsenter --mount=/proc/1/ns/mnt -- nvidia-smi pmon -s u -c 1',
      'echo "nvidia-smi not available — no GPU detected on this node."',
    ],
  },
  {
    id: 'gpu-health',
    label: 'GPU health',
    group: 'GPU',
    desc: 'Per-GPU temperature, power, utilization, memory, ECC errors, and clock throttle reasons.',
    commands: [
      'nvidia-smi --query-gpu=index,name,temperature.gpu,temperature.memory,power.draw,power.limit,utilization.gpu,utilization.memory,memory.used,memory.free,memory.total,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total,clocks_throttle_reasons.active --format=csv,noheader 2>/dev/null',
      'nsenter --mount=/proc/1/ns/mnt -- nvidia-smi --query-gpu=index,name,temperature.gpu,temperature.memory,power.draw,power.limit,utilization.gpu,utilization.memory,memory.used,memory.free,memory.total,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total,clocks_throttle_reasons.active --format=csv,noheader',
      'echo "nvidia-smi not available — no GPU detected on this node."',
    ],
  },
];

module.exports = { PROBES };

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
    desc: "The node's /etc/resolv.conf (read from the mounted host root).",
    commands: ['cat /host/etc/resolv.conf'],
  },
  {
    id: 'nsswitch',
    label: 'nsswitch.conf',
    group: 'DNS',
    desc: 'Host name-resolution order (/etc/nsswitch.conf).',
    commands: ['cat /host/etc/nsswitch.conf'],
  },
  {
    id: 'hosts',
    label: '/etc/hosts',
    group: 'DNS',
    desc: 'Static host entries on the node.',
    commands: ['cat /host/etc/hosts'],
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
];

module.exports = { PROBES };

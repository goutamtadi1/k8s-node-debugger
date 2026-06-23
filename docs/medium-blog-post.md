# You Don't Need SSH to Debug Kubernetes Network Issues Anymore

## One command. One browser tab. Full visibility into what's actually happening on your node.

---

It's 2:47 AM. An alert fires. Pods are failing health checks, but only on one specific node. Everything looks fine from `kubectl` — the pods are Running, the services exist, the endpoints are populated. But something at the network level is broken, and you have no idea what.

You know what you need to look at. iptables rules. The conntrack table. Maybe resolv.conf. The routing table. But to get there, you have to SSH into the node, run a dozen different commands, copy-paste output into a notepad, and try to make sense of walls of text at 3 in the morning.

Sound familiar?

I built a tool that changes this entirely. It's called **k8s-node-debugger**, and this post is me trying to convince you that it should be in your debugging toolkit.

---

## The Problem With Node-Level Debugging

Kubernetes does a fantastic job abstracting away infrastructure. Most of the time, that's exactly what you want. But when things go wrong at the network level, that abstraction works against you.

The real networking on a Kubernetes node lives in places that `kubectl` simply doesn't reach:

- **iptables** — where kube-proxy writes thousands of rules for every service and endpoint in your cluster. DROP rules silently killing traffic. NAT rules redirecting packets to the wrong place. Rules that were supposed to be cleaned up but weren't.
- **conntrack** — the kernel's connection tracking table. When this fills up, new connections are silently dropped. No error. No log. Just… nothing works.
- **resolv.conf** — DNS on a node is not the same as DNS in a pod. Confusion here causes all sorts of subtle failures.
- **routes and interfaces** — CNI plugins manipulate these constantly. A bad CNI state can make an entire node invisible to the rest of the cluster.

The traditional approach is SSH + root + a mental model of 15 different command outputs. It works, but it's slow, it's error-prone, and it requires you to already know what you're looking for.

---

## A Better Way

k8s-node-debugger takes a different approach. You run one command on your laptop:

```bash
node bin/k8s-node-debugger.js aks-a10ad467df85-50868432-vmss000015
```

It uses your existing kubeconfig — the same one you use for `kubectl` — to spin up a privileged debug pod directly on the target node. The pod gets `hostNetwork`, `hostPID`, and the host root filesystem mounted. Then it opens a browser tab that looks like this:

*[iptables screenshot]*

Everything you need to understand the node's network state is right there, in a readable, searchable, interactive UI.

---

## Let's Walk Through What You Actually See

### iptables — Finally Readable

If you've ever tried to read raw `iptables-save` output, you know the pain. Here's what a busy Kubernetes node looks like:

```
-A KUBE-SERVICES -d 10.0.127.195/32 -p tcp -m comment --comment
"default/my-service:http cluster IP" -m tcp --dport 80 -j
KUBE-SVC-XPGD46QRK7WJZT7O
```

Multiply that by hundreds of services. Now try to figure out why traffic to `10.0.127.195:80` is being dropped.

k8s-node-debugger parses all of that and presents it as:

- **Tabs per table** — mangle, filter, nat, raw — with rule counts so you can instantly see which table has the action
- **Collapsible chain cards** — each chain shows its default policy (green for ACCEPT, red for DROP), its rule count, and its packet/byte counters
- **Colour-coded target badges** — ACCEPT is green, DROP is red, MASQUERADE is purple, jumps to k8s chains are teal. You see the pattern of traffic instantly
- **Human-readable summaries** — instead of `--dport 443`, you see `port 443 (HTTPS)`. Instead of `--state ESTABLISHED,RELATED`, you see `established/related connections`
- **Live search** — type an IP address or port number and every matching rule across all tables lights up immediately

The KUBE-SVC-\* and KUBE-SEP-\* chains (one per service endpoint — there can be thousands) are collapsed by default. One click on "K8s chains" expands them when you need to trace a specific service. Click any rule to see the raw iptables line underneath.

---

### conntrack — Understanding Your Connection State at a Glance

The conntrack table is one of those things that causes mysterious failures and is almost never the first thing people check. Until it's full. Then everything breaks and nobody knows why.

*[conntrack screenshot]*

The conntrack view gives you:

**Stat cards across the top** — Total connections, TCP ESTABLISHED, TCP TIME\_WAIT, UDP, ICMP, and total bytes transferred. At a glance, you can see if you have a TIME\_WAIT explosion (a common cause of connection exhaustion), or whether your UDP traffic is higher than expected.

**Distribution bars** — A visual breakdown of TCP vs UDP vs ICMP, and a separate bar showing the TCP state distribution. When something is wrong, these bars tell the story in two seconds. A node where 95% of connections are TIME\_WAIT is a very different problem from one where 95% are ESTABLISHED.

**Top talkers** — Which source IPs are responsible for the most connections? Which destination ports are seeing the most traffic? In an incident, this is often the first question you need to answer.

**The connection table itself** — Filterable by protocol, TCP state, or any IP/port. Each row shows the connection state as a colour-coded badge, the src:port → dst:port with service name labels (so `443` becomes `443 (HTTPS)`, `6443` becomes `6443 (k8s-API)`), the TTL remaining, and a NAT tag when the reply source differs from the original destination — which is exactly how you spot kube-proxy doing DNAT.

**The count/max gauge** — A gradient bar showing how full your conntrack table is. Green below 50%. Amber at 50–80%. Red above 80%. Above 100% means new connections are being silently dropped. This is one of those things you really want to see before it becomes a problem, not during an incident.

---

### Everything Else in One Place

Beyond iptables and conntrack, the sidebar gives you instant access to:

- **resolv.conf** — the actual node-level DNS config, read through the host mount namespace so symlinks resolve correctly (a subtle issue that breaks most naive approaches)
- **Routes** — IPv4 and IPv6 routing tables, policy rules
- **Interfaces** — all network interfaces with addresses and link statistics
- **ARP/neighbors** — the neighbor cache
- **Listening sockets** — what's actually bound on which ports, with process names
- **Sysctls** — the key networking kernel parameters: ip\_forward, rp\_filter, conntrack max, etc.

---

### The Terminal — For When You Need to Go Deeper

Sometimes you need to run something that isn't a pre-built probe. The tool includes a streaming terminal that runs inside the debug pod:

```
tcpdump -ni any port 53
```

```
dig kubernetes.default @10.96.0.10
```

```
conntrack -E --event-mask NEW
```

```
ip route get 10.244.1.5
```

Commands run in the host network namespace. `↑`/`↓` for history. Ctrl-C or the Stop button to interrupt long-running commands. The output streams in real time, right in the browser.

---

## Real Scenarios Where This Saves You

**"My pod can't reach the cluster DNS"**
Check resolv.conf on the node. Check that the CoreDNS service IP is reachable. Use the terminal to run `dig kubernetes.default` and trace the query. Look at the iptables nat table to see if the DNS service DNAT rules exist.

**"New connections to my service are timing out, but existing connections work fine"**
Check the conntrack count/max gauge first. If it's near 100%, you've found it. If not, look at the iptables filter table for DROP rules and check the conntrack table for UNREPLIED entries to that service's IP.

**"Traffic between two nodes stopped working after a CNI update"**
Check the interfaces section for unexpected changes. Look at the routing table for missing or wrong routes. Check the iptables FORWARD chain — a CNI that misconfigured bridge-nf-call-iptables can cause all inter-node traffic to be dropped.

**"I'm seeing random connection drops under load"**
Look at the conntrack count/max gauge. Look at the conntrack stats for per-CPU drop and early\_drop counters (highlighted red if non-zero). A conntrack table that's filling up drops new connections silently.

**"I need to verify kube-proxy wrote the right rules for a new service"**
Open the iptables nat table, search for the service ClusterIP. You'll see the KUBE-SVC chain and all the KUBE-SEP endpoint chains below it, with the DNAT rules pointing to each pod IP.

---

## How It Actually Works (The Short Version)

The tool shells out to your local `kubectl`, so it inherits your active kubeconfig, current context, and any exec auth plugins — EKS, GKE, AKS, all work automatically.

It creates a pod with:
- `hostNetwork: true` — the pod shares the node's network namespace, so `iptables` and `conntrack` see the host's tables
- `hostPID: true` — allows `nsenter --mount=/proc/1/ns/mnt` to enter the host's mount namespace, which is how resolv.conf is read correctly even when it's a symlink
- `privileged: true` — required for iptables, conntrack, tcpdump
- The host root mounted at `/host` as a fallback
- Tolerations for all taints — works on control-plane nodes too

When you Ctrl-C, the pod is deleted. Pass `--keep` if you want it to survive for follow-up commands.

---

## Getting Started

```bash
git clone git@github.com:goutamtadi1/k8s-node-debugger.git
cd k8s-node-debugger
npm install

# see your nodes
node bin/k8s-node-debugger.js --list

# debug one
node bin/k8s-node-debugger.js <your-node-name>
```

A browser tab opens at `http://localhost:7878`. All probes run automatically. You're looking at the node's full network state within about 10 seconds of the pod becoming Ready.

---

## Closing Thought

Kubernetes networking is genuinely complex. kube-proxy alone can generate thousands of iptables rules on a busy cluster. CNI plugins add their own layers. The conntrack table silently drops packets when it's full. resolv.conf behaves differently at the node level than inside pods.

None of this is a bug. It's just how Linux networking at scale works. But it means that when something breaks, you need visibility into a lot of different systems at once — and that visibility has historically required SSH access, root privileges, and the knowledge to run the right commands in the right order.

k8s-node-debugger wraps all of that into something you can open in a browser tab. Not to hide the complexity — the raw iptables output is always one click away — but to give you a starting point that doesn't require you to already know the answer.

The next time an alert fires at 2:47 AM, you'll know where to look.

---

*The tool is open source at [github.com/goutamtadi1/k8s-node-debugger](https://github.com/goutamtadi1/k8s-node-debugger). Feedback and contributions welcome.*

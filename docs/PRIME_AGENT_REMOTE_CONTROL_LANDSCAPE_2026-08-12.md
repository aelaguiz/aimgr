# Prime Agent Remote Control Landscape

**Research snapshot:** 2026-08-12
**Target:** remotely monitor and control Prime Agent sessions running on a desktop, with a phone/browser experience comparable to Codex Remote
**Status:** findings and recommendation; no production exposure has been configured

## Executive answer

Prime Agent already has most of the *local* machinery a remote-control product needs: durable daemon-backed sessions, detach/attach, stable live-session identifiers, event cursors and replay, steering/follow-up delivery, observation of roots and subagents, schedules/heartbeats, and several programmatic integration surfaces. What it does **not** ship is the internet-facing layer: no browser/mobile client, authenticated network gateway, pairing flow, hosted relay, or remote authorization policy.

There is no mature product today that gives an already-running daemon-backed Prime Agent root the same first-class mobile semantics as Codex Remote. There are, however, three credible near-term paths:

1. **Use Orca main/the next qualifying release for the closest packaged experience.** Orca's Prime Agent integration was merged on 2026-08-09, followed by merged Prime status-hook work, and Orca has an iOS/Android companion with pairing, terminal control, status, replies, source-control review, and notifications. At this snapshot the latest stable tag, `v1.4.180`, still did **not** contain the Prime catalog entry, so use a later tag whose source includes `prime-agent` or build current main. The Prime integration launches/resumes Prime, recognizes its process, parses Prime's session JSONL, and installs an Orca-managed status extension for Orca-launched Prime processes. It still does not provide Orca Native Chat for Prime or native attachment to Prime's resident daemon protocol, nor expose Prime-only features such as RLM trees, goals, heartbeats, schedules, or continual-harness state. A raw terminal can run `prime-agent attach` to an existing resident session. This is the best immediate product trial, not yet the final integration.
2. **Try Happier or AionUi as low-code ACP experiments.** Both accept a custom ACP command. Prime officially speaks ACP through `prime-agent --mode acp`, so either should be able to launch a Prime-controlled session without a bespoke driver. Happier provides web/desktop/mobile clients, an outbound relay, self-hosting, and E2EE by default; AionUi provides a polished browser WebUI, Pi support, remote access, and single-user password/QR login. This compatibility is protocol-derived and should be smoke-tested. ACP is one session per process and omits much of Prime's richer control plane; it does not attach to an already-running daemon root.
3. **For the actual north star, add a thin authenticated host bridge around Prime's local client boundary.** Keep the Prime daemon owner-local. Let a supervised host component use `AgentConnection`/the daemon client locally for resident-session attach and snapshots, and use the supported RPC/CLI surfaces where appropriate for commands and observation. Expose only typed remote actions over a private Tailscale MVP or an outbound E2EE relay. Do not forward the daemon socket.

**Recommended sequence:** trial Orca, Happier Custom ACP, and AionUi Custom ACP on a private Tailscale network; choose the best client shell; then implement or upstream the small Prime-specific adapter needed for resident-session fidelity. Do not start by building a new native mobile app or a generic public web shell.

## Terminology: Prime Agent is not Pi or Prime Intellect

These names are easy to conflate and lead to incorrect compatibility claims.

| Name | What it is | Relevance here |
|---|---|---|
| **Prime Agent** | The local open-source coding/research harness in [`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent). It has a persistent IPython kernel, RLM subagents, continual harness, durable daemon sessions, schedules, heartbeats, and TUI. | **The target.** Its CLI is `prime-agent`; state normally lives under `~/.prime/agent`. |
| **Pi** | The separate agent harness in [`earendil-works/pi`](https://github.com/earendil-works/pi). Prime Agent began as a hard fork, but the products and current architectures have diverged. | Pi UIs and bridges are useful design/reference code. They are not automatically Prime-compatible. |
| **Prime Intellect** | The company/cloud platform for inference, training, environments/evals, sandboxes and compute. | It is not the control plane for local Prime Agent daemon sessions. Prime Agent may use its inference service as a provider. |

Prime still contains historical `pi` package names and compatibility artifacts. Those are not a promise that Pi extensions, session readers, RPC clients, or remote products will work unchanged.

## What Prime Agent already provides

The official Prime sources were inspected at commit `965941c`. The important result is that this is not a persistence problem; it is a secure remote-client problem.

### Resident daemon and session model

- A normal root runs in a resident worker behind a detached local supervisor. Closing the TUI detaches the client; the worker keeps running.
- Public lifecycle commands include `agents`, `list`, `attach`, `send`, `stop`, `rename`, `schedule`, `status`, `doctor`, and `shutdown`.
- Durable transcripts are tree-structured JSONL. A durable session ID/path is different from the **active-session ID** used to address a live daemon session.
- The local daemon protocol already has stable client/command identifiers, generation and sequence cursors, snapshots and chunking, idempotency journals, leases, reconnect/replay, and backpressure.
- The Unix socket lives in an owner-only directory and is mode `0600` (Windows uses a named pipe). That is an intentional same-user trust boundary, not a network API.

Official sources: [architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md), [daemon](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md), [sessions](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/sessions.md), and [daemon socket implementation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/modes/daemon/daemon-socket.ts).

### Control surfaces

| Surface | Strengths | Limitations for this goal |
|---|---|---|
| **`AgentConnection` / daemon client** | Intended local client boundary; coherent attach snapshots, commands, cursors and reconnect for resident sessions. Best fit for attaching to an existing root. | Official docs explicitly say it is not a hosted gateway protocol. Network auth, stable public DTOs, upload/download IDs and multi-client ownership policy are not supplied. |
| **RPC** (`--mode rpc`) | Rich, supported duplex JSONL subprocess contract: prompt, steer, follow-up, abort, state/messages/model, compaction, schedules/heartbeats, daemon `send_message`, and `observe`/`unobserve` for another root or subagent. Serializes user UI requests and correlated responses. | The RPC process naturally owns its own session. Watching or messaging an existing daemon session requires its active ID and does not by itself reproduce every attach/control behavior. The transport is stdio, not authenticated networking. |
| **ACP** (`--mode acp`) | Standard JSON-RPC vocabulary understood by existing clients. Streams assistant/tool activity and exposes Prime extensions in ignorable `_meta`. | One session per connection; smaller surface; no full daemon-session browser or all Prime features. Best for launching a new client-owned Prime process. |
| **Node SDK** | In-process `AgentSession` / `AgentSessionRuntime` for a custom TypeScript application. | Best for sessions the app owns, not a drop-in remote layer for every existing resident worker. |
| **JSON mode** | One-shot event capture with an exit code. | Batch only; not interactive remote control. |
| **TUI over PTY** | Zero integration effort; `prime-agent attach` reaches existing roots. | Shell-sized security boundary, brittle semantics, poor structured approvals/replay, and weak mobile UX. |

Official sources: [`AgentConnection`](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/agent-connection.md), [RPC](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md), [ACP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/acp.md), and [SDK](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/sdk.md).

### Existing-session compatibility is the decisive test

Many products say they “support” an agent when they can spawn its CLI in a PTY. That is not the same as controlling a resident Prime root.

A solution qualifies as **resident-native** only if it can:

1. enumerate live Prime active-session IDs independently of terminal windows;
2. attach and obtain an authoritative snapshot plus cursor;
3. replay missed events after a disconnect;
4. send a prompt/steer/follow-up to the intended live root;
5. correlate and answer pending UI/approval requests;
6. cancel or stop the intended session without keystroke scraping;
7. preserve Prime-specific subagent and scheduler state; and
8. enforce one clear controller/observer policy when desktop and phone are both connected.

No reviewed third-party product demonstrates all eight today. Prime itself has most of the local primitives.

## Decision matrix

| Candidate | Prime compatibility | Existing resident root | Remote UX | Security / transport | Maturity and license | Effort to useful result |
|---|---|---:|---|---|---|---|
| **Orca** | Built-in launch/resume/history merged | **Partial:** raw terminal can `attach`; no proven semantic daemon adapter | Native iOS/Android + desktop; terminal/chat, replies, Git, push | One-time device pairing; direct/LAN or optional relay; no verified content-E2EE claim found | Very active, ~43.4k★, MIT | **Low** trial; medium to deepen provider |
| **Happier Custom ACP** | Protocol-derived: `prime-agent --mode acp` | **No**; launches one ACP process/session | Web/desktop/mobile, notifications and cross-device state | Outbound service path; E2EE default; self-hostable | Active, ~1.5k★, MIT | **Low** smoke test; medium for Prime-aware extension |
| **AionUi Custom ACP** | Protocol-derived: `prime-agent --mode acp`; Pi already listed | **No**; launches one ACP process/session | Polished responsive WebUI; headless/server and IM options | Localhost default; password/cookie/rate-limit auth; use Tailscale/HTTPS | Very active, ~31.9k★, Apache-2.0 | **Low** private-browser POC |
| **T3 Code** | Prime RPC provider requested, not shipped | Not available | Remote browser/provider architecture | Pairing/Tailscale patterns; must audit after provider exists | Very active, ~18.3k★, MIT | **Medium** provider contribution; no current result |
| **Custom Prime host bridge** | Native `AgentConnection` + supported RPC/CLI | **Yes — target design** | PWA first; native later only if needed | Private Tailscale MVP; outbound device-bound E2EE relay later | New code owned by us; Prime itself MIT | **Medium** alpha; highest fidelity |
| **Pi Web / Pi Chat / Takopi** | Pi-native only | No Prime guarantee | Strong web/chat patterns | Varies; Pi's raw authority still requires sandboxing | Active OSS, mostly MIT/Apache-2.0 | Medium/high port; use as reference first |
| **VibeTunnel / ttyd + tmux** | Any terminal CLI | **Yes via `prime-agent attach`**, but only PTY semantics | Mobile browser terminal | Full-shell boundary; loopback + Tailscale Serve + app auth | Active OSS, MIT | **Very low** fallback |
| **SSH/Mosh + tmux** | Any terminal CLI | **Yes via `attach`**, PTY semantics | Phone SSH client, not agent-native | Smallest private attack surface with Tailscale ACLs | Mature OSS | **Very low** and robust |

“Protocol-derived” means the documented interfaces line up; it does not mean this research performed a production compatibility certification.

## Closest Prime-compatible products

Snapshot metadata below is from GitHub on 2026-08-12. Stars are a rough activity signal, not a security or quality score.

### 1. Orca — closest shipping Prime product

- **Project:** [`stablyai/orca`](https://github.com/stablyai/orca) — MIT, roughly 43.4k stars, active.
- **Prime status:** [PR #12935](https://github.com/stablyai/orca/pull/12935) merged on 2026-08-09. It adds Prime launch, process recognition, session-history parsing, `--resume`, skill discovery, and Prime environment/session-directory handling. [PR #13384](https://github.com/stablyai/orca/pull/13384) then added Prime status hooks by installing `orca-agent-status.ts` in the chosen Prime extension directory. The accompanying [Prime issue #808](https://github.com/PrimeIntellect-ai/prime-agent/issues/808) documents the contracts used.
- **Release caveat:** exact tag inspection showed the latest stable `v1.4.180` did not yet contain `prime-agent` in `src/shared/tui-agent-config.ts`; current main did. A trial therefore needs a later qualifying release/RC or a source build from main.
- **Remote UX:** the [mobile companion](https://www.onorca.dev/docs/mobile) supports iOS and Android, one-time pairing, multiple hosts, agent status, hydrated terminal scrollback, reply/voice/files, source-control review/commit, saved commands, account switching, and completion pushes. The desktop remains source of truth; direct/LAN and Orca Relay paths exist.
- **What is actually compatible:** launch/resume, durable transcript browsing, raw mobile terminal control, and status-hook reporting for Orca-launched Prime processes. A terminal can manually use `prime-agent attach` against an existing daemon root.
- **What remains missing:** Orca's current `NATIVE_CHAT_SUPPORTED_AGENTS` set does not include Prime, so Prime opens as a terminal rather than structured Native Chat. There is also no semantic Prime daemon attach, active-ID/cursor replay through Prime's client boundary, RLM tree rendering, schedules/heartbeats/goals, or Prime-native approval/UI request mapping. The integration consumes session JSONL, extension, and CLI/env contracts that need ongoing compatibility tests.
- **Live-environment caveat:** status integration writes an Orca-managed extension into the selected Prime agent directory. Test against an isolated `PRIME_AGENT_CODING_AGENT_DIR` before allowing it to modify a production `~/.prime/agent/extensions` tree.
- **Verdict:** trial first. If the product experience is right, the smallest high-value contribution is an Orca Prime provider extension that uses Prime's resident-session client boundary rather than adding a new client application.

### 2. Happier — best low-code E2EE ACP experiment

- **Project:** [`happier-dev/happier`](https://github.com/happier-dev/happier) — MIT, roughly 1.5k stars, active; web, desktop and mobile.
- **Existing support:** Pi is explicitly supported through an experimental ACP path: [Pi provider docs](https://docs.happier.dev/providers/pi). Happier also supports arbitrary command/args definitions through [Custom ACP backends](https://docs.happier.dev/features/acp-backends).
- **Prime mapping to test:** command `prime-agent`; arguments `--mode acp`. This follows both products' documented contracts, but no official Prime preset or published compatibility test was found.
- **Remote/security model:** clients and local CLI/daemon communicate through the Happier service; [E2EE](https://docs.happier.dev/security) is the default, and [self-hosting/storage policy](https://docs.happier.dev/server/encryption) can require ciphertext-only storage.
- **Limitation:** generic ACP quality is capped by ACP capabilities. Prime's ACP starts a new process/session, allows one session per connection, and cannot expose the full resident daemon or Prime-only semantics without a custom extension.
- **Verdict:** the best quick experiment for semantic chat from phone without writing a mobile client. If it works, add a Prime-aware backend instead of forking the whole product.

### 3. AionUi — strongest browser-first custom ACP option

- **Project:** [`iOfficeAI/AionUi`](https://github.com/iOfficeAI/AionUi) — Apache-2.0, roughly 31.9k stars, very active.
- **Existing support:** Pi is listed among the built-in agent choices. Any ACP-compatible CLI can be added with a display name, command, and arguments in [Custom Agents](https://github.com/iOfficeAI/AionUi/wiki/ACP-Setup).
- **Prime mapping to test:** `prime-agent --mode acp`.
- **Remote UX:** desktop-bundled or standalone headless WebUI; phone/browser use; server mode; optional IM channels. The [WebUI guide](https://github.com/iOfficeAI/AionUi/wiki/WebUI-Configuration-Guide) documents localhost-by-default operation, `--remote` LAN binding, random initial admin password, bcrypt hashing, HMAC-signed HttpOnly cookies, login rate limiting, and session invalidation on password rotation. The [remote guide](https://github.com/iOfficeAI/AionUi/wiki/Remote-Internet-Access-Guide) recommends Tailscale for cross-network personal use.
- **Limitations:** single `admin` user, ordinary web-session authentication rather than a verified device-bound E2EE relay, and generic ACP feature limits. Public-IP HTTP examples in the guide should not be followed for an agent with code-execution authority; use Tailscale/HTTPS.
- **Verdict:** excellent private-network browser proof of concept. Treat QR login as convenience, not sufficient evidence of phishing-resistant pairing, until its exact token flow is audited.

### 4. T3 Code — ideal upstream destination, not available yet

- **Project:** [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) — MIT, roughly 18.3k stars, active. It already has a remote browser experience, provider drivers/adapters, QR/pairing work, and Tailscale deployment patterns.
- **Prime status:** [feature request #6126](https://github.com/pingdotgg/t3code/issues/6126) asks for a Prime RPC driver and correctly identifies the provider-adapter seam. It was open with no implementation at this snapshot.
- **Verdict:** strong place to upstream a Prime RPC/daemon-aware adapter if maintainers accept it. It is not a current solution.

### 5. Pi-native products — useful source material, not drop-in Prime clients

| Project | What exists | Prime verdict |
|---|---|---|
| [`agegr/pi-web`](https://github.com/agegr/pi-web) | Mature Pi browser UI with resume/session management, files, diffs, configuration and skills; MIT, roughly 4.1k stars. | High-value UI/reference code. Pi session and extension assumptions must be ported deliberately. |
| [`earendil-works/pi-chat`](https://github.com/earendil-works/pi-chat) | Official Pi Telegram/Discord bridge with per-channel Gondolin workspaces and status/stop/compact/new; Apache-2.0. | Good chat and isolation reference; not a generic Prime bridge. |
| [`banteg/takopi`](https://github.com/banteg/takopi) | Telegram bridge for Codex, Claude, OpenCode and Pi; streaming, worktrees, resume/handoff, files/voice; MIT. | Pi yes, Prime no preset. A Prime RPC backend is plausible. |
| [`giuliastro/harness-remote`](https://github.com/giuliastro/harness-remote) | One companion across Pi/OMP/Claude/Codex/OpenCode; Apache-2.0. | Small adaptable backend architecture; no Prime backend found. |
| [`04mg/caw`](https://github.com/04mg/caw) | Browser terminal multiplexer and activity board listing Pi, with push notifications; MIT. | Can spawn arbitrary terminal agents and likely Prime with configuration, but remains PTY/process-oriented. |
| [`BlackBeltTechnology/pi-agent-dashboard`](https://github.com/BlackBeltTechnology/pi-agent-dashboard) | Mobile Pi dashboard, terminal, diffs and tunnel integration; MIT. | Another useful client/reference, not Prime-compatible by name. |
| TelePi / Lucarne / Nexting | Telegram/notification/companion variations with Pi among supported agents. | Treat as patterns or adapter candidates, not proof of Prime compatibility. |

## Pi's own remote direction

Pi v0.84.1 has a mature stdio RPC and SDK, plus a newly published but explicitly experimental network-oriented stack:

- `@earendil-works/pi-protocol`: CBOR framing and schemas;
- `@earendil-works/pi-client`: multi-session client, snapshots, leases and explicit reconnect;
- `@earendil-works/pi-server`: a composable Unix-socket server;
- `RemoteSession`: higher-level controller/reducer.

The [server README](https://github.com/earendil-works/pi/blob/v0.84.1/packages/server/README.md) explicitly says it is not a standalone CLI or coding-agent service. Applications must supply durable service behavior, authentication, transport, supervision, reconnect/session reacquisition, sandboxing and UI. Protocol v1 is narrower than Pi's stdio RPC and has no compatibility guarantee.

This matters because it validates the architecture, not because Prime should import it blindly: authoritative snapshots, transient progress, controller leases, and reconnect cursors are the right concepts. Prime's daemon already has analogous and in several areas richer local mechanics.

Primary sources: Pi [RPC](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/rpc.md), [SDK](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/sdk.md), [protocol](https://github.com/earendil-works/pi/blob/v0.84.1/packages/protocol/README.md), [client](https://github.com/earendil-works/pi/blob/v0.84.1/packages/client/README.md), and [server](https://github.com/earendil-works/pi/blob/v0.84.1/packages/server/README.md).

## Broader remote-agent landscape

### First-party analogues

| Product | Proven ideas to copy | Important distinction |
|---|---|---|
| [Codex Remote](https://learn.chatgpt.com/docs/remote-connections) | One-to-one phone↔host pairing, secure relay, host-local files/credentials/tools/execution, steering, approvals, diffs/tests/terminal/screenshots, host start/stop/pair commands. | Proprietary and Codex-only; exact implementation is not reusable. |
| [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) | Outbound HTTPS only, no inbound listener, scoped short-lived credentials, terminal/web/mobile continuity, presence-aware pushes. | Transcript/messages/tool activity are stored on Anthropic servers; Claude-only. |
| [Claude Code Channels](https://code.claude.com/docs/en/channels) | Official Telegram/Discord/iMessage injection into a running local session; sender allowlists and explicit per-session opt-in. | Chat relay rather than a full synchronized client. Admitted senders can relay permission decisions. |
| [GitHub Copilot CLI Remote Control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control) | Another vendor validation of phone/browser control for a local CLI session. | Copilot-only. |
| [VS Code Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels) | Outbound tunnel, account auth on both ends, browser IDE, no inbound host listener. | Remote development environment, not agent-semantic control; put the agent in tmux for true process persistence. |

### Mature cross-agent clients that do not currently support Prime

| Product | Remote/session model | Prime status |
|---|---|---|
| [`slopus/happy`](https://github.com/slopus/happy) | MIT iOS/Android/web for Codex and Claude; outbound relay, QR-established E2EE keys, encrypted blobs, approvals, diffs, push and voice; self-hostable. | Strong client/relay to adapt, but no Pi/Prime provider found. |
| [`siteboon/claudecodeui`](https://github.com/siteboon/claudecodeui) (CloudCLI) | Self-hosted mobile web UI for Claude, Codex, OpenCode and Cursor; sessions, shell, files and Git; AGPL-3.0. | No Prime adapter documented. |
| [`K9i-0/ccpocket`](https://github.com/K9i-0/ccpocket) | Self-hosted phone/desktop control of Codex and Claude via local WebSocket bridge; recommends Tailscale. | Good small bridge/UI reference; no Prime. |
| [`chenhg5/cc-connect`](https://github.com/chenhg5/cc-connect) | Broad IM bridge across Slack, Telegram, Discord, Lark, DingTalk, LINE and WeCom for mainstream CLIs. | No Prime/Pi; no repository license detected at snapshot, which blocks safe reuse. |
| [`amplifthq/opentag`](https://github.com/amplifthq/opentag) | Team-channel gateway for Slack/GitHub/GitLab/Linear/Lark/Telegram/Discord/Teams and local Claude/Codex/ACP execution; MIT. | A Prime ACP executor should be possible; not supplied. |
| [`Nimbalyst/nimbalyst`](https://github.com/Nimbalyst/nimbalyst) | MIT desktop workspace + iOS companion for Claude/Codex, diff review, queued work and push; client source describes QR-seeded AES-256-GCM E2EE. | No Prime. Sync server is separate from the MIT client repo. |
| [Omnara Remote](https://remote.omnara.com/) | Desktop/web/iOS/Android/Watch for Claude/Codex and optional offline cloud migration. | No Prime; current remote security details are less complete and older disclosures describe server-readable stored content rather than E2EE. |
| [`Emanuele-web04/remodex`](https://github.com/Emanuele-web04/remodex) | Codex-specific local-first Mac/iPhone pairing, steering, queues, approvals and reconnect; Apache-2.0. | Excellent focused UX/reference; Codex-specific. |
| [`getpaseo/paseo`](https://github.com/getpaseo/paseo), [`kzahel/yepanywhere`](https://github.com/kzahel/yepanywhere), [`milisp/codexia`](https://github.com/milisp/codexia) | Multi-agent supervisor/mobile patterns, E2EE or self-hosting in some products, and worktree/session management. | Potential client architectures; no verified Prime provider. Review licenses and current security individually before reuse. |

### Direct browser and API building blocks

| Project | Strength | Risk / Prime fit |
|---|---|---|
| [`coder/agentapi`](https://github.com/coder/agentapi) | REST/SSE and built-in chat for several agents; MIT. | Drives PTYs/TUIs and lacks a documented auth layer. Prototype only, behind VPN/auth proxy. |
| [`achimala/farfield`](https://github.com/achimala/farfield) | Direct browser client for Codex app-server/OpenCode SDK; no hosted relay; MIT. | Server has no auth; private Tailscale HTTPS only. No Prime. |
| [ACP](https://agentclientprotocol.com/overview/introduction) + [`acp-ui`](https://github.com/formulahendry/acp-ui) | Standard semantic vocabulary and a reusable web/desktop/mobile client direction. | ACP is not a network security/reliability protocol. Prime's generic ACP works for new one-process sessions, not resident-daemon parity. |
| OpenCode Web | Native web/server with Basic auth option. | OpenCode-only; TLS/VPN still required. |
| `ttyd` / WeTTY | Works with any terminal command. | Full shell boundary and no agent semantics. Use only privately and preferably read-only. |

## Generic terminal and network fallback

If the requirement is “I can reach the desktop and type into Prime tonight,” the smallest robust stack is:

```text
Prime Agent inside named tmux session
        ↑
SSH or Mosh over a private Tailscale tailnet
        ↑
phone SSH client (for example Blink on iOS)
```

- **tmux** owns persistence. The session survives client/network loss but not host reboot or tmux-server death.
- **Mosh** is excellent for phone roaming, sleep and IP changes; use tmux for scrollback and durable process ownership.
- **Tailscale Serve** privately exposes a loopback web service to the tailnet with HTTPS and ACLs. Keep the backend bound to localhost.
- **Do not use Tailscale Funnel** for an agent shell. Funnel is public internet exposure; TLS does not authorize visitors.

For browser access:

- [`amantus-ai/vibetunnel`](https://github.com/amantus-ai/vibetunnel) is the richest generic option: mobile browser terminal dashboard, activity and recordings, several auth methods. It is beta; use Tailscale Serve, keep app auth enabled, and put tmux underneath.
- [`ttyd`](https://github.com/tsl0922/ttyd) is the leaner option and read-only by default. Its own examples wrap `tmux new -A -s ...`; enable writes only for an authenticated private deployment.
- [WeTTY](https://github.com/butlerx/wetty) is a browser-to-login/SSH gateway rather than a session manager. Avoid URL-controlled hosts/commands and password-in-URL auto-login.

A writable terminal is equivalent to the host OS account. Use a dedicated unprivileged account, no broad inherited cloud credentials, no agent forwarding unless essential, and separate read-only observation from write takeover.

## Recommended Prime-native architecture

```text
phone / PWA / desktop client
          │
          │ authenticated TLS/WSS; later application E2EE
          ▼
private Serve endpoint or routing relay
          ▲
          │ outbound-only connection for public-relay mode
          │
Prime host bridge (launchd/systemd; authorization authority)
          │
          ├── local AgentConnection / daemon client
          ├── public Prime RPC + CLI commands where appropriate
          └── resident Prime workers and their RLM children
```

### Host bridge responsibilities

1. **Resident-session registry:** map opaque remote session IDs to Prime active-session IDs. Never send local socket paths or transcript paths to clients.
2. **Authoritative attach:** send a snapshot plus generation/sequence cursor, then append semantic events. On reconnect the client supplies the last acknowledged cursor and replays gaps.
3. **Typed commands:** list, attach/read, send prompt, steer, follow up, answer a pending UI request, abort turn, stop session, and optionally start in a predeclared workspace/profile. Do not make login synonymous with shell access.
4. **Controller lease:** allow many read-only observers but only one write controller generation per session. Make local-terminal preemption explicit.
5. **Idempotency:** every remote command carries an idempotency key; cancel/stop are repeatable; stale approval decisions fail closed.
6. **Authorization:** capability profiles are fixed at session creation (roots, writes, command/network classes, MCP/connectors, GUI/browser, secret handles, production side effects). A phone may reduce capabilities but cannot silently expand them.
7. **Audit/content separation:** keep a small tamper-evident action ledger separate from prompts, outputs, diffs and screenshots. Redact before disk and before relay.
8. **Secret boundary:** credentials remain host-side, injected narrowly and just in time. Remember that an approved command can still wield host credentials; local storage alone is not protection.

### Pairing and relay requirements

- QR contains a one-time high-entropy nonce and host fingerprint/public key, expires in minutes, and is confirmed with a short code plus host/workspace identity. It must not contain a reusable bearer token.
- Each device gets a keychain/secure-enclave-backed key. Bind short-lived host/purpose-scoped tokens to it and support immediate device/host revocation.
- The relay routes encrypted semantic events but has no host execution authority. Prefer E2EE content if server-side search is not required.
- Pending approvals remain host-owned with TTLs. Relay outage or notification timeout never approves anything.
- Push payloads contain only an opaque event/session ID and generic state such as “action required” or “completed.” Fetch current details after authenticated app open; do not approve from lock-screen actions.

### Approval contract

An approval request should include an immutable request ID/session ID; exact tool/argv and normalized inputs; cwd, paths, network destination and affected resources/diff; risk/policy class; expiry; and a hash over all authorization-relevant fields. Decisions bind to that hash and are `allow once`, narrow `allow for session/time`, `deny once`, or `deny persistently`. Any changed input creates a new request. High-risk remote approvals require step-up auth, and there should be no remote “approve everything” default.

ACP provides useful semantic names for prompts, updates, cancellations and permissions, but it is not a pairing, authorization, replay or transport-security protocol. Use its vocabulary where useful; do not expose raw ACP/daemon/PTY sockets to the internet.

Security references: [RFC 8628 device flow](https://datatracker.ietf.org/doc/html/rfc8628), [DPoP](https://datatracker.ietf.org/doc/html/rfc9449), [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), and [APNs payload guidance](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CreatingtheNotificationPayload.html).

## Suggested execution plan

### Phase 0 — product trials, private only

1. Install the current Orca release/build containing the merged Prime support; launch and resume a disposable Prime session; test desktop-to-mobile pairing, reconnect, terminal/chat rendering, prompt reply, diff review and notification.
2. Define `prime-agent --mode acp` in Happier Custom ACP and repeat the same test grid. Verify cancellation, tool streams, permissions/questions, images, reconnect, and transcript reload rather than assuming protocol compliance equals UX parity.
3. Define the same custom agent in AionUi; run its WebUI on localhost behind Tailscale Serve or its documented private Tailscale path. Do not open the port publicly.
4. Record which Prime capabilities are missing: resident attach, RLM children, schedules/heartbeats/goals, approvals/UI, model controls, files/diffs, and reconnect replay.

A successful trial may reduce the custom work to one provider adapter.

### Phase 1 — private alpha for existing resident sessions

Build the smallest host bridge and responsive PWA supporting:

- host status;
- list resident roots;
- attach/read snapshot and live updates;
- send/steer/follow-up;
- answer a pending confirm/input/select request;
- abort/stop;
- explicit controller takeover; and
- reconnect by cursor.

Run it behind Tailscale Serve with restrictive ACLs. No generic terminal, file browser, arbitrary workspace start, production side effects, public relay, or native apps yet.

### Phase 2 — Codex-style pairing

Add outbound host WSS, device-bound pairing/revocation, application E2EE, encrypted durable event queue, offline/reconnect behavior, generic push notifications and audit ledger. Keep host authorization authoritative.

### Phase 3 — Prime-specific depth

Only after the core loop is reliable, add RLM tree observation/messaging, schedules, heartbeats, goals, continual-harness status, file/diff review, and bounded session creation profiles. This is where a generic ACP client stops being enough.

## What not to build or expose

- Do not expose, reverse-proxy, SSH-forward, or publicly bind Prime's daemon socket.
- Do not use an unauthenticated AgentAPI/Farfield/PTY endpoint, Tailscale Funnel, or an unguessable URL as “security.”
- Do not make raw terminal access the default remote capability; keep it a separately privileged emergency/admin lane.
- Do not assume Pi session/extension compatibility because Prime was once a fork.
- Do not parse transient streaming deltas into canonical state; use authoritative snapshots and durable terminal/message records.
- Do not send prompts, commands, diffs, paths, secrets or approval tokens in push notifications.
- Do not build a new native iOS/Android app before proving that Orca, Happier, AionUi, or an ACP UI cannot host the required Prime adapter.
- Do not add remote expansion of sandbox/network/MCP/secret permissions without fresh local or step-up authorization.

## Ranked recommendation

1. **Immediate trial:** Orca, because it is the only reviewed major product with merged Prime Agent support and a real iOS/Android companion.
2. **Best protocol experiment:** Happier Custom ACP with `prime-agent --mode acp`, because it combines a generic ACP backend with mobile/web/desktop and E2EE. AionUi is the strongest browser-first alternative on a private network.
3. **Best durable solution:** a small Prime-aware adapter using the local `AgentConnection`/daemon boundary for resident roots, with a Tailscale-only PWA first and an outbound E2EE relay only after the interaction contract is proven.
4. **Best generic fallback:** tmux + Tailscale + SSH/Mosh; VibeTunnel or ttyd behind Tailscale Serve if browser access is essential.
5. **Best upstream targets:** deepen Orca's Prime integration or implement the open T3 Code Prime provider request. Avoid maintaining a standalone client unless those paths fail.

## Research method and source notes

- Searched 30 GitHub/web query lanes across Prime/Pi/Claude/Codex plus remote, mobile, browser, chat, API, ACP and PTY terms; one delegated GitHub pass inspected 1,058 search results and package-registry metadata.
- Read official Prime Agent source/docs locally and cross-checked public GitHub links.
- Read primary product repositories, security/architecture docs, issue/PR state and GitHub metadata. The larger competitive inventory in [`kzahel/yepanywhere`](https://github.com/kzahel/yepanywhere/blob/main/docs/competitive/all-projects.md) was used as a discovery index, not as sole evidence for recommendations.
- “Compatible” is separated into: built-in provider, generic protocol compatibility, process/PTY compatibility, and native control of already-running resident sessions.
- GitHub stars, releases, claims and security docs are time-sensitive. Re-check before adoption, especially Orca release packaging, Happier/AionUi Prime smoke tests, relay E2EE details, and any public network mode.

## Primary source index

### Prime Agent

- [Repository](https://github.com/PrimeIntellect-ai/prime-agent)
- [Docs index / Prime-vs-Pi statement](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/index.md)
- [Architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md)
- [Daemon](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md)
- [`AgentConnection`](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/agent-connection.md)
- [Long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)
- [RLM/subagents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)
- [RPC](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md)
- [ACP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/acp.md)
- [SDK](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/sdk.md)

### Leading products

- [Orca repository](https://github.com/stablyai/orca), [Prime PR](https://github.com/stablyai/orca/pull/12935), [mobile docs](https://www.onorca.dev/docs/mobile)
- [Happier repository](https://github.com/happier-dev/happier), [Custom ACP](https://docs.happier.dev/features/acp-backends), [security](https://docs.happier.dev/security)
- [AionUi repository](https://github.com/iOfficeAI/AionUi), [ACP setup](https://github.com/iOfficeAI/AionUi/wiki/ACP-Setup), [WebUI](https://github.com/iOfficeAI/AionUi/wiki/WebUI-Configuration-Guide)
- [T3 Code](https://github.com/pingdotgg/t3code), [Prime request](https://github.com/pingdotgg/t3code/issues/6126)
- [Happy](https://github.com/slopus/happy), [security](https://happy.engineering/docs/security/), [FAQ](https://happy.engineering/docs/faq/)
- [Pi Web](https://github.com/agegr/pi-web), [Pi Chat](https://github.com/earendil-works/pi-chat), [Harness Remote](https://github.com/giuliastro/harness-remote), [Caw](https://github.com/04mg/caw)

### Networking and security

- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and [Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [tmux manual](https://man7.org/linux/man-pages/man1/tmux.1.html), [Mosh](https://mosh.org/), [VibeTunnel](https://github.com/amantus-ai/vibetunnel), [ttyd](https://github.com/tsl0922/ttyd)
- [Claude Remote security](https://code.claude.com/docs/en/security), [Codex approvals/security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [ACP overview/schema](https://agentclientprotocol.com/protocol/v1/overview)

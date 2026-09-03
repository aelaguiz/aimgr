# Herdr and Prime session health inventory — 2026-09-02

Snapshot time: **2026-09-02 10:56 CDT**

This is a read-only incident snapshot of what was actually present in Herdr, what each local pane was running, whether its Prime transcript was making substantive progress, and whether its terminal frontend was usable. No pane received input. No session, worker, daemon, socket, lease, workspace, process, or Herdr server was stopped, restarted, killed, closed, or otherwise changed.

## Bottom line

- Herdr itself has **9 running named servers**, containing **35 workspaces and 45 panes**. The `personal`, `planning`, and `snap` Herdr servers are stopped.
- **25 panes are Prime-facing.** Seven were still producing useful work or actively monitoring a dependency; the other 18 had no demonstrated useful activity at snapshot time.
- The Prime control socket is absent while a live detached Prime process still owns the daemon launch lease. Clients repeatedly report `lastProbe=absent` followed by `launchLease=contended`.
- Background Prime workers can survive that control-plane failure. A pane can therefore be both **actively working in the background** and **functionally unusable from the terminal**.
- Machine load is still severe after the disk recovery: `fseventsd` was using 103.6% CPU and about 2.85 GiB RSS; one live validation belonging to the ChatGPT Ads lane was using about 96% CPU.

## How to read the verdicts

| Work verdict | Meaning |
|---|---|
| `ACTIVE` | Recent substantive transcript events, verified child activity, or a verified live build/test/validation. |
| `MONITORING` | Waiting on CI, a Pro response, or a child, with a live heartbeat or recent polling activity. |
| `DONE/IDLE` | Useful work appears complete or deliberately idle; no useful activity is currently required. |
| `STALLED` | Work appears unfinished and there is no recent substantive progress. |
| `DEAD FRONTEND` | The Prime process has exited or launch failed; only a shell or stale terminal scrollback remains. |

The control verdict is separate. `DISCONNECTED` or `FROZEN` describes the terminal/control path, not whether a detached worker is still doing work.

## The three reported sessions

| Prime session | Herdr location | Work state | Control state | Evidence-backed verdict |
|---|---|---|---|---|
| `01a06297-612d-769b-9ece-89b500064cf5` | `pvai` / `w15` “Pvai broken” / `w15:p1` | `DONE/IDLE` | `DEAD FRONTEND` | Its root-cause analysis was saved to `psagentspace/docs/bugs/2026-09-02-production-play-vs-ai-rustai-action-panic.md` and `REGRESSIONS.md`; the transcript was refined at 10:13 CDT. The Prime process then exited. The pane now contains only `zsh`, and a resume attempt failed on daemon-launch lease contention. The work is preserved, but this pane is not a live Prime session. |
| `01a05ece-0927-76f7-ab63-2743e9b75407` | `growth` / `w5Z` “chatgpt ads” / `w5Z:p1` | `ACTIVE` | `FROZEN` | The visible Herdr screen did not advance during the sample, but the durable transcript resumed at 10:52 CDT and said it was restarting the PR-B validation. A `check-model-has-description` pre-commit validation in `psmobile-4788b` was then verified at about 96% CPU. This session is doing real background work even though the terminal cannot currently accept useful interaction. Do not terminate it casually. |
| `01a05ec0-668a-72cb-aff3-fb298bc6a7ec` | `content` / `w1F` “puzzle universe” / `w1F:p2` | `DONE/IDLE` | `DISCONNECTED` | The session reported its work done and no heartbeats running. Its last substantive event was at 10:22 CDT; later transcript writes were only `agent_status` records. The wrapper and Prime frontend processes still exist, but the pane says `Daemon connection lost; reconnecting…`. |

## Prime-facing panes — complete listing

| Herdr / workspace | Pane | Prime session | Work verdict | Terminal/control verdict and evidence |
|---|---|---|---|---|
| `bugs` / `w51` “silent failures” | `w51:p1` | `01a05f54-b86e-770a-98b2-b8f356b83823` | `STALLED` | Prime explicitly says the daemon stopped this agent session. The final useful event was an aborted request at 09:46 CDT; the pane has waited for more than an hour and `heartbeats_list` times out. |
| `bugs` / `w53` “FTL testing” | `w53:p1` | `01a05f55-2408-773c-8980-85faf2471008` | `DONE/IDLE` | Last substantive refinement was 06:57 CDT. The pane repeatedly timed out on `heartbeats_list` and now says the daemon connection is lost. |
| `bugs` / `w55` “testing” | `w55:p1` | `01a05def-2652-70ae-82d1-23439a018cdf` | `DEAD FRONTEND` | No matching local transcript is present. The launch timed out waiting for daemon `create`; only `zsh` remains. The scrollback states no commit or push was made. |
| `bugs` / `w56` “testing 2” | `w56:p1` | `01a05f55-b396-728f-8038-3c3b3f6f9ebf` | `STALLED` | The pane says the actual decoder/client fix had not started. No substantive work since 2026-09-01 19:04 CDT; repeated daemon timeouts and disconnect. |
| `bugs` / `w57` “natasha 4791” | `w57:p2` | `01a05ec9-1baf-7703-ac74-48387edfafe6` | `DONE/IDLE` | PR work was reported green and merge-ordered. No substantive event since 05:02 CDT; daemon reconnection failed on launch-lease contention. |
| `bugs` / `w59` “maintenance flash” | `w59:p1` | `01a061e1-cb8b-70fa-9d88-d7588e8f8095` | `ACTIVE / MONITORING` | Substantive browser/Pro-review inspection continued through 10:54 CDT. Herdr reported `working`, and the pane was still rendering a writing state. |
| `bugs` / `w5A` “payment epic” | `w5A:p1` | `01a061ee-b7fa-7343-80de-80ca74b13f0c` | `DONE/IDLE` | No substantive work since a 06:55 CDT refinement; daemon timeout and disconnect are visible. |
| `bugs` / `w5B` “projects” | `w5B:p1` | `01a061fd-f476-758f-b258-2a7a82ba8106` | `STALLED` | OAuth reconnect investigation stopped at 09:46 CDT. The pane then timed out on `heartbeats_list` and disconnected. |
| `content` / `w1A` “puzzle collections” | `w1A:p1` | `01a05ed0-21c2-7329-8f94-0c15e48bdf0b` | `STALLED` | The agent was still structuring an unfinished puzzle waterfall. No substantive event since 2026-09-01 21:06 CDT; reconnection failed on launch-lease contention. |
| `content` / `w1C` “puzzlegen” | `w1C:p1` | `01a061f0-2269-703f-aea6-9f6c83f0121d` | `ACTIVE / MONITORING` | Herdr labels the parent `done`, but that label is stale: child usage and a child completion arrived through 10:55 CDT. Seven PRs were restacked; three CI runs remained pending. |
| `content` / `w1E` “semantic detection” | `w1E:p1` | `01a05f13-fbdb-7334-88f7-4d89931a0dc3` | `ACTIVE` | Detached children continued reporting usage through 10:54 CDT, and Rust release tests/builds were verified running during the sample. The visible frontend says daemon reconnection failed, so work continues without a healthy control pane. |
| `content` / `w1F` “puzzle universe” | `w1F:p2` | `01a05ec0-668a-72cb-aff3-fb298bc6a7ec` | `DONE/IDLE` | Work was reported complete; only status events followed the 10:22 CDT substantive event. Live frontend process, but visibly disconnected. |
| `cratejoy` / `w8` “cratejoy bundle notice” | `w8:p1` | `01a05ecd-6449-760b-935a-76a48ee0e6ee` | `ACTIVE / MONITORING` | CI went green, a new-head Pro verification was submitted, and a five-minute response heartbeat was armed at 10:53 CDT. Herdr reported `working`. |
| `growth` / `w69` “community sweep · 09:12” | `w69:p1` | `01a06276-7004-71f9-9d9a-9a37c3183b7d` | `DONE/IDLE` | The routine said `Done`; its stop/archive request then timed out, and Prime reported the daemon stopped the session. Transcript remains saved. |
| `growth` / `w68` “morning report · 09:11” | `w68:p1` | `01a06276-21e2-75b3-a63c-cb8e3e6210cd` | `DONE/IDLE` | Morning Watch declared complete at 10:35 CDT. It intentionally left repository changes uncommitted because no commit was requested. |
| `growth` / `w5M` “rename events” | `w5M:p1` | `01a05f73-2d38-7179-8044-51f11a1890c3` | `DONE/IDLE` | The explainer and PR-body work were reported done. No substantive event since 2026-09-01 21:05 CDT; repeated daemon timeout and disconnect. |
| `growth` / `w5Z` “chatgpt ads” | `w5Z:p1` | `01a05ece-0927-76f7-ab63-2743e9b75407` | `ACTIVE` | Durable transcript and a live high-CPU validation prove background progress, while the visible pane remains frozen at revision 360. Active backend; unusable frontend. |
| `growth` / `w63` “home tab” | `w63:p1` | `01a061d2-6904-71cc-97db-b146f3d8cf3b` | `STALLED` | The single-page report work appears unfinished. No substantive event since 09:12 CDT; daemon timeout and disconnect. |
| `pvai` / `wZ` “AI NPC Arch” | `wZ:p1` | `01a05fe0-4a88-74c9-abca-a6cbf9e758a8` | `DONE/IDLE` | The prior failure was analyzed and a repair path recorded. No substantive event since 2026-09-01 21:16 CDT; daemon timeout and disconnect. |
| `pvai` / `w13` “playstyle feedback” | `w13:p1` | `01a05f37-f4b6-731e-96da-798a113b28fa` | `ACTIVE, FUNCTIONALLY STALLED` | Parent was monitoring an implementation child. The child remained inside a long deletion of old Xcode DerivedData; the deletion process was still present after 24 minutes. The parent transcript was active at 10:50 CDT, but useful implementation progress was waiting on cleanup. |
| `pvai` / `w15` “Pvai broken” | `w15:p1` | `01a06297-612d-769b-9ece-89b500064cf5` | `DEAD FRONTEND` | Findings are saved, but the Prime process is gone. Only `zsh` remains; resume failed on launch-lease contention. |
| `rustai` / `w9` “rustai 2p training” | `w9:p4` | `01a06194-d1be-748d-889e-86feb6bbc440` | `DONE/IDLE` | The work and receipt were reported complete at 10:23 CDT. The pane then displayed a daemon disconnect. |
| `rustai` / `wF` “mp milestone 2” | `wF:p1` | `01a05f51-826b-753f-8e38-174fe551b422` | `STALLED / MONITORING LOST` | It had waited about 85 minutes for a Pro generation whose trace stopped changing. Last substantive check was 10:35 CDT; heartbeat listing then timed out and the pane disconnected. |
| `rustai` / `wH` “sng milestone D” | `wH:p2` | `01a06280-4351-7563-b719-3f45d4651f5c` | `ACTIVE / MONITORING` | Status/check polling and tool results continued through 10:55 CDT. Herdr reported `working` and the pane was rendering a writing state. |
| `tools` / `w1E` “arch_skill” | `w1E:p1` | `01a05f63-4c03-71aa-a7bf-c7eac6773e77` | `DONE/IDLE` | Skill work was fixed, committed locally, installed, and later refined. No substantive work since 09:23 CDT; daemon timeout and disconnect. |

## Non-Prime panes — complete listing

These panes are included so the inventory covers every pane actually present in every running Herdr server. Remote SSH panes were not sent input, so only their live connection/process type can be classified.

| Herdr / workspace | Pane(s) | Observed foreground | Verdict |
|---|---|---|---|
| `default` / `w1M` “~” | `w1M:p1` | Local `zsh` | No foreground agent. |
| `bugs` / `w55` “testing” | `w55:p2` | Local `zsh` | No foreground agent. |
| `content` / `w1F` “puzzle universe” | `w1F:p1` | Local `zsh`; stale Prime scrollback | No live Prime frontend. |
| `cratejoy` / `w3` “data warehouse” | `w3:p2` | Local `zsh` | No foreground agent. |
| `logan` / `w4` “logan” | `w4:p1`, `w4:p2` | Local shells | No foreground agent in either pane. |
| `rustai` / `w2` “rustai rts” | `w2:p9`, `w2:pB` | SSH to `home` | Remote state unclassified; connection only was observed. |
| `rustai` / `w9` “rustai 2p training” | `w9:p3` | SSH to `home` | Remote state unclassified; connection only was observed. |
| `rustai` / `wG` “rustai SNG training” | `wG:p1` | SSH to `home` | Remote state unclassified; connection only was observed. |
| `rustai` / `wH` “sng milestone D” | `wH:p1` | Local `zsh` | No foreground agent. |
| `tools` / `wP` “update prime agent” | `wP:p2`, `wP:p3` | SSH to `home`; local `zsh` | Remote state unclassified; second pane has no foreground agent. |
| `tools` / `wV` “aimgr” | `wV:p6`, `wV:p7`, `wV:p5` | Codex (`done`), Codex (`working`), local `zsh` | One Codex pane done; one is this active inventory session; one shell pane is inactive. |
| `tools` / `wC` “account setup” | `wC:p2` | Local `zsh` | No foreground agent. |
| `tools` / `w1F` “aim status” | `w1F:p1` | Local `zsh` | No foreground agent. |
| `tools` / `w1H` “second CI runner” | `w1H:p1`, `w1H:p2` | SSH to `home` | Remote state unclassified; connections only were observed. |

## Herdr server and workspace totals

| Herdr server | State | Workspaces | Panes |
|---|---:|---:|---:|
| `default` | running | 1 | 1 |
| `bugs` | running | 8 | 9 |
| `content` | running | 4 | 5 |
| `cratejoy` | running | 2 | 2 |
| `growth` | running | 5 | 5 |
| `logan` | running | 1 | 2 |
| `pvai` | running | 3 | 3 |
| `rustai` | running | 5 | 8 |
| `tools` | running | 6 | 10 |
| **Total** | **9 running** | **35** | **45** |

Stopped Herdr servers: `personal`, `planning`, and `snap`. They had no live server state to query and were not started for this inventory.

## Why the terminals are laggy versus truly disconnected

There are two concurrent failure layers:

| Layer | Direct evidence | Effect |
|---|---|---|
| Machine CPU/I/O pressure | At 10:56 CDT, `fseventsd` used 103.6% CPU and about 2.85 GiB RSS. `psmobile-4788b` validation used about 96% CPU. A DerivedData `rm` remained active. Rust compilers used 31–91% each in the earlier 10:54 sample. | Terminal rendering and typing can become generally laggy even in healthy shells. The disk now has 106 GiB available, but filesystem event processing and cleanup are still active. |
| Prime control-plane failure | `daemon.sock` is absent. The daemon log stopped at 10:30:39 CDT, while client errors continued through 10:56. Clients from both installed Prime builds repeatedly see `lastProbe=absent` and then a contended launch lease. | Prime heartbeats, create/resume, stop/archive, and reconnect operations time out or fail. This explains the truly disconnected/frozen Prime panes independently of raw CPU load. |

Herdr itself was not a top CPU consumer in the process sample.

## Launch-lease evidence

- Expected socket: `/private/var/folders/cr/8sccc69d0rg1b8dsp42v7q900000gn/T/prime-agent-501/daemon.sock` — **absent**.
- Lease directory: `.supervisor-launch-a9cccd67a53b.lock` — created at **10:29:59 CDT**.
- Lease owner PID: **19763** — still alive, detached, about 5 hours 50 minutes old, with cwd `/Users/aelaguiz/workspace/coaching`.
- The lease owner is not serving the expected daemon socket. Guard publication files continue to churn while other clients fail to acquire the lease.
- This owner was deliberately not signaled or altered because it may still represent recoverable session state.

## Evidence locations

| Evidence | Location |
|---|---|
| Prime session transcripts | `/Users/aelaguiz/.prime/agent/sessions/<session-id>.jsonl` |
| Prime daemon log | `/Users/aelaguiz/.prime/agent/logs/daemon.sock.a9cccd67.log` |
| Prime client error log | `/Users/aelaguiz/.prime/agent/logs/client-errors.log` |
| Prime process lifecycle logs | `/Users/aelaguiz/.prime/agent/logs/processes/` |
| Prime runtime authority directory | `/private/var/folders/cr/8sccc69d0rg1b8dsp42v7q900000gn/T/prime-agent-501/` |

## Preservation status

All observed transcripts remain on disk except the failed/stale `01a05def-2652-70ae-82d1-23439a018cdf` launch, for which no matching JSONL was found. No recovery action was performed. In particular, the active background work in `01a05ece…`, `01a05f13…`, `01a061f0…`, `01a05ecd…`, `01a061e1…`, `01a05f37…`, and `01a06280…` was left untouched.

# Mini 2 installation prerequisites

- [x] Bring rehearsal policy-permission fix `e83c661` into Codex PR #14.
- [x] Bring rehearsal routine-selection fix `80b6e9c` into Codex PR #14.
- [x] Provision a missing Claude environment identity without replacing an existing one.
- [x] Install both approved provider bundles through `install-release.sh`.
- [x] Pass temporary-home installer tests on Mac.
- [x] Pass affected Codex policy and scheduling regressions on the combined stack.
- [x] Push all three stack branches; the Mini 2 pin is the final `auth/manual-callback-only` commit reported in the handoff.

Scope: the four AIM changes explicitly requested by Amir through the devcluster session on November 9. The rollout and Mini 2 test plan live in devcluster-config `MINI-2-PLAN.md`; this is an implementation receipt, not a second rollout plan. No additional rollout gates, runtime approval, fleet installation or service behavior changes are included.

## Changes

- The Codex branch contains the existing reviewed policy-permission and routine-selection fixes, cherry-picked as `3d9d654` and `bfafa92`.
- Release installation chooses Claude and Codex bundles separately from the same bundle directory, filtering by provider, OS, architecture and normal-use approval. Both activations finish before replacing the AIM wrappers. Codex's existing activation path installs its administrator policy.
- Claude's installer has an `--ensure-environment` operation using the existing installation lock and anchor validation. It creates a missing anchor and preserves an existing valid anchor byte-for-byte. It does not reactivate the bundle or require a Linux owner stop. Invalid existing anchors fail without replacement.
- A repeat release install provisions the Claude anchor even when both runtimes are already active. The new selector is `scripts/choose-runtime.py`, replacing the Claude-only selector.

## Validation

`python3 test/scripts/release-install.test.py`: 10 tests pass on Mac. These execute release orchestration in temporary homes with synthetic runtime installers and sudo/service stand-ins, plus the actual environment provisioning code with root ownership simulated. Coverage includes fresh dual-provider activation, a second release commit, preserved identity, repairing a missing anchor under already-active bundles, provider-specific selection, rejection of test-only approval, and Codex-install failure before wrapper publication. No installed runtime or service is changed by these tests.

`bash -n scripts/install-release.sh` and `git diff --check` pass.

On the combined stack, the home-server scratch checkout passed the four affected Node test files (`codex-policy-installer`, `codex-managed-policy`, `use-watch`, and `routine-run`): 86 passed, zero failed, one skipped. The skipped maintenance test requires the dedicated offsite audit host and writes its administrator maintenance state; it was not enabled on the shared home server. The same 10 temporary-home installer tests also passed on Linux. No provider requests or live service changes were made.

The three branches were pushed together without rewriting published history. The top branch includes current main `9766071b8b9cd0c8929f64dc216feab24941d5e4`. These four changes affect AIM orchestration and installers, not bytes inside the approved Claude or Codex runtime bundles.

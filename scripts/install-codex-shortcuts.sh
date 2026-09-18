#!/usr/bin/env bash
# Install the same rotating Codex shortcuts on macOS and Linux.
set -euo pipefail

repo_root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${AIMGR_NODE_BIN:-$(command -v node)}"
"$node_bin" --input-type=module - "$repo_root" <<'JS'
import fs from "node:fs";
import path from "node:path";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required to install Codex shortcuts.");
const shortcuts = path.join(home, ".config", "aimgr", "codex-shortcuts.zsh");
fs.mkdirSync(path.dirname(shortcuts), { recursive: true });
const body = `# Installed by aimgr/scripts/install-codex-shortcuts.sh.
# Every command selects a different eligible AIM account before launching.
#   c   - new thread on a rotated account
#   cr  - rotate, carry the thread into a brand-new thread id, scrubbed, then resume the copy
#         (no argument means: the most recent thread for this directory, like the old picker default)
# There is deliberately no same-thread resume shortcut: resuming an existing thread id on a
# different account sends that thread id and session id to the Codex servers under the new
# account, which links the two accounts. See CLAUDE.md, "Codex account rotation rule".
unalias c cr crr 2>/dev/null || true
unfunction crr 2>/dev/null || true
c()   { command aim codex run "$@"; }
cr()  { if [ "$#" -eq 0 ]; then command aim codex resume-fresh --last; else command aim codex resume-fresh "$@"; fi }
`;
const source = '[ ! -r "$HOME/.config/aimgr/codex-shortcuts.zsh" ] || source "$HOME/.config/aimgr/codex-shortcuts.zsh"';

function install(file, text) {
  const existing = fs.existsSync(file);
  const target = existing ? fs.realpathSync(file) : file;
  if (existing && fs.readFileSync(target, "utf8") === text) return;
  if (existing) fs.copyFileSync(target, `${target}.before-aim-codex-${Date.now()}`);
  const staged = `${target}.aim-codex-${process.pid}`;
  fs.writeFileSync(staged, text, { mode: existing ? fs.statSync(target).mode & 0o777 : 0o644 });
  fs.renameSync(staged, target);
}

install(shortcuts, body);
const rc = path.join(process.env.ZDOTDIR || home, ".zshrc");
const current = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
// Keep the managed source last, after any older shortcuts in shared dotfiles.
// Drop the managed source line (re-added last below) and any inline same-thread resume
// definition an older installer or dotfile left behind.
const hazardous = new Set([
  'cr() { command aim codex resume "$@"; }',
  'crr() { command aim codex resume "$@"; }',
]);
const lines = current.split("\n").filter(line => line !== source && !hazardous.has(line.trim()));
const updated = `${lines.join("\n").trimEnd()}\n${source}\n`;
install(rc, updated);
console.log(`Installed c/cr (crr removed): ${shortcuts}`);
console.log(`Startup file: ${rc}`);
console.log('Reload in an existing shell: source "$HOME/.config/aimgr/codex-shortcuts.zsh"');
JS

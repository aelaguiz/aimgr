#!/usr/bin/env bash
set -euo pipefail
for d in "$HOME"/.nvm/versions/node/*/bin; do [ ! -d "$d" ] || PATH="$d:$PATH"; done
PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
export PATH
cd "$HOME/workspace/aimgr"
target=298cd2637405b9c13163ebf13ee94a5d79830ca5
test "$(git rev-parse HEAD)" = "$target"
test "$(git branch --show-current)" = main
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureHarnessSessionIdentityExtension } from './src/targets/harness-session-identity.js';
const extensions=[];
for(const kind of ['prime','pi']) {
  const agentDir=path.join(os.homedir(),`.${kind}`,'agent');
  const file=path.join(agentDir,'extensions/session-title-footer.ts');
  if(!fs.existsSync(file)){extensions.push({kind,status:'not installed'});continue;}
  const backup=path.join(os.homedir(),'.aimgr/deploy-backups/footer-298cd26',`${kind}.ts`);
  fs.mkdirSync(path.dirname(backup),{recursive:true,mode:0o700});
  if(!fs.existsSync(backup)) fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
  const result=ensureHarnessSessionIdentityExtension({agentDir});
  assert.equal(fs.readFileSync(file,'utf8'),fs.readFileSync('native/harness/session-title-footer.js','utf8'));
  extensions.push({kind,status:result.status});
}
const aim=path.join(os.homedir(),'.local/bin/aim');
const source=fs.readFileSync(aim,'utf8');
const entry=path.join(process.cwd(),'bin/aimgr.js');
assert.ok(fs.realpathSync(aim) === fs.realpathSync(entry) || source.includes(entry), 'Installed aim wrapper points elsewhere');
console.log(JSON.stringify({host:os.hostname(),node:process.version,installedAim:aim,extensions}));
JS
aim --help >/dev/null
log="$HOME/.aimgr/deploy-backups/performance-298cd26-smoke.log"
env -u CODEX_HOME -u PI_CODING_AGENT_DIR -u PRIME_AGENT_CODING_AGENT_DIR -u CLAUDE_CONFIG_DIR \
  node --test --test-concurrency=1 \
  test/io/file-lines.test.js test/claude/claude-sessions.test.js \
  test/claude/claude-transcript-rekey.test.js test/routines/claude-hook.test.js \
  test/pi/prime-sessions.test.js test/pi/session-identity-extension.test.js >"$log" 2>&1 || { tail -35 "$log"; exit 1; }
tail -9 "$log"
git diff --check
git status --short

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexWorkingDirectories } from "../../src/privacy/codex-working-directories.js";
import { resolveCodexLaunchInputs } from "../../src/privacy/codex-launch-inputs.js";
import { readAimgrConfig, writeAimgrConfig } from "../../src/config/aimgr-config.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "linux" ? "/var/tmp" : os.tmpdir(), "codex-work-areas-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home"); fs.mkdirSync(homeDir);
  return { root, homeDir };
}

test("machine-local extra directories survive unrelated AIM config writes", t => {
  const { homeDir } = fixture(t);
  writeAimgrConfig({ homeDir, config: { codexWorkingDirectories: ["~/other workspace", "/mnt/screenshots"] } });
  const config = readAimgrConfig({ homeDir }).config;
  writeAimgrConfig({ homeDir, config: { ...config, redis: { url: "redis://fixture" } } });
  const roots = codexWorkingDirectories({ homeDir, platform: "linux" });
  assert.deepEqual(roots, [path.join(homeDir, "workspace"), "/tmp", path.join(homeDir, "Downloads"),
    path.join(homeDir, "Pictures/Screenshots"), path.join(homeDir, "other workspace"), "/mnt/screenshots"]);
  assert.equal(fs.existsSync(path.join(homeDir, "workspace")), false, "reading grants does not create directories");
  assert.throws(() => codexWorkingDirectories({ homeDir, config: { codexWorkingDirectories: "wrong" } }), /list/);
});

test("Linux respects XDG download and picture locations without executing configuration", t => {
  const { homeDir } = fixture(t);
  fs.mkdirSync(path.join(homeDir, ".config"));
  const file = path.join(homeDir, ".config/user-dirs.dirs");
  fs.writeFileSync(file, 'XDG_DOWNLOAD_DIR="$HOME/Incoming files"\nXDG_PICTURES_DIR="/mnt/pictures"\n');
  assert.deepEqual(codexWorkingDirectories({ homeDir, platform: "linux" }), [path.join(homeDir, "workspace"), "/tmp",
    path.join(homeDir, "Incoming files"), "/mnt/pictures/Screenshots"]);
  fs.writeFileSync(file, 'XDG_DOWNLOAD_DIR="$HOME"\nXDG_PICTURES_DIR="$HOME"\n');
  assert.deepEqual(codexWorkingDirectories({ homeDir, platform: "linux" }), [path.join(homeDir, "workspace"), "/tmp"]);
});

test("Mac uses its screenshot location without granting an enclosing home directory", t => {
  const { root, homeDir } = fixture(t);
  const temporary = path.join(root, "os-user-temp");
  const tempResult = { status: 0, stdout: temporary + "\n" };
  assert.deepEqual(codexWorkingDirectories({ homeDir, platform: "darwin", spawnSyncImpl: () => tempResult }), [path.join(homeDir, "workspace"), "/tmp",
    path.join(homeDir, "Downloads"), temporary, path.join(homeDir, "Desktop")]);
  const preferences = path.join(homeDir, "Library/Preferences/com.apple.screencapture.plist");
  fs.mkdirSync(path.dirname(preferences), { recursive: true }); fs.writeFileSync(preferences, "synthetic plist");
  const roots = codexWorkingDirectories({ homeDir, platform: "darwin", spawnSyncImpl: (command, args) => {
    if (command === "/usr/bin/getconf") { assert.deepEqual(args, ["DARWIN_USER_TEMP_DIR"]); return tempResult; }
    assert.equal(command, "/usr/bin/plutil"); assert.deepEqual(args, ["-extract", "location", "raw", "-o", "-", preferences]);
    return { status: 0, stdout: "~/Screen captures\n" };
  } });
  assert(roots.includes(path.join(homeDir, "Screen captures"))); assert(!roots.includes(homeDir));
  assert(roots.includes(temporary), "OS temporary folder survives an invocation TMPDIR override");
  const defaults = spawnSyncImpl => codexWorkingDirectories({ homeDir, platform: "darwin", spawnSyncImpl,
    env: { TMPDIR: "/tmp/aim-private-scratch" } });
  assert(!defaults(() => ({ status: 0, stdout: homeDir })).includes(homeDir), "home preference is skipped");
  assert(defaults(() => ({ status: 1 })).includes(path.join(homeDir, "Desktop")), "unreadable preferences use the normal default");
  fs.symlinkSync(path.join(root, "unmounted-volume"), path.join(homeDir, "workspace"));
  assert(!defaults(() => ({ status: 1 })).includes(path.join(homeDir, "workspace")), "dangling optional roots are skipped");
  assert(codexWorkingDirectories({ homeDir, platform: "linux", config: { codexWorkingDirectories: ["~/workspace"] } })
    .includes(path.join(homeDir, "workspace")), "explicit roots stay strict at launch");
});

test("work grants cover future files and aliases while preserving exact outside selections", t => {
  const { root, homeDir } = fixture(t);
  const cwd = path.join(homeDir, "workspace/one"), sharedHome = path.join(homeDir, ".codex");
  const accountRoot = path.join(homeDir, ".aimgr/accounts/a"), codexHome = path.join(accountRoot, "home");
  for (const file of [cwd, sharedHome, codexHome]) fs.mkdirSync(file, { recursive: true });
  const alias = path.join(root, "work-alias"); fs.symlinkSync(path.join(homeDir, "workspace"), alias);
  const outside = path.join(root, "selected image.png"); fs.writeFileSync(outside, "synthetic");
  const options = { homeDir, env: {}, prepared: { accountRoot, codexHome, sharedHome },
    parsedArgs: { directories: [], images: [outside] }, spawnSyncImpl: () => ({ status: 1 }),
    effectiveInputs: { cwd, reads: [], writes: [], database_roots: [] },
    workingDirectories: [alias, path.join(homeDir, "Downloads")] };
  const inputs = resolveCodexLaunchInputs(options);
  assert(inputs.writes.includes(path.join(homeDir, "workspace")));
  assert(!inputs.writes.includes(cwd), "recursive parent replaces redundant project grant");
  assert(inputs.writes.includes(path.join(homeDir, "Downloads")), "missing directory gets a future recursive grant");
  assert(inputs.reads.includes(outside)); assert(!inputs.reads.includes(root)); assert(!inputs.writes.includes(root));
  fs.mkdirSync(path.join(homeDir, "workspace/later/subdirectory"), { recursive: true });
  assert.deepEqual(resolveCodexLaunchInputs(options), inputs, "later work needs no new launch grant");
  const homeAlias = path.join(root, "home-alias"); fs.symlinkSync(homeDir, homeAlias);
  for (const directory of ["/", homeDir, root, homeAlias, path.join(homeDir, ".aimgr")]) {
    assert.throws(() => resolveCodexLaunchInputs({ ...options, workingDirectories: [directory] }), /whole home or account collection/);
  }
});

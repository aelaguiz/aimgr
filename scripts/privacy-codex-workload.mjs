#!/usr/bin/env node
// Finite actual-tool recipes for cases 1, 5, 8 and 12. The model endpoint is
// synthetic; the vendor, native patch/image tools, shell, git and media tools are real.
// This does not establish real-agent orchestration or service/device acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { writeAimgrConfig } from "../src/config/aimgr-config.js";

assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST") && process.getuid() !== 0);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const selectedCase = Number(process.argv.find(arg => arg.startsWith("--case="))?.split("=")[1]);
const lateTemp = process.argv.includes("--late-temp");
const skillSymlinks = process.argv.includes("--skill-symlinks");
const skillAliases = process.argv.includes("--skill-aliases");
assert.ok([1, 5, 8, 12].includes(selectedCase), "choose --case=1, --case=5, --case=8 or --case=12");
assert.ok(!lateTemp || selectedCase === 8, "--late-temp extends case 8 only");
assert.ok(!(skillSymlinks && skillAliases));
assert.ok(!(skillSymlinks || skillAliases) || selectedCase === 12, "skill options extend case 12 only");
const root = fs.mkdtempSync(`/opt/aimgr-state-audit/codex-m1-fixtures/workload-${selectedCase}-`);
console.log(JSON.stringify({ case: selectedCase, fixture: root }));
const q = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const returnedImage = output => {
  const match = JSON.stringify(output).match(/data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/);
  assert.ok(match, "native image must contain its actual payload");
  return Buffer.from(match[1], "base64");
};
const py = text => "/usr/bin/python3 -c " + q(text);
const shell = (id, cmd) => ({ type: "function_call", call_id: id, name: "exec_command",
  arguments: JSON.stringify({ cmd, login: false, yield_time_ms: 1000, max_output_tokens: 1500 }) });
const image = (id, file) => ({ type: "function_call", call_id: id, name: "view_image", arguments: JSON.stringify({ path: file }) });
const patch = (id, file, before, after) => ({ type: "custom_tool_call", call_id: id, name: "apply_patch",
  input: before === null ? `*** Begin Patch\n*** Add File: ${file}\n${after.trimEnd().split("\n").map(line => "+" + line).join("\n")}\n*** End Patch`
    : `*** Begin Patch\n*** Update File: ${file}\n@@\n${before.trimEnd().split("\n").map(line => "-" + line).join("\n")}\n${after.trimEnd().split("\n").map(line => "+" + line).join("\n")}\n*** End Patch` });
const results = [];

for (const protectedLaunch of [false, true]) {
  const name = protectedLaunch ? "protected" : "stock";
  const homeDir = path.join(root, name), shared = path.join(homeDir, ".codex");
  let cwd = path.join(homeDir, "workspace/current"), invocation, child, timer;
  for (const dir of [shared, cwd]) fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), `aim-workload-${name}-`));
  const env = { HOME: homeDir, CODEX_HOME: shared, TMPDIR: tmp,
    PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "xterm-256color" };
  const requests = [], outputs = new Map(), steps = [], survivors = [], ownedTemporary = [tmp];
  let step = 0, first = true, serverError, credentialReceipts = 0, fixtureVideo;
  const credentialCanary = "SYNTHETIC_TOOL_KEY_" + hash(name + root).slice(0, 20);
  let verify, afterExit, afterNative, outsideImage, extraConfig = "";
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/tool-credential") {
        assert.equal(req.headers.authorization, "Bearer " + credentialCanary);
        credentialReceipts++; res.writeHead(200); res.end("TOOL_AUTHORIZED"); return;
      }
      if (req.url === "/test-pattern.mp4") { assert.ok(fixtureVideo); res.writeHead(200, { "content-type": "video/mp4" }); res.end(fixtureVideo); return; }
      if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"models":[]}'); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
      if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
      const body = JSON.parse(bytes.toString()); requests.push(body);
      for (const item of body.input ?? []) if (["function_call_output", "custom_tool_call_output"].includes(item.type)) outputs.set(item.call_id, item.output);
      if (first) { first = false; assert.equal(step, 0); }
      const latestOutput = (body.input ?? []).filter(item => item.type === "function_call_output").at(-1)?.output;
      const running = JSON.stringify(latestOutput ?? "").match(/Process running with session ID (\d+)/);
      const item = running ? { type: "function_call", call_id: "poll-" + requests.length, name: "write_stdin",
        arguments: JSON.stringify({ session_id: Number(running[1]), chars: "", yield_time_ms: 1000, max_output_tokens: 1500 }) }
        : steps[step++] ?? { type: "message", role: "assistant", id: "done", content: [{ type: "output_text", text: "Synthetic workload tool sequence completed." }] };
      const id = `workload-${selectedCase}-${name}-${step}`;
      const events = [{ type: "response.created", response: { id } }, { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) { serverError ??= error; res.writeHead(500); res.end("Synthetic workload fixture failed"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let args = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "Replay the synthetic workload."];

  if (selectedCase === 1) {
    const repo = path.join(homeDir, "workspace/source repository"), sibling = path.join(homeDir, "workspace/brief and assets");
    const remote = path.join(root, name + "-disposable.git");
    fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(sibling, { recursive: true });
    const git = (at, ...argv) => execFileSync("git", ["-C", at, ...argv], { env: { ...process.env, HOME: homeDir }, stdio: "pipe" });
    git(repo, "init", "-b", "main"); git(repo, "config", "user.email", "fixture@example.invalid"); git(repo, "config", "user.name", "Synthetic Fixture");
    put(path.join(repo, "sum.py"), "def add(a,b): return a\n");
    put(path.join(repo, "check.py"), "from sum import add\nassert add(2,3)==5\n");
    put(path.join(repo, ".gitignore"), "__pycache__/\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "Synthetic baseline");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" }); git(repo, "remote", "add", "origin", remote);
    cwd = path.join(homeDir, "workspace/linked worktree"); git(repo, "worktree", "add", "-b", "workload", cwd);
    put(path.join(sibling, "brief.md"), "Implement addition. Write the result beside this brief.\n");
    put(path.join(homeDir, "Private/tool-env.sh"), `export SYNTHETIC_TOOL_KEY=${q(credentialCanary)}\n`);
    steps.push(shell("worktree-first-revision", `set -eu\ncat ${q(path.join(sibling, "brief.md"))}\n. ${q(path.join(homeDir, "Private/tool-env.sh"))}\ncurl -fsS -H "Authorization: Bearer $SYNTHETIC_TOOL_KEY" ${q(endpoint + "/tool-credential")}\n${py("from pathlib import Path; Path('sum.py').write_text('def add(a,b): return abs(a)+abs(b)\\n')")}\npython3 check.py\nprintf 'first revision\\n' > ${q(path.join(sibling, "result.txt"))}\ngit add sum.py\ngit commit -m 'Implement addition'\ngit push origin workload`));
    const mutationRestore = `from pathlib import Path
import subprocess
p=Path('sum.py'); before=p.read_bytes()
try:
 p.write_text('def add(a,b): return 0\\n')
 failed=subprocess.run(['python3','check.py'],capture_output=True)
 assert failed.returncode!=0
finally: p.write_bytes(before)
assert p.read_bytes()==before
print('DELIBERATE_FAILURE_AND_RESTORE_OK')
`;
    steps.push(shell("returned-review-and-correction", `set -eu\n${py(mutationRestore)}\n${py("from pathlib import Path; import subprocess; result=subprocess.run(['python3','-c','from sum import add; assert add(-2,3)==1'],capture_output=True); assert result.returncode!=0; print('RETURNED_REVIEW_NEGATIVE_INPUT_REPRODUCED'); Path('sum.py').write_text('def add(a,b): return a+b\\n')")}\npython3 check.py\npython3 -c 'from sum import add; assert add(-2,3)==1'\ngit add sum.py\ngit commit -m 'Handle signed inputs'\ngit push origin workload\nprintf 'corrected signed addition\\n' > ${q(path.join(sibling, "result.txt"))}\nprintf 'WORKTREE_COMPLETE\\n'`));
    verify = () => {
      assert.equal(fs.readFileSync(path.join(cwd, "sum.py"), "utf8"), "def add(a,b): return a+b\n");
      assert.equal(fs.readFileSync(path.join(sibling, "result.txt"), "utf8"), "corrected signed addition\n");
      assert.equal(git(cwd, "branch", "--show-current").toString().trim(), "workload");
      assert.equal(git(cwd, "rev-list", "--count", "main..HEAD").toString().trim(), "2");
      assert.equal(git(cwd, "status", "--porcelain").toString(), "", "only the intended tracked source changes");
      assert.equal(git(cwd, "rev-parse", "HEAD").toString(), execFileSync("git", ["--git-dir", remote, "rev-parse", "workload"]).toString());
      assert.match(JSON.stringify([...outputs.values()]), /WORKTREE_COMPLETE/);
      assert.equal(credentialReceipts, 1);
      const search = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) search(file); else if (entry.isFile()) assert.ok(!fs.readFileSync(file).includes(Buffer.from(credentialCanary)), "tool credential copied to native state: " + file); } };
      search(shared); if (invocation) search(path.join(homeDir, ".aimgr/accounts"));
      return { linkedWorktree: true, revisions: 2, localRemoteMatches: true, credentialDeliveredWithoutNativeCopy: true };
    };
  }

  if (selectedCase === 5) {
    const sourceVideo = path.join(tmp, "source.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=2:d=1", "-vf", "drawbox=x=80:y=0:w=80:h=90:color=blue:t=fill", "-c:v", "mpeg4", "-y", sourceVideo]);
    fixtureVideo = fs.readFileSync(sourceVideo); fs.unlinkSync(sourceVideo);
    const screenshot = path.join(homeDir, process.platform === "linux" ? "Pictures/Screenshots" : "Screen captures");
    const areas = [path.join(homeDir, "workspace/sibling frames"), tmp, path.join(homeDir, "Downloads"), screenshot];
    if (process.platform === "darwin") { const macTmp = fs.mkdtempSync(path.join(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim(), "aim-workload-frames-")); areas.push(macTmp); ownedTemporary.push(macTmp); }
    if (process.platform === "darwin") put(path.join(homeDir, "Library/Preferences/com.apple.screencapture.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>location</key><string>${screenshot}</string></dict></plist>`);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
    outsideImage = path.join(root, name + "-outside/selected.png"); const neighbor = path.join(path.dirname(outsideImage), "neighbor.png"), privateImage = path.join(homeDir, "Private/private.png"), other = path.join(homeDir, ".aimgr/accounts/openai-codex/other/image.png");
    for (const file of [outsideImage, neighbor, privateImage, other]) put(file, png);
    const alias = path.join(cwd, "private-link.png"); fs.symlinkSync(privateImage, alias);
    args.splice(1, 0, "--image", outsideImage);
    const downloaded = path.join(tmp, "downloaded after start.mp4");
    steps.push(shell("download-and-generate", `set -eu\ncurl -fsS ${q(endpoint + "/test-pattern.mp4")} -o ${q(downloaded)}\n` + areas.map(area => `mkdir -p ${q(path.join(area, "created after start"))}\nffmpeg -hide_banner -loglevel error -i ${q(downloaded)} -frames:v 1 -threads 1 -y ${q(path.join(area, "created after start/frame.png"))}`).join("\n") + "\nprintf 'FRAMES_CREATED_AFTER_START\\n'"));
    for (let index = 0; index < areas.length; index++) steps.push(image("generated-frame-" + index, path.join(areas[index], "created after start/frame.png")));
    steps.push(image("selected-outside", outsideImage));
    for (const [id, file] of [["unselected-sibling", neighbor], ["private-canary", privateImage], ["other-account", other], ["private-symlink", alias]]) steps.push(image(id, file));
    verify = () => {
      assert.equal(hash(fs.readFileSync(downloaded)), hash(fixtureVideo));
      for (let index = 0; index < areas.length; index++) {
        assert.match(JSON.stringify(outputs.get("generated-frame-" + index)), /input_image|data:image\//);
        const payload = returnedImage(outputs.get("generated-frame-" + index));
        const payloadFile = path.join(root, name + "-native-frame-" + index + ".png"); put(payloadFile, payload);
        const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", payloadFile, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        assert.equal(raw.length, 160 * 90 * 3); const left = 3 * (45 * 160 + 40), right = 3 * (45 * 160 + 120);
        assert.ok(raw[left] > 200 && raw[left + 2] < 50 && raw[right] < 50 && raw[right + 2] > 200, "generated frame must contain red/blue test pattern");
      }
      assert.match(JSON.stringify(outputs.get("selected-outside")), /input_image|data:image\//);
      for (const id of ["unselected-sibling", "private-canary", "other-account", "private-symlink"]) assert.match(JSON.stringify(outputs.get(id)), protectedLaunch ? /[Pp]ermission denied|[Oo]peration not permitted/ : /input_image|data:image\//);
      return { downloadedVideoHash: hash(fixtureVideo), generatedNativeImages: areas.length, selectedOutsideImage: true, privateBoundary: protectedLaunch ? "denied" : "stock readable" };
    };
  }

  if (selectedCase === 8 && lateTemp) {
    const support = path.join(cwd, "late-temp"), job = path.join(cwd, "late-temp-worker.py");
    put(job, `import json,os,pathlib,socket,tempfile,time\nroot=pathlib.Path(${JSON.stringify(support)}); root.mkdir(exist_ok=True)\n(root/'ready.json').write_text(json.dumps({'pid':os.getpid(),'tmpdir':os.environ.get('TMPDIR')}))\ndeadline=time.monotonic()+30\nwhile not (root/'go').exists():\n assert time.monotonic()<deadline, 'parent exit gate timed out'\n time.sleep(.05)\nresult={'tmpdir':os.environ.get('TMPDIR')}\ntry:\n fd,name=tempfile.mkstemp(prefix='late-',dir=os.environ['TMPDIR']); os.close(fd); pathlib.Path(name).unlink()\n s=socket.socket(socket.AF_UNIX); name=str(pathlib.Path(os.environ['TMPDIR'])/'late.sock'); s.bind(name); s.close(); pathlib.Path(name).unlink()\n result['passed']=True\nexcept Exception as error: result.update(passed=False,error=repr(error))\n(root/'result.json').write_text(json.dumps(result))\n`);
    steps.push(shell("detach-before-first-temp-use", py(`import json,pathlib,subprocess,time\nroot=pathlib.Path(${JSON.stringify(support)}); root.mkdir(exist_ok=True)\np=subprocess.Popen(['python3',${JSON.stringify(job)}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\nfor _ in range(60):\n if (root/'ready.json').exists(): break\n time.sleep(.05)\nelse: raise AssertionError('late worker not ready')\nprint('LATE_TEMP_WORKER_READY',p.pid)\n`)));
    afterExit = async () => {
      const ready = JSON.parse(fs.readFileSync(path.join(support, "ready.json")));
      survivors.push({ pid: ready.pid, script: job });
      process.kill(ready.pid, 0);
      put(path.join(support, "go"), "native parent closed\n");
      for (let n = 0; !fs.existsSync(path.join(support, "result.json")); n++) { assert.ok(n < 120); await delay(50); }
      survivors.length = 0;
      const outcome = JSON.parse(fs.readFileSync(path.join(support, "result.json")));
      put(path.join(root, name + "-late-temp.json"), JSON.stringify({ expectedTmpdir: tmp, ...outcome }, null, 2));
      assert.equal(outcome.passed, true, `${name} late temp failed: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.tmpdir, tmp, "ordinary tools retain original caller TMPDIR");
    };
    verify = () => ({ lateFirstTempAfterParentExit: true, originalTmpdirRetained: true });
  }

  if (selectedCase === 8 && !lateTemp) {
    const support = path.join(homeDir, "Library/Application Support/aim-workload-test"), job = path.join(cwd, "workbook.py");
    const worker = `import fcntl,json,os,pathlib,socket,sys,time\nroot=pathlib.Path(${JSON.stringify(support)}); root.mkdir(parents=True,exist_ok=True)\nlock=(root/'job.lock').open('a+')\ntry: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: print('LOCK_BUSY'); sys.exit(7)\n(root/'pid.json').write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()}))\ns=socket.socket(socket.AF_UNIX); sock=pathlib.Path(os.environ['TMPDIR'])/'job.sock'; s.bind(str(sock)); (root/'ready').write_text('ready')\ntry:\n if sys.argv[1]=='gate':\n  deadline=time.monotonic()+30\n  while not (root/'allow-finish').exists():\n   assert time.monotonic()<deadline, 'parent exit gate timed out'\n   time.sleep(.05)\n else: time.sleep(float(sys.argv[1]))\n (root/'output.txt').write_text('SYNTHETIC_WORKBOOK_VALUES: 2,3,5\\n'); (root/'completed').write_text('once'); print('DETACHED_COMPLETE',flush=True)\nfinally: s.close(); sock.unlink(missing_ok=True)\n`;
    put(job, worker);
    steps.push(shell("detach-and-contend", py(`import json,os,pathlib,subprocess,time\nroot=pathlib.Path(${JSON.stringify(support)}); root.mkdir(parents=True,exist_ok=True)\nlog=(root/'job.log').open('ab'); p=subprocess.Popen(['python3',${JSON.stringify(job)},'gate'],stdout=log,stderr=log,start_new_session=True)\nfor _ in range(60):\n if (root/'ready').exists(): break\n time.sleep(.05)\nelse: raise AssertionError('worker never ready')\nr=subprocess.run(['python3',${JSON.stringify(job)},'.01'],capture_output=True,text=True); assert r.returncode==7 and 'LOCK_BUSY' in r.stdout\nprint('DETACHED_AND_LOCK_BUSY',p.pid)\n`)));
    // Native parent exits while the detached process remains. Continuation is
    // another real native invocation, rather than an assertion by this model.
    afterExit = async () => {
      const record = JSON.parse(fs.readFileSync(path.join(support, "pid.json"))); survivors.push({ pid: record.pid, script: job });
      assert.doesNotThrow(() => process.kill(record.pid, 0), "detached worker must survive native parent exit");
      put(path.join(support, "allow-finish"), "parent exited\n");
      for (let n = 0; !fs.existsSync(path.join(support, "completed")); n++) { assert.ok(n < 120, "survivor did not complete"); await delay(50); }
      survivors.length = 0;
      step = steps.length;
      steps.push(shell("continue-and-recover", py(`import json,os,pathlib,signal,subprocess,time\nroot=pathlib.Path(${JSON.stringify(support)}); assert (root/'output.txt').read_text()=='SYNTHETIC_WORKBOOK_VALUES: 2,3,5\\n'; assert not (pathlib.Path(os.environ['TMPDIR'])/'job.sock').exists()\n(root/'ready').unlink(); p=subprocess.Popen(['python3',${JSON.stringify(job)},'30'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\nfor _ in range(60):\n if (root/'ready').exists(): break\n time.sleep(.05)\nelse: raise AssertionError('retry worker never ready')\nrecord=json.loads((root/'pid.json').read_text()); assert record['pid']==p.pid and record['pgid']==p.pid; os.killpg(p.pid,signal.SIGTERM); assert p.wait(timeout=5)==-signal.SIGTERM\n(pathlib.Path(os.environ['TMPDIR'])/'job.sock').unlink(missing_ok=True)\nr=subprocess.run(['python3',${JSON.stringify(job)},'.01'],capture_output=True,text=True); assert r.returncode==0 and 'DETACHED_COMPLETE' in r.stdout\nprint('CONTINUATION_AND_OWNED_RETRY_OK')\n`)));
    };
    verify = () => { assert.match(JSON.stringify([...outputs.values()]), /DETACHED_AND_LOCK_BUSY/); assert.match(JSON.stringify([...outputs.values()]), /CONTINUATION_AND_OWNED_RETRY_OK/); assert.equal(fs.readFileSync(path.join(support, "output.txt"), "utf8"), "SYNTHETIC_WORKBOOK_VALUES: 2,3,5\n"); return { detachedSurvivedParent: true, duplicateContenderDenied: true, ownedWorkerStoppedAndRetried: true, invocationTmpSocket: true }; };
  }

  if (selectedCase === 12 && !skillSymlinks && !skillAliases) {
    const skill = path.join(homeDir, ".agents/skills/workload-note/SKILL.md"), instruction = path.join(cwd, "AGENTS.md"), reports = path.join(homeDir, "workspace/reports");
    const privateSibling = path.join(homeDir, ".agents/private-note.txt");
    put(skill, "---\nname: workload-note\ndescription: Synthetic workload note\n---\nWrite the original scope.\n");
    put(privateSibling, "PRIVATE_SIBLING_ORIGINAL\n");
    assert.equal(fs.lstatSync(path.join(homeDir, ".agents/skills")).isSymbolicLink(), false, "test installed skills must be a real directory outside workspace");
    put(instruction, "Write a report containing FIRST_SCOPE.\n"); put(path.join(shared, "relative-instructions.md"), "SYNTHETIC_RELATIVE_INSTRUCTIONS\n");
    writeAimgrConfig({ homeDir, config: { codexWorkingDirectories: [reports] } });
    fs.mkdirSync(reports, { recursive: true });
    steps.push(shell("first-scope", `set -eu\ncat ${q(instruction)} ${q(skill)}\nprintf 'FIRST_SCOPE\\n' > ${q(path.join(reports, "report.txt"))}`));
    steps.push(patch("native-instruction-edit", instruction, "Write a report containing FIRST_SCOPE.", "Scope correction: write REVISED_SCOPE and include signed inputs."));
    steps.push(patch("native-installed-skill-edit", skill, "Write the original scope.", "REVISED_SCOPE: include signed inputs."));
    steps.push(patch("native-private-sibling-edit", privateSibling, "PRIVATE_SIBLING_ORIGINAL", "PRIVATE_SIBLING_CHANGED"));
    steps.push(shell("honor-corrected-scope", `set -eu\ncat ${q(instruction)} ${q(skill)}\nprintf 'REVISED_SCOPE: signed inputs\\n' > ${q(path.join(reports, "report.txt"))}`));
    afterNative = async runNative => {
      step = steps.length;
      steps.push(patch("native-readonly-installed-skill-edit", skill, "description: Synthetic workload note", "description: Synthetic changed readonly"));
      await runNative(["-a", "never", "--sandbox", "read-only", "exec", "--json", "--skip-git-repo-check", "Try only the synthetic installed skill patch."]);
    };
    verify = () => {
      assert.match(String(outputs.get("native-installed-skill-edit")), /Success/);
      assert.match(fs.readFileSync(skill, "utf8"), /REVISED_SCOPE: include signed inputs\./);
      assert.match(fs.readFileSync(skill, "utf8"), /description: Synthetic workload note\n/, "read-only native patch must not modify installed skill");
      assert.match(String(outputs.get("native-readonly-installed-skill-edit")), /reject|denied|not permitted|read.only|outside.*project/i);
      assert.equal(fs.readFileSync(privateSibling, "utf8"), protectedLaunch ? "PRIVATE_SIBLING_ORIGINAL\n" : "PRIVATE_SIBLING_CHANGED\n");
      assert.match(String(outputs.get("native-private-sibling-edit")), protectedLaunch ? /denied|not permitted/i : /Success/);
      assert.equal(fs.readFileSync(path.join(reports, "report.txt"), "utf8"), "REVISED_SCOPE: signed inputs\n");
      assert.match(String(outputs.get("honor-corrected-scope")), /REVISED_SCOPE/);
      return { scopeCorrectionSameInvocation: true, nativeInstalledSkillWrite: true, installedSkillsRealDirectoryOutsideWorkspace: true,
        nativePrivateSiblingWrite: protectedLaunch ? "denied" : "stock allowed", nativeReadonlySkillWrite: "denied",
        remaining: "helper discovery and native live non-path settings are separate existing fixtures; this recipe does not claim those steps" };
    };
  }

  if (selectedCase === 12 && skillSymlinks) {
    const sources = path.join(homeDir, "Installed skill sources"), privateNeighbor = path.join(sources, "private-neighbor.txt");
    const linked = [
      { id: "agents", link: path.join(homeDir, ".agents/skills/linked-agents"), target: path.join(sources, "agents-target"), description: "SYNTHETIC_LINKED_AGENTS_DESCRIPTION" },
      { id: "codex", link: path.join(shared, "skills/linked-codex"), target: path.join(sources, "codex-target"), description: "SYNTHETIC_LINKED_CODEX_DESCRIPTION" },
      { id: "disabled", link: path.join(shared, "skills/linked-disabled"), target: path.join(sources, "disabled-target"), description: "SYNTHETIC_LINKED_DISABLED_DESCRIPTION", disabled: true },
      { id: "nested", link: path.join(shared, "skills/linked-collection"), target: path.join(sources, "collection/nested-target"), aliasTarget: path.join(sources, "collection"), description: "SYNTHETIC_LINKED_NESTED_DESCRIPTION" },
      { id: "invalid", link: path.join(homeDir, ".agents/skills/linked-invalid"), target: path.join(sources, "invalid-target"), description: "SYNTHETIC_LINKED_INVALID_DESCRIPTION", invalid: true },
      { id: "empty", link: path.join(homeDir, ".agents/skills/linked-empty"), target: path.join(sources, "empty-target"), description: "SYNTHETIC_LINKED_EMPTY_DESCRIPTION", empty: true },
    ];
    for (const skill of linked) {
      const document = content => `---\nname: linked-${skill.id}\ndescription: ${skill.description}\n---\n${content}\n`;
      const original = skill.invalid ? `---\nname: [invalid frontmatter\n---\nORIGINAL_LINKED_INVALID_CONTENT\n` : document(`ORIGINAL_LINKED_${skill.id.toUpperCase()}_CONTENT`);
      if (skill.empty) fs.mkdirSync(skill.target, { recursive: true });
      else put(path.join(skill.target, "SKILL.md"), original);
      fs.mkdirSync(path.dirname(skill.link), { recursive: true }); fs.symlinkSync(skill.aliasTarget ?? skill.target, skill.link);
      assert.equal(fs.realpathSync(skill.link), skill.aliasTarget ?? skill.target);
      skill.file = path.join(skill.link, skill.aliasTarget ? "nested-target/SKILL.md" : "SKILL.md");
      steps.push(patch(`native-linked-${skill.id}-edit`, skill.file, skill.empty ? null : original, document(`CHANGED_LINKED_${skill.id.toUpperCase()}_CONTENT`)));
    }
    // Match a realistic installed inventory using only fictional skill files:
    // 139 ordinary skills plus four valid linked skills, with two repair cases.
    for (let index = 0; index < 139; index++) put(path.join(shared, "skills", `synthetic-installed-${String(index).padStart(3, "0")}`, "SKILL.md"),
      `---\nname: synthetic-installed-${index}\ndescription: Synthetic installed workload skill ${index}.\n---\nUse only the fictional workload inputs.\n`);
    put(privateNeighbor, "PRIVATE_NEIGHBOR_ORIGINAL\n");
    extraConfig = `[skills]\nconfig=[{path=${JSON.stringify(linked[2].link)},enabled=false}]\n`;
    steps.push(patch("native-linked-private-neighbor-edit", privateNeighbor, "PRIVATE_NEIGHBOR_ORIGINAL", "PRIVATE_NEIGHBOR_CHANGED"));
    afterNative = async runNative => {
      step = steps.length;
      for (const skill of linked) steps.push(patch(`native-readonly-linked-${skill.id}-edit`, skill.file,
        `CHANGED_LINKED_${skill.id.toUpperCase()}_CONTENT`, `READONLY_CHANGED_${skill.id.toUpperCase()}_CONTENT`));
      await runNative(["-a", "never", "--sandbox", "read-only", "exec", "--json", "--skip-git-repo-check", "Try only the synthetic linked skill patches."]);
    };
    verify = () => {
      const checks = linked.map(skill => {
        const content = fs.readFileSync(path.join(skill.target, "SKILL.md"), "utf8"), output = String(outputs.get(`native-linked-${skill.id}-edit`));
        const discovered = JSON.stringify(requests[0].input).includes(skill.description), changed = content.includes(`CHANGED_LINKED_${skill.id.toUpperCase()}_CONTENT`);
        assert.equal(changed, true, "actual native patch must edit each linked target");
        assert.equal(discovered, !(skill.disabled || skill.invalid || skill.empty), "native context must follow the configured enabled state");
        assert.match(output, /Success/);
        assert.match(String(outputs.get(`native-readonly-linked-${skill.id}-edit`)), /reject|denied|not permitted|read.only|outside.*project/i);
        assert.ok(!content.includes("READONLY_CHANGED"));
        if (protectedLaunch) assert.ok(invocations[0].nativeWrites.includes(skill.aliasTarget ?? skill.target), "disabled and enabled target grants remain exact");
        return { root: skill.id, target: skill.target, ...(skill.aliasTarget ? { aliasTarget: skill.aliasTarget } : {}), discoveredInInitialNativeContext: discovered, nativePatch: "succeeded", nativeReadonlyPatch: "denied", output };
      });
      assert.equal(fs.readFileSync(privateNeighbor, "utf8"), protectedLaunch ? "PRIVATE_NEIGHBOR_ORIGINAL\n" : "PRIVATE_NEIGHBOR_CHANGED\n");
      assert.match(String(outputs.get("native-linked-private-neighbor-edit")), protectedLaunch ? /denied|not permitted/i : /Success/);
      return { linkedSkillChecks: checks, syntheticValidInstalledSkills: 143, additionalRepairDirectories: 2,
        disabledTargetStillEditable: true, privateNeighbor: protectedLaunch ? "denied" : "stock allowed" };
    };
  }

  if (selectedCase === 12 && skillAliases) {
    const agents = path.join(homeDir, ".agents"), sharedSkills = path.join(shared, "skills"), privateFile = path.join(homeDir, "Private/neighbor.txt");
    const phases = ["dangling-parent", "dangling-skills", "broad-agents-home", "broad-shared-home", "broad-project-home"];
    put(path.join(homeDir, "SKILL.md"), "---\nname: synthetic-broad-root\ndescription: SYNTHETIC_BROAD_ROOT_SKILL\n---\nSynthetic broad alias.\n");
    const configure = phase => {
      fs.rmSync(agents, { recursive: true, force: true }); fs.rmSync(sharedSkills, { recursive: true, force: true });
      fs.rmSync(path.join(cwd, ".agents"), { recursive: true, force: true });
      if (phase === "broad-project-home") { fs.mkdirSync(path.join(cwd, ".agents")); fs.symlinkSync(homeDir, path.join(cwd, ".agents/skills")); }
      if (phase === "dangling-parent") fs.symlinkSync(path.join(homeDir, "not-installed"), agents);
      else {
        fs.mkdirSync(agents);
        fs.symlinkSync(phase === "broad-agents-home" ? homeDir : path.join(homeDir, "not-installed"), path.join(agents, "skills"));
      }
      if (phase === "broad-shared-home") fs.symlinkSync(homeDir, sharedSkills);
      put(privateFile, "PRIVATE_ALIAS_NEIGHBOR_ORIGINAL\n");
      steps.push(patch(`native-alias-${phase}-private-edit`, privateFile, "PRIVATE_ALIAS_NEIGHBOR_ORIGINAL", "PRIVATE_ALIAS_NEIGHBOR_CHANGED"));
    };
    configure(phases[0]);
    afterNative = async runNative => {
      for (const phase of phases.slice(1)) { step = steps.length; configure(phase); await runNative(args); }
    };
    verify = () => {
      for (const phase of phases) assert.match(String(outputs.get(`native-alias-${phase}-private-edit`)), protectedLaunch ? /denied|not permitted/i : /Success/);
      if (protectedLaunch) for (const run of invocations) {
        for (const parent of [homeDir, shared, agents]) assert.ok(!run.nativeReads.includes(parent) && !run.nativeWrites.includes(parent), "optional discovery never admits a protected parent");
      }
      assert.equal(fs.readFileSync(privateFile, "utf8"), protectedLaunch ? "PRIVATE_ALIAS_NEIGHBOR_ORIGINAL\n" : "PRIVATE_ALIAS_NEIGHBOR_CHANGED\n");
      return { optionalAliasLaunches: phases, nativePrivateNeighborWrite: protectedLaunch ? "denied in every phase" : "stock allowed" };
    };
  }

  const fixtureModel = selectedCase === 12 ? "gpt-6.1-sol" : "gpt-5.4";
  put(path.join(shared, "config.toml"), `model=${JSON.stringify(fixtureModel)}\nmodel_provider="fixture"\n[features]\napps=false\ncode_mode=false\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(endpoint)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n${extraConfig}`);
  const stdout = [], stderr = [], invocations = [];
  async function runNative(nativeArgs) {
    invocation = undefined;
    if (protectedLaunch) {
      const prepared = { ...prepareCodexAccountState({ homeDir, env, environment: readCodexEnvironment(), accountId: "api-provider:deepseek", label: "fixture" }), keyBacked: true };
      invocation = await prepareCodexNativeInvocation({ prepared, homeDir, cwd, env, args: nativeArgs });
    }
    invocations.push({ args: nativeArgs, effectiveMode: nativeArgs.includes("read-only") ? "read-only" : "danger-full-access", cwd, protectedLaunch,
      ...(selectedCase === 12 && invocation ? { artifactSet: invocation.artifact.artifactSet,
        nativeWrites: invocation.inputs.writes, nativeReads: invocation.inputs.reads } : {}) });
    child = spawn(invocation?.command ?? "/opt/aimgr-state-audit/bin/codex", invocation?.args ?? nativeArgs,
      { cwd, env: invocation?.env ?? env, stdio: ["ignore", "pipe", "pipe", ...(invocation ? [invocation.environmentFd] : [])], detached: true });
    invocation?.closeEnvironment(); child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
    timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 90_000);
    const [code, signal] = await once(child, "close"); clearTimeout(timer);
    if (serverError) throw serverError;
    assert.equal(code, 0, `${name} code=${code} signal=${signal}; evidence ${root}`);
    await invocation?.close();
  }
  try {
    await runNative(args);
    if (afterExit) {
      await afterExit();
      if (!lateTemp) {
        const thread = Buffer.concat(stdout).toString().split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.type === "thread.started")?.thread_id;
        assert.ok(thread, "resume uses actual event-reported thread ID");
        await runNative(["exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", thread, "Inspect completed work and recover only the owned failed worker."]);
      }
    }
    await afterNative?.(runNative);
    const row = { case: selectedCase, launch: name, actualNativeToolSequence: true, model: `synthetic endpoint, ${fixtureModel} native tool schema`, realAgentOrchestration: "not run", ...verify() };
    results.push(row); console.log(JSON.stringify(row));
  } finally {
    clearTimeout(timer);
    put(path.join(root, `${name}-stdout.log`), Buffer.concat(stdout)); put(path.join(root, `${name}-stderr.log`), Buffer.concat(stderr));
    put(path.join(root, `${name}-requests.json`), JSON.stringify(requests, null, 2)); put(path.join(root, `${name}-tool-results.json`), JSON.stringify([...outputs], null, 2));
    put(path.join(root, `${name}-invocations.json`), JSON.stringify(invocations, null, 2));
    if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    for (const { pid, script } of survivors) {
      execFileSync("/usr/bin/python3", ["-c", "import os,signal,subprocess,sys; pid=int(sys.argv[1]); command=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout; owned=sys.argv[2] in command; exec('if owned and os.getpgid(pid)==pid: os.killpg(pid,signal.SIGTERM)')", String(pid), script]);
    }
    await invocation?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const directory of ownedTemporary) fs.rmSync(directory, { recursive: true, force: true });
  }
}
put(path.join(root, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ fixture: root, finiteToolSequencePassed: true, case: selectedCase, results }));

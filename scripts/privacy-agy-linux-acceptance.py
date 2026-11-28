#!/usr/bin/env python3
"""Exercise the Antigravity Linux runtime on the designated offsite VM only.

Run as root in `unshare --mount --propagation private --net` with the AIM
checkout's dependencies already installed. All credentials are synthetic.
Optionally test signed-out startup of the exact, locally supplied Linux x64
Antigravity 1.5.11 binary. The runner never downloads or signs in.
"""
import argparse
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pty
import pwd
import re
import secrets
import select
import shutil
import signal
import socket
import stat
import struct
import subprocess
import tempfile
import termios
import time
import uuid


BASE = Path("/opt/aimgr-state-audit")
RUNTIME = Path("/opt/aimgr-agy-runtime")
HOST_SELECTOR = BASE / "AGY_TEST_HOST.json"
PASSWD = Path("/etc/passwd")
PROFILES = Path("/sys/kernel/security/apparmor/profiles")
OFFICIAL_SHA256 = "01b063665007b7098116ac98015954d97ff49b7e3147086d75849c16e952ee0e"
SYSTEM_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"}
AMBIENT_CANARIES = {
    "GEMINI_API_KEY": "synthetic-api-key",
    "GOOGLE_APPLICATION_CREDENTIALS": "/fixture-host-credentials",
    "AGY_ADC_AUTH": "true",
    "SSH_AUTH_SOCK": "/fixture-host-ssh-agent",
    "XDG_CONFIG_HOME": "/fixture-host-config",
    "XDG_RUNTIME_DIR": "/fixture-host-runtime",
    "HTTPS_PROXY": "http://127.0.0.1:1",
    "DBUS_SESSION_BUS_ADDRESS": "unix:path=/fixture-host-keyring",
    "DBUS_SYSTEM_BUS_ADDRESS": "unix:path=/fixture-host-keyring",
    "AIMGR_AGY_FIXTURE_AMBIENT": "must-not-reach-agy",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def system(command, **options):
    return subprocess.run(command, check=True, env=SYSTEM_ENV, timeout=30, **options)


def secure_root_path(path, *, directory):
    info = path.lstat()
    file_type = stat.S_ISDIR if directory else stat.S_ISREG
    require(file_type(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
            f"Expected root-owned protected {'directory' if directory else 'file'} at {path}.")


def check_host():
    require(platform.system() == "Linux" and platform.machine() == "x86_64" and os.getuid() == 0,
            "Run as root on the designated Linux x64 test host.")
    for directory in (Path("/"), BASE.parent, BASE):
        secure_root_path(directory, directory=True)
    secure_root_path(BASE / "OFFSITE_AUDIT_HOST", directory=False)
    for namespace in ("mnt", "net"):
        require(os.readlink(f"/proc/self/ns/{namespace}") != os.readlink(f"/proc/1/ns/{namespace}"),
                "Run in private mount and network namespaces via unshare.")
    require(system(["/usr/bin/findmnt", "-no", "PROPAGATION", "--target", PASSWD],
                   text=True, capture_output=True).stdout.strip() == "private",
            "The passwd mount must have private propagation.")
    require({name for _, name in socket.if_nameindex()} == {"lo"}, "Use a loopback-only network namespace.")
    require(Path("/sys/module/apparmor/parameters/mode").read_text().strip() == "enforce",
            "AppArmor must be enforcing.")
    require(not os.path.lexists(RUNTIME) and not os.path.lexists(HOST_SELECTOR),
            "A test selector or Antigravity runtime already exists. Use a clean test host.")


def write_file(path, content, mode, owner=None):
    with path.open("x") as stream:
        if owner:
            os.fchown(stream.fileno(), *owner)
        os.fchmod(stream.fileno(), mode)
        stream.write(content)


def write_record(path, value, mode=0o644, owner=None):
    write_file(path, json.dumps(value, sort_keys=True) + "\n", mode, owner)


def owned_directory(path, owner):
    path.mkdir(mode=0o700)
    os.chown(path, *owner)
    return path


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def build(source, output):
    system(["/usr/bin/gcc", "-std=gnu11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output])


def check_installer(repo, root, node, user):
    spec = importlib.util.spec_from_file_location("agy_fixture_install", repo / "scripts/install-agy-runtime.py")
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    runtime, bundle = root / "installer-runtime", root / "installer-bundle"
    bundle.mkdir(mode=0o700)
    version = "0.0.0-installer-fixture"
    for name in ("agy", "launcher"):
        write_file(bundle / name, f"synthetic bytes incapable of execution: {name}\n", 0o600)
    write_record(bundle / "policy.json", {"schema": 1, "version": version, "platform": "linux", "arch": "x64",
                                          "sourceCommit": "a" * 40})
    roles = {"agy": "vendor", "launcher": "launcher", "policy.json": "policy"}
    files = {name: {"sha256": digest(bundle / name), "size": (bundle / name).stat().st_size,
                    "role": role, "executable": role != "policy"} for name, role in roles.items()}
    approval = {"kind": "normal-use", "approver": "SYNTHETIC TEST ONLY", "reference": "Inert fixture",
                "reviewEvidence": "Never-executed synthetic fixture", "approvedAt": "2026-11-01T00:00:00Z"}
    write_record(bundle / "approval.json", {"schema": 1, "platform": "linux", "arch": "x64", "version": version,
                 "privacyAbi": "agy-privacy-v2", "entrypoint": "agy", "launcher": "launcher", "policy": "policy.json",
                 "reviewedAimRevision": "a" * 40, "files": files, "approval": approval})
    staged = installer.install(bundle, str(node), user, runtime=runtime)
    selector = runtime / "active.json"
    require(not staged["activated"] and not selector.exists(), "Staging activated the synthetic bundle.")
    active = installer.install(bundle, str(node), user, activate=True, runtime=runtime)
    require(active["activated"] and active["artifactSet"] == staged["artifactSet"] and
            json.loads(selector.read_text())["artifactSet"] == active["artifactSet"], "Explicit installer activation failed.")
    original = selector.read_bytes()
    (bundle / "agy").write_bytes(b"x" + (bundle / "agy").read_bytes()[1:])
    try:
        installer.install(bundle, str(node), user, activate=True, runtime=runtime)
    except RuntimeError as error:
        require("approved bytes changed" in str(error), "Installer rejected changed bytes for an unexpected reason.")
    else:
        raise RuntimeError("Installer accepted changed bytes.")
    require(selector.read_bytes() == original, "Installer changed the selector on rejection.")


def install_artifact(stage, launcher, vendor, version, source_sha):
    policy = stage / f"policy-{version}.json"
    write_record(policy, {"schema": 1, "scope": "offsite offline acceptance", "version": version,
                          "testedKernelRelease": os.uname().release})
    entries = {"agy": (vendor, "vendor", True), "launcher": (launcher, "launcher", True),
               "policy.json": (policy, "policy", False)}
    files = {name: {"sha256": digest(path), "size": path.stat().st_size, "role": role, "executable": executable}
             for name, (path, role, executable) in entries.items()}
    inventory = [[name, item["sha256"], item["size"], item["executable"], item["role"]]
                 for name, item in sorted(files.items())]
    artifact = hashlib.sha256(json.dumps(inventory, separators=(",", ":")).encode()).hexdigest()
    target = RUNTIME / "artifacts" / artifact
    target.mkdir(mode=0o755)
    for name, (path, _, executable) in entries.items():
        installed = target / name
        shutil.copyfile(path, installed)
        installed.chmod(0o4755 if name == "launcher" else 0o755 if executable else 0o644)
        require(digest(installed) == files[name]["sha256"], "Installed artifact bytes changed during copying.")
    write_record(target / "approval.json", {
        "schema": 1, "platform": "linux", "arch": "x64", "version": version, "privacyAbi": "agy-privacy-v2",
        "entrypoint": "agy", "launcher": "launcher", "policy": "policy.json", "files": files,
        "candidateSourceSha256": source_sha,
        "approval": {"kind": "offsite-test", "normalUseApproved": False, "reference": "Offline acceptance"},
    })
    return target


def approve_fixture(stack, artifact):
    token = secrets.token_hex(32)
    # Opening exclusively before registering cleanup preserves another owner's
    # file if something else created this path since the initial host check.
    with HOST_SELECTOR.open("x") as stream:
        stack.callback(HOST_SELECTOR.unlink)
        os.fchmod(stream.fileno(), 0o644)
        json.dump({"schema": 1, "token": token}, stream)
    now = datetime.now(timezone.utc)
    write_record(RUNTIME / "offsite-test.json", {
        "schema": 1, "artifactSet": artifact.name, "platform": "linux", "arch": "x64",
        "normalUseApproved": False, "hostTokenSha256": hashlib.sha256(token.encode()).hexdigest(),
        "authorizedAt": now.isoformat(), "expiresAt": (now + timedelta(hours=1)).isoformat(),
        "reference": "Temporary host authorization for offline Antigravity acceptance",
    })
    write_record(RUNTIME / "active.json", {"schema": 1, "artifactSet": artifact.name})


def fixture_profiles(uid):
    expression = re.compile(rf"aim-agy-p-{uid}-(?:n[0-9]+-)?[a-f0-9]{{32}}(?:-tools)?")
    return {name for line in PROFILES.read_text().splitlines()
            if expression.fullmatch(name := line.split(" ", 1)[0])}


def remove_fixture_profiles(uid, previous):
    profiles = fixture_profiles(uid) - previous
    if not profiles:
        return
    # Do not remove policy from a still-running descendant. Both fixture and
    # signed-out startup are expected to finish within their process group.
    for status in Path("/proc").glob("[0-9]*/attr/current"):
        try:
            active = status.read_text().split(" ", 1)[0].split("//&")
        except OSError:
            continue
        require(not (profiles & set(active)), "A process still holds this run's Antigravity test policy.")
    policy = "".join(f"profile {name} {{}}\n" for name in sorted(profiles))
    system(["/usr/sbin/apparmor_parser", "-R", "-T"], text=True, input=policy)
    require(not (profiles & fixture_profiles(uid)), "An Antigravity test policy was left installed.")


def bind_fixture_home(stack, root, user, home):
    passwd = root / "passwd"
    records = [line.split(":") for line in PASSWD.read_text().splitlines()]
    matches = [entry for entry in records if entry[0] == user.pw_name]
    require(len(matches) == 1 and int(matches[0][2]) == user.pw_uid, "Use a local ordinary fixture user.")
    matches[0][5] = str(home)
    write_file(passwd, "\n".join(":".join(entry) for entry in records) + "\n", 0o644)
    system(["/usr/bin/mount", "--bind", passwd, PASSWD])
    stack.callback(system, ["/usr/bin/umount", PASSWD])
    require(pwd.getpwuid(user.pw_uid).pw_dir == str(home), "Fixture passwd entry did not take effect.")


def run_user(command, owner, cwd, env, *, pass_fds=()):
    with subprocess.Popen(command, user=owner[0], group=owner[1], extra_groups=[], cwd=cwd, env=env,
                          pass_fds=pass_fds, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True, text=True, errors="replace") as child:
        try:
            stdout, stderr = child.communicate(timeout=45)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise
    return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)


def check_result(result, condition, label):
    require(condition, f"{label} failed (exit {result.returncode}).\n{result.stdout[-2000:]}{result.stderr[-2000:]}")


@contextmanager
def direct_environment(owner, home, *, partial_proxy):
    # Match node:fs mkdtemp's six-character suffix and the native handoff's
    # unlinked caller-owned file rather than providing AGY state via argv.
    scratch = owned_directory(Path("/tmp") / ("aim-agy-" + secrets.token_hex(3)), owner)
    try:
        environment = {"HOME": str(home.parents[3]), "PATH": "/fixture-host-path", "BROWSER": "/fixture-host-browser",
                       "AGY_CLI_DISABLE_AUTO_UPDATE": "false", "TERM": "xterm", **AMBIENT_CANARIES}
        if not partial_proxy:
            del environment["HTTPS_PROXY"]
        with tempfile.TemporaryFile(dir=scratch) as stream:
            os.fchown(stream.fileno(), *owner)
            stream.write(b"".join(f"{name}={value}\0".encode() for name, value in environment.items()))
            stream.flush()
            yield scratch, stream.fileno()
    finally:
        scratch.rmdir()


def launch_direct(artifact, owner, account, project, roots, args, *, partial_proxy=False):
    # The extra inherited descriptor points at synthetic data outside the
    # workspace. The launcher must close it independently of the env handoff.
    with (direct_environment(owner, account, partial_proxy=partial_proxy) as (scratch, envfd),
          (project / "hidden-link").open("rb") as canary):
        return run_user([artifact / "launcher", "v1", "run", account, project, scratch, str(envfd),
                         str(len(roots)), *roots, "--", *args], owner, project,
                        SYSTEM_ENV | AMBIENT_CANARIES, pass_fds=(envfd, canary.fileno()))


def make_account(state, label, owner, *, signed_in):
    connection = owned_directory(state / label, owner)
    write_record(connection / "connection.json", {"version": 1, "label": label}, 0o600, owner)
    account = owned_directory(connection / "home", owner)
    if signed_in:
        gemini = owned_directory(account / ".gemini", owner)
        native = owned_directory(gemini / "antigravity-cli", owner)
        write_file(native / "antigravity-oauth-token", f"synthetic-grant-{label}\n", 0o600, owner)
        write_file(native / "installation_id", f"synthetic-id-{label}\n", 0o600, owner)
    return account


def wait_for_pty(master, expected, failure):
    deadline = time.monotonic() + 15
    output = bytearray()
    while time.monotonic() < deadline:
        if not select.select([master], [], [], max(0, deadline - time.monotonic()))[0]:
            break
        try:
            chunk = os.read(master, 16384)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        screen = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output).lower()
        if all(text in screen for text in expected):
            return
        if len(output) > 256 * 1024:
            break
    # The screen can contain an authorization challenge. Report only the
    # check that failed and keep the terminal bytes out of test diagnostics.
    raise RuntimeError(failure)


def check_manual_prompt(artifact, owner, account, project):
    with direct_environment(owner, account, partial_proxy=False) as (scratch, envfd):
        pid, master = pty.fork()
        if pid == 0:
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 180, 0, 0))
                os.set_inheritable(envfd, True)
                os.setgroups([])
                os.setgid(owner[1])
                os.setuid(owner[0])
                os.chdir(project)
                launcher = str(artifact / "launcher")
                os.execve(launcher, [launcher, "v1", "login", str(account), str(project), str(scratch),
                                     str(envfd), "1", "/tmp", "--"], SYSTEM_ENV)
            finally:
                os._exit(125)
        try:
            wait_for_pty(master, [b"google oauth"], "Pinned Antigravity did not show the Google OAuth picker.")
            os.write(master, b"\r")
            wait_for_pty(master, [b"authorization code", b"https://accounts.google.com/"],
                         "Pinned Antigravity did not show the Google URL and manual code prompt.")
        finally:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(master)
            os.waitpid(pid, 0)


def check_official(artifact, owner, state, project):
    ids = []
    for label in (".login-ProbeA", ".login-ProbeB", ".login-ProbeA"):
        candidate = state / label
        account = candidate / "home"
        if not account.exists():
            owned_directory(owned_directory(candidate, owner) / "home", owner)
        check_manual_prompt(artifact, owner, account, project)
        native = account / ".gemini/antigravity-cli"
        require(not (native / "antigravity-oauth-token").exists(), "Signed-out startup wrote an OAuth grant.")
        ids.append(uuid.UUID((native / "installation_id").read_text().strip()))
    require(all(value.version == 4 for value in ids) and ids[0] == ids[2] and ids[0] != ids[1],
            "Pinned Antigravity did not retain separate installation IDs across account homes.")
    return {"sha256": OFFICIAL_SHA256, "manualGooglePromptChecks": len(ids), "separatePersistentInstallationIds": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", required=True, help="local, unprivileged fixture user")
    parser.add_argument("--node", type=Path, required=True, help="absolute path to Node.js 20 or newer")
    parser.add_argument("--official", type=Path, help="optional existing Linux x64 Antigravity 1.5.11 binary")
    args = parser.parse_args()
    check_host()
    user = pwd.getpwnam(args.user)
    owner = (user.pw_uid, user.pw_gid)
    require(all(owner), "The fixture user and primary group must be unprivileged.")
    require(args.node.is_absolute() and args.node.is_file(), "Provide an absolute Node.js path.")
    if args.official:
        require(digest(args.official) == OFFICIAL_SHA256, "The official Antigravity executable does not match the pin.")
    repo = Path(__file__).resolve().parents[1]
    source = repo / "native/agy/approved_launch_linux.c"
    fixture_source = repo / "test/fixtures/agy/privacy-linux.c"
    require((repo / "node_modules/proper-lockfile").is_dir(), "Install AIM's Node.js dependencies before running offline.")
    inventory = [source, source.with_name("credential-boundary.h"), fixture_source, repo / "native/privacy/launch_linux.h",
                 repo / "native/privacy/profile_gc_linux.h", repo / "src/privacy/agy-native-invocation.js"]
    source_sha = hashlib.sha256("".join(digest(path) for path in inventory).encode()).hexdigest()

    with tempfile.TemporaryDirectory(prefix="agy-acceptance-", dir=BASE) as directory, ExitStack() as stack:
        root = Path(directory)
        root.chmod(0o755)
        home = owned_directory(root / "home", owner)
        bind_fixture_home(stack, root, user, home)
        project = owned_directory(root / "project", owner)
        extra = owned_directory(root / "extra", owner)
        downloads = owned_directory(home / "Downloads", owner)
        write_file(project / "workspace-input", "synthetic-workspace\n", 0o600, owner)
        for path in (extra, downloads):
            write_file(path / "fixture-input", "synthetic-working-directory\n", 0o600, owner)
        hidden = home / "host-canary"
        write_file(hidden, "synthetic-host\n", 0o600, owner)
        (project / "hidden-link").symlink_to(hidden)
        desktop_state = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="agy-acceptance-", dir="/tmp")))
        desktop_state.chmod(0o755)
        dbus_canary = desktop_state / "dbus-canary"
        write_file(dbus_canary, "synthetic-keyring-fallback\n", 0o600, owner)
        (project / "dbus-link").symlink_to(dbus_canary)
        gemini = owned_directory(home / ".gemini", owner)
        ide = owned_directory(gemini / "antigravity-ide", owner)
        write_file(ide / "installation_id", "synthetic-ide\n", 0o600, owner)
        host_cli = owned_directory(gemini / "antigravity-cli", owner)
        write_file(host_cli / "installation_id", "synthetic-host-cli\n", 0o600, owner)
        desktop = owned_directory(owned_directory(home / ".config", owner) / "antigravity", owner)
        write_file(desktop / "desktop-canary", "synthetic-desktop\n", 0o600, owner)
        aimgr = owned_directory(home / ".aimgr", owner)
        write_record(aimgr / "config.yaml", {"agyWorkingDirectories": [str(extra)]}, 0o600, owner)
        codex_store = owned_directory(aimgr / "accounts", owner)
        write_file(codex_store / "fixture-auth", "synthetic-codex-grant\n", 0o600, owner)
        figma = owned_directory(owned_directory(aimgr / "claude-integrations", owner) / "figma", owner)
        credentials = [figma / "grant.json", owned_directory(home / ".codex", owner) / ".env", home / ".claude.json"]
        for credential in credentials:
            write_file(credential, "synthetic-protected-state\n", 0o600, owner)
        state = owned_directory(aimgr / "agy", owner)
        accounts = {label: make_account(state, label, owner, signed_in=True) for label in ("a", "b")}

        process_env = SYSTEM_ENV | {"HOME": str(home), "TERM": "xterm"} | AMBIENT_CANARIES
        control = run_user(["/usr/bin/cat", hidden, ide / "installation_id", project / "hidden-link", project / "dbus-link",
                            host_cli / "installation_id", desktop / "desktop-canary", *credentials,
                            *(account / ".gemini/antigravity-cli/antigravity-oauth-token" for account in accounts.values())],
                           owner, project, process_env)
        check_result(control, control.returncode == 0 and control.stdout.splitlines() ==
                     ["synthetic-host", "synthetic-ide", "synthetic-host", "synthetic-keyring-fallback",
                      "synthetic-host-cli", "synthetic-desktop",
                      *(["synthetic-protected-state"] * len(credentials)),
                      "synthetic-grant-a", "synthetic-grant-b"],
                     "Unconfined synthetic file control")

        stage = root / "build"
        stage.mkdir(mode=0o700)
        check_installer(repo, root, args.node, user)
        launcher, vendor = stage / "launcher", stage / "agy"
        build(source, launcher)
        build(fixture_source, vendor)
        RUNTIME.mkdir(mode=0o755)
        stack.callback(shutil.rmtree, RUNTIME)
        (RUNTIME / "artifacts").mkdir(mode=0o755)
        with (RUNTIME / "policy.lock").open("x") as lock:
            os.fchmod(lock.fileno(), 0o600)
        artifact = install_artifact(stage, launcher, vendor, "0.0.0-fixture", source_sha)
        approve_fixture(stack, artifact)
        stack.callback(remove_fixture_profiles, user.pw_uid, fixture_profiles(user.pw_uid))

        cli = [args.node, repo / "bin/aimgr.js", "agy"]
        result = run_user([*cli, "status", "--json"], owner, project, process_env)
        check_result(result, result.returncode == 0, "AIM Antigravity status")
        status = json.loads(result.stdout)
        require(status["runtime"] == "supported" and status["localState"] == "available"
                and [(row["label"], row["status"]) for row in status["connections"]] ==
                [(label, "ready") for label in accounts] and "synthetic-grant" not in result.stdout,
                "AIM status did not return two ready labels without grant content.")
        for label in accounts:
            result = run_user([*cli, "run", label, "--", "--print", label], owner, project, process_env)
            check_result(result, result.returncode == 39 and f"Antigravity fixture passed ({label})" in result.stdout,
                         f"AIM Antigravity run for label {label}")
        result = launch_direct(artifact, owner, accounts["a"], project, [extra], ["--print=direct"])
        check_result(result, result.returncode == 39 and "Antigravity fixture passed (direct)" in result.stdout,
                     "Native launcher with synthetic ambient credentials and an explicit working directory")
        result = launch_direct(artifact, owner, accounts["a"], project, [extra], ["--print=direct"], partial_proxy=True)
        check_result(result, result.returncode == 125 and "assigned proxy environment" in result.stderr,
                     "Incomplete staged proxy environment")
        for denied, error in ((home, "overbroad working path"), (figma, "overbroad working path"),
                              (Path("/etc"), "system working path")):
            result = launch_direct(artifact, owner, accounts["a"], project, [denied], ["--print=direct"])
            check_result(result, result.returncode == 125 and error in result.stderr, "Overbroad native working directory")
        for output in (downloads / "a-output", downloads / "b-output", extra / "direct-output", project / "tool-output"):
            require(output.read_text() == "fixture\n", f"The sandboxed child did not write {output.name}.")

        os.chmod(artifact / "agy", 0o775)
        result = run_user([*cli, "run", "a", "--", "--print=a"], owner, project, process_env)
        check_result(result, result.returncode == 1 and "Antigravity was not started" in result.stderr
                     and "Antigravity fixture passed" not in result.stdout, "AIM admission of a writable vendor")
        os.chmod(artifact / "agy", 0o755)

        session_id = "f77b6850-814d-429a-978e-3e73bc464c27"
        result = run_user([*cli, "resume", "a", session_id, "--", "--print=resume"], owner, project, process_env)
        check_result(result, result.returncode == 0 and result.stdout == "RESUME_OK\n", "AIM exact native session resume")
        result = run_user([*cli, "resume", "b", session_id, "--", "--print=resume"], owner, project, process_env)
        check_result(result, result.returncode == 1 and not result.stdout and "could not find the session" in result.stderr,
                     "AIM denies cross-account resume")
        result = run_user([*cli, "logout", "a"], owner, project, process_env)
        check_result(result, result.returncode == 0 and "connection a signed out" in result.stdout, "AIM selected native logout")
        result = run_user([*cli, "status", "--json"], owner, project, process_env)
        check_result(result, result.returncode == 0, "AIM Antigravity status after logout")
        require([(row["label"], row["status"]) for row in json.loads(result.stdout)["connections"]] ==
                [("a", "needs-sign-in"), ("b", "ready")],
                "Native logout affected an unselected label.")

        report = {"fixtureArtifact": artifact.name, "network": "loopback-only",
                  "readyLabels": list(accounts), "fixtureExitCode": 39, "writableVendorRejected": True,
                  "overbroadWorkingDirectoriesRejected": True, "partialStagedProxyRejected": True,
                  "exactNativeResume": True, "crossAccountResumeRejected": True, "selectedNativeLogout": True,
                  "syntheticInstallerStagingActivationAndByteRejection": True}
        if args.official:
            official = install_artifact(stage, launcher, args.official, "1.5.11", source_sha)
            require(digest(official / "agy") == OFFICIAL_SHA256, "Installed official Antigravity does not match the pin.")
            report["official"] = check_official(official, owner, state, project)
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()

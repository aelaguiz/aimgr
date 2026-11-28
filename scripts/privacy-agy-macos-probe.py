#!/usr/bin/env python3
"""Offline macOS state probe for Google's signed agy 1.5.11 executable.

Pass the extracted executable from Google's pinned distribution. The default
probe blocks macOS services and uses a signed-out, noninteractive command.

The optional Keychain check runs from Terminal in a disposable, non-admin
macOS console account named agyprivacyprobe. Provision an unlocked, disposable
agy-privacy-probe.keychain-db as that account's only user search-list entry and
its default Keychain. In that fixture, add a generic password with the service
and account matched by this agy build, the literal value '{[', and access for
/usr/bin/security and the verified agy binary. The script never changes the
Keychain or its search list. JSON contains comparisons and outcomes only.
"""

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import signal
import socket
import stat
import subprocess
import tempfile
import threading
import uuid

from agy_macos_signature import verify_google_cli_command

VERSION = "1.5.11"
CLI_STATE = Path(".gemini/antigravity-cli")
IDE_ID = Path(".gemini/antigravity-ide/installation_id")
GRANT_FILE = "antigravity-oauth-token"
PERL = str(Path("/usr/bin/perl").resolve())
CODESIGN = "/usr/bin/codesign"
SECURITY = "/usr/bin/security"
HEADLESS_ARGS = ["--model=gemini-3.8-flash", "--print=OFFLINE_PROBE", "--output-format=json"]

# All network destinations are numeric loopback addresses in this probe.
# A closed port, a timeout, or a missing interpreter cannot pass the canary.
CANARY = r"""
use strict;
use warnings;
use Errno qw(EACCES EPERM);
use Fcntl qw(O_CREAT O_EXCL O_WRONLY);
use Socket qw(AF_INET AF_INET6 SOCK_STREAM SOCK_DGRAM inet_pton pack_sockaddr_in pack_sockaddr_in6);
sub outcome { return $_[0] ? 'allowed' : ($! == EPERM || $! == EACCES ? 'denied' : 'other-error'); }
my ($outside, $v4, $v6) = @ARGV;
my $written = open(my $local, '>', 'allowed');
print 'scratch_write=', outcome($written), "\n";
close $local if $written;
print 'scratch_read=', outcome(open($local, '<', 'allowed')), "\n";
print 'outside_read=', outcome(open(my $outside_read, '<', $outside)), "\n";
print 'outside_write=', outcome(sysopen(my $outside_write, "$outside.new", O_WRONLY | O_CREAT | O_EXCL, 0600)), "\n";
for my $case (['ipv4', AF_INET, pack_sockaddr_in($v4, inet_pton(AF_INET, '127.0.0.1'))],
              ['ipv6', AF_INET6, pack_sockaddr_in6($v6, inet_pton(AF_INET6, '::1'))]) {
    my ($name, $family, $addr) = @$case;
    for my $protocol (['tcp', SOCK_STREAM], ['udp', SOCK_DGRAM]) {
        my ($label, $kind) = @$protocol;
        my $sock;
        my $status;
        if (!socket($sock, $family, $kind, 0)) {
            $status = outcome(0);
        } elsif ($kind == SOCK_STREAM) {
            $status = outcome(connect($sock, $addr));
        } else {
            $status = outcome(defined(send($sock, 'probe', 0, $addr)));
        }
        print "${name}_${label}=$status\n";
    }
}
"""


class ProbeError(Exception):
    pass


def policy(root, binary, extra_read=(), mach_services=()):
    def paths(kind, allowed):
        return " ".join(f"({kind} {json.dumps(str(path))})" for path in allowed)

    programs = [binary, PERL, CODESIGN, SECURITY]
    # dyld needs file-read-data for the literal root directory before main.
    readable = programs + ["/", "/dev/null", "/dev/random", "/dev/urandom", *extra_read]
    # /System/Volumes/Data is another path to the host's data volume.
    system = ["/System/Library", "/usr/lib", "/usr/share", "/Library/Apple",
              "/private/var/db/dyld", "/private/preboot/Cryptexes/OS"]
    ancestors = sorted({p for path in [root, *map(Path, readable + system)] for p in path.parents})
    services = " ".join(f"(global-name {json.dumps(name)})" for name in mach_services)
    return f"""(version 1)
(allow default)
(deny network*)
(deny mach-lookup)
{f'(allow mach-lookup {services})' if services else ''}
(deny job-creation)
(deny file-read* (require-not (require-any
  {paths('literal', readable)} {paths('subpath', [root, *system])})))
(allow file-read-metadata {paths('literal', ancestors)})
(deny file-write* (require-not (require-any (literal "/dev/null") {paths('subpath', [root])})))
(deny process-exec (require-not (require-any {paths('literal', programs)})))
"""


def run(argv, *, home, profile=None):
    home.mkdir(exist_ok=True, mode=0o700)
    work = home / "work"
    tmp = home / "tmp"
    work.mkdir(exist_ok=True, mode=0o700)
    tmp.mkdir(exist_ok=True, mode=0o700)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "TMPDIR": str(tmp), "LC_ALL": "C"}
    for name in ("CACHE", "CONFIG", "DATA", "STATE"):
        env[f"XDG_{name}_HOME"] = str(home / f"xdg-{name.lower()}")
    argv = [str(arg) for arg in argv]
    if profile is not None:
        argv = ["/usr/bin/sandbox-exec", "-p", profile, *argv]
    with subprocess.Popen(argv, cwd=work, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace", start_new_session=True) as child:
        try:
            output, _ = child.communicate(timeout=20)
            return child.returncode, output
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()
            return None, ""


def check_canary(root, outside, profile):
    with socket.socket(socket.AF_INET) as ipv4, socket.socket(socket.AF_INET6) as ipv6:
        ipv4.bind(("127.0.0.1", 0))
        ipv6.bind(("::1", 0))
        ipv4.listen()
        ipv6.listen()
        code, output = run([PERL, "-e", CANARY, outside, ipv4.getsockname()[1],
                            ipv6.getsockname()[1]], home=root / "control", profile=profile)
    outcomes = dict(re.findall(r"^(\w+)=(allowed|denied|other-error)$", output, re.M))
    expected = {"scratch_write": "allowed", "scratch_read": "allowed", "outside_read": "denied",
                "outside_write": "denied", "ipv4_tcp": "denied", "ipv4_udp": "denied",
                "ipv6_tcp": "denied", "ipv6_udp": "denied"}
    if code != 0 or outcomes != expected:
        summary = ", ".join(f"{name}={outcomes.get(name, 'unavailable')}" for name in expected)
        if code != 0:
            diagnostic = output.replace(str(root.parent), "<temporary directory>").strip()
            summary += f". Canary exit {code}. {diagnostic[:360]}"
        raise ProbeError(f"Sandbox controls failed. {summary}")
    return outcomes


def check_binary(binary, root, profile):
    # Apple's verifier needs local trust services. Its profile permits only the
    # verifier to execute, while the vendor binary will use the strict profile.
    verification_profile = f"""(version 1)
(allow default)
(deny network*)
(deny job-creation)
(deny process-exec (require-not (literal "{CODESIGN}")))
"""
    code, output = run(verify_google_cli_command(binary),
                       home=root / "control", profile=verification_profile)
    if code != 0:
        diagnostic = output.replace(str(binary), "<supplied executable>").strip()
        raise ProbeError(f"Google Developer ID verification failed (exit {code}). {diagnostic[:250]}")
    code, output = run([binary, "--version"], home=root / "version", profile=profile)
    if code != 0 or output.strip() != VERSION:
        versions = ", ".join(re.findall(r"\b\d+\.\d+\.\d+\b", output)) or "none"
        raise ProbeError(f"The signed executable did not report exactly {VERSION} (exit {code}, versions {versions})")
    digest = hashlib.sha256()
    with binary.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return {"version": VERSION, "apple_developer_id_team": "EQHXZ8M8AV", "sha256": digest.hexdigest()}


def installation_id(home):
    path = home / CLI_STATE / "installation_id"
    try:
        if path.resolve() != path or not stat.S_ISREG(path.lstat().st_mode):
            return None
        value = uuid.UUID(path.read_text().strip())
    except (OSError, UnicodeError, ValueError):
        return None
    return value if value.version == 4 else None


def agy_case(binary, home, profile):
    code, output = run([binary, *HEADLESS_ARGS], home=home, profile=profile)
    value = installation_id(home)
    return value, {
        "exit_code": code,
        "timed_out": code is None,
        "authentication_message": bool(re.search(r"authenticat|sign[ -]?in|log[ -]?in", output, re.I)),
        "sandbox_exec_error": "sandbox-exec:" in output,
        "cli_installation_uuid_v4": value is not None,
        "native_oauth_file_present": os.path.lexists(home / CLI_STATE / GRANT_FILE),
    }, output


def with_ide_marker(binary, home, profile):
    # A successful FIFO write requires a reader. Regular file existence or an
    # unchanged CLI UUID by themselves would not establish an IDE ID read.
    fifo = home / IDE_ID
    fifo.parent.mkdir(exist_ok=True, mode=0o700)
    os.mkfifo(fifo, mode=0o600)
    marker = f"{uuid.uuid4()}\n".encode()
    stop = threading.Event()
    observed = threading.Event()

    def publish():
        while not stop.is_set():
            try:
                fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
            except OSError as error:
                if error.errno != errno.ENXIO:
                    return
            else:
                with os.fdopen(fd, "wb", buffering=0) as stream:
                    try:
                        stream.write(marker)
                        observed.set()
                    except BrokenPipeError:
                        pass
            stop.wait(0.02)

    writer = threading.Thread(target=publish)
    writer.start()
    try:
        value, result, _ = agy_case(binary, home, profile)
    finally:
        stop.set()
        writer.join()
        fifo.unlink()
    result["synthetic_ide_id_fifo_reader_observed"] = observed.is_set()
    return value, result


def disposable_keychain():
    uid = os.getuid()
    user = pwd.getpwuid(uid)
    if (user.pw_name != "agyprivacyprobe" or uid == 0 or uid != os.geteuid() or
            80 in os.getgroups() or Path("/dev/console").stat().st_uid != uid):
        raise ProbeError("Keychain scope requires the disposable non-admin macOS console user agyprivacyprobe")
    domain = subprocess.run(["/bin/launchctl", "managername"], capture_output=True, text=True, timeout=10)
    if domain.returncode != 0 or domain.stdout.strip() != "Aqua":
        raise ProbeError("Start the Keychain check from Terminal in the disposable user's Aqua session")
    home = Path(user.pw_dir).resolve()
    fixture = home / "Library/Keychains/agy-privacy-probe.keychain-db"
    if (not fixture.is_file() or fixture.resolve() != fixture or fixture.stat().st_uid != uid or
            stat.S_IMODE(fixture.stat().st_mode) & 0o077):
        raise ProbeError("The disposable user's private agy-privacy-probe Keychain is missing")
    return fixture


def keychain_scope(binary, root, outside, fixture, attributes):
    # The only additional Mach services are for the disposable user's native
    # credential store and its preferences. Browser launch remains blocked.
    prefs = fixture.parent.parent / "Preferences"
    profile = policy(root, binary, extra_read=(fixture, prefs / "com.apple.security.plist"), mach_services=(
        "com.apple.SecurityServer", "com.apple.securityd", "com.apple.securityd.xpc", "com.apple.cfprefsd.agent",
    ))
    check_canary(root, outside, profile)
    service, account = attributes
    lookup = [SECURITY, "find-generic-password", "-s", service, "-a", account, "-w"]
    contexts = [root / "keychain-home-a", root / "keychain-home-b"]
    for home in contexts:
        expected = (f'"{fixture}"', f'"{str(fixture).removesuffix("-db")}"')
        for command in ("list-keychains", "default-keychain"):
            code, output = run([SECURITY, command, "-d", "user"], home=home, profile=profile)
            if code != 0 or output.strip() not in expected:
                raise ProbeError("The sole user search-list entry and default Keychain must both be the disposable fixture")
        code, output = run(lookup, home=home, profile=profile)
        if code != 0 or output.strip() != "{[":
            raise ProbeError("The native lookup did not find the expected synthetic Keychain marker from both HOME values")

    results = []
    marker_error = "invalid character '[' looking for beginning of object key string"
    for home in contexts:
        _, result, output = agy_case(binary, home, profile)
        result["reported_synthetic_keychain_marker_parse_error"] = marker_error in output
        results.append(result)
    return {
        "security_found_same_synthetic_item_from_both_homes": True,
        "agy_reported_synthetic_item_from_both_homes": all(
            result["reported_synthetic_keychain_marker_parse_error"] for result in results
        ),
        "home_a": results[0],
        "home_b": results[1],
    }


def probe(binary, root, outside, fixture, attributes):
    profile = policy(root, binary)
    controls = check_canary(root, outside, profile)
    artifact = check_binary(binary, root, profile)
    first, a, _ = agy_case(binary, root / "home-a", profile)
    reopened, warm = with_ide_marker(binary, root / "home-a", profile)
    second, b, _ = agy_case(binary, root / "home-b", profile)
    receipt = {
        "platform": {"macos": platform.mac_ver()[0], "architecture": platform.machine()},
        "artifact": artifact,
        "controls": controls,
        "fresh_home_a": a,
        "reopened_home_a": warm,
        "fresh_home_b": b,
        "same_home_reused_cli_uuid": first is not None and first == reopened,
        "different_homes_used_distinct_cli_uuids": first is not None and second is not None and first != second,
        "native_keychain_scope": "unverified: requires a disposable macOS console login and synthetic Keychain",
    }
    if fixture is not None:
        try:
            receipt["native_keychain_scope"] = keychain_scope(binary, root, outside, fixture, attributes)
        except ProbeError as error:
            receipt["native_keychain_scope"] = {"status": "unverified", "reason": str(error)}
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, help="path to the official Google executable")
    parser.add_argument("--native-keychain", nargs=2, metavar=("SERVICE", "ACCOUNT"),
                        help="check a synthetic Keychain item in the disposable Aqua login")
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("This probe requires macOS")
    binary = args.binary.resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("Pass an executable file")
    try:
        fixture = disposable_keychain() if args.native_keychain else None
        with tempfile.TemporaryDirectory(prefix="agy-macos-probe-") as directory:
            base = Path(directory).resolve()
            root = base / "sandbox"
            root.mkdir(mode=0o700)
            outside = base / "outside-canary"
            outside.write_text("synthetic outside canary\n")
            receipt = probe(binary, root, outside, fixture, args.native_keychain)
    except (OSError, ProbeError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"Probe stopped: {error}\n")
    print(json.dumps(receipt, indent=2))
    cases = [receipt[key] for key in ("fresh_home_a", "reopened_home_a", "fresh_home_b")]
    state_verified = (receipt["same_home_reused_cli_uuid"] and receipt["different_homes_used_distinct_cli_uuids"] and
                      all(not case["timed_out"] and not case["native_oauth_file_present"] for case in cases))
    keychain_verified = (not args.native_keychain or
                         receipt["native_keychain_scope"].get("agy_reported_synthetic_item_from_both_homes", False))
    return not (state_verified and keychain_verified)


if __name__ == "__main__":
    raise SystemExit(main())

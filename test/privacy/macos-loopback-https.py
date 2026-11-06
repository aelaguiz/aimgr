#!/usr/bin/env python3
"""Bind synthetic HTTPS on the rental, then run the fixture as its normal user.

sudo python3 test/privacy/macos-loopback-https.py --user ec2-user node scripts/privacy-codex-services.mjs
The socket listens only on loopback; no vendor code runs with root privileges.
"""
import argparse
import os
from pathlib import Path
import platform
import pwd
import socket

parser = argparse.ArgumentParser()
parser.add_argument('--user', required=True)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
assert platform.system() == 'Darwin' and os.geteuid() == 0
assert Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file()
assert args.command
user = pwd.getpwnam(args.user)
assert user.pw_uid != 0
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', 443))
listener.listen(128)
listener.set_inheritable(True)
env = dict(os.environ, HOME=user.pw_dir, USER=user.pw_name, LOGNAME=user.pw_name,
           AIMGR_SYNTHETIC_HTTPS_FD=str(listener.fileno()))
os.setgroups(os.getgrouplist(user.pw_name, user.pw_gid))
os.setgid(user.pw_gid)
os.setuid(user.pw_uid)
assert os.getuid() == os.geteuid() == user.pw_uid
os.execvpe(args.command[0], args.command, env)

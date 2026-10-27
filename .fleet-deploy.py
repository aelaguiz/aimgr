import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

repo = Path.home() / 'workspace/aimgr'
os.chdir(repo)
target, action = sys.argv[1:]

def git(*args, check=True):
    return subprocess.run(['git', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)

def digest(data):
    return None if data is None else hashlib.sha256(data).hexdigest()

def current_file(rel):
    p = repo / rel
    if p.is_symlink():
        raise RuntimeError('Refusing symlink: ' + rel)
    return p.read_bytes() if p.exists() else None

def tree(commit):
    result = {}
    for entry in git('ls-tree', '-rz', commit).stdout.split(b'\0'):
        if not entry:
            continue
        meta, name = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        result[name.decode()] = (mode, kind, oid)
    return result

def blob(entries, rel):
    entry = entries.get(rel)
    if not entry:
        return None
    if entry[1] != 'blob' or entry[0] not in ('100644', '100755'):
        raise RuntimeError('Unsupported tree entry: ' + rel)
    return git('cat-file', 'blob', entry[2]).stdout

assert git('branch', '--show-current').stdout.strip() == b'main', 'Not on main'
assert git('diff', '--cached', '--quiet', check=False).returncode == 0, 'Staged work exists'
old_head = git('rev-parse', 'HEAD').stdout.decode().strip()
assert git('merge-base', '--is-ancestor', old_head, target, check=False).returncode == 0, 'Not a fast-forward'
old_tree, new_tree = tree(old_head), tree(target)
names = git('diff', '--name-only', '-z', old_head, target).stdout.decode().split('\0')
plan = []
known_installed_doc = '250c4fbb237bbf240e89c6eef1c01ed7f1cc5f40be358c40d2d20bb2ab8cf03e'
for rel in filter(None, names):
    assert not Path(rel).is_absolute() and '..' not in Path(rel).parts
    base, incoming, local = blob(old_tree, rel), blob(new_tree, rel), current_file(rel)
    if incoming is None:
        raise RuntimeError('Deletion requires separate review: ' + rel)
    if local == incoming:
        merged = local
    elif local == base:
        merged = incoming
    elif base is None:
        if rel == 'docs/AI_MANAGER_RESOURCE_AUDIT_AND_FIX_PLAN_2026-10-25.md' and digest(local) == known_installed_doc:
            merged = incoming
        else:
            raise RuntimeError('Untracked file collision: ' + rel)
    elif local is None:
        raise RuntimeError('Locally deleted file: ' + rel)
    else:
        with tempfile.TemporaryDirectory(prefix='aimgr-merge-') as td:
            paths = [Path(td) / name for name in ('local', 'base', 'incoming')]
            for p, data in zip(paths, (local, base, incoming)):
                p.write_bytes(data)
            result = git('merge-file', '-p', *map(str, paths), check=False)
            if result.returncode:
                raise RuntimeError('Merge needs review: ' + rel)
            merged = result.stdout
    plan.append({'path': rel, 'before': local, 'after': merged, 'mode': int(new_tree[rel][0], 8) & 0o777})

if action == 'plan':
    print(json.dumps({'host': os.uname().nodename, 'head': old_head, 'target': target,
                      'files': len(plan), 'writes': sum(p['before'] != p['after'] for p in plan),
                      'mergedLocalEdits': [p['path'] for p in plan if p['after'] != blob(new_tree, p['path'])]}))
    sys.exit(0)
assert action == 'apply'
backup = Path.home() / '.aimgr/deploy-backups' / ('performance-' + target[:12] + '-' + str(time.time_ns()))
backup.mkdir(parents=True, mode=0o700)
(backup / 'before.patch').write_bytes(git('diff', '--binary', 'HEAD').stdout)
index = Path(git('rev-parse', '--git-path', 'index').stdout.decode().strip())
index_before = index.read_bytes()
(backup / 'index').write_bytes(index_before)
manifest = {'oldHead': old_head, 'target': target, 'files': []}
for item in plan:
    rel = item['path']
    manifest['files'].append({'path': rel, 'before': digest(item['before']), 'after': digest(item['after'])})
    if item['before'] is not None:
        p = backup / 'files' / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(item['before'])
(backup / 'manifest.json').write_text(json.dumps(manifest, indent=2))
for item in plan:
    assert current_file(item['path']) == item['before'], 'Concurrent edit: ' + item['path']
assert index.read_bytes() == index_before, 'Concurrent index change'
assert git('rev-parse', 'HEAD').stdout.decode().strip() == old_head, 'Concurrent branch change'

# Install new dependency files before callers that import their new exports.
order = {'src/io/file-lines.js': 0, 'src/targets/claude-transcript-rekey.js': 1,
         'src/targets/claude-sessions.js': 2, 'src/routines/claude.js': 2,
         'src/targets/prime-sessions.js': 2}
for item in sorted(plan, key=lambda p: (order.get(p['path'], 10), p['path'])):
    if item['before'] == item['after']:
        continue
    dest = repo / item['path']
    assert current_file(item['path']) == item['before'], 'Concurrent edit: ' + item['path']
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, staged = tempfile.mkstemp(prefix='.aimgr-release-', dir=dest.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(item['after'])
        os.chmod(staged, item['mode'])
        os.replace(staged, dest)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)

assert index.read_bytes() == index_before, 'Concurrent index change'
git('update-ref', 'refs/heads/main', target, old_head)
git('read-tree', target)  # Index only: preserve all merged working files and unrelated work.
for item in plan:
    assert current_file(item['path']) == item['after'], 'Readback mismatch: ' + item['path']
print(json.dumps({'host': os.uname().nodename, 'head': target, 'verifiedFiles': len(plan), 'backup': str(backup)}))

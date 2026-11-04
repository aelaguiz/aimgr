#!/usr/bin/env python3
"""Expand the reviewed upstream archive without modifying its source.

Builds run on the isolated development machines. This script does not fetch,
execute Codex, copy credentials, or select a different upstream revision.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path, help='git archive --format=tar.gz of source.json revision')
args = parser.parse_args()
root = Path(__file__).resolve().parent
source = json.loads((root / 'source.json').read_text())
digest = hashlib.sha256()
with args.archive.open('rb') as stream:
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
if digest.hexdigest() != source['archiveSha256']:
    raise SystemExit('Upstream archive does not match the reviewed source revision.')
vendor = root / 'vendor'
vendor.mkdir(exist_ok=True)
destination = vendor / 'codex'
if destination.exists():
    raise SystemExit('Source already exists. Use a fresh build directory; existing source is never overwritten.')
with tempfile.TemporaryDirectory(prefix='.source-', dir=vendor) as temporary:
    stage = Path(temporary) / 'codex'
    stage.mkdir()
    with tarfile.open(args.archive) as archive:
        # Support the stock Python shipped on the isolated Mac, which predates
        # tarfile's data filter. The archive digest is checked before parsing.
        for member in archive.getmembers():
            relative = Path(member.name)
            if relative.is_absolute() or '..' in relative.parts or member.isdev() or member.isfifo():
                raise SystemExit('Unexpected upstream archive member.')
            if member.issym() or member.islnk():
                target = (stage / relative.parent / member.linkname).resolve()
                if stage.resolve() not in target.parents:
                    raise SystemExit('Unexpected upstream archive link.')
        archive.extractall(stage)
    stage.rename(destination)
print('Prepared unchanged upstream source ' + source['revision'])

from pathlib import Path
import json,hashlib,os,sys
work=Path(__file__).resolve().parent; live=Path('/Users/aelaguiz/workspace/aimgr')
base=json.loads((work/'.baseline-sha256.json').read_text()); deployed=json.loads((work/'.deployed-sha256.json').read_text())
files=sys.argv[1:]
for rel in files:
 dest=live/rel; expected=deployed.get(rel,base.get(rel))
 assert (hashlib.sha256(dest.read_bytes()).hexdigest() if dest.exists() else None)==expected,f'Concurrent change: {rel}'
for rel in files:
 dest=live/rel; saved=work/'.deployment-backup'/rel
 if dest.exists() and not saved.exists(): saved.parent.mkdir(parents=True,exist_ok=True); saved.write_bytes(dest.read_bytes())
 dest.parent.mkdir(parents=True,exist_ok=True)
 staged=dest.with_name(dest.name+'.performance-update'); staged.write_bytes((work/rel).read_bytes()); os.chmod(staged,0o644); os.replace(staged,dest)
 deployed[rel]=hashlib.sha256(dest.read_bytes()).hexdigest()
(work/'.deployed-sha256.json').write_text(json.dumps(deployed,indent=2))
print('Installed: '+', '.join(files))

#!/usr/bin/env bash
# Disposable GCP development host only. Never run on an existing user machine.
# No Claude accounts, office-proxy credentials, or production Redis state belong here.
set -euo pipefail
umask 027

readonly provision_root=/opt/aimgr-privacy-dev
readonly node_release=v24.22.2
readonly node_archive=node-v24.22.2-linux-x64.tar.xz
readonly node_sha256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75

if [[ ${EUID} -ne 0 ]] || [[ $(uname -s) != Linux ]]; then
  echo 'This bootstrap requires root on the disposable Linux VM.' >&2
  exit 1
fi
if [[ -f ${provision_root}/bootstrap-complete ]]; then
  echo 'Development bootstrap already completed; leaving existing state intact.'
  exit 0
fi
install -d -m 0755 "$provision_root"
exec > >(tee -a /var/log/aimgr-privacy-dev-bootstrap.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git jq python3 python3-venv build-essential \
  redis-server redis-tools openssl rsync tmux nftables tcpdump iproute2 \
  ripgrep dnsutils iputils-ping socat unzip xz-utils

node_stage=$(mktemp -d)
trap 'rm -rf -- "$node_stage"' EXIT
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/${node_release}/${node_archive}" \
  --output "${node_stage}/${node_archive}"
echo "${node_sha256}  ${node_stage}/${node_archive}" | sha256sum --check --status
tar -xJf "${node_stage}/${node_archive}" -C /usr/local --strip-components=1

if ! id aimdev >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash aimdev
fi
printf '%s\n' 'aimdev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/aimgr-privacy-dev
chmod 0440 /etc/sudoers.d/aimgr-privacy-dev
visudo -cf /etc/sudoers.d/aimgr-privacy-dev
install -d -o aimdev -g aimdev -m 0750 /home/aimdev/workspace
install -d -o aimdev -g aimdev -m 0700 /home/aimdev/.aimgr
install -d -o aimdev -g aimdev -m 0755 /home/aimdev/.local/bin

# The test database is a distinct Redis process, not a prefix in production Redis.
systemctl disable --now redis-server.service
install -d -o root -g redis -m 0750 /etc/aimgr-privacy-dev
install -d -o redis -g redis -m 0750 /var/lib/aimgr-privacy-redis
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 180 \
  -subj '/CN=AI Manager Disposable Redis' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1' \
  -keyout /etc/aimgr-privacy-dev/redis.key \
  -out /etc/aimgr-privacy-dev/redis.crt 2>/dev/null
chown root:redis /etc/aimgr-privacy-dev/redis.key /etc/aimgr-privacy-dev/redis.crt
chmod 0640 /etc/aimgr-privacy-dev/redis.key
install -m 0644 /etc/aimgr-privacy-dev/redis.crt "$provision_root/redis-ca.crt"

python3 - <<'PY'
from pathlib import Path
import hashlib, json, os, pwd, secrets

password = secrets.token_hex(32)
Path('/etc/aimgr-privacy-dev/redis.acl').write_text(
    'user default off\nuser aimgr on #' + hashlib.sha256(password.encode()).hexdigest()
    + ' ~* &* +@all\n'
)
url = 'rediss://aimgr:' + password + '@127.0.0.1:6380'
config = Path('/home/aimdev/.aimgr/config.yaml')
config.write_text(json.dumps({
    'version': 1,
    'redis': {
        'url': url,
        'keyPrefix': 'aimgr-privacy-dev:',
        'primaryHost': '127.0.0.1',
        'transport': 'tls'
    }
}, indent=2) + '\n')
owner = pwd.getpwnam('aimdev')
os.chown(config, owner.pw_uid, owner.pw_gid)
config.chmod(0o600)
PY
chown root:redis /etc/aimgr-privacy-dev/redis.acl
chmod 0640 /etc/aimgr-privacy-dev/redis.acl
cat > /etc/aimgr-privacy-dev/redis.conf <<'REDIS'
bind 127.0.0.1 ::1
protected-mode yes
port 0
tls-port 6380
tls-cert-file /etc/aimgr-privacy-dev/redis.crt
tls-key-file /etc/aimgr-privacy-dev/redis.key
tls-ca-cert-file /etc/aimgr-privacy-dev/redis.crt
tls-auth-clients no
aclfile /etc/aimgr-privacy-dev/redis.acl
dir /var/lib/aimgr-privacy-redis
appendonly yes
maxmemory 512mb
maxmemory-policy noeviction
logfile ""
REDIS
chown root:redis /etc/aimgr-privacy-dev/redis.conf
chmod 0640 /etc/aimgr-privacy-dev/redis.conf
cat > /etc/systemd/system/aimgr-privacy-redis.service <<'SERVICE'
[Unit]
Description=Disposable AI Manager development Redis (loopback TLS only)
After=network.target

[Service]
Type=simple
User=redis
Group=redis
ExecStart=/usr/bin/redis-server /etc/aimgr-privacy-dev/redis.conf
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now aimgr-privacy-redis.service
redis_status=''
for attempt in {1..10}; do
  redis_status=$(redis-cli --tls --cacert "$provision_root/redis-ca.crt" \
    -h 127.0.0.1 -p 6380 ping 2>/dev/null || true)
  [[ "$redis_status" == 'NOAUTH Authentication required.' ]] && break
  sleep 1
done
if [[ "$redis_status" != 'NOAUTH Authentication required.' ]]; then
  echo 'Disposable Redis did not become ready with TLS and authentication required.' >&2
  exit 1
fi

cat > /etc/profile.d/aimgr-privacy-dev.sh <<'PROFILE'
export NODE_EXTRA_CA_CERTS=/opt/aimgr-privacy-dev/redis-ca.crt
export PATH="$HOME/.local/bin:$PATH"
PROFILE
chmod 0644 /etc/profile.d/aimgr-privacy-dev.sh
cat > /home/aimdev/.local/bin/aim <<'AIM'
#!/usr/bin/env bash
set -euo pipefail
export NODE_EXTRA_CA_CERTS=/opt/aimgr-privacy-dev/redis-ca.crt
exec /usr/local/bin/node /home/aimdev/workspace/aimgr/bin/aimgr.js "$@"
AIM
chmod 0755 /home/aimdev/.local/bin/aim
chown aimdev:aimdev /home/aimdev/.local/bin/aim
ln -s aim /home/aimdev/.local/bin/aimgr

cat > "$provision_root/README.txt" <<'README'
AI Manager disposable development VM: mock-only stage.

Workspace: /home/aimdev/workspace/aimgr
Plan: workspace docs/aelaguiz/CLAUDE_PRIVACY_PROXY_WORKLOG_2026-10-30.md
Test Redis: rediss://127.0.0.1:6380; credentials are only in aimdev's AIM config.
Redis service: aimgr-privacy-redis.service
Redis TLS trust: /opt/aimgr-privacy-dev/redis-ca.crt

No Claude/office-proxy/production-Redis credentials are installed.
External egress is closed by GCP after dependency bootstrap; use IAP for SSH/SCP.
Do not copy the sacrificial account inventory into this mock-only environment.
No full acceptance test or production enforcement claim follows from VM setup.
README
chmod 0644 "$provision_root/README.txt"
date -u +'%Y-%m-%dT%H:%M:%SZ' > "$provision_root/bootstrap-complete"
chmod 0644 "$provision_root/bootstrap-complete"
echo "Bootstrap complete: Node $(node --version), $(redis-server --version)."

#!/usr/bin/env bash
# llmux v2 system-mode install script.
#
# Sets up the 'llmux' service user + group, system directories, default
# config, and the systemd unit. Run as root.
#
# This is a SCAFFOLD — actual install logic lands in v2 Phase 13 ('Release
# as v2.0; document migration'). The shape below documents what the
# eventual install will do.

set -euo pipefail

# ─── prerequisite checks ─────────────────────────────────────────────────
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "error: this installer must run as root" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: systemd not detected. v2 system-mode currently requires systemd." >&2
  echo "       For non-systemd hosts, stick with v1.x user-mode." >&2
  exit 1
fi

# ─── service user + group ────────────────────────────────────────────────
if ! getent group llmux >/dev/null; then
  groupadd --system llmux
  echo "created group: llmux"
fi
if ! id llmux >/dev/null 2>&1; then
  # --home-dir /var/lib/llmux: agent CLI credentials (~llmux/.claude/, etc.)
  # live here, operator-managed centrally. Daemon NEVER reads /home/*.
  useradd --system --gid llmux --home-dir /var/lib/llmux \
          --shell /usr/sbin/nologin --comment "llmux daemon" llmux
  echo "created user: llmux"
fi

# ─── directories ─────────────────────────────────────────────────────────
install -d -o root  -g llmux -m 0750 /etc/llmux
install -d -o llmux -g llmux -m 0750 /var/lib/llmux
install -d -o llmux -g llmux -m 0750 /var/lib/llmux/orchestration
install -d -o llmux -g llmux -m 0750 /var/log/llmux
# /var/run/llmux is created by systemd's RuntimeDirectory= at unit start

# ─── default config (only if not already present) ────────────────────────
if [ ! -f /etc/llmux/config.yaml ]; then
  cat > /etc/llmux/config.yaml <<'EOF'
# llmux v2 system-mode config.
# All keys optional; defaults documented inline.

listenPort: 3001
listenHost: '0.0.0.0'         # change to '127.0.0.1' for loopback-only
transportDir: /var/lib/llmux/orchestration
dataDir: /var/lib/llmux
serviceUser: llmux
serviceGroup: llmux
workerSpawner: systemd-run    # alternatives: sudo, runuser

# Optional TLS — set both to enable HTTPS:
# tlsCertPath: /etc/llmux/tls/cert.pem
# tlsKeyPath:  /etc/llmux/tls/key.pem
EOF
  chown root:llmux /etc/llmux/config.yaml
  chmod 0640 /etc/llmux/config.yaml
  echo "wrote default config: /etc/llmux/config.yaml"
fi

# ─── systemd unit ────────────────────────────────────────────────────────
# Install the unit from the package's deploy/ directory.
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
install -o root -g root -m 0644 \
  "$SOURCE_DIR/llmuxd.service" \
  /etc/systemd/system/llmuxd.service

systemctl daemon-reload
echo "installed: /etc/systemd/system/llmuxd.service"

# ─── next steps ──────────────────────────────────────────────────────────
cat <<'EOF'

llmux v2 system-mode install complete.

  systemctl enable --now llmuxd

After start, llmuxd will print a setup URL on first run:

  journalctl -u llmuxd -e | grep 'first-run setup'

Visit that URL to create the first admin user.

EOF

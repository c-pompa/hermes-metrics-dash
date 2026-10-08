#!/usr/bin/env bash
# install-plugin.sh — install the metrics-dashboard Hermes plugin (both halves).
#
# Usage:
#   ./install-plugin.sh              install
#   ./install-plugin.sh --uninstall  remove
#
# Copies:
#   plugin/                 -> ${HERMES_HOME:-~/.hermes}/plugins/metrics-dashboard/
#   desktop-plugin/plugin.js -> ${HERMES_HOME:-~/.hermes}/desktop-plugins/metrics-dashboard/
# Idempotent: safe to re-run; the installed copies are fully replaced each
# time.
#
# This script only copies files. It does NOT edit config.yaml or restart
# anything — see the printed manual steps.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
PLUGIN_DEST="$HERMES_HOME_DIR/plugins/metrics-dashboard"
DESKTOP_DEST="$HERMES_HOME_DIR/desktop-plugins/metrics-dashboard"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$PLUGIN_DEST" "$DESKTOP_DEST"
  echo "Removed:"
  echo "  $PLUGIN_DEST"
  echo "  $DESKTOP_DEST"
  echo
  echo "Manual step: remove 'metrics-dashboard' from plugins.enabled in"
  echo "$HERMES_HOME_DIR/config.yaml, then restart the Hermes desktop app."
  exit 0
fi

rm -rf "$PLUGIN_DEST" "$DESKTOP_DEST"
mkdir -p "$PLUGIN_DEST" "$DESKTOP_DEST"
cp -R "$SRC_DIR/plugin/." "$PLUGIN_DEST/"
cp "$SRC_DIR/desktop-plugin/plugin.js" "$DESKTOP_DEST/plugin.js"
# Never ship bytecode caches from a dev checkout into the installed plugin.
find "$PLUGIN_DEST" -type d -name __pycache__ -prune -exec rm -rf {} +

echo "Installed:"
echo "  $PLUGIN_DEST/            (plugin.yaml, __init__.py, metrics_core.py, dashboard/)"
echo "  $DESKTOP_DEST/plugin.js  (desktop UI)"
echo
echo "Manual steps (not done by this script):"
echo
echo "  1. Enable the Python half in $HERMES_HOME_DIR/config.yaml:"
echo
echo "       plugins:"
echo "         enabled:"
echo "           - metrics-dashboard"
echo
echo "  2. Restart the Hermes desktop app — backend routes"
echo "     (/api/plugins/metrics-dashboard/) mount at backend startup. Restarting"
echo "     the desktop app restarts its backend; 'launchctl kickstart"
echo "     ai.hermes.gateway' is NOT the right service."
echo
echo "  3. The desktop half hot-loads from desktop-plugins/ within seconds"
echo "     (or Cmd-K -> 'Reload desktop plugins')."
echo
echo "Optional:"
echo "  - METRICS_DASH_URL env on the backend overrides the dashboard server URL"
echo "    (default: loopback :8899, then any METRICS_DASH_REMOTES candidates)."
echo "  - If the desktop connects to a REMOTE Hermes backend,"
echo "    repeat this install against that host's HERMES_HOME too."
echo "  - The desktop 'open full dashboard' link defaults to"
echo "    http://127.0.0.1:8899; override in the app's devtools console with"
echo "    ctx.storage key 'dashboardUrl' (hermes.plugin.metrics-dashboard.dashboardUrl)."

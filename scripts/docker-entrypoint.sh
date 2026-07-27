#!/bin/bash
# Docker entrypoint for NotebookLM MCP Server
# Starts VNC services (for visual auth) and Node.js HTTP server
set -e
echo "==========================================="
echo "  NotebookLM MCP Server - Docker"
echo "==========================================="
echo ""

PROFILE_DIR="${CHROME_PROFILE_DIR:-${DATA_DIR:-/data}/chrome_profile}"
if [ -d "$PROFILE_DIR" ]; then
    echo "[Entrypoint] Cleaning stale Chromium profile locks in ${PROFILE_DIR}..."
    rm -f "${PROFILE_DIR}/SingletonLock" \
          "${PROFILE_DIR}/SingletonSocket" \
          "${PROFILE_DIR}/SingletonCookie" 2>/dev/null || true
fi

# Check if VNC should be started (default: yes in Docker)
ENABLE_VNC="${ENABLE_VNC:-true}"
if [ "$ENABLE_VNC" = "true" ]; then
    echo "[Entrypoint] Starting VNC services..."
    source /app/scripts/start-vnc.sh
    echo ""
    echo "[Entrypoint] VNC ready at: http://<host>:${NOVNC_PORT:-6080}/vnc.html"
    echo ""
else
    echo "[Entrypoint] VNC disabled (ENABLE_VNC=false)"
fi
# Render injecte automatiquement PORT, on l'utilise en priorité
export HTTP_PORT=${PORT:-${HTTP_PORT:-3000}}
echo "[Entrypoint] Starting Node.js HTTP server on port ${HTTP_PORT}..."
echo ""
# Start the Node.js server (foreground)
exec node dist/http-wrapper.js

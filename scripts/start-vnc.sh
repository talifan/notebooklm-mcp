#!/bin/bash
# Start VNC services for browser visibility in Docker
# This allows users to see and interact with Chromium via noVNC web interface

set -e

DISPLAY_NUM="${DISPLAY_NUM:-99}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
SCREEN_RESOLUTION="${SCREEN_RESOLUTION:-1280x800x24}"

export DISPLAY=":${DISPLAY_NUM}"

DISPLAY_LOCK="/tmp/.X${DISPLAY_NUM}-lock"
DISPLAY_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"

check_process() {
    local pid="$1"
    local name="$2"
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "[VNC] ERROR: ${name} exited during startup"
        wait "$pid" || true
        exit 1
    fi
}

echo "[VNC] Cleaning stale display files for :${DISPLAY_NUM}..."
rm -f "${DISPLAY_LOCK}" "${DISPLAY_SOCKET}" 2>/dev/null || true
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

echo "[VNC] Starting Xvfb on display :${DISPLAY_NUM}..."
Xvfb :${DISPLAY_NUM} -screen 0 ${SCREEN_RESOLUTION} -ac &
XVFB_PID=$!
check_process "${XVFB_PID}" "Xvfb"

echo "[VNC] Starting fluxbox window manager..."
fluxbox &
FLUXBOX_PID=$!
check_process "${FLUXBOX_PID}" "fluxbox"

echo "[VNC] Starting x11vnc on port ${VNC_PORT}..."
x11vnc -display :${DISPLAY_NUM} -forever -shared -rfbport ${VNC_PORT} -nopw -xkb &
X11VNC_PID=$!
check_process "${X11VNC_PID}" "x11vnc"

echo "[VNC] Starting noVNC websockify on port ${NOVNC_PORT}..."
# noVNC location on Debian
NOVNC_DIR="/usr/share/novnc"
if [ -d "$NOVNC_DIR" ]; then
    websockify --web=${NOVNC_DIR} ${NOVNC_PORT} localhost:${VNC_PORT} &
else
    echo "[VNC] Warning: noVNC directory not found at ${NOVNC_DIR}"
    websockify ${NOVNC_PORT} localhost:${VNC_PORT} &
fi
WEBSOCKIFY_PID=$!
check_process "${WEBSOCKIFY_PID}" "websockify"

echo "[VNC] VNC services started successfully"
echo "[VNC] Access browser at: http://localhost:${NOVNC_PORT}/vnc.html"

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start.sh — Set up and launch the Gmail Spam Classifier server
#
# First run:  creates a virtual environment, installs deps, starts the server.
# Subsequent runs: activates the existing venv and starts the server directly.
#
# Usage:
#   chmod +x start.sh
#   ./start.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
SERVER_FILE="$SCRIPT_DIR/spam_server.py"
PORT=5001

cd "$SCRIPT_DIR"

# ── 1. Create virtual environment if it doesn't exist ────────────────────────
if [ ! -d "$VENV_DIR" ]; then
    echo "→ Creating virtual environment…"
    python3 -m venv "$VENV_DIR"
fi

# ── 2. Activate venv ─────────────────────────────────────────────────────────
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# ── 3. Install / upgrade dependencies ────────────────────────────────────────
echo "→ Installing dependencies…"
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

# ── 4. Check port availability ───────────────────────────────────────────────
if lsof -iTCP:"$PORT" -sTCP:LISTEN -t &>/dev/null; then
    echo ""
    echo "⚠️  Port $PORT is already in use."
    echo "   If the spam server is already running, you don't need to start it again."
    echo "   To stop it: kill \$(lsof -iTCP:$PORT -sTCP:LISTEN -t)"
    exit 1
fi

# ── 5. Launch the server ──────────────────────────────────────────────────────
echo ""
echo "✓ Starting Gmail Spam Classifier on http://127.0.0.1:$PORT"
echo "  Press Ctrl+C to stop."
echo ""

python "$SERVER_FILE"
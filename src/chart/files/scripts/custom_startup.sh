#!/usr/bin/env bash
set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
HOME_DIR="/home/kasm-user"
SOFTWARE_DIR="$HOME_DIR/Software"
MARKERS_DIR="$HOME_DIR/.markers"
BASHRC="$HOME_DIR/.bashrc"
ARCH=$(uname -m)

# ── Init ─────────────────────────────────────────────────────────────────────
mkdir -p "$MARKERS_DIR" "$SOFTWARE_DIR"
export PATH="$SOFTWARE_DIR/nodejs/bin:$SOFTWARE_DIR/uv/bin:$SOFTWARE_DIR/python/bin:$SOFTWARE_DIR/chromium:$PATH"

# ── Helpers ──────────────────────────────────────────────────────────────────
add_to_path() {
  local entry="$1"
  grep -q "$entry" "$BASHRC" || echo "export PATH=\"$entry:\$PATH\"" >> "$BASHRC"
}

mark_done() {
  touch "$MARKERS_DIR/$1"
}

# ── Git ───────────────────────────────────────────────────────────────────────
setup_git() {
  git config --global user.name "OpenGhiara"
  git config --global user.email "openghiara@openghiara.ai"
  mark_done git
  echo "Git setup complete."
}

# ── Node.js ───────────────────────────────────────────────────────────────────
setup_node() {
  case "$ARCH" in
    x86_64)  NODE_ARCH="x64" ;;
    aarch64) NODE_ARCH="arm64" ;;
    armv7l)  NODE_ARCH="armv7l" ;;
    *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
  esac

  NODE_VERSION=$(curl -sL https://nodejs.org/dist/latest-v24.x/ \
    | grep -oP 'node-v\K[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  NODE_FILENAME="node-v${NODE_VERSION}-linux-${NODE_ARCH}"

  echo "Downloading Node.js v${NODE_VERSION} for ${NODE_ARCH}..."
  curl -sL "https://nodejs.org/dist/latest-v24.x/${NODE_FILENAME}.tar.xz" -o /tmp/nodejs.tar.xz
  tar -xf /tmp/nodejs.tar.xz -C "$SOFTWARE_DIR/"
  mv "$SOFTWARE_DIR/${NODE_FILENAME}" "$SOFTWARE_DIR/nodejs"
  rm /tmp/nodejs.tar.xz

  add_to_path "$SOFTWARE_DIR/nodejs/bin"
  mark_done node
  echo "Node.js setup complete."
}

# ── Python ────────────────────────────────────────────────────────────────────
setup_python() {
  case "$ARCH" in
    x86_64)  PYTHON_ARCH="x86_64-unknown-linux-gnu" ;;
    aarch64) PYTHON_ARCH="aarch64-unknown-linux-gnu" ;;
    *)       echo "Unsupported architecture for Python: $ARCH"; exit 1 ;;
  esac

  PYTHON_URL=$(curl -sL "https://api.github.com/repos/indygreg/python-build-standalone/releases/latest" \
    | grep -oP '"browser_download_url": "\Khttps://[^"]+cpython-3\.13[^"]+'"${PYTHON_ARCH}"'-install_only\.tar\.gz(?=")')

  echo "Downloading Python 3.13 (${PYTHON_ARCH})..."
  curl -sL "$PYTHON_URL" -o /tmp/python.tar.gz
  tar -xf /tmp/python.tar.gz -C "$SOFTWARE_DIR/"
  rm /tmp/python.tar.gz

  add_to_path "$SOFTWARE_DIR/python/bin"
  mark_done python
  echo "Python 3.13 setup complete."
}

# ── uv ────────────────────────────────────────────────────────────────────────
setup_uv() {
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR="$SOFTWARE_DIR/uv" sh

  add_to_path "$SOFTWARE_DIR/uv/bin"
  mark_done uv
  echo "uv/uvx setup complete."
}

# ── Chromium ──────────────────────────────────────────────────────────────────
setup_chromium() {
  echo "Installing Chromium via Playwright..."
  PLAYWRIGHT_BROWSERS_PATH="$SOFTWARE_DIR/chromium" npx -y playwright install chromium

  CHROMIUM_BIN=$(find "$SOFTWARE_DIR/chromium" -path "*/chrome-linux/chrome" -type f | head -1)
  ln -sf "$CHROMIUM_BIN" "$SOFTWARE_DIR/chromium/chrome"

  mkdir -p "$HOME_DIR/.local/share/applications"
  printf '[Desktop Entry]\nType=Application\nName=Chromium\nExec=%s %%U\nMimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;\n' \
    "$CHROMIUM_BIN" > "$HOME_DIR/.local/share/applications/chromium.desktop"
  xdg-settings set default-web-browser chromium.desktop

  add_to_path "$SOFTWARE_DIR/chromium"
  mark_done chromium
  echo "Chromium setup complete."
}

# ── Run setup steps (idempotent via markers) ──────────────────────────────────
[ ! -f "$MARKERS_DIR/git" ]     && setup_git
[ ! -f "$MARKERS_DIR/node" ]    && setup_node
[ ! -f "$MARKERS_DIR/python" ]  && setup_python
[ ! -f "$MARKERS_DIR/uv" ]      && setup_uv
[ ! -f "$MARKERS_DIR/chromium" ] && setup_chromium

# ── Runtime services ──────────────────────────────────────────────────────────
export DISPLAY="${DISPLAY:-:1}"
eval "$(echo "" | gnome-keyring-daemon --unlock --daemonize --components=secrets 2>/dev/null)"
export GNOME_KEYRING_CONTROL GNOME_KEYRING_PID

npx -y @1mcp/agent \
  --config /etc/1mcp/mcp.json \
  --instructions-template /etc/1mcp/instructions-template.md \
  --port 9191 \
  --host 127.0.0.1 \
  -u "$INGRESS_HOST" \
  --trust-proxy true &

node /etc/mcp-proxy/mcp-proxy.js &
/usr/bin/desktop_ready && /usr/bin/xfce4-terminal &

mkdir -p /home/kasm-user/.markers
mkdir -p /home/kasm-user/Software
export PATH="/home/kasm-user/Software/nodejs/bin:/home/kasm-user/Software/uv/bin:$PATH"
ARCH=$(uname -m)
if [ ! -f /home/kasm-user/.markers/git ]; then
  git config --global user.name "OpenGhiara"
  git config --global user.email "openghiara@openghiara.ai"
  touch /home/kasm-user/.markers/git
  echo "Git setup complete."
fi
if [ ! -f /home/kasm-user/.markers/node ]; then
  case "$ARCH" in
    x86_64)  NODE_ARCH="x64" ;;
    aarch64) NODE_ARCH="arm64" ;;
    armv7l)  NODE_ARCH="armv7l" ;;
    *)        echo "Unsupported architecture: $ARCH"; exit 1 ;;
  esac
  NODE_VERSION=$(curl -sL https://nodejs.org/dist/latest-v24.x/ | grep -oP 'node-v\K[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  NODE_FILENAME="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
  NODE_URL="https://nodejs.org/dist/latest-v24.x/${NODE_FILENAME}.tar.xz"
  echo "Downloading Node.js v${NODE_VERSION} for ${NODE_ARCH}..."
  curl -sL "$NODE_URL" -o /tmp/nodejs.tar.xz
  tar -xf /tmp/nodejs.tar.xz -C /home/kasm-user/Software/
  mv /home/kasm-user/Software/${NODE_FILENAME} /home/kasm-user/Software/nodejs
  rm /tmp/nodejs.tar.xz
  if ! grep -q "Software/nodejs" /home/kasm-user/.bashrc; then
    echo 'export PATH="/home/kasm-user/Software/nodejs/bin:$PATH"' >> /home/kasm-user/.bashrc
  fi
  touch /home/kasm-user/.markers/node
  echo "Node.js setup complete."
fi
if [ ! -f /home/kasm-user/.markers/python ]; then
  case "$ARCH" in
    x86_64)  PYTHON_ARCH="x86_64-unknown-linux-gnu" ;;
    aarch64) PYTHON_ARCH="aarch64-unknown-linux-gnu" ;;
    *)        echo "Unsupported architecture for Python: $ARCH"; exit 1 ;;
  esac
  PYTHON_URL=$(curl -sL "https://api.github.com/repos/indygreg/python-build-standalone/releases/latest" \
    | grep -oP '"browser_download_url": "\Khttps://[^"]+cpython-3\.14[^"]+'"${PYTHON_ARCH}"'-install_only\.tar\.gz(?=")')
  echo "Downloading Python 3.14 (${PYTHON_ARCH})..."
  curl -sL "$PYTHON_URL" -o /tmp/python.tar.gz
  tar -xf /tmp/python.tar.gz -C /home/kasm-user/Software/
  rm /tmp/python.tar.gz
  if ! grep -q "Software/python" /home/kasm-user/.bashrc; then
    echo 'export PATH="/home/kasm-user/Software/python/bin:$PATH"' >> /home/kasm-user/.bashrc
  fi
  touch /home/kasm-user/.markers/python
  echo "Python 3.14 setup complete."
fi
if [ ! -f /home/kasm-user/.markers/uv ]; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR="/home/kasm-user/Software/uv" sh
  if ! grep -q "Software/uv" /home/kasm-user/.bashrc; then
    echo 'export PATH="/home/kasm-user/Software/uv/bin:$PATH"' >> /home/kasm-user/.bashrc
  fi
  touch /home/kasm-user/.markers/uv
  echo "uv/uvx setup complete."
fi
if [ ! -f /home/kasm-user/.markers/chromium ]; then
  echo "Installing Chromium via Playwright..."
  PLAYWRIGHT_BROWSERS_PATH=/home/kasm-user/Software/chromium npx -y playwright install chromium
  CHROMIUM_BIN=$(find /home/kasm-user/Software/chromium -path "*/chrome-linux/chrome" -type f | head -1)
  CHROMIUM_DIR=$(dirname "$CHROMIUM_BIN")
  ln -sf "$CHROMIUM_BIN" /home/kasm-user/Software/chromium/chrome
  if ! grep -q "Software/chromium" /home/kasm-user/.bashrc; then
    echo 'export PATH="/home/kasm-user/Software/chromium:$PATH"' >> /home/kasm-user/.bashrc
  fi
  # Create .desktop file and set as default browser
  mkdir -p /home/kasm-user/.local/share/applications
  printf '[Desktop Entry]\nType=Application\nName=Chromium\nExec=%s %%U\nMimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;\n' "${CHROMIUM_BIN}" \
    > /home/kasm-user/.local/share/applications/chromium.desktop
  xdg-settings set default-web-browser chromium.desktop

  touch /home/kasm-user/.markers/chromium
  echo "Chromium setup complete."
fi

eval $(echo "" | gnome-keyring-daemon --unlock --daemonize --components=secrets 2>/dev/null)
export GNOME_KEYRING_CONTROL GNOME_KEYRING_PID

npx -y @1mcp/agent --config /etc/1mcp/mcp.json --port 9090 --host 0.0.0.0 -u $INGRESS_HOST --trust-proxy true &
/usr/bin/desktop_ready && /usr/bin/xfce4-terminal &
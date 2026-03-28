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
export PATH="$SOFTWARE_DIR:$SOFTWARE_DIR/nodejs/bin:$SOFTWARE_DIR/uv/bin:$SOFTWARE_DIR/python/bin:$SOFTWARE_DIR/chromium:$SOFTWARE_DIR/kubectl:$SOFTWARE_DIR/helm:$PATH"

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

# ── kubectl ───────────────────────────────────────────────────────────────────
setup_kubectl() {
  case "$ARCH" in
    x86_64)  KUBECTL_ARCH="amd64" ;;
    aarch64) KUBECTL_ARCH="arm64" ;;
    *)       echo "Unsupported architecture for kubectl: $ARCH"; exit 1 ;;
  esac

  KUBECTL_VERSION=$(curl -sL https://dl.k8s.io/release/stable.txt)
  echo "Downloading kubectl ${KUBECTL_VERSION}..."
  mkdir -p "$SOFTWARE_DIR/kubectl"
  curl -sL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KUBECTL_ARCH}/kubectl" \
    -o "$SOFTWARE_DIR/kubectl/kubectl"
  chmod +x "$SOFTWARE_DIR/kubectl/kubectl"

  add_to_path "$SOFTWARE_DIR/kubectl"
  mark_done kubectl
  echo "kubectl setup complete."
}

# ── Helm ──────────────────────────────────────────────────────────────────────
setup_helm() {
  case "$ARCH" in
    x86_64)  HELM_ARCH="amd64" ;;
    aarch64) HELM_ARCH="arm64" ;;
    *)       echo "Unsupported architecture for helm: $ARCH"; exit 1 ;;
  esac

  HELM_VERSION=$(curl -sL https://api.github.com/repos/helm/helm/releases/latest \
    | grep -oP '"tag_name": "\K[^"]+')
  echo "Downloading Helm ${HELM_VERSION}..."
  curl -sL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${HELM_ARCH}.tar.gz" -o /tmp/helm.tar.gz
  tar -xf /tmp/helm.tar.gz -C /tmp/
  mkdir -p "$SOFTWARE_DIR/helm"
  mv "/tmp/linux-${HELM_ARCH}/helm" "$SOFTWARE_DIR/helm/helm"
  rm -rf /tmp/helm.tar.gz "/tmp/linux-${HELM_ARCH}"

  add_to_path "$SOFTWARE_DIR/helm"
  mark_done helm
  echo "Helm setup complete."
}

# ── kubeconfig ────────────────────────────────────────────────────────────────
setup_kubeconfig() {
  SA_DIR="/var/run/secrets/kubernetes.io/serviceaccount"

  if [ ! -f "$SA_DIR/token" ]; then
    echo "No SA token found, skipping kubeconfig setup."
    mark_done kubeconfig
    return
  fi

  TOKEN=$(cat "$SA_DIR/token")
  CA=$(base64 -w0 < "$SA_DIR/ca.crt")
  NAMESPACE=$(cat "$SA_DIR/namespace")

  mkdir -p "$HOME_DIR/.kube"
  cat > "$HOME_DIR/.kube/config" <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: ${CA}
    server: https://kubernetes.default.svc
  name: in-cluster
contexts:
- context:
    cluster: in-cluster
    namespace: ${NAMESPACE}
    user: sa
  name: default
current-context: default
users:
- name: sa
  user:
    token: ${TOKEN}
EOF
  chmod 600 "$HOME_DIR/.kube/config"

  mark_done kubeconfig
  echo "kubeconfig setup complete."
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

  add_to_path "$SOFTWARE_DIR/chromium"
  mark_done chromium
  echo "Chromium setup complete."
}

# ── Run setup steps (idempotent via markers) ──────────────────────────────────
[ ! -f "$MARKERS_DIR/git" ]      && setup_git
[ ! -f "$MARKERS_DIR/node" ]     && setup_node
[ ! -f "$MARKERS_DIR/python" ]   && setup_python
[ ! -f "$MARKERS_DIR/uv" ]       && setup_uv
[ ! -f "$MARKERS_DIR/kubectl" ]    && setup_kubectl
[ ! -f "$MARKERS_DIR/helm" ]       && setup_helm
[ ! -f "$MARKERS_DIR/kubeconfig" ] && setup_kubeconfig
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

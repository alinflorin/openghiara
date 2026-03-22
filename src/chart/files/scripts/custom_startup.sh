    if [ ! -f /home/kasm-user/.setupcomplete ]; then
      echo "First run detected, setting up environment..."

      ARCH=$(uname -m)
      case "$ARCH" in
        x86_64)  NODE_ARCH="x64" ;;
        aarch64) NODE_ARCH="arm64" ;;
        armv7l)  NODE_ARCH="armv7l" ;;
        *)        echo "Unsupported architecture: $ARCH"; exit 1 ;;
      esac

      NODE_VERSION=$(curl -sL https://nodejs.org/dist/latest-v24.x/ | grep -oP 'node-v\K[0-9]+\.[0-9]+\.[0-9]+' | head -1)
      NODE_FILENAME="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
      NODE_URL="https://nodejs.org/dist/latest-v24.x/${NODE_FILENAME}.tar.xz"

      mkdir -p /home/kasm-user/Software

      echo "Downloading Node.js v${NODE_VERSION} for ${NODE_ARCH}..."
      curl -sL "$NODE_URL" -o /tmp/nodejs.tar.xz
      tar -xf /tmp/nodejs.tar.xz -C /home/kasm-user/Software/
      mv /home/kasm-user/Software/${NODE_FILENAME} /home/kasm-user/Software/nodejs
      rm /tmp/nodejs.tar.xz

      if ! grep -q "Software/nodejs" /home/kasm-user/.bashrc; then
        echo 'export PATH="/home/kasm-user/Software/nodejs/bin:$PATH"' >> /home/kasm-user/.bashrc
      fi

      touch /home/kasm-user/.setupcomplete
      echo "Node.js setup complete."
    fi

    /usr/bin/desktop_ready && /usr/bin/xfce4-terminal &
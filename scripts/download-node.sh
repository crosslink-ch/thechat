#!/usr/bin/env bash
# Download a Node.js distribution into src-tauri/resources/node for local
# development and testing of the bundled Node.js fallback.
#
# Usage: ./scripts/download-node.sh [version]
#   version  Node.js version to download (default: 22.15.0)

set -euo pipefail

NODE_VERSION="${1:-24.14.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../packages/desktop/src-tauri/resources/node"

# Detect platform and architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)
    echo "Unsupported OS: $OS (use this script on Linux or macOS)" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64)  NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ARCHIVE="node-v${NODE_VERSION}-${PLATFORM}-${NODE_ARCH}"

if [ "$PLATFORM" = "linux" ]; then
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}.tar.xz"
else
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}.tar.gz"
fi

echo "Downloading Node.js v${NODE_VERSION} (${PLATFORM}-${NODE_ARCH})..."
echo "  URL: $URL"
echo "  Target: $RESOURCES_DIR"

# Clean existing download
rm -rf "$RESOURCES_DIR"
mkdir -p "$RESOURCES_DIR"

# Download and extract
if [ "$PLATFORM" = "linux" ]; then
  curl -fsSL "$URL" | tar xJ --strip-components=1 -C "$RESOURCES_DIR"
else
  curl -fsSL "$URL" | tar xz --strip-components=1 -C "$RESOURCES_DIR"
fi

# Remove files not needed at runtime
rm -rf "$RESOURCES_DIR/include" "$RESOURCES_DIR/share" \
       "$RESOURCES_DIR/CHANGELOG.md" "$RESOURCES_DIR/README.md" "$RESOURCES_DIR/LICENSE"

# Replace symlinks with wrapper scripts (they may not survive Tauri bundling)
for cmd in npm npx; do
  LINK="$RESOURCES_DIR/bin/$cmd"
  if [ -L "$LINK" ]; then
    TARGET=$(readlink "$LINK")
    rm "$LINK"
    printf '#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/%s" "$@"\n' "$TARGET" > "$LINK"
    chmod +x "$LINK"
  fi
done

# Remove corepack (not needed)
rm -f "$RESOURCES_DIR/bin/corepack"
rm -rf "$RESOURCES_DIR/lib/node_modules/corepack"

# Report size
SIZE=$(du -sh "$RESOURCES_DIR" | cut -f1)
echo "Done. Bundled Node.js size: $SIZE"

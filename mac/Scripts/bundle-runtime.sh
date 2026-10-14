#!/usr/bin/env bash
# Freeze the CLI and both Node architectures inside the app. Never copy local npm credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTENTS="${1:?Usage: bundle-runtime.sh /path/to/App.app/Contents}"
NODE_VERSION="22.23.3"
CACHE="${ROOT}/mac/.build/node-runtime/${NODE_VERSION}"
mkdir -p "${CACHE}" "${CONTENTS}/Helpers" "${CONTENTS}/Resources/cli" "${CONTENTS}/MacOS"

for arch in arm64 x64; do
  archive="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  case "${arch}" in
    arm64) expected="23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53" ;;
    x64) expected="8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8" ;;
  esac
  if [[ ! -f "${CACHE}/${archive}" ]]; then
    curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 \
      "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "${CACHE}/${archive}.part"
    mv "${CACHE}/${archive}.part" "${CACHE}/${archive}"
  fi
  actual="$(shasum -a 256 "${CACHE}/${archive}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || { echo "Node ${arch} checksum mismatch. Remove ${CACHE}/${archive} and retry." >&2; exit 1; }
  tar -xzf "${CACHE}/${archive}" -C "${CACHE}" \
    "node-v${NODE_VERSION}-darwin-${arch}/bin/node" "node-v${NODE_VERSION}-darwin-${arch}/LICENSE"
done
lipo -create "${CACHE}/node-v${NODE_VERSION}-darwin-arm64/bin/node" \
  "${CACHE}/node-v${NODE_VERSION}-darwin-x64/bin/node" -output "${CONTENTS}/Helpers/node"
chmod 755 "${CONTENTS}/Helpers/node"
cp "${CACHE}/node-v${NODE_VERSION}-darwin-arm64/LICENSE" "${CONTENTS}/Resources/Node-LICENSE"
cp "${ROOT}/package.json" "${ROOT}/package-lock.json" "${ROOT}/LICENSE" "${CONTENTS}/Resources/cli/"
cp -R "${ROOT}/dist" "${CONTENTS}/Resources/cli/"
find "${CONTENTS}/Resources/cli/dist" -name '*.map' -delete
# A new directory with only explicit manifests; no .env, .npmrc, user config or development deps.
(cd "${CONTENTS}/Resources/cli" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org)
cat > "${CONTENTS}/Resources/cli/exe-watcher" <<'LAUNCHER'
#!/bin/sh
set -eu
contents="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
exec "${contents}/Helpers/node" --max-old-space-size=256 --expose-gc "${contents}/Resources/cli/dist/cli.js" "$@"
LAUNCHER
chmod 755 "${CONTENTS}/Resources/cli/exe-watcher"

# Verify on this host with no developer PATH, credentials, or globally installed CLI.
env -i HOME="${HOME}" PATH=/usr/bin:/bin "${CONTENTS}/Resources/cli/exe-watcher" --version

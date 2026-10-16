#!/usr/bin/env bash
# Contributor-only regeneration; the resulting icons are committed for clean CI builds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for tool in node rsvg-convert sips iconutil; do
  command -v "${tool}" >/dev/null || { echo "Missing ${tool}" >&2; exit 1; }
done
node "${ROOT}/mac/Scripts/generate-owl-assets.mjs"
node "${ROOT}/mac/Scripts/generate-owl-preview.mjs" --original
node "${ROOT}/mac/Scripts/generate-owl-preview.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
mkdir "${WORK}/AppIcon.iconset"
rsvg-convert -w 1024 -h 1024 "${ROOT}/assets/owls/selected-app.svg" -o "${ROOT}/assets/owl-icon.png"
sips -z 512 512 "${ROOT}/assets/owl-icon.png" --out "${ROOT}/assets/owl-icon-512.png" >/dev/null
for size in 16 32 128 256 512; do
  sips -z "${size}" "${size}" "${ROOT}/assets/owl-icon.png" --out "${WORK}/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "${double}" "${double}" "${ROOT}/assets/owl-icon.png" --out "${WORK}/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "${WORK}/AppIcon.iconset" -o "${ROOT}/mac/Sources/ExeWatcherMenubar/Resources/AppIcon.icns"
rsvg-convert "${ROOT}/assets/owl-header.svg" -o "${ROOT}/assets/owl-header.png"
rsvg-convert -f pdf "${ROOT}/assets/owls/selected.svg" -o "${ROOT}/mac/Sources/ExeWatcherMenubar/Resources/owl.pdf"
rsvg-convert -f pdf "${ROOT}/assets/owls/selected-menubar.svg" -o "${ROOT}/mac/Sources/ExeWatcherMenubar/Resources/owl-menubar.pdf"
cp "${ROOT}/assets/owls/selected-app.svg" "${ROOT}/assets/logo.svg"
cp "${ROOT}/assets/owl-icon.png" "${ROOT}/assets/logo.png"
sips -z 256 256 "${ROOT}/assets/owl-icon.png" --out "${WORK}/logo-256.png" >/dev/null
sips -s format ico "${WORK}/logo-256.png" --out "${ROOT}/assets/logo.ico" >/dev/null

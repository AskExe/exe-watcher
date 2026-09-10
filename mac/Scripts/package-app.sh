#!/usr/bin/env bash
# Builds a universal ExeWatcherMenubar.app bundle from the SwiftPM target and drops a
# distributable zip alongside. Used by the GitHub release workflow; also runnable locally.
#
# Usage:
#   mac/Scripts/package-app.sh [<version>]
# Defaults to `dev` if no version is given.

set -euo pipefail

VERSION="${1:-dev}"
BUNDLE_NAME="Watcher by EXE.app"
BUNDLE_ID="com.askexe.exe-watcher-menubar"
EXECUTABLE_NAME="ExeWatcherMenubar"
MIN_MACOS="14.0"

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd)
}

ROOT=$(repo_root)
MAC_DIR="${ROOT}/mac"
DIST_DIR="${MAC_DIR}/.build/dist"

cd "${MAC_DIR}"

echo "▸ Cleaning previous dist..."
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"

echo "▸ Building universal binary (arm64 + x86_64)..."
swift build -c release --arch arm64 --arch x86_64

BIN_PATH=$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)
BUILT_BINARY="${BIN_PATH}/${EXECUTABLE_NAME}"
if [[ ! -x "${BUILT_BINARY}" ]]; then
  echo "Binary not found at ${BUILT_BINARY}" >&2
  exit 1
fi

echo "▸ Assembling ${BUNDLE_NAME}..."
BUNDLE="${DIST_DIR}/${BUNDLE_NAME}"
mkdir -p "${BUNDLE}/Contents/MacOS"
mkdir -p "${BUNDLE}/Contents/Resources"
cp "${BUILT_BINARY}" "${BUNDLE}/Contents/MacOS/${EXECUTABLE_NAME}"

cat > "${BUNDLE}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>Watcher by EXE</string>
    <key>CFBundleExecutable</key>
    <string>${EXECUTABLE_NAME}</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Watcher by EXE</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>${MIN_MACOS}</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>© Exe AI</string>
</dict>
</plist>
PLIST

cat > "${BUNDLE}/Contents/PkgInfo" <<'PKG'
APPL????
PKG

# Copy app icon into bundle Resources so Finder/Dock/Spotlight display it.
ICON_SRC="${MAC_DIR}/Sources/ExeWatcherMenubar/Resources/AppIcon.icns"
if [[ -f "${ICON_SRC}" ]]; then
  cp "${ICON_SRC}" "${BUNDLE}/Contents/Resources/AppIcon.icns"
  echo "▸ App icon installed."
fi

# Keep SwiftPM resources inside Contents/Resources so codesign can seal the bundle.
# The app resolves this packaged location before falling back to Bundle.module in development.
echo "▸ Copying resource bundles..."
for rb in "${BIN_PATH}"/*.bundle; do
  [[ -d "${rb}" ]] || continue
  cp -R "${rb}" "${BUNDLE}/Contents/Resources/"
  echo "  → $(basename "${rb}")"
done

# Ad-hoc sign so macOS treats the bundle as internally consistent. This satisfies the
# minimum bundle-validity checks on macOS 14+ and prevents a class of Gatekeeper edge
# cases on managed Macs. A Developer ID signature (separate setup) would additionally
# surface the publisher name in Finder; not required here.
echo "▸ Ad-hoc signing..."
codesign --force --sign - --timestamp=none --deep "${BUNDLE}"
codesign --verify --deep --strict "${BUNDLE}"

ZIP_NAME="ExeWatcherMenubar-${VERSION}.zip"
ZIP_PATH="${DIST_DIR}/${ZIP_NAME}"
echo "▸ Packaging ${ZIP_NAME}..."
(cd "${DIST_DIR}" && /usr/bin/ditto -c -k --keepParent "${BUNDLE_NAME}" "${ZIP_NAME}")

echo ""
echo "✓ Built ${ZIP_PATH}"
ls -la "${DIST_DIR}"

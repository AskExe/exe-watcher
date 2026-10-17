#!/usr/bin/env bash
# Builds a self-contained universal app, updater zip, drag-to-install DMG and checksums.
# Set CODESIGN_IDENTITY and NOTARY_PROFILE for a public, notarized release.
# Set REQUIRE_NOTARIZATION=1 to fail closed if either setting is missing.
#
# Usage:
#   mac/Scripts/package-app.sh [<version>]
# Defaults to `dev` if no version is given.

set -euo pipefail

VERSION="${1:-dev}"
[[ "${VERSION}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "Invalid version label" >&2; exit 1; }
BUNDLE_NAME="Watcher by EXE.app"
BUNDLE_ID="com.askexe.exe-watcher-menubar"
EXECUTABLE_NAME="ExeWatcherMenubar"
MIN_MACOS="14.0"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MAC_DIR="${ROOT}/mac"
IDENTITY="${CODESIGN_IDENTITY:--}"
if [[ "${REQUIRE_NOTARIZATION:-0}" == 1 ]] && { [[ "${IDENTITY}" == - ]] || [[ -z "${NOTARY_PROFILE:-}" ]]; }; then
  echo "Public release requires CODESIGN_IDENTITY and NOTARY_PROFILE." >&2
  exit 1
fi
if [[ -n "${NOTARY_PROFILE:-}" && "${IDENTITY}" == - ]]; then
  echo "Notarization requires a Developer ID signing identity." >&2; exit 1
fi
for tool in swift node npm lipo codesign hdiutil curl; do
  command -v "${tool}" >/dev/null || { echo "Missing ${tool}" >&2; exit 1; }
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1)'
plutil -lint "${MAC_DIR}/Scripts/node-entitlements.plist"
bash -n "${MAC_DIR}/Scripts/bundle-runtime.sh"
if [[ "${IDENTITY}" != - ]]; then
  security find-identity -v -p codesigning | grep -F -- "${IDENTITY}" >/dev/null || { echo "Signing identity not found" >&2; exit 1; }
fi
mkdir -p "${MAC_DIR}/.build"
DIST_DIR="$(mktemp -d "${MAC_DIR}/.build/package.XXXXXX")"
trap 'rm -rf "${DIST_DIR}"' EXIT

echo "▸ Building bundled CLI..."
(cd "${ROOT}" && npm run build)
APP_VERSION="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "${ROOT}/package.json")"
OWL_LABEL="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).label' "${ROOT}/assets/owls/selection.json")"
if [[ "${REQUIRE_NOTARIZATION:-0}" == 1 && "${VERSION#v}" != "${APP_VERSION}" ]]; then
  echo "Release label must match package.json version ${APP_VERSION}." >&2; exit 1
fi

cd "${MAC_DIR}"

echo "▸ Building universal binary (arm64 + x86_64)..."
# Separate native SwiftPM builds avoid Xcode's SDK-stat-cache hang on repeat multi-arch builds.
swift build --build-system native -c release --arch arm64
BIN_PATH=$(swift build --build-system native -c release --arch arm64 --show-bin-path)
swift build --build-system native -c release --arch x86_64
INTEL_BIN_PATH=$(swift build --build-system native -c release --arch x86_64 --show-bin-path)
BUILT_BINARY="${DIST_DIR}/${EXECUTABLE_NAME}"
lipo -create "${BIN_PATH}/${EXECUTABLE_NAME}" "${INTEL_BIN_PATH}/${EXECUTABLE_NAME}" -output "${BUILT_BINARY}"
if [[ ! -x "${BUILT_BINARY}" ]]; then
  echo "Binary not found at ${BUILT_BINARY}" >&2
  exit 1
fi

echo "▸ Assembling ${BUNDLE_NAME}..."
BUNDLE="${DIST_DIR}/${BUNDLE_NAME}"
mkdir -p "${BUNDLE}/Contents/MacOS"
mkdir -p "${BUNDLE}/Contents/Resources"
cp "${BUILT_BINARY}" "${BUNDLE}/Contents/MacOS/${EXECUTABLE_NAME}"
rm "${BUILT_BINARY}"

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
    <string>${APP_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${APP_VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>${MIN_MACOS}</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>© 2026 Exe AI. Includes CodeBurn © 2026 AgentSeal (MIT).</string>
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

echo "▸ Bundling pinned Node runtime and production CLI..."
"${MAC_DIR}/Scripts/bundle-runtime.sh" "${BUNDLE}/Contents"
lipo "${BUNDLE}/Contents/MacOS/${EXECUTABLE_NAME}" -verify_arch arm64 x86_64
lipo "${BUNDLE}/Contents/Helpers/node" -verify_arch arm64 x86_64

echo "▸ Signing app and bundled runtime..."
SIGN_ARGS=(--force --sign "${IDENTITY}")
if [[ "${IDENTITY}" == - ]]; then
  SIGN_ARGS+=(--timestamp=none)
else
  SIGN_ARGS+=(--options runtime --timestamp)
fi
codesign "${SIGN_ARGS[@]}" --entitlements "${MAC_DIR}/Scripts/node-entitlements.plist" "${BUNDLE}/Contents/Helpers/node"
codesign "${SIGN_ARGS[@]}" "${BUNDLE}"
codesign --verify --deep --strict "${BUNDLE}"
# Exercise the signed runtime, not only the pre-signing binary.
CLI_VERSION="$(env -i HOME="${HOME}" PATH=/usr/bin:/bin "${BUNDLE}/Contents/Resources/cli/exe-watcher" --version)"
[[ "${CLI_VERSION}" == "${APP_VERSION}" ]] || { echo "Bundled CLI version mismatch" >&2; exit 1; }
echo "▸ Verified bundled CLI ${CLI_VERSION}."

if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  echo "▸ Submitting app for Apple notarization..."
  ditto -c -k --keepParent "${BUNDLE}" "${DIST_DIR}/notary-submission.zip"
  xcrun notarytool submit "${DIST_DIR}/notary-submission.zip" --keychain-profile "${NOTARY_PROFILE}" --wait
  xcrun stapler staple "${BUNDLE}"
  xcrun stapler validate "${BUNDLE}"
  spctl --assess --type execute --verbose=2 "${BUNDLE}"
  rm "${DIST_DIR}/notary-submission.zip"
fi

ZIP_NAME="ExeWatcherMenubar-${VERSION}.zip"
echo "▸ Packaging ${ZIP_NAME}..."
(cd "${DIST_DIR}" && /usr/bin/ditto -c -k --keepParent "${BUNDLE_NAME}" "${ZIP_NAME}")

echo "▸ Building drag-to-install disk image..."
DMG_STAGE="${DIST_DIR}/dmg-content"
mkdir "${DMG_STAGE}"
ditto "${BUNDLE}" "${DMG_STAGE}/${BUNDLE_NAME}"
ln -s /Applications "${DMG_STAGE}/Applications"
cat > "${DMG_STAGE}/Read me.txt" <<'README'
Watcher by EXE — macOS 14 or later (Apple Silicon and Intel)

Drag Watcher by EXE into Applications, then open it.
Watcher lives in your menu bar. Click the owl to see your local AI coding usage.
Node and the Watcher CLI are included. No npm install or account is required.
Costs are API-equivalent estimates, not subscription invoices.

Includes code from CodeBurn by AgentSeal (MIT).
License and attribution notices: Watcher by EXE.app/Contents/Resources/cli/

Support: https://github.com/AskExe/exe-watcher/issues
README
DMG_PATH="${DIST_DIR}/Watcher-${VERSION}-universal.dmg"
hdiutil create -quiet -volname "Watcher by EXE" -srcfolder "${DMG_STAGE}" -format UDZO "${DMG_PATH}"
rm -rf "${DMG_STAGE}"
if [[ "${IDENTITY}" != - ]]; then
  codesign --force --sign "${IDENTITY}" --timestamp "${DMG_PATH}"
fi
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "${DMG_PATH}" --keychain-profile "${NOTARY_PROFILE}" --wait
  xcrun stapler staple "${DMG_PATH}"
  xcrun stapler validate "${DMG_PATH}"
fi
(cd "${DIST_DIR}" && shasum -a 256 "${ZIP_NAME}" "$(basename "${DMG_PATH}")" > SHA256SUMS.txt)
cat > "${DIST_DIR}/BUILD-INFO.txt" <<INFO
Watcher ${APP_VERSION}
Source base revision: $(git -C "${ROOT}" rev-parse HEAD)
Source tree: $(git -C "${ROOT}" rev-parse 'HEAD^{tree}')
Modified tracked files: $(git -C "${ROOT}" status --porcelain --untracked-files=no | wc -l | tr -d ' ')
Local source additions may also be included; this is not a merge receipt.
Signing identity: ${IDENTITY}
Notarization: $(if [[ -n "${NOTARY_PROFILE:-}" ]]; then echo 'accepted and stapled'; else echo 'not performed'; fi)
Owl: ${OWL_LABEL}
Architectures: arm64 x86_64
Minimum macOS: ${MIN_MACOS}
Bundled Node: 22.23.3
INFO
OUTPUT_DIR="${MAC_DIR}/.build/dist"
rm -rf "${OUTPUT_DIR}"
mv "${DIST_DIR}" "${OUTPUT_DIR}"
trap - EXIT

echo ""
echo "✓ Built ${OUTPUT_DIR}"
ls -lh "${OUTPUT_DIR}"

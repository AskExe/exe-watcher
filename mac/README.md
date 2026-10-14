# Watcher Menubar (macOS)

Native Swift + SwiftUI menubar app. The Watcher menubar surface.

## Requirements

- macOS 14+ (Sonoma)
- Swift 6.0+ toolchain (bundled with Xcode 16 or standalone)
- Packaged app: Node and the matching CLI are included (from 0.2.55).
- Source builds: Node 22.5+ and `exe-watcher` installed globally, or a local CLI passed via `EXE_WATCHER_BIN`.

## Install (end users)

Download the universal `.dmg` from [GitHub Releases](https://github.com/AskExe/exe-watcher/releases/latest), drag **Watcher by EXE** into **Applications**, then open it. No Node, npm, account, or command-line setup is needed for the packaged app. Public releases must be Developer ID signed and Apple notarized.

Alternatively, with Node 22.5+ already installed:

```bash
npx exe-watcher menubar
```

That's it. The command downloads the latest `.app` from GitHub Releases, drops it into `~/Applications`, clears Gatekeeper quarantine, and launches it. Re-running it upgrades in place with `--force`, or just launches the existing copy otherwise.

If you already have the CLI installed globally (`npm install -g exe-watcher`), `exe-watcher menubar` works the same way.

### Build from source

For contributors running a local build instead of the packaged release:

```bash
npm install -g exe-watcher                       # CLI the app shells out to for data
git clone https://github.com/AskExe/exe-watcher.git
cd exe-watcher/mac
swift build -c release
.build/release/ExeWatcherMenubar                # launch
```

## Build & run (dev against a local CLI checkout)

```bash
cd mac
swift build
# Point the app at your dev CLI build instead of the globally installed `exe-watcher`:
npm --prefix .. run build
EXE_WATCHER_BIN="node $(pwd)/../dist/cli.js" swift run
```

The app registers itself as a menubar accessory (`LSUIElement = true` at runtime). No Dock icon.

## Data source

On launch, wake, and relevant usage-file changes, the app spawns `exe-watcher status --format menubar-json --no-optimize` directly (argv, no shell) via `ExeWatcherCLI.makeProcess` and decodes the JSON into `MenubarPayload`. The manual refresh button in the footer invokes the same command without `--no-optimize`, which includes optimize findings but takes longer. There is no periodic usage scan. File notifications are coalesced with a minimum two-minute spacing and a rest period proportional to scan duration. Only one CLI worker can run at a time, with a 256 MiB V8 heap, a 60-second timeout, bounded output, and lower scheduling priority. A failed scan preserves the last successful payload; the same-day badge survives app restarts.

Override the binary via the `EXE_WATCHER_BIN` environment variable (default: `exe-watcher` on PATH). The value is validated against a strict allowlist (alphanumerics plus `._/-` space) before use, so a malicious env var can't inject shell commands.

## Project layout

```
mac/
├── Package.swift                     SwiftPM manifest
├── Sources/ExeWatcherMenubar/
│   ├── WatcherApp.swift                 @main + MenuBarExtra scene
│   ├── AppStore.swift                @Observable store + enums
│   ├── Data/MenubarPayload.swift     Codable payload types + placeholder
│   ├── Theme/Theme.swift             Design tokens (Exe Foundry Bold palette)
│   └── Views/MenuBarContent.swift    Popover layout + footer action bar
└── README.md                         This file
```

## Updating

Update both the CLI and app to receive accounting and scheduling fixes:

```bash
npm install -g exe-watcher@latest --registry=https://registry.npmjs.org
exe-watcher menubar --force
```

The app's Update button downloads the latest macOS app, including its matching bundled CLI. It does not update a separately installed global npm CLI. Releases include a universal Apple Silicon and Intel app for macOS 14+.

## Packaging and public release

```bash
npm ci
mac/Scripts/package-app.sh v0.2.55
```

This builds a universal app, updater ZIP, drag-to-install DMG and `SHA256SUMS.txt` in `mac/.build/dist`. It freezes the CLI's production dependencies and a checksum-pinned universal Node 22.23.3 runtime. Only explicit build outputs/manifests are copied; local credentials and configuration are excluded. The original Node license and dependency licenses ship with the app.

Local builds default to ad-hoc signing for development. To produce a public download:

```bash
CODESIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
NOTARY_PROFILE='your-existing-keychain-profile' \
REQUIRE_NOTARIZATION=1 mac/Scripts/package-app.sh v0.2.55
```

The release mode signs the runtime and app with hardened runtime, submits both app and DMG to Apple, staples their tickets, and verifies the app's Gatekeeper assessment. An unsigned or unnotarized package is a review build, not a public launch artifact. See [Apple's notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

Tagged GitHub releases require these repository secrets: `WATCHER_CERTIFICATE_BASE64` (Developer ID `.p12`), `WATCHER_CERTIFICATE_PASSWORD`, `WATCHER_CODESIGN_IDENTITY`, `WATCHER_APPLE_ID`, `WATCHER_APPLE_APP_PASSWORD`, and `WATCHER_APPLE_TEAM_ID`. The workflow fails before publishing when configuration is missing. Manual workflow runs produce development artifacts. Local signing remains supported without putting private signing material in GitHub.

## Owl artwork and review

The chosen logo is **01A · Folded wings**: tucked feathers, a slim beak and the original eyes. `assets/owls/selection.json` selects it for the native header, menu bar, loading owl, Finder icon and README banner. Open `docs/launch-preview/index.html` for the selected logo and the remaining wing/beak and eye studies. The first comparison remains at `original-studies.html`. All fonts and brand colors are preserved.

Vector geometry lives in `assets/owls/marks.json`, `wing-studies.json` and `eye-studies.json`; the selected variation is compiled into the native renderer. Regenerate all assets with `mac/Scripts/build-owl-icons.sh` (requires librsvg and macOS tools). Wing details drop out below 24 points for legibility. Native developer previews accept `EXE_WATCHER_OWL_STYLE=classic`, `refined`, `rounded`, `focus`, or `refined_tucked`; the default and packaged Finder icon are 01A. The macOS menu-bar owl uses the same Exe Gold (#F5D76E) as the header, including on light and dark menu bars.

## Design tokens

Exe Foundry Bold palette (gold accent on dark purple):

- Brand accent (gold): `#F5D76E`
- Brand accent hover: `#FADF85`
- Aura purple (depth/glow): `#6B4C9A`
- Dark purple (text on gold): `#3A285C`
- Pressed gold: `#E6C54F`
- Surface (light): `#FAF8F3`
- Surface (dark): `#1A1528`

SF Mono for currency values; SF Pro for UI text. Web equivalents: Epilogue (headings), Manrope (body).

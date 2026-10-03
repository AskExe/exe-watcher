# Watcher Menubar (macOS)

Native Swift + SwiftUI menubar app. The Watcher menubar surface.

## Requirements

- macOS 14+ (Sonoma)
- Swift 6.0+ toolchain (bundled with Xcode 16 or standalone)
- `exe-watcher` CLI installed globally (`npm install -g exe-watcher`) or available at a path you pass via `EXE_WATCHER_BIN`

## Install (end users)

One command:

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

The app's Update button downloads the latest macOS app. It does not update the globally installed npm CLI. Releases include a universal Apple Silicon and Intel app for macOS 14+.

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

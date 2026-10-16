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

From 0.2.56, each daily refresh also updates every period whose history is fully cached. Closed days are reused and today's bucket is replaced with fresh usage, so switching periods needs no separate scan. These summaries survive same-day restarts. Historical validation still runs when needed to catch late usage; a large repricing job saves completed provider scans and resumes after a timeout.

From 0.2.57, Watcher also reads native Kimi Code `sessions/**/wire.jsonl` files under `~/.kimi-code` (or `KIMI_CODE_HOME`), including subagents. GLM and Kimi models used through Claude/OpenCode remain attributed to those clients. Recorded token usage is counted even when a model alias has no verified API rate; its cost is excluded with a warning.

From 0.2.59, historical token recovery marks missing call counts explicitly: `—` means unavailable and `18+` means at least 18 calls are recorded. Costs recovered from cumulative token counters no longer appear to have an exact zero or partial call count. The aggregate call count uses the same notation; counts backed by request logs remain unchanged.

## Floating display

Open the menu bar app, choose **Display settings** (the sliders button in the footer), then enable **Floating quota display**. It starts off. Drag the bottom handle to move it; it snaps to any screen edge or stays floating. Position, display, quota window and time period survive relaunches. Hover for details, click the quota ring to pin them, or use the close button to hide the display. Outside clicks dismiss the detail card; Escape does too when macOS already permits the key event.

The rail shows one ring per selected provider. **Claude and Codex** appear by default; use the floating display’s sliders menu to add **Kimi, Cursor, GitHub Copilot or Gemini**, hide a provider, or show all six. Click a ring or a provider tab to open its own usage card. The rail wraps into two columns at a side edge and scrolls when space is constrained. Provider selection and visibility survive relaunches. Each ring uses the selected five-hour/weekly window when the provider reports it, otherwise its first available window (for example, monthly or per-model). The time rows cover **all agents**, independent of the main popover's provider/period filters:

- **You + AI ≈**: your estimated interaction time, inferred from short reply-to-next-prompt gaps. Overlapping interaction intervals count once. It does not measure attention.
- **AI Time**: recorded runtime added across agents, so simultaneous runs accumulate agent-hours. Inferred durations get an approximation mark.

Time defaults to **Today**; choose **Week** (last seven days), **Month** (calendar month), or **All Time** (retained timing history). Unavailable values show a dash and incomplete coverage is labeled in details.

Claude quota requests are shared with Plan. Each additional provider has an independent request, connection state and cooldown: passive reads at most every five minutes after success or fifteen after failure, with at least a fifteen-minute 429 cooldown (longer provider Retry-After delays are honored). Passive refreshes never open Keychain prompts or rotate credentials. Use Refresh for an explicit connection attempt. This adds no periodic usage-log scan; timing reuses existing snapshots and the bounded timing-only recovery worker. OS threshold notifications remain future work.

Supported live readers:

| Provider | Existing local sign-in | Reported capacity |
| --- | --- | --- |
| Claude | Claude Code credentials or permitted Keychain access | Five-hour, weekly and model windows |
| Codex | ChatGPT credentials in `CODEX_HOME/auth.json` or the `Codex Auth` Keychain item, following the root `cli_auth_credentials_store` setting | Provider-reported windows, additional model limits and monthly credit allowance when present |
| Kimi | Kimi Code credentials under `KIMI_CODE_HOME` | Weekly and rate-limit windows |
| Cursor | One read-only lookup in the Cursor app’s local state database | Monthly, Auto/API and other reported pools |
| GitHub Copilot | Editor-plugin `hosts.json` / `apps.json` under the XDG config directory | Premium allowance and Chat, when metered; unlimited is labeled explicitly |
| Gemini | Gemini CLI’s `~/.gemini/oauth_creds.json` | Per-model remaining-quota buckets for eligible accounts |

The five new adapters never refresh or write OAuth tokens, copy credentials to Watcher storage, read browser cookies or change a provider’s login. Codex can request Keychain access only on an explicit refresh. Expired sessions need the provider’s own client to renew them. API-key Codex accounts, custom Codex gateways, encrypted/ephemeral stores and ineligible Gemini tiers can have no readable subscription quota. Missing or unlimited percentages remain dashes, not zero.

Copilot credentials stay bound to their GitHub.com or Enterprise Cloud (`*.ghe.com`) host; unsupported or unidentified hosts fail without a request to GitHub.com. New adapters reject HTTP redirects, use ephemeral sessions without cookie/cache persistence, cap response/credential sizes and suppress response bodies in errors. Endpoints are informed by CodeBurn’s adapters and may change; an unrecognized response is unavailable. Quota support does not add a local spend/time importer for a previously unsupported client.

For a credential-free visual review, launch a developer build with `--floating-quota-preview`. Add `--quota-providers=all` for all six rings, `--quota-provider=codex` to select one, `--quota-preview-card` to review only its expanded card, or `--quota-state=stale|disconnected|loading|expired` for failure states. This uses isolated preferences and sample quota/time data, bypassing normal usage, login-item and updater startup.

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

This builds a universal app, updater ZIP, drag-to-install DMG and `SHA256SUMS.txt` in `mac/.build/dist`. It freezes the CLI's production dependencies and a checksum-pinned universal Node 22.23.3 runtime. Only explicit build outputs/manifests are copied; local credentials and configuration are excluded. Watcher's `LICENSE` and `THIRD_PARTY_NOTICES.md`, including CodeBurn's original MIT notice, ship at `Contents/Resources/cli/`. The original Node license and dependency licenses also ship with the app.

Local builds default to ad-hoc signing for development. To produce a public download:

```bash
CODESIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
NOTARY_PROFILE='your-existing-keychain-profile' \
REQUIRE_NOTARIZATION=1 mac/Scripts/package-app.sh v0.2.55
```

The release mode signs the runtime and app with hardened runtime, submits both app and DMG to Apple, staples their tickets, and verifies the app's Gatekeeper assessment. An unsigned or unnotarized package is a review build, not a public launch artifact. See [Apple's notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

Releases are built and signed locally. The hosted `Release macOS Menubar` workflow is disabled: it has no signing secrets and only failed on each tag. To ship a version:

1. Bump `package.json`, `package-lock.json` and `CHANGELOG.md`, open the PR, and merge it once CI passes.
2. Package with the release command above. `BUILD-INFO.txt` must name a commit whose tree equals the merge commit (`git rev-parse <sha>^{tree}`), with zero modified files.
3. Publish the release at the merge commit, attaching all four files from `mac/.build/dist`: `gh release create mac-vX.Y.Z --target <merge sha> --latest <dmg> <zip> SHA256SUMS.txt BUILD-INFO.txt`. The in-app updater reads the latest release, so this is what customers receive.
4. Update the download on odd.community (`OddCommunity/odd-website`): the `/watcher/download` redirect in `vercel.json`, the version line and release-notes link in `public/watcher/index.html`, and the README note. Merge that PR, then deploy it. Merging does not publish the site: run `vercel deploy --prod` from a clean checkout of the merged commit.
5. Verify as a customer: `curl -I https://odd.community/watcher/download` redirects to the new DMG, the downloaded DMG matches `SHA256SUMS.txt`, and `spctl` accepts it as Notarized Developer ID.

## Owl artwork and review

The chosen logo is **01A · Folded wings**: tucked feathers, a slim beak and the approved contrasting pupil details. `assets/owls/selection.json` selects it for the native header, menu bar, loading owl, Finder icon and README banner. Open `docs/launch-preview/index.html` for the selected logo and the remaining wing/beak and eye studies. The first comparison remains at `original-studies.html`. All fonts and brand colors are preserved.

Vector geometry lives in `assets/owls/marks.json`, `wing-studies.json` and `eye-studies.json`; the selected variation is compiled into the native renderer. Regenerate all assets with `mac/Scripts/build-owl-icons.sh` (requires librsvg and macOS tools). Wing details drop out below 24 points for legibility. Native developer previews accept `EXE_WATCHER_OWL_STYLE=classic`, `refined`, `rounded`, `focus`, or `refined_tucked`; the default and packaged Finder icon are 01A. The selected mark uses larger white pupil details on black owls and centered dark details on yellow owls; their geometry and colors live in `selection.json`. The same details follow animated eye movement and blinks. The macOS menu-bar owl uses the same Exe Gold (#F5D76E) as the header, including on light and dark menu bars.

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

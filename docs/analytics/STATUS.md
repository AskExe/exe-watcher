# Watcher analytics handoff — 2026-10-23

Implemented locally on existing branch `feat/personal-ai-time`, base `f661476`.
No commit, push, npm publication or public Mac release. The installed Watcher
0.2.70 remains untouched. A separate ad-hoc-signed 0.2.67 app was built/tested at
`mac/.build/Watcher Analytics.app`, then stopped to avoid competing refreshes.
The previously approved usage/error choices remain enabled on this Mac. Basic
usage now defaults on for new installs after disclosure; detailed diagnostics
default off. Existing explicit opt-outs remain off. Token usage figures are unavailable.

## Delivered and verified

- CLI uses the shared `@odd-core/analytics/privacy` implementation through a
  reproducible `file:` package snapshot. Atomic 0600 storage, one non-waiting
  process owner, independent consent, bounded retries and revocation epochs.
- Swift adapter uses the same restricted wire format, private bounded queues,
  stable retry UUIDs, independent native disclosures and real foreground time.
  Finder/LaunchServices reopening reveals the menu for menu-only app access.
- Self-hosted PostHog Watcher project **3**, dashboard **4**:
  https://build-my.tail910c31.ts.net/project/3/dashboard/4
- Sentry `odd-community`: Watcher CLI project **3**, retained issue **6**;
  Watcher macOS project **4**, retained issue **7**:
  https://build-my.tail910c31.ts.net:8443/organizations/odd-community/issues/?project=3&project=4
- `data.odd.community` resolves to 72.60.192.211 → existing pinned Caddy →
  loopback 18081 → existing gateway image and mounted maps. Only gateway source
  and Watcher mappings changed. Existing mappings were compared and preserved.
  Source equals the shared package gateway. Public read routes remain 404.
- Real foreground CLI status/menu navigation reached Watcher’s project with one
  shared pseudonymous installation, active minutes and allowlisted features.
  Recording minutes are N/A. Both consent checkmarks were visually verified;
  harmless handled native/CLI errors reached Sentry without messages/paths/user IDs.
- Public duplicate counter/error canaries deduplicated; exact disposable events
  and error issue were removed. Real dogfood reports remain for inspection.
- Final checks: **789 Node tests, 205 Swift tests, 5 gateway tests, 3 release-helper
  tests**, TypeScript typecheck, build, shell syntax, package inventory and shared
  artifact provenance. See `verification.json` for compact receipts and limits.

## Ownership and next action

Watcher source, adapter tests, the vendored snapshot and these operator helpers
are in this checkout. Shared kit authority is
`/Users/exeai/odd-core-kits/packages/analytics`; snapshot hashes and source revision
are in `vendor/odd-core-analytics/PROVENANCE.json`. The snapshot now pins published upstream source commit
`6ae44a117e23a4332ab13209b840a912d132e7a4`, package version **0.1.0**.
It is rebuilt from committed sources without modifying the shared checkout.
No registry publication is assumed. Refresh using the documented script.

Server-private project maps/keys stay in `/opt/odd-analytics` and `/opt/odd-sentry`.
Backups `gateway.before-watcher.mjs`, `gateway.before-shared-watcher.mjs`, and
`*.json.before-watcher` preserve pre-change server state. The gateway is now the
shared kit version, so future deployments must compare its current hash first.
Sentry Compose requires `.env.custom`; native private files require uid 999.

Ready for code review/integration into the desired newer release branch. Do not
replace the newer installed app with this older checkout as a release. Full
native crash capture is intentionally excluded. Real self-hosted app verification
and focused native UI checks passed; a full universal signed release build and
public distribution have not been requested or performed.

## Shared source pin follow-up

Pinned the committed 0.1.0 source above. The gateway artifact is byte-identical
to the previously qualified deployment; no server change or restart was made.
The settings button now uses `gearshape` with “Settings” accessibility text;
its Swift build passed. Installed app remains unchanged.

## Basic-default policy — user approved

The user approved default-on basic usage with clear first-run disclosure and
easy opt-out. CLI and Swift adapters implement that product policy while the
shared PrivacyClient stays pinned and default-off internally. Saved false values,
legacy global opt-outs and privacy environment overrides take precedence. Native
onboarding can save an opt-out before collecting; the CLI prints its notice on
stderr before interactive collection. Error diagnostics remain independent and
off for new installs. Ember’s Analytics chat received the same approved policy.
Version/OS cohorts and broader performance buckets remain a shared-schema gap;
no unsupported fields or server changes were introduced. No release authorized.

Policy-change checks passed: 790 Node tests, 208 Swift tests, TypeScript typecheck,
CLI build and three release-helper tests. Isolated native UI confirmed the basic
checkbox starts checked and can be unchecked before collection; the saved choice
was false, diagnostics remained off, and no identity or telemetry queue existed.
The isolated test process was stopped. Receipt: `basic-default-verification.json`.
The CLI first-notice receipt uses its own private marker, so displaying a notice
cannot overwrite concurrent user settings. Installed app remains untouched.

Ember Analytics independently confirmed the same local default policy: 84 Swift
cases executed (one skipped, zero failures), four gateway checks passed. Its
installed/running builds are unchanged. No cross-app release was performed.

## Shared 0.2.0 metric follow-up

Updated the local shared snapshot to **0.2.0**, pinned source
`3fb6fb095a1f9b1b8601965df58f08521fc38f7f`. The gateway-owning task deployed
the extension separately; Watcher compared its live hash and used it without
changing gateway source, runtime or project maps. Default-on basic usage and
existing opt-outs remain as explicitly approved by the human. Diagnostics stays
independently off by default. Earlier generic agent instructions do not reset it.

CLI and native events now carry validated numeric version/coarse platform, plus
fixed command or foreground refresh success/failure outcomes. No raw error data
is included. A real foreground CLI status completed through the shared client.
The public four-event canary retained version/platform/outcome and deduplicated
the repeated batch; exact disposable events were removed. Watcher dashboard
provisioning adds outcome and version/platform views. OS-major and latency data
remain uncollected. Ember Analytics received the compatible pin/API update.

Checks: **791 Node tests, 209 Swift tests, six gateway tests, three release-helper
tests**, build/typecheck and diff checks passed. No public release, installed-app
replacement or gateway restart by Watcher. Token usage remains unavailable.

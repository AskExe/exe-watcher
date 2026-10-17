# Watcher floating display and 0.2.66 release handoff

Owned worktree: `/Users/exeai/.codex/worktrees/watcher-floating-quota/exe-watcher`, branch `codex/watcher-floating-quota`. Trusted main `29063c1` is integrated through `fa70f05`. Previous installed measured source `38991b5`, app version 0.2.65; receipt `/Users/exeai/.local/share/exe-watcher/backups/2026-10-17-before-floating-polish/install-receipt.json`. Prior implementation details and UI evidence are in this document's Git history at `c4f24e5`.

## Delivered behavior

Optional native floating display: Claude, Codex, Kimi, Cursor, GitHub Copilot and Gemini. Claude/Codex default to Weekly; shared Weekly/5h toggle; capacity is labeled “left.” Provider visibility, horizon, position and time period persist. Today defaults; Week, Month and All Time are independent of the quota horizon. You + AI estimates interaction time; AI Time sums work across agents, including parallel work. Cards use real recorded timing and disclose partial history. Unknown timing rows are hidden. Focus rings are suppressed. Claude login uses the current Keychain credentials. Compact metric buttons, number/unit hierarchy and cap-height-aligned animated owl were verified in native previews and the installed app.

All Time diagnosis: the CLI and native decoder returned real totals, but timing was memory-only and Today financial cache could prevent prewarming All Time. 0.2.66 now saves bounded, symlink-safe independent timing snapshots, restores same-day periods, retains only All Time across day rollover, and refreshes all-provider timing without altering financial freshness. Loading shows an ellipsis; offline refresh keeps recorded totals. Private aggregate diagnostics remain under `/tmp/watcher-all-time-*`, not in Git. Live All Time was approximately 91h interaction /2312h AI; estimates change as history is indexed.

README, MIT notices and original CodeBurn import evidence are included. Upstream review: `docs/codeburn-upstream-review.md`. Full CodeBurn notice ships in both app and npm package. Owl animation uses existing native `AnimatedOwl`/`OwlPresence`; reduced-motion and lifecycle behavior remain intact.

## Release work

0.2.66 pairs npm publication with a signed/notarized Mac release through `mac/Scripts/publish-release.mjs`. It requires clean actual merged main and successful CI; checks source-tree provenance, Gatekeeper, staples and uploaded digests. Existing matching releases are reused, drafts stop for inspection. The disabled hosted native-release workflow stays disabled. Signing identity is the existing Henry Love Developer ID; notarization profile `hansel-notarize`. Keep npm credentials in Keychain/environment only.

Website worktree: `/Users/exeai/.codex/worktrees/odd-watcher-release/odd-website`, branch `codex/watcher-release-0-2-66`, based on `dd711ba`. The dynamic `/watcher/release` and `/watcher/download` resolver accepts complete stable repository-owned Mac assets; the product page follows its version. Original website checkout has unrelated untracked `exe/`; preserve it. Vercel project `odd-website`, id `prj_IS5YvPt8ZluVIHvUQLTathwg3cEl`.

## Checks and next action

Passed: 768 CLI tests/63 files, 186 native tests/29 suites, TypeScript check/build, two paired-release tests, eight website/download tests, website production build and whitespace checks. Logs: `/tmp/watcher-066-cli-tests.log`, `/tmp/watcher-066-native-tests.log`, `/tmp/odd-watcher-066-tests.log`, `/tmp/odd-watcher-066-build.log`. The actual bounded native DataClient-to-installed-CLI timing diagnostic passed. Detached updater parent watcher checks direct parent identity, so its zsh-launched installer is unaffected. Changed-code review covered timing persistence, release provenance and website URL boundaries. Token usage unavailable.

Next: commit, PR/CI/merge both repositories; build the notarized candidate once and compare its source tree to merged main; install transactionally with backup and verify real All Time across relaunch. Publish latest GitHub Mac release and npm 0.2.66, deploy merged website main, verify public download checksum, customer installer, app signature and website version. Record final merge revisions and release/install receipts. Public release and new installation are still pending at this checkpoint.

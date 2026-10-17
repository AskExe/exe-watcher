# Floating display implementation

Branch: `codex/watcher-floating-quota`. Worktree: `/Users/exeai/.codex/worktrees/watcher-floating-quota/exe-watcher`. Installed measured source: **`38991b5`**, version **0.2.65**. Trusted main **`29063c1`** is integrated through `fa70f05`. Weekly/toggle base: `62c4209`; “left”/“Weekly” wording: `2b75ff0`. Primary and attribution worktrees remain unchanged.

Complete locally, unreleased: an optional native floating rail with **Claude, Codex, Kimi, Cursor, GitHub Copilot and Gemini** quota readers. Claude/Codex appear initially; the sliders menu adds/hides providers or shows all six. Rings, bars, cards and tooltips say **“left”** and show remaining capacity. **Weekly** defaults for both Claude/Codex; the inline **Weekly / 5h** control switches all rings and persists. Missing selected Claude/Codex windows show dashes; other providers retain their reported period. Cards list available windows, with scrolling and reset-to-top on provider changes. Visibility, active provider, position, display, quota horizon and time period persist.

**You + AI ≈** estimates human interaction; **AI Time** adds runtime across agents, including parallel work. Today defaults, with Week/Month/All Time choices. Totals cover retained local timing independently of quota selection. Quota adapters add no local timing importer. Unknown time stays a dash; partial history is labeled. Artwork uses main’s contrast-pupil selection; the README owl animation remains; see [animation handoff](../videos/watcher-owl-motion/HANDOFF.md).

Latest polish: **38-point rings**, larger monospaced percentage digits with smaller percent signs, and larger time digits with smaller h/m units. Both floating headers reuse `AnimatedOwl`/`OwlPresence`, including reduced-motion support and existing pause/detach cleanup. The rail aligns the wordmark by its visible capital-letter height. No timing or quota calculation changed.

Size stays **152 × 174 points** for two providers at a side edge and **280 × 104** at top/bottom. Six providers fit horizontally or in two columns vertically. Time buttons sit below the time-period pill and quota toggle. Clicking one pins its explanation; clicking the selected metric in the card collapses that explanation. Provider rings restore quota details. Selection clears on dismissal.

Enable through **Display settings → Floating quota display** in the main popover footer. It starts disabled. Hover for details, click to pin, close to hide, or drag the bottom grip. Panels cannot become key/main, stay below system notifications and join Spaces/full-screen.

Quota architecture:

- Window `percent` remains provider-reported used internally; presentation computes its complement. Claude shares Plan’s reader. Other providers coalesce independently: five-minute success and fifteen-minute failure cooldowns, honoring longer 429 Retry-After delays.
- New adapters use existing sign-ins without credential writes/rotation or browser-cookie access. Codex honors `cli_auth_credentials_store`. Passive Keychain reads cannot prompt or fall back after denial; provider clients renew expired sessions.
- Copilot tokens remain bound to their GitHub host. HTTP rejects redirects, limits responses to 512 KiB, uses 20/25-second timeouts, avoids persistent cookies/cache and raw error output. Credential reads are bounded and reject final symlinks; Cursor SQLite is bounded/read-only with parent aliases resolved.
- Opaque identities stay memory-only. Invalid/changed credentials clear old readings; transient failures retain only the same account. Unlimited/unknown percentages stay explicit.
- Financial scans and bounded timing recovery are unchanged. OS threshold notifications, a quota CLI and multi-provider Plan UI remain future work.

Attribution: credential/schema adapters adapt [CodeBurn 9a40cc6](https://github.com/getagentseal/codeburn/tree/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/src/quota), credited in source and the full MIT notice in `THIRD_PARTY_NOTICES.md`. No upstream vectors or OAuth write-back were imported. Codex storage follows [official authentication documentation](https://learn.chatgpt.com/docs/auth#credential-storage).

Validation, October 17, 2026:

- **88 tests in 11 suites pass**, including floating/provider/credential behavior, owl choreography, reduced motion and animation lifecycle (`/tmp/watcher-floating-polish-tests.log`). Earlier full-suite and integration evidence remains in previous handoff revisions.
- Native UI: two-provider side rail, six-provider horizontal rail, detail card and preview All Time; installed live Today shows Claude 19% left, Codex 20% left, 6m interaction and 11h 27m AI time. Owl/wordmark alignment and unit hierarchy verified. Live All Time showed dashes during this check, so long-history sizing remains unverified for this typography revision; restored Today. Physical multi-display/Spaces switching remains untested.
- Changed-code and final integration review completed. Universal package, strict deep signature, CLI/notices preservation and whitespace checks pass (`/tmp/watcher-floating-polish-build.log`). Session token usage unavailable.

Installed at `/Users/exeai/Applications/Watcher by EXE.app`, Developer ID signed locally without notarization/public release. Current artifact matches the package. Latest previous app, preferences and receipt: `/Users/exeai/.local/share/exe-watcher/backups/2026-10-17-before-floating-polish/`. Original release backup remains in neighboring `2026-10-16-before-floating-d7c57ae/`.

CLI JS still matches main `29063c1`, preserving optimizer copy-all/export; see `/Users/exeai/.cache/exe-watcher/optimizer-share-20261016/handoff.md`. Use the latest signed-install receipt rather than older native hashes.

Preview bundle: `mac/.build/Watcher Floating Preview.app`, with `--floating-quota-preview`; optional `--quota-providers=all`, `--quota-provider=codex`, `--quota-preview-card`, `--quota-state=stale|disconnected|loading|expired`, or `--ai-time-preview`. It never reads credentials, scans usage or starts the updater. Last preview preferences: six providers, top edge, All Time. Preview stopped after install.

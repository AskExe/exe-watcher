# Floating display implementation

Branch: `codex/watcher-floating-quota`. Worktree: `/Users/exeai/.codex/worktrees/watcher-floating-quota/exe-watcher`. Installed source: **`2b75ff0`**, version **0.2.65** (quota “left”; both labels “Weekly”). Compact UI: `43335be`; accepted main **`29063c1`** is integrated in `fa70f05`. Functional weekly/toggle base: `62c4209`. Primary and attribution worktrees remain unchanged.

Complete locally, unreleased: an optional native floating rail with **Claude, Codex, Kimi, Cursor, GitHub Copilot and Gemini** quota readers. Claude and Codex are shown by default; the widget’s sliders menu adds/hides providers or shows all six. Rings, bars, cards and tooltips say **“left”** and show remaining capacity. **Weekly** defaults for both Claude/Codex; the inline **Weekly / 5h** toggle switches all rings and persists. A missing selected Claude/Codex window shows a dash; other providers retain their reported periods. Click a ring or provider button for its card. Six rings fit horizontally at top/bottom edges and in a two-column grid at side edges. Extra quota windows scroll and reset to the top when switching providers. Saved visibility, active provider, position, display, quota horizon and time period survive relaunches.

**You + AI ≈** estimates human interaction; **AI Time** adds runtime across agents, including parallel work. Today is the initial period, with Week/Month/All Time choices. Totals cover retained local timing independently of quota selection; quota adapters add no local timing importer. Unknown time remains a dash and partial history is labeled. Artwork uses main’s contrast-pupil selection; the README owl animation is retained; see [animation handoff](../videos/watcher-owl-motion/HANDOFF.md).

The compact two-provider side rail is **152 × 174 points**, about **37% less area**. Top/bottom is **280 × 104**. Time buttons sit beneath the time-period pill and quota toggle. Selecting one pins its explanation; the detailed card has the same buttons, and selecting its active metric collapses the explanation. Provider rings restore quota details. Selection clears on dismissal; period/placement persistence is unchanged.

Enable through the main popover footer’s **Display settings → Floating quota display**. It starts disabled. Hover for details, click to pin, close to hide, or drag the visible bottom grip. Panels cannot become key/main, stay below system notifications and join Spaces/full-screen.

Quota architecture:

- Window `percent` remains provider-reported **used** internally; presentation computes its complement. Claude shares Plan's reader/request. Other providers coalesce independently: five-minute success and fifteen-minute failure cooldowns, respecting longer 429 Retry-After.
- New adapters use existing sign-ins without credential writes/rotation or browser-cookie reads. Codex honors `cli_auth_credentials_store`. Passive Keychain reads cannot prompt or fall back after access denial; provider clients renew expired sessions.
- Copilot tokens stay bound to their GitHub host. HTTP rejects redirects, caps responses at 512 KiB, uses 20/25-second limits, and avoids persistent cookies/cache and raw error output. Credential reads are bounded and reject final symlinks; Cursor SQLite is bounded/read-only with parent aliases resolved.
- Identities are opaque, memory-only hashes. Invalid/changed credentials clear older readings; transient failures retain only the same account. Unlimited/unknown percentages remain explicit.
- Financial scans and bounded timing recovery are unchanged. OS threshold notifications, a quota CLI and multi-provider Plan UI remain future work.

Attribution: native credential/schema adapters adapt [CodeBurn 9a40cc6](https://github.com/getagentseal/codeburn/tree/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/src/quota), credited in source and `THIRD_PARTY_NOTICES.md` with the full original MIT notice. No upstream vectors or OAuth rotation/write-back were imported. Codex storage was checked against [official OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth#credential-storage) and its public storage interface.

Validation, October 16–17, 2026:

- **41 tests in 7 suites passed on `62c4209`** for remaining capacity, exact window selection and persisted defaults (`/tmp/watcher-weekly-remaining-tests.log`); earlier 43/8 cover timing (`/tmp/watcher-compact-integrated-tests.log`). Earlier full native validation: 176 passed on `5ac7441`; reconnect run passed 180/181, with the timing-sensitive priority assertion passing alone (`/tmp/watcher-claude-connect-priority-recheck.log`).
- Latest copy-only update: universal signed package passes (`/tmp/watcher-quota-left-weekly-build.log`); installed screenshot/AX confirms “left” and matching “Weekly” labels. Earlier weekly/5-hour switching, persistence, cards, side/top rails and All Time fit pass. Live installed readings and missing Codex 5-hour handling pass; restored Weekly/Today. Earlier six-provider, scrolling, time-explanation and focus checks remain applicable. Physical multi-display/Spaces switching has not been exercised.
- Changed-code review covers credential/HTTP boundaries, provider state ownership and cancellation, stale identity handling, prefs/layout and notices. Final integration review covers the complete diff; documentation local links and whitespace checks pass.

HTTP/account tests use fixtures; the installed app was verified with live Claude/Codex data. Session token counts unavailable.

Installed at `/Users/exeai/Applications/Watcher by EXE.app`. Native executable matches the packaged build; app/CLI versions are 0.2.65; strict deep signature validation passes. Developer ID signed locally, without notarization or public release. Original release backup: `/Users/exeai/.local/share/exe-watcher/backups/2026-10-16-before-floating-d7c57ae/`. Latest prior app/preferences and signed-install receipt: neighboring `2026-10-17-before-quota-left/` (CLI/notices matched the prior accepted receipt before replacement).

Claude reconnect opens official `claude auth login --claudeai` in Terminal. Keychain precedes obsolete files; denied/malformed items never select another account. Passive reads stay silent; explicit Refresh can request access immediately. Unknown provider timing rows remain hidden. Latest installed trial: Claude **19% left**, Codex **24% left**, both labeled **Weekly**. The earlier five-hour trial showed Claude 96% left and Codex unavailable. Enabled, Weekly/Today; copy-only installation preserves preferences. Earlier All Time **2320h 41m** fits.

CLI source and bundled JS match accepted main `29063c1`, preserving optimizer `c` copy-all and `e` Markdown export. Existing CI/PTY receipts: `/Users/exeai/.cache/exe-watcher/optimizer-share-20261016/handoff.md`. Re-signing changes raw native hashes; use the latest installed receipt for future guards.

Preview with `--floating-quota-preview`, optionally `--quota-providers=all`, `--quota-provider=codex`, `--quota-preview-card` or `--quota-state=stale|disconnected|loading|expired`. Add `--ai-time-preview` for the isolated timing panel: mouse/Tab checks show only its three timed providers and no blue focus rectangle. Sample-only bundle: `mac/.build/Watcher Floating Preview.app`.

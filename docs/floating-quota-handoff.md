# Floating display implementation

Branch: `codex/watcher-floating-quota`. Worktree: `/Users/exeai/.codex/worktrees/watcher-floating-quota/exe-watcher`. Installed source: **`2138a42`**, version **0.2.65**. Compact UI: `43335be`; accepted main **`29063c1`** is integrated in `fa70f05`. Earlier implementations: multi-provider `8657056`, focus `004421e`, Claude reconnect/unknown-row filtering `f28a7e9`, isolated timing preview `074f5ac`. Primary and attribution worktrees remain unchanged.

Complete locally, unreleased: an optional native floating rail with **Claude, Codex, Kimi, Cursor, GitHub Copilot and Gemini** quota readers. Claude and Codex are shown by default; the widget’s sliders menu adds/hides providers or shows all six. Click a ring or a provider button for its own card. Six rings fit horizontally at top/bottom edges and in a two-column grid at side edges. Extra quota windows scroll and reset to the top when switching providers. Saved visibility, active provider, position, display, quota horizon and time period survive relaunches.

**You + AI ≈** estimates human interaction; **AI Time** adds runtime across agents, including parallel work. Today is the initial period, with Week/Month/All Time choices. These totals cover retained timing from Watcher’s supported clients independently of quota selection; a new quota adapter does not add a local spend/time importer. Unknown time remains a dash and partial history is labeled. Native artwork and app icons use accepted main’s contrast-pupil selection; the README owl animation is retained from the first implementation; see [animation handoff](../videos/watcher-owl-motion/HANDOFF.md).

The compact two-provider side rail is **152 × 174 points**, about **37% less area**. Top/bottom is **280 × 104**. Both time totals are buttons beneath the period pill. Selecting one pins its explanation; the detailed card has the same buttons, and selecting its active metric collapses the explanation. Provider rings restore quota details. Selection clears on dismissal; period/placement persistence is unchanged.

Enable through the main popover footer’s **Display settings → Floating quota display**. It starts disabled. Hover for details, click to pin, close to hide, or drag the visible bottom grip. Panels cannot become key/main, stay below system notifications and join Spaces/full-screen.

Quota architecture:

- Claude reuses its existing Plan reader and request. Each other provider has independent coalescing, state and cooldown: five minutes after success, fifteen after failure, with longer Retry-After honored for 429s.
- The five new adapters use only existing local sign-ins, never rotate/write/copy OAuth credentials or read browser cookies. Codex follows root `cli_auth_credentials_store` for its auth file or `Codex Auth` Keychain item. Passive Keychain reads cannot prompt; unreadable Keychain items do not fall back to an older file account. Expired sessions require the provider’s own client to renew them.
- Copilot tokens remain bound to their GitHub.com or Enterprise Cloud host. New HTTP readers reject redirects, have 20/25-second request/resource limits, cap responses at 512 KiB, avoid cookie/cache persistence and suppress raw errors/bodies. Credential files are bounded regular-file reads with final symlinks refused. Cursor uses a bounded, read-only SQLite lookup after resolving parent aliases.
- Account identities are opaque hashes held only in memory. Unusable credentials and changed/unreadable identities clear older readings. Transient failures preserve readings only for the same known identity. Unlimited/no-percentage allowances remain explicit, never invented zeroes.
- Existing event-driven financial scans and bounded timing recovery are unchanged. OS threshold notifications, additional adapters, a quota CLI and multi-provider main Plan UI remain future work.

Attribution: native credential/schema adapters adapt [CodeBurn 9a40cc6](https://github.com/getagentseal/codeburn/tree/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/src/quota), credited in source and `THIRD_PARTY_NOTICES.md` with the full original MIT notice. No upstream vectors or OAuth rotation/write-back were imported. Codex storage was checked against [official OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth#credential-storage) and its public storage interface.

Validation, October 16, 2026:

- Latest **43 tests in 8 suites pass after main integration**, covering floating geometry/state, providers, Claude credential isolation and timing (`/tmp/watcher-compact-integrated-tests.log`). Earlier full native validation: 176 passed on `5ac7441`; reconnect run passed 180/181, with the timing-sensitive priority assertion passing alone (`/tmp/watcher-claude-connect-priority-recheck.log`).
- Native UI: compact two/six-provider rails at side/top edges, both metric explanations and selected states, daily/all-time switching, long totals, no blue focus rectangle. Earlier provider cards, scrolling/reset, visibility and persisted state remain applicable. Physical multi-display/Spaces switching has not been exercised.
- Changed-code review covers credential/HTTP boundaries, provider state ownership and cancellation, stale identity handling, prefs/layout and notices. Final integration review covers the complete diff; documentation local links and whitespace checks pass.

HTTP/account tests use fixtures; the installed app was verified with live Claude/Codex data. Session token counts unavailable.

Installed at `/Users/exeai/Applications/Watcher by EXE.app`. Native executable matches the packaged build; app/CLI versions are 0.2.65; strict deep signature validation passes. Developer ID signed locally, without notarization or public release. Original release backup: `/Users/exeai/.local/share/exe-watcher/backups/2026-10-16-before-floating-d7c57ae/`. Latest previous app/preferences and installed build metadata: neighboring `2026-10-16-before-compact-time/`.

Claude reconnect opens official `claude auth login --claudeai` in Terminal. Keychain precedes obsolete files; denied/malformed items never select another account. Passive reads stay silent; explicit Refresh can request access immediately. Unknown provider timing rows remain hidden. Live trial: Claude 2%, Codex 57%; All Time **2320h 41m** fits its button. Restored Today afterward.

CLI source and bundled JS match accepted main `29063c1`, preserving optimizer `c` copy-all and `e` Markdown export. Existing CI/PTY receipts: `/Users/exeai/.cache/exe-watcher/optimizer-share-20261016/handoff.md`. Its re-signing changed the raw native hash; the latest installed receipt validated native/CLI/notices before replacement. Use current signing receipts rather than an older raw executable hash for future guards.

Preview with `--floating-quota-preview`, optionally `--quota-providers=all`, `--quota-provider=codex`, `--quota-preview-card` or `--quota-state=stale|disconnected|loading|expired`. Add `--ai-time-preview` for an isolated native timing panel with the screenshot's three timed and six untimed providers. Expanded mouse/Tab checks confirm only Claude/Codex/Kimi and no blue focus rectangle. The timing view and focus modifier match installed `f28a7e9` exactly; its installed executable matches the signed package. The isolated sample-only bundle is `mac/.build/Watcher Floating Preview.app`.

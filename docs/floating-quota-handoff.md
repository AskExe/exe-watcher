# Floating display implementation

Branch: `codex/watcher-floating-quota`. Worktree: `/Users/exeai/.codex/worktrees/watcher-floating-quota/exe-watcher`. Original base: `1d310d1`, including accepted main `d5789f6`. Initial floating display/branding: `21036f7`; AI-time focus styling: `004421e`. Multi-provider implementation: `8657056`. Accepted main `4af3375` is integrated, including its authoritative contrast-pupil artwork and optimizer fixes. The current branch adds native multi-provider quotas. Primary and earlier attribution worktrees remain unchanged.

Complete locally, unreleased: an optional native floating rail with **Claude, Codex, Kimi, Cursor, GitHub Copilot and Gemini** quota readers. Claude and Codex are shown by default; the widget’s sliders menu adds/hides providers or shows all six. Click a ring or a provider button for its own card. Six rings fit horizontally at top/bottom edges and in a two-column grid at side edges. Extra quota windows scroll and reset to the top when switching providers. Saved visibility, active provider, position, display, quota horizon and time period survive relaunches.

**You + AI ≈** estimates human interaction; **AI Time** adds runtime across agents, including parallel work. Today is the initial period, with Week/Month/All Time choices. These totals cover retained timing from Watcher’s supported clients independently of quota selection; a new quota adapter does not add a local spend/time importer. Unknown time remains a dash and partial history is labeled. Native artwork, app icons and the README owl animation are retained from the first implementation; see [animation handoff](../videos/watcher-owl-motion/HANDOFF.md).

Enable through the main popover footer’s **Display settings → Floating quota display**. It starts disabled. Hover for details, click to pin, close to hide, or drag the visible bottom grip. Panels cannot become key/main, stay below system notifications and join Spaces/full-screen.

Quota architecture:

- Claude reuses its existing Plan reader and request. Each other provider has independent coalescing, state and cooldown: five minutes after success, fifteen after failure, with longer Retry-After honored for 429s.
- The five new adapters use only existing local sign-ins, never rotate/write/copy OAuth credentials or read browser cookies. Codex follows root `cli_auth_credentials_store` for its auth file or `Codex Auth` Keychain item. Passive Keychain reads cannot prompt; unreadable Keychain items do not fall back to an older file account. Expired sessions require the provider’s own client to renew them.
- Copilot tokens remain bound to their GitHub.com or Enterprise Cloud host. New HTTP readers reject redirects, have 20/25-second request/resource limits, cap responses at 512 KiB, avoid cookie/cache persistence and suppress raw errors/bodies. Credential files are bounded regular-file reads with final symlinks refused. Cursor uses a bounded, read-only SQLite lookup after resolving parent aliases.
- Account identities are opaque hashes held only in memory. Unusable credentials and changed/unreadable identities clear older readings. Transient failures preserve readings only for the same known identity. Unlimited/no-percentage allowances remain explicit, never invented zeroes.
- Existing event-driven financial scans and bounded timing recovery are unchanged. OS threshold notifications, additional adapters, a quota CLI and multi-provider main Plan UI remain future work.

Attribution: native credential/schema adapters adapt [CodeBurn 9a40cc6](https://github.com/getagentseal/codeburn/tree/9a40cc603fcd194caca9daa8c5134a61ea7e0e2b/src/quota), credited in source and `THIRD_PARTY_NOTICES.md` with the full original MIT notice. No upstream vectors or OAuth rotation/write-back were imported. Codex storage was checked against [official OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth#credential-storage) and its public storage interface.

Validation, October 16, 2026:

- Native build and **175 tests in 28 suites passed before integration** (`/tmp/watcher-multi-native-tests.log`), including six-provider mapping, missing/unlimited data, token expiry, passive Keychain reads, source/tenant isolation, malformed/special/oversized credential files, unchanged Cursor DB, request coalescing/cooldown/account changes and six-provider geometry.
- Real native fixture UI: all six rings, horizontal and side-edge layouts, all six provider cards, Gemini window scrolling/reset, visibility hide/show-all, provider/period independence, pinning and saved state after relaunch. Earlier disconnected/stale layout checks remain applicable. Physical multi-display/Spaces switching has not been exercised.
- Changed-code review covers credential/HTTP boundaries, provider state ownership and cancellation, stale identity handling, prefs/layout and notices. Final integration review covers the complete diff; documentation local links and whitespace checks pass.

No real credentials or provider requests were used for QA; all HTTP and account tests use fixtures. No deployment, release or replacement of the installed app occurred. Session token counts unavailable.

Preview a local build with `--floating-quota-preview`, optionally `--quota-providers=all`, `--quota-provider=codex`, `--quota-preview-card` or `--quota-state=stale|disconnected|loading|expired`. The isolated sample-only bundle is `mac/.build/Watcher Floating Preview.app`.

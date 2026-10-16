# Floating display implementation

Branch: `codex/watcher-floating-quota`. Base: `1d310d1` (attribution/README work, including accepted main `d5789f6`). Worktree: `/Users/exeai/.codex/worktrees/watcher-floating-quota/exe-watcher`. Primary checkout and earlier attribution worktree remain unchanged.

Implementation commit: `21036f7`.

Deliverable complete locally (unreleased): optional native Watcher floating display with Claude five-hour/weekly quota, reset timing, hover expansion, pin/dismiss, all-edge snapping, free placement and saved preferences. You + AI ≈ shows estimated human interaction time; AI Time adds agent runtime, including parallel agents. Time defaults to Today, with Week (last seven days), Month (calendar month) and All Time (retained history). These totals cover all agents independently of the main popover selection. Unknown values remain dashes, partial timing is labeled, and inferred AI time has an approximation mark.

Enable through the main menu bar footer’s **Display settings → Floating quota display**. The feature starts disabled. The native panels cannot take keyboard focus, use floating level below system notifications, and join Spaces/full-screen. Drag the visible bottom grip; top/bottom placements use a horizontal layout. Position, display, quota horizon and time period persist.

Quota reads share one request with Plan, use bounded existing HTTP requests, and back off for five minutes after success or fifteen after failure/429. Passive reads cannot open Keychain prompts or rotate credentials. Timing reuses snapshots and the existing single-process, bounded timing-only recovery worker; this adds no periodic financial scan. Codex quotas, OS threshold notifications and their credential adapters remain backlog items. CodeBurn’s Capacity Dock is credited as the interaction reference; no upstream brand/vector assets were copied.

Branding: unchanged supplied SVGs in `assets/owls/brand/`, centered pupil cutouts in generated native/static artwork and the owl motion rig, regenerated app icons. README uses the 512×512, six-second, 90-frame infinite GIF (225,514 bytes). Editable animation and its validation are in [animation handoff](../videos/watcher-owl-motion/HANDOFF.md). The dated CodeBurn origin, MIT text and packaging notices are inherited from the base branch.

Checks completed October 16, 2026:

- Swift build passes without warnings. Final native regression: **152 tests in 25 suites passed** (`/tmp/watcher-floating-final-tests.log`). Includes all-edge geometry, display-size changes, preference defaults/persistence, quota coalescing/backoff, rejected credentials, non-focusing panels, independent all-agent time and timing failure cooldown.
- Real native UI reviewed through the isolated fixture app: compact/expanded layout, four period choices and changed totals, ring horizon selection, pinning, drag detachment, top-edge horizontal snapping, saved placement, and disconnected/stale states. Multi-display geometry is tested; physical Spaces/full-screen/display switching was not exercised.
- Animation lint/runtime/layout/motion/contrast checks pass; decoded GIF contact sheet and seam reviewed. Supplied SVG copies are byte-identical. Native artwork regression tests pass.
- Both asset generators pass syntax checks. README/documentation local links and whitespace checks pass. Changed-code review covers panel lifecycle, credential boundaries, refresh admission, timing independence and generated asset consistency; final integration review covers the full worktree diff.

No real credentials, provider requests, login registration or updater calls were used for UI QA. The user’s installed app was not replaced. Signed/notarized packaging, publication and merge into main remain release work. Session token counts unavailable. Latest animation service budget: 48% used / 52% remaining.

Review a local build with `--floating-quota-preview` (sample data and isolated preferences), optionally `--quota-preview-card` and `--quota-state=stale|disconnected|loading|expired`. The fixture-only bundle is under `mac/.build/Watcher Floating Preview.app`; it is not a release build.

Follow-up, October 16: the AI-time details button and timing Retry control now use the existing `noFocusRing()` styling after the user reported an automatic blue focus outline. Native rebuild and all four `TimePayloadTests` pass (`/tmp/watcher-time-focus-check.log`); diff/whitespace review passes. This follow-up has no separate real-window focus verification or release/install.

<p align="center">
  <img src="assets/owl-header.png" alt="Exe Watcher banner" width="520" />
</p>

<p align="center"><strong>The owl watching your AI coding spend — tokens, cost, models, agents, and projects in one beautiful terminal + macOS menu bar.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/exe-watcher"><img src="https://img.shields.io/npm/v/exe-watcher.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/exe-watcher"><img src="https://img.shields.io/npm/dt/exe-watcher.svg" alt="total downloads" /></a>
  <a href="https://github.com/AskExe/exe-watcher/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/exe-watcher.svg" alt="license" /></a>
  <a href="https://github.com/AskExe/exe-watcher"><img src="https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen.svg" alt="node version" /></a>
  <a href="https://discord.gg/pJ2DMWvtAx"><img src="https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

<p align="center">
  <img src="assets/exe-watcher-readme.png" alt="Exe Watcher macOS menu bar spend dashboard" width="401" />
</p>

Exe Watcher turns your local AI coding sessions into a live spend cockpit: today's burn, provider/model mix, activity breakdown, one-shot rate, token trends, optimization hints, and project cost — without API keys, cloud sync, or wrappers around your tools.

```bash
npm install -g exe-watcher
```

---

## What makes it cool

- **Local-first spend tracking** — reads session data already on your machine; no telemetry service, no account, no proxy.
- **Terminal + native macOS menu bar** — run the full TUI in your terminal or keep today's spend visible in the menu bar.
- **Multi-provider view** — Claude Code, Codex, Cursor, Cursor Agent, Copilot, OpenCode, OMP, and Pi are auto-detected.
- **Actually useful metrics** — cost, calls, sessions, tokens, cache hit %, one-shot rate, activity type, model split, tools, MCP servers, shell commands, and top sessions.
- **Optimization built in** — finds token waste and gives copy-paste fixes for bloated prompts, repeated file reads, uncapped shell output, unused MCP servers, and ghost agents.
- **Exe OS aware** — when Exe OS is present, Watcher adds AI employee memory growth and per-agent spend.

---

## Features

### Native macOS menu bar app

```bash
exe-watcher menubar            # install + launch
exe-watcher menubar --force    # reinstall latest
exe-watcher menubar --version v0.2.38  # install a specific version
exe-watcher                    # on macOS: prompts to install menubar app
```

> **Note:** Running `exe-watcher` with no subcommand on macOS prompts you to install the menubar app. In non-interactive environments (pipes, CI), it shows help instead. Use `exe-watcher --help` to see all available commands.

A Swift/SwiftUI popover that lives in your menu bar. Today's spend is always visible at a glance.

- **Period switcher** — Today, 7 Days, 30 Days, Month, All Time. Each period includes comparison to the previous window where available.
- **Provider tabs** — Switch between All, Claude, Codex, Cursor, and any other detected provider with spend.
- **Insight tabs** — Trend, Forecast, Pulse, and Stats summarize token/cost movement, projections, optimization wins, and usage streaks.
- **Activity breakdown** — Research, Building, Debugging, DevOps, Testing, and Planning with cost, turns, and one-shot rate.
- **Model breakdown** — See which models are driving spend and call volume.
- **Project spend** — Per-project cost across today / 7d / 30d.
- **Optimization findings** — Menubar links open the full optimizer or report directly in Terminal.
- **Subscription tracking** — Claude Pro ($20/mo), Claude Max ($200/mo), Cursor Pro ($20/mo), or custom monthly budgets.
- **Capacity estimation** — Derives likely token limits from usage patterns when hard caps aren't published.
- **Multi-currency** — USD, GBP, EUR, JPY, AUD, CAD, CHF, CNY, SEK, NOK, DKK, NZD, SGD, HKD, KRW, INR, BRL.

macOS pushes usage-log change notifications to Watcher; there is no repeating background usage scan. Rapid writes are combined, with at least two minutes of rest after a scan and longer after slow scans (nine times the scan duration). A failed notification gets at most two spaced retries before waiting for new data or a user action. Watcher also catches up on launch/wake and explicit user actions. Only one CLI child runs at a time, at low scheduling priority, with a 256 MiB V8 heap limit and a 60-second timeout. Historical and provider detail views load on demand. Failed scans retain the last successful total, including across app restarts on the same date; missing data after midnight displays a dash until a scan succeeds.

### Interactive TUI dashboard

```bash
exe-watcher                    # default: 7 days
exe-watcher today              # today only
exe-watcher month              # this calendar month
```

Full-screen terminal dashboard with gradient charts, responsive panels, and keyboard navigation. Breaks down spend by day, project, model, activity type, tools, MCP servers, and shell commands. Auto-refreshes every 30 seconds.

**Keys:** `1`-`5` switch periods (Today / 7d / 30d / Month / All). `p` toggle providers. `c` compare mode. `o` optimize view. `q` quit.

### Optimize

```bash
exe-watcher optimize           # full scan
exe-watcher optimize -p week   # scope to last 7 days
```

Scans your sessions and `~/.claude/` config for waste: re-read files, low read:edit ratios, uncapped bash output, unused MCP servers, ghost agents, bloated CLAUDE.md files. Returns exact copy-paste fixes and estimated savings. Grades your setup A through F.

### Compare

```bash
exe-watcher compare            # interactive model picker
```

Side-by-side model comparison on your own data. One-shot rate, retry rate, cost per edit, cache hit rate, delegation style, fast mode usage — broken down by task category.

---

## Supported providers

| Provider | Data source | Notes |
|----------|-------------|-------|
| **Claude Code** | `~/.claude/projects/` | Full support — tokens, cost, cache, tools |
| **Codex** (OpenAI) | `~/.codex/sessions/` | Full support |
| **Cursor** | SQLite (`state.vscdb`) | Auto mode estimated at Sonnet pricing |
| **Cursor Agent** | CLI sessions | Full support |
| **Copilot** | `~/.copilot/session-state/` | Output tokens only |
| **OpenCode** | SQLite (`~/.local/share/opencode/`) | Subtask sessions excluded |
| **OMP** (Oh My Pi) | `~/.omp/agent/sessions/` | Full support |
| **Pi** | `~/.pi/agent/sessions/` | Full support |

All providers auto-detected. If multiple tools have data, press `p` in the dashboard to toggle between them. The provider plugin system makes adding new tools straightforward — each provider is a single file in `src/providers/`.

---

## CLI reference

```bash
# Dashboard
exe-watcher                                    # interactive (default: 7 days)
exe-watcher today                              # today only
exe-watcher month                              # this month

# Reports
exe-watcher report -p 30days                   # rolling 30-day window
exe-watcher report -p all                      # everything on disk
exe-watcher report --from 2026-04-01 --to 2026-04-10
exe-watcher report --format json               # structured JSON to stdout
exe-watcher status                             # compact one-liner (today + month)

# Menubar data (used by the Swift app)
exe-watcher status --format menubar-json --period today --provider all

# Filter
exe-watcher report --provider claude           # single provider
exe-watcher report --project myapp             # project substring match
exe-watcher report --exclude tests             # exclude projects

# Tools
exe-watcher optimize                           # find waste, get fixes
exe-watcher optimize -p week                   # scope to last 7 days
exe-watcher compare                            # interactive model picker
exe-watcher export                             # CSV (today, 7d, 30d)
exe-watcher export -f json                     # JSON export
```

**Flags work everywhere:** `--provider`, `--project`, `--exclude`, `--from`, `--to`, and `--format json` combine freely across all commands.

---

## Configuration

### Currency

```bash
exe-watcher currency GBP              # any supported ISO 4217 code
exe-watcher currency --reset           # back to USD
```

Supported: USD, GBP, EUR, JPY, AUD, CAD, CHF, CNY, SEK, NOK, DKK, NZD, SGD, HKD, KRW, INR, BRL. Exchange rates from the ECB via [Frankfurter](https://www.frankfurter.app/), cached 24 hours. Applies everywhere: dashboard, menubar, exports.

### Plans

Track spend against your subscription quota:

```bash
exe-watcher plan set claude-max        # $200/month
exe-watcher plan set claude-pro        # $20/month
exe-watcher plan set cursor-pro        # $20/month
exe-watcher plan set custom --monthly-usd 150 --provider claude
exe-watcher plan set none              # disable
```

The menubar shows a usage bar against your plan limit when a plan is active.

### Model aliases

If a model shows `$0.00`, your provider's model name doesn't match LiteLLM pricing data. Map it:

```bash
exe-watcher model-alias "my-proxy-model" "claude-opus-4-6"
exe-watcher model-alias --list
exe-watcher model-alias --remove "my-proxy-model"
```

Stored in `~/.config/exe-watcher/config.json`. User aliases override built-ins.

---

## Exe OS integration

When [Exe OS](https://github.com/AskExe/exe-os) is installed, Watcher auto-detects it and adds an **AI Employees** section to the menubar with two panels:

- **Memory** — Per-agent memory count with 24h / 7d / 30d growth columns
- **Employee Spend** — Per-agent cost across 24h / 7d / 30d, using model-aware pricing (Opus, Sonnet, Haiku rates applied per-model)

How it works:

1. Exe OS's SessionStart hook maps Claude Code sessions to agents via `~/.exe-os/session-cache/`
2. The daemon computes `getAgentSpend()` with per-model pricing and writes `~/.exe-os/agent-stats.json` every 60 seconds
3. Watcher reads the stats file — zero coupling, no auth, no direct database access
4. Worktree-aware: agent worktree paths collapse into parent project names

The section appears automatically when exe-os is present and hides when it's not. Also shows daemon uptime and agent memory growth trends.

---

## Architecture

Two components, loosely coupled via CLI output:

```text
Provider usage files
       ↓
CLI: deduplicate → price tokens → cache daily totals → JSON
       ↓
macOS app: file notifications → one bounded CLI worker → menu bar
```

**CLI pipeline:** Parse provider session files from disk → deduplicate by message ID → compute cost per token type (input, output, cache write, cache read, web search) → aggregate by period, project, model, activity → output as TUI, JSON, or CSV.

**Menubar app:** Calls `exe-watcher status --format menubar-json --period <period> --provider <provider>` → decodes JSON → renders SwiftUI popover. Usage-file notifications trigger coalesced refreshes, with catch-up on launch and wake. Period and provider views load when selected. A single CLI worker has memory, runtime, and output limits; failed scans preserve the last successful total. There is no periodic background usage scan. Security: no shell injection — validated argv arrays are passed directly to child processes, not through a shell.

**Deduplication** per provider: API message ID (Claude), cumulative token cross-check (Codex), conversation/timestamp (Cursor), session+message ID (OpenCode), responseId (Pi/OMP).

---

## Test suite

Tests cover CLI data integrity, native scheduling and resource limits, and optional macOS Accessibility smoke checks. CLI end-to-end tests use isolated usage fixtures.

```bash
# Run CLI tests
npx vitest run

# Run native state and resource tests
swift test --package-path mac --filter ExeWatcherMenubarTests

# UI smoke tests require macOS Accessibility access
swift test --package-path mac --filter ExeWatcherUITests
```

---

## Activity tracking

6 categories classified from tool usage patterns and keywords. No LLM calls, fully deterministic.

| Category | What triggers it |
|----------|-----------------|
| Building | Edit, Write tools; "add", "create", "implement"; refactoring keywords |
| Debugging | Error/fix/bug keywords + tools |
| Testing | pytest, vitest, jest in Bash |
| Research | Read, Grep, WebSearch without edits; brainstorming; conversation |
| DevOps | git push/commit/merge; npm build, docker, deploy |
| Planning | EnterPlanMode, TaskCreate, Agent tool spawns |

---

## Reading the signals

| What you see | What it might mean |
|---|---|
| Cache hit < 80% | Unstable system prompt or caching not enabled |
| Lots of `Read` calls per session | Agent re-reading files, missing context |
| Low 1-shot rate (Coding 30%) | Agent struggling, retry loops |
| Opus on small turns | Overpowered model for simple tasks |
| Bash dominated by `git status`, `ls` | Agent exploring instead of executing |
| Conversation category dominant | Agent talking instead of doing |

Starting points, not verdicts. A single experimental session with 60% cache hit is fine. That same number across weeks of work is a config issue.

---

## How it works

Reads session data directly from disk. No wrapper, no proxy, no API keys needed. Pricing refreshes every 24 hours from official OpenAI, Anthropic, MiniMax, Z.AI, Kimi and xAI pricing pages, supplemented by [LiteLLM](https://github.com/BerriAI/litellm). Official rates take precedence over reseller prices for unqualified model names. Offline use retains the last available catalog or the bundled rates verified October 1, 2026, with warnings when a refresh fails. Handles input, output, 5-minute and 1-hour cache writes, cache reads, long-context tiers, and recorded web search costs. Claude streaming records are reconciled by API message ID using cumulative token counters; final usage is counted once.

Both historical and current usage use the latest available per-model API list rates. This answers "what would these tokens cost via API at today's prices?" Historical totals are rebuilt when pricing changes; they do not reconstruct the price charged on each original date. JSON reports include `pricing` metadata with the basis, refresh timestamp and source URLs. Missing session details still make recovered history an estimate. Models without published token prices (including Codex Spark) retain their tokens and an explicit cost-exclusion warning, rather than inheriting another model's price or an old reported bill.

Switching Claude accounts does not filter usage: Watcher counts all retained sessions in the configured data directory and Claude Desktop account folders. Codex archived sessions also count. Add other Claude profile roots with `claudeConfigDirs` in `~/.config/exe-watcher/config.json`.

“All Time” includes the entire available history. To set the beginning of your coding journey, add `"historyStartDate": "2025-07-01"` to the same config. This defines the reporting window; it cannot recreate missing logs. Unknown model prices generate a warning while their tokens remain counted.

For unfiltered All Time Claude totals, Watcher also reconciles `stats-cache.json` cumulative model counters with retained logs through the snapshot's cutoff date. Only missing per-model/token counters are added. Recovered usage is separately identified as `historicalRecovery`: it has no fabricated dates, sessions, or projects, and uses standard API rates with 5-minute cache writes because TTL/speed metadata is unavailable. Daily charts show dated logs only. Project/provider sums include recovery only where attribution is known. Usage lost from both logs and cumulative counters remains unknown. These are API-equivalent estimates, not subscription charges or invoices.

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Override Claude data directory (default: `~/.claude`) |
| `CODEX_HOME` | Override Codex data directory (default: `~/.codex`) |
| `EXE_WATCHER_CACHE_DIR` | Override cache directory (default: `~/.cache/exe-watcher`) |

---

## Contributing

Contributions welcome. The provider plugin system is the easiest entry point — each provider is a single file in `src/providers/`.

```
src/
  cli.ts            Entry point (Commander.js)
  dashboard.tsx     TUI (Ink — React for terminals)
  parser.ts         Session reader, dedup, date filter
  models.ts         LiteLLM pricing engine
  classifier.ts     Activity classifier (6 categories)
  compare-stats.ts  Model comparison engine
  menubar-json.ts   Menubar payload builder (agent spend, project spend)
  export.ts         CSV/JSON export
  config.ts         Config management
  currency.ts       Currency conversion
  providers/        One file per supported tool
mac/                Native macOS menubar app (Swift + SwiftUI)
tests/              CLI data integrity tests (Vitest)
```

---

## Origin & attribution

Watcher is forked from [codeburn](https://github.com/getagentseal/codeburn) by [AgentSeal](https://github.com/getagentseal) (MIT license). We forked rather than contributed upstream because our roadmap diverges significantly:

**What we changed:**
- Rebranded to Watcher with the Exe Foundry Bold design system
- 8 provider support (added Cursor Agent, Copilot, OMP, Pi, OpenCode)
- Native macOS menubar app with multi-period views, provider tabs, project spend, and subscription tracking
- Exe OS integration — per-agent spend and memory tracking for AI employee teams
- Daily cache system (v8) with atomic writes and cold-start/progressive full-history backfill
- Capacity estimation from usage patterns
- Multi-currency support (17 currencies)
- Test coverage across CLI, Swift state, resource limits, and UI smoke layers
- Consolidated activity categories from 13 to 6
- Fixed double-counting bugs in the menubar JSON pipeline
- Performance: 7-day and 30-day queries from 2-5s down to ~1s via daily cache

**Why we forked:**
- Full control over the data pipeline to integrate with exe-os (our AI employee operating system)
- Our classification model, provider support, and UI direction serve a different user base (AI-first teams running multi-agent workflows)
- MIT license allows this — we give full credit to AgentSeal for the foundation

Thank you to AgentSeal for building the original. If you want a clean cost tracker without exe-os integration, [codeburn](https://github.com/getagentseal/codeburn) is excellent.

---

## Star History

<a href="https://www.star-history.com/?repos=AskExe%2Fexe-watcher&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=AskExe/exe-watcher&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=AskExe/exe-watcher&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=AskExe/exe-watcher&type=date&legend=top-left" />
 </picture>
</a>

---

## License

MIT

---

Built by [Exe AI](https://askexe.com). Forked from [codeburn](https://github.com/getagentseal/codeburn) by AgentSeal (MIT). Pricing data from [LiteLLM](https://github.com/BerriAI/litellm). Exchange rates from [Frankfurter](https://www.frankfurter.app/).

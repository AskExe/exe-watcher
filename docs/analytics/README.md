# Watcher self-hosted observability

Collector: `https://data.odd.community`. Real PostHog tokens and Sentry keys remain
on build-my. Public aliases are `public-watcher-cli-v1` and `public-watcher-mac-v1`.
No cloud SDK, raw crash handler, replay or Google analytics is installed.

Basic usage defaults **on** after first-run disclosure; detailed diagnostics
remain **off** until independently enabled. Explicit `usageEnabled: false`, legacy
`enabled: false`, and privacy environment overrides always take precedence.
The shared PrivacyClient keeps its own safe off-by-default primitive; the product
adapter applies this approved policy after displaying the notice.

The Mac first-run notice has a checked **Share basic usage statistics** control;
unchecking it saves an opt-out before collection. The CLI prints its first-run
notice to stderr before collection during the first interactive command. Settings
remain reachable through the gear; enabling diagnostics requires a separate native
confirmation. CLI users can explicitly choose:

```sh
exe-watcher telemetry --usage on --errors on
exe-watcher telemetry --usage off --errors off
exe-watcher telemetry --test-error
```

These update `telemetry.usageEnabled`, `telemetry.diagnosticsEnabled`, and revocation epochs in
Watcher’s existing config. The two app surfaces share that consent and a random
installation ID. `DO_NOT_TRACK=1` or `EXE_WATCHER_TELEMETRY=0` suppress both. Turning
off usage clears the local ID; off clears that lane’s unsent queue. Received data
is not retroactively deleted. The collector sees the connection IP; it does not
forward it to the backing projects.

Counters: DAU is participating installations, not people. Interactive CLI invocations
count allowlisted `cli_*` features. Mac usage counts `mac_menu`, `mac_report`,
`mac_period`, `mac_provider`, plus foreground menu time while non-idle/unlocked.
Background CLI scans, closed-menu residency, idle time and sleep gaps do not count.
Terminal focus cannot be reliably measured across platforms, so CLI active minutes
are not inferred from command wall time. Recording minutes are **N/A**.

Errors contain a fixed category, allowlisted class, numeric version and empty
frames. No messages, paths, project names, prompts, session/log content, spend,
credentials, screen recordings, native crash dumps or installation ID are sent.
Coverage is handled CLI failures and native refresh failures; full native crash
capture is intentionally excluded. The test-diagnostic control uses the same
handled-error reporting path.

Private queues live beside `config.json` (CLI state in `telemetry-cli/state.json`): at most 500 events per CLI lane and 100 per native lane,
seven-day TTL, 0600 files, stable UUIDs across retries. The CLI uses `@odd-core/analytics/privacy` with atomic private storage and a
non-waiting cross-process lease; a busy telemetry owner never delays accounting.
Consent epochs prevent a dormant process from replaying reports revoked elsewhere. Mac retries every 30s;
CLI retries on the next command. HTTPS redirects are refused. Requests time out
(1.5s CLI, 5s Mac); errors never block accounting. Revocation is rechecked before
flush and the native app cancels in-flight requests when it observes changed
consent. A request already accepted by the collector cannot be recalled.

The CLI and deployed gateway use the shared MIT `@odd-core/analytics` privacy and
gateway entry points. Because this repo is outside the toolkit’s
workspace, `vendor/odd-core-analytics` is a reproducible local package snapshot,
installed through a `file:` dependency and bundled into the CLI. No private
registry or sibling checkout is required by CI or the packaged Mac app. Run
`node scripts/vendor-analytics.mjs /path/to/odd-core-kits/packages/analytics` to rebuild it from the pinned committed source. An optional third argument
selects another full commit SHA. `PROVENANCE.json` records upstream revision,
package version, compiler version, and exact source/artifact hashes.
Current pin: `@odd-core/analytics` **0.2.0**, upstream commit
`3fb6fb095a1f9b1b8601965df58f08521fc38f7f`. Only these dependency-free entry points
are included; the toolkit’s unrelated APIs and workspace dependency are excluded.
`node --test docs/analytics/gateway.test.mjs` tests Watcher/Hansel isolation against
the shared gateway. Its source-only deployment preserves the existing image,
service configuration and private mappings.

`provision-watcher.py` runs on build-my, creates only Watcher projects, preserves
other mappings, and stores credentials only in server-private files. Compose for
Sentry must use `--env-file /opt/odd-sentry/.env.custom` and its project directory.
Do not run Hansel’s original provisioning script: it replaces its token map.
Gateway updates must verify the running source hash and preserve config, image,
networks and mounts. Restart only the gateway after changing its two maps.

Infrastructure/setup/backup authority:
`/Users/exeai/Hansel/docs/analytics/{APP_SETUP.md,STATUS.md,SENTRY.md,backup/README.md}`.
Raw retention: PostHog 30 days, Sentry 14 days, encrypted backups seven days;
expiry is asynchronous. No public/npm/App Store release is implied.

## Current metric boundary

Shared 0.2.0 now supports numeric app version, coarse platform and fixed outcomes.
Watcher sends those basic fields, plus daily activity/retention, foreground menu
time and static feature counts. CLI completion records `success` or `failure`;
visible selected-menu refreshes record the same outcomes under `mac_menu`.
Background refreshes do not create basic result events while the menu is closed.
No messages or content are attached to an outcome, and errors still require the
separate diagnostics switch. Exact OS version and latency buckets are not collected.
There is no cross-app installation linking. No gateway restart was made by Watcher;
the shared gateway had already been qualified and deployed by its owning task.

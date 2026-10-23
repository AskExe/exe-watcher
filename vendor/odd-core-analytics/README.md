# Shared private PostHog + Sentry integration

Use **`@odd-core/analytics/privacy`** for Odd's self-hosted counter/error collector.
It is separate from the older generic API at `@odd-core/analytics` and from
`@odd-core/telemetry`; those APIs do not enforce this wire protocol or its defaults.
The privacy entry point has no runtime dependencies or provider SDKs. Its source
and the matching Node gateway are MIT licensed. This change does not publish npm
artifacts or make the containing repository public.

## New app setup

1. Create separate PostHog and Sentry projects for the app. A CLI and a native app
   may use separate Sentry projects/aliases. Reuse the existing **build-my** server.
2. Register public aliases, the app slug, and static feature/source allowlists in
   the gateway's private maps (see below). Never copy Hansel's project IDs/aliases.
3. Install/link `@odd-core/analytics` through the app's normal dependency process.
   Build it with `tsc -b packages/types packages/analytics` from this repository.
   In this workspace, use `"@odd-core/analytics": "workspace:*"`.
4. Supply private storage and a cryptographic UUID provider, then expose **two
   independent opt-in controls**, both initially off. Keys/configuration alone
   never constitute consent. Update the app's privacy policy/store disclosures.
5. Hook explicit features, foreground/idle state, real recording completion, and
   handled structural errors to the client. Schedule `flush()` on a bounded timer
   and lifecycle transitions. No timers or error hooks start automatically.
6. Verify real local app usage and one harmless handled error in the app's own
   dashboards. Check opt-out, no pre-consent history, retry IDs, and tenant routing
   before the app's normal release process. No paid/cloud build is required here.

```ts
import { ActiveClock, PrivacyClient } from '@odd-core/analytics/privacy';

const analytics = await PrivacyClient.create({
  app: 'watcher',
  usageAlias: 'public-watcher-v1',       // provision first; illustrative values
  diagnosticsAlias: 'public-watcher-cli-v1',
  features: ['home', 'menu'],           // static developer-owned list, not user text
  storage: privateAppStorage,          // getItem/setItem, atomic durable replacement
  randomUUID: () => crypto.randomUUID(),
  // collector defaults to https://data.odd.community
});

// Only after the user accepts the relevant disclosure:
await analytics.setConsent({ usage: true });
await analytics.track({ event: 'active' }); // startup/return-to-active, not background polls
await analytics.track({ event: 'feature', feature: 'menu' });

const clock = new ActiveClock();
// Sample about every 5 seconds using a monotonic clock and actual app state.
// Skip/reset the clock while consent is off, after consent changes, and on sleep.
if (analytics.status().usage) {
  const active_ms = clock.sample(performance.now(), isFocused, idleSeconds, isRecording);
  if (active_ms > 0) await analytics.track({ event: 'usage', active_ms });
} else clock.reset();

// Recording apps only: duration from the actual completed recording, no audio/text.
await analytics.track({ event: 'recording', recording_ms: 3700 });

// Separate diagnostics consent, followed by a safe structural report.
await analytics.setConsent({ diagnostics: true });
await analytics.report({ event: 'error', category: 'ipc_error',
  error_class: 'RangeError', version: '1.0.0', frames: [] });
await analytics.flush();

// On revocation: abort pending requests, erase the channel queue and usage ID.
await analytics.setConsent({ usage: false });
clock.reset();
```

`setConsent`, `track`, and `report` return a boolean: check it when displaying
settings or troubleshooting persistence. A storage failure disables both channels
in memory. If a revocation cannot be persisted, the app must keep collection off
on subsequent launches until it can durably save the choice. One client instance
owns each app state store; don't share a writable queue across processes/tabs.
Already accepted server events cannot be recalled by aborting a request.

## Platform adapters

| Platform | Adapter responsibilities |
| --- | --- |
| Node CLI / Electron main | Owner-only atomic file replacement (directory `0700`, files `0600`), `node:crypto.randomUUID`, explicit lifecycle flush. Renderer requests cross a narrow, validated IPC boundary. Suppress background child CLI polling. |
| Web | App-scoped storage, Web Crypto UUIDs, visibility/focus/idle sampling. Configure exact CORS origins on the gateway and ingress. Cross-origin cookies are omitted. Browser storage is accessible to same-origin code. |
| React Native / Expo | Durable app-scoped storage, platform cryptographic UUIDs, foreground state and actual activity/idle signals. Keep Node modules out of the mobile bundle. |
| Native Swift/Kotlin/Dart | Implement the small protocol below or bridge this client; JavaScript cannot be imported directly into Swift. Reuse the same consent/storage/lifecycle rules and gateway allowlists. |

Never install global native crash handlers or send minidumps/raw crash reports as
part of this kit. Sentry gets explicit sanitized structural errors. There are no
automatic breadcrumbs, network traces, replay, screenshots, account identification,
device fingerprints, prompt/transcript/audio collection, or Google analytics.
DAU counts consenting installations, not authenticated people. Recording minutes
are **N/A** for apps without a recording feature. Metric days are UTC in the pilot.
IP addresses necessarily reach the collection network edge; the gateway does not
forward incoming IP/user-agent/cookies to PostHog or Sentry. Edge logging and
retention are operator responsibilities; pseudonymous analytics is still data.

## Persistence and transport contract

Both queues are capped at **500 events**, expire after **7 days**, and are
re-sanitized on load. UUID/timestamp are assigned once before retries, preserving
the backend deduplication key. Each flush sends at most 50 usage and 10 errors,
with 5s/10s timeouts. Failures retain safe events for the next scheduled attempt.
Re-enabling usage after revocation creates a fresh random installation UUID.
The state is bound to collector/app/aliases so a config change cannot reroute an
old queue. App adapters must not backfill history or generate synthetic activity.

`POST /batch/`, JSON content type:

```json
{"api_key":"public-watcher-v1","batch":[{
  "uuid":"a1c01189-72bf-4f63-b6e6-9e940e87ebc7","timestamp":"2026-10-23T12:00:00.000Z",
  "event":"app_feature","properties":{
    "distinct_id":"a1c01189-72bf-4f63-b6e6-9e940e87ebc8","app":"watcher","feature":"menu"
  }
}]}
```

Usage events: `app_active` (no counter), `app_usage` (`active_ms`, integer 1–60000),
`app_recording` (`recording_ms`, integer 1–86400000), `app_feature` (registered enum).
`POST /errors/`: same envelope/UUID/timestamp but each row has `diagnostic` instead
of `event`/`properties`. Diagnostic fields: `event: "error"`, fixed `category`,
standard JS `error_class` (unknown becomes `Error`), numeric `x.y.z` version, and
up to 8 registered logical frames with bounded integer line/column numbers.
Never put a raw exception object, message, stack string, arbitrary properties,
filesystem path, attachment, user identity, or DSN into either payload.

## Gateway and provisioning

The dependency-free gateway is `@odd-core/analytics/gateway` (ESM, Node 20+).
Run `node node_modules/@odd-core/analytics/gateway/server.mjs` in the private
deployment. Server-only configuration, supplied as mounted owner-only JSON files:

```json
// PROJECT_TOKENS_FILE
{"public-watcher-v1":{"app":"watcher","token":"PRIVATE_POSTHOG_PROJECT_TOKEN","features":["home","menu"]}}
// SENTRY_PROJECTS_FILE
{"public-watcher-cli-v1":{"app":"watcher","project_id":7,"public_key":"32_HEX_CHAR_PUBLIC_KEY","platform":"javascript","frames":["app:///main/index.js"]}}
```

Those aliases/IDs are examples, not provisioned projects. Maps route each alias
to a single backend project; caller-supplied project IDs, tokens, and properties
cannot select another tenant. Copy only public aliases into app configuration.
The server supports per-project `features`/`frames`; omitted lists preserve the
Hansel pilot defaults. The pilot gateway currently deployed in Hansel predates
these per-app lists: validate and deploy the shared gateway before using new
Watcher feature/source enums. Existing Hansel payloads remain compatible.

Optional `ALLOWED_ORIGINS` is a JSON array of exact web origins; none by default.
Unlisted Origin headers are rejected. Permit OPTIONS for only the two intake
routes at ingress when enabling web apps; do not expose dashboard routes.
The process binds port 8080; provision private upstreams via `POSTHOG_UPSTREAM`
(default `http://proxy:80/batch/`) and `SENTRY_UPSTREAM` (`http://sentry-ingress`).
Standalone mode restricts upstream hostnames to the private service names/local
host; never configure a hosted provider fallback. Rate/body/connection limits
remain enabled. `GET /health` does not prove end-to-end ingestion.

Existing infrastructure runbooks and provisioning helpers are in
`/Users/exeai/Hansel/docs/analytics/`: `APP_SETUP.md`, `STATUS.md`, `SENTRY.md`,
`provision-hansel.py`, `provision-sentry.py`, `create-dashboard.py`,
`connect-sentry-intake.py`, and `backup/README.md`. Adapt scripts without replacing
Hansel mappings. Actual credentials stay on the server, outside source control.
Dashboards: PostHog `https://build-my.tail910c31.ts.net`, Sentry
`https://build-my.tail910c31.ts.net:8443` (Tailscale + Tailscale DNS).
Encrypted daily restic backups already use Cloudflare R2, seven-day retention.

## Checks and adoption status

`pnpm --filter @odd-core/analytics test` builds the package and runs the privacy,
wire-contract, project isolation, CORS, and gateway tests without live services.
`pnpm --filter @odd-core/analytics test:privacy` runs against an existing build.
The legacy API remains available; adding this entry point does not automatically
migrate apps, deploy the gateway, create projects, or qualify Swift/mobile builds.
Hansel's original integration has live dogfood evidence; this shared extraction
requires each consuming app's normal integration checks before rollout.

## Standard basic analytics (0.2.0)

Keep collection off until the person explicitly accepts a clear first-run choice.
Offer **Share Basic Analytics** and **Not Now**. An unchecked optional diagnostics
choice can share the same screen, while usage/errors remain independently
controllable in Settings. Persist a decline; never repeatedly prompt or silently
turn on a channel after an upgrade. Existing approved choices remain approved.
Apps must obtain their required platform/privacy permissions before collection.

The standard product dataset is consenting-installation DAU/WAU/MAU, foreground
active duration, real recording duration where applicable, allowlisted feature
counts/outcomes, numeric app version and coarse platform. `USAGE_DISCLOSURE` and
`DIAGNOSTICS_DISCLOSURE` provide shared field descriptions. Supply static
`appVersion: '1.0.48'` and `platform: 'macos'` to PrivacyClient; platform is one of
macos/windows/linux/ios/android/web. Neither field comes from arbitrary event data.
Feature results are `{ event: 'result', feature: 'menu', outcome: 'success' }`
(or `failure`), sent as app_result. No error text accompanies a failure counter.
The gateway independently validates metadata and results. Deploy that capability
before enabling result events in clients; old payloads remain compatible.

DAU/WAU/MAU use the same per-app random installation ID with UTC day/7-day/30-day
windows; no account or cross-app ID is necessary. Existing 30-day raw retention
limits the rolling monthly window. Counts cover consenting installations only.

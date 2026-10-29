# Watcher private account history

## Current handoff — shared-project decision, 2026-10-29

Hosted qualification follow-up: the canonical central migration and cleanup core
are pinned in `supabase/SHARED_PROJECT_PROVENANCE.json`. The migration also
registers Watcher atomically. Admin-seeded QA access expires within four hours;
public rollout stays false. `scripts/watcher-hosted-qa.ts` uses only newly created
disposable review-mailbox aliases, synthetic totals and in-memory credentials. It
checks genuine hosted login, isolation, immutable ciphertext, new-device restore,
retention, consent revocation, physical history cleanup and central account erasure.
Cleanup of exact generated identity IDs runs independently after any failure.

No production migration/function or recurring job has been applied. Existing
server-key use requires explicit approval after automatic review rejected even
metadata-only retrieval. The protected endpoint uses existing platform secrets;
no new key, project, budget change or schedule is prepared implicitly.

Run only after the reviewed backend is deployed, with `WATCHER_QA_DISPOSABLE=1`,
a protected `WATCHER_SERVICE_SECRET`, the installed Supabase CLI and an optional
`WATCHER_QA_RECEIPT` path outside the temporary fixture directory. Never pass a
server key in argv or write it to a file. The command is
`node_modules/.bin/tsx scripts/watcher-hosted-qa.ts`.

Henry chose the **existing central Odd Supabase project** for Watcher. This is a
Watcher-specific exception to the per-app project architecture and supersedes
the earlier extra-project/billing request. No new project or base compute charge
is required; shared storage, egress and database usage still use existing quotas.

The original dirty account branch is preserved on 0.2.72. The release candidate
is isolated at `/private/tmp/watcher-shared-account` on
`codex/watcher-shared-account`, based on actual merged main 05d9cfe (published
security-only 0.2.73), with version 0.2.74. Account work is still unreleased.
`src/cloud/deployment.json` now explicitly points data and auth to the same pinned
Odd project, with rollout still **false**. A missing/foreign data endpoint never
becomes an implicit fallback.

Read-only live preflight found no Watcher objects, 9 existing buckets, 37 existing
storage policies and 101 existing public/private functions. Private evidence:
`/private/tmp/watcher-shared-inventory.json`. Existing definitions and ACLs are
fingerprinted for preservation; no Watcher production DDL has been applied.

## Implemented

- Settings → **Odd account & private history…**. Local tracking/history requires no
  account. In-app email-code login; new accounts require a separate Terms/Privacy
  acknowledgement. Auth uses the existing central public publishable key.
- Refresh credentials and account-scoped backup keys use a native Keychain broker,
  with values in stdin, never argv. Account commands are excluded from analytics;
  unknown/network errors are sanitized before SDK logging.
- Sign-in never uploads history. Backup requires separate consent and the existing
  Odd phrase, or explicit first vault enrollment. Pinned Odd Core code derives a
  distinct Watcher wrapping key. Phrase/root never enter server or app storage.
- Approved provider/day costs and token totals, completeness markers and lifetime
  AI timing estimates only. No prompts, code, paths, project/model names, session
  identifiers, credentials, personal-activity details or diagnostic dumps.
- Authenticated immutable chunks/manifests are read back before CAS publication.
  Current/previous versions survive failed uploads, corruption and competing writes.
  Account/device/vault/version are bound cryptographically. A durable pause marker
  bypasses the account lock to revoke consent during an upload.
  Before replacement, the prior snapshot is decrypted and merged: missing days
  survive cache rebuilds and regressed accounting is refused. Phrase resets retain
  the existing working key; missing original keys never cause silent replacement.
- The Mac checks opted-in backups every six hours; disabled rollout/consent makes no
  auth/network request. CLI users can manually back up.
- Restores are atomic private archives, preserving current logs and financial caches.
  Monthly/all-time provider views work. Device histories stay separate to avoid
  double counting copied logs. API-equivalent estimates are not invoices, and
  runtime is not human time saved.
- Public sharing stays off. A unified Odd web dashboard, daily timing trends,
  automatic budget alerts and selective public cards remain future work.

## Backend / activation gates

The migration targets the shared Odd project and creates only namespaced Watcher
objects: `watcher_private`, `public.watcher_*`, a private `watcher-history` bucket,
scoped storage policies and a Watcher deletion hook. It never revokes permissions
on central `private` or unrelated tables. Restrictive guards keep Watcher objects
private even if another storage policy is permissive. Existing buckets retain
their own access rules. Verified identity, owner consent, immutable objects,
monotonic CAS, current/previous retention and a 100-object account ceiling remain.
Both rollouts start false. No original logs or plaintext history are stored there.

Same-project Auth deletion queues Watcher objects and tombstones ownership; a
protected sweep catches soft-deleted/orphaned accounts. Ciphertext must be removed
through the Storage API before central Auth deletion; a companion central
`delete-account` integration is required before rollout. No cross-project deletion
export, new caller registration or extra signing key is needed. The protected
`scripts/watcher-maintenance.ts` entry point is pinned to central Odd and needs
only server-held `WATCHER_PROJECT_REF` and `WATCHER_SERVICE_SECRET`. It creates no
schedule and acknowledges only successful Storage API removals.

Before activating:

1. Finish the shared-project regression review, including existing policy and ACL
   preservation, other-app access, stale/deleted sessions and deletion concurrency.
2. Merge reviewed migration/client source and the central account-deletion hook.
   Apply only merged source after a fresh schema/long-transaction preflight with
   `lock_timeout='2s'`; verify every pre-existing fingerprint afterward.
3. Register only Watcher's catalog entry. Keep current Auth providers, other app
   registrations, subscription/paywall settings and existing schedules unchanged.
4. Bind protected Storage API cleanup to an explicitly approved executor/schedule;
   no recurring job is authorized or installed by this change.
5. Prove real hosted JWT, cross-account/anonymous denials, immutable Storage,
   revoke-during-upload, encrypted new-device restore and account/history deletion
   with exact owned fixtures. Local PostgreSQL tests do not prove hosted delivery.
6. Update the live privacy section's storage-project description and availability.
   Complete the authorized review mailbox signup. Henry approved Terms; the browser
   reviewer requested a fresh confirmation on the ready signup form.
7. Enable the reviewed server/client rollouts, then ship a newer paired release.
   Do not overwrite published 0.2.73 assets or claim local account code is shipped.

Paid backup later needs a server entitlement bridge if the shared Odd-wide
backup paywall changes. The current central free-backup setting remains unchanged.

## Verification

Existing Node/native/release suites, plus encrypted round-trip, consent, account
switching, SQL tenant isolation and cleanup tests run locally. SQL tests use real
PostgreSQL through PGlite and fictional UUIDs. An isolated ad-hoc native preview
successfully viewed this Mac's saved monthly/all-time history via the real CLI.
It skips live scans, telemetry, login-item registration and updater startup.
No key has been enrolled or history uploaded during QA. Live account qualification
remains pending; earlier native checks exercised preview fixtures only.

Latest candidate checks: both TypeScript checks, build, all 46 account/history/
SQL-policy/maintenance tests, 214 native tests, three paired-release tests,
package dry-run (24 files; no source maps/credentials), vendored source digests
and runtime dependency audit (zero vulnerabilities) pass. The unchanged source
also passed the full 865-test Node suite across the original run and targeted
permission/timeout rechecks; candidate and primary source/test inventories are
byte-identical. Logs: `/private/tmp/watcher-account-candidate-*`,
`/private/tmp/watcher-shared-all-tests.log`,
`/private/tmp/watcher-shared-sandbox-recheck.log` and
`/private/tmp/watcher-account-timeout-recheck.log`.

Central deletion companion: OddCommunity/odd-core-kits PR77, head
318dc53b3234a7792f2ca6de4964e246c6a8f9e3. Its 134 tests and Deno typecheck pass;
current hosted CI has passed delete-account and both real GoTrue gates, with two
dependency-download failures and build pending. Production is untouched.
No new project, billing change, credential export or schedule was created.
Token usage figures are unavailable.

## Odd Community branding — 2026-10-26

Account, login, verification, backup and history screens now reuse the exact Odd
website mark, Satoshi body fonts and Grandstander heading fonts. Native account
tokens match `public/join/account.css` and `public/assets/odd-site.css`: cobalt
`#355ea7`, orange `#ff6200`, cream `#f5f2ea`, muted `#d0d9e9`. Resources are bundled
offline and registered through CoreText; font notices accompany them. The native
preview was visually checked, asset bytes match the canonical website copies,
and the build plus all 214 native tests passed. This branding change is local
and has not been released.

## Account layout review — 2026-10-26

Default window is 560×680 points, minimum 500×580, with content capped at
620 points and centered in wider windows. Tightened section/field spacing,
full-width sign-in/verification actions, quieter helper/legal links, inline
feedback, adaptive backup action rows and collapsed optional history controls.
Visually checked login, signup, verification and recovery with small/default/wide
windows; long recovery content scrolls to all controls/footer links. Layout-only
preview fixtures send no email or cloud requests. Build and all 214 native tests
passed; changes remain local and unreleased.

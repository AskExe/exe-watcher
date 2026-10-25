# Watcher 0.2.72 — hybrid release handoff

## Ownership and current authority

On 2026-10-25 the user explicitly authorized cloud checks wherever possible and
required local native steps. This supersedes the earlier full-cloud hold.
Cloud CICD owner: `01a16ead-c8de-7682-9cde-a26848ef50b3`.
Local native/publication owner: Watcher chat `01a1689d-8827-7ff0-bd99-fcf9d5be2f86`.
One publisher at a time. Existing cloud-only history remains on branch
`codex/watcher-0272-cloud-release-status`; it is historical, not a current hold.

## Source and passed checks

Functional PR #41 and version PR #42 merged. Prepared main was
`15dedd18854e984b4c8747a2a35b525303090466`; CI run
[40099737590](https://github.com/AskExe/exe-watcher/actions/runs/40099737590)
passed all four jobs. Local native checks: 211 tests. Cloud onboarding passed
803 Node tests, three release guard tests, typecheck/build and JSON report.
No functional source changes are needed for the ownership update. Integrate and
qualify its actual merged main before packaging; do not sign an older tree.

## Environment and gates

Cloud onboarding saved workspace-local cache/config/proxy settings. The cloud
runtime is Linux and provides no native Mac signing or Finder access. The local
Mac has the existing Watcher Developer ID identity and notarization profile;
preflight succeeded without moving any credentials. Hosted release workflow
stays disabled. No paid resources, mobile builds or schedules are authorized.

Use existing paired release scripts. Require signed, Apple accepted/stapled app
and DMG, clean-source receipts, Gatekeeper and uploaded digest validation. Verify
npm latest and updater both deliver 0.2.72, customer installation succeeds, and
the actual installed Finder/Apps icon has no thick grey surround. Check aligned
menu badge, continuous animation, persisted off setting and Reduce Motion.
Repair and requalify if installed appearance fails. A universal cross-build is
not native Intel hardware qualification.

## Next action

Merge the hybrid ownership PR after green CI, qualify merged main, build/sign/
notarize locally, inspect native appearance, publish paired assets/npm, then
exercise the customer update. Public channels were still 0.2.71 at preflight.
No new release has yet been claimed. Token usage unavailable.

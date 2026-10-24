# Watcher 0.2.72 cloud release coordination

Recorded 2026-10-24 by Codex in Henry's ChatGPT Cloud release-coordination conversation.

## Ownership and environment

Coordination owner: Codex in the current Henry-authorized ChatGPT Cloud conversation.
This is a coordination assignment, not a connected or provisioned release pipeline.
No managed cloud task ID, dashboard URL, Mac environment ID or signing binding is exposed
to this conversation. Do not invent these identifiers or claim migration complete.

Observed execution environment: Linux x86_64, hostname 7ed3290964e6,
workspace /workspace/scratch/195cb4d6afc6, Node v24.22.1, npm 11.9.0.
git, node and npm are available. swift, xcodebuild, codesign, security,
xcrun and gh were absent from PATH. Tool discovery exposed no first-party
native Mac runner/task provisioning or protected release-credential binding API.
The installed Mac app and Finder are not accessible from this environment.

## Verified source and existing evidence

- Remote main and clean checkout: 15dedd18854e984b4c8747a2a35b525303090466.
- Source tree: 68ff49ea972efc7041af7dcb79b4f66d01774fdb.
- package.json and both lockfile version fields: 0.2.72.
- PR #41 merged as d94090f54722035bc39f8319a5c4cb1d3fb03397.
- PR #42 merged as 15dedd18854e984b4c8747a2a35b525303090466.
- CI run 40099737590 completed successfully at this main SHA. All four jobs
  succeeded: both Node build/test jobs, semgrep, macos-resource-tests.
- The existing macos-latest job is GitHub Actions evidence, not an execution
  capability or signing binding of this ChatGPT Cloud task. Its package command
  uses development/ad-hoc signing and does not qualify a public release.
- Passed checks were not repeated. No source or workflow was changed.
- npm registry query returned latest exe-watcher 0.2.71.
- GitHub latest public release is mac-v0.2.71. mac-v0.2.72 returned 404.
- Handoff and repository AGENTS.md report zero registered runners/secrets and a
  disabled release workflow. Current inventory/disabled state could not be
  independently refreshed through the exposed GitHub connector endpoints;
  attempted workflow reads were rejected as unsupported.
- AGENTS.md, docs/menu-bar-icon-status.md, mac/README.md and all three existing
  release scripts were read. The README's older local-signing wording does not
  override AGENTS.md or Henry's cloud-only release authorization.

## Gates retained

Use mac/Scripts/publish-release.mjs, package-app.sh and bundle-runtime.sh.
Keep actual clean merged-main, successful CI, version/tree/provenance,
universal app/runtime architecture checks, Developer ID signature,
Apple notarization, stapling, Gatekeeper and uploaded asset digest gates.
npm prepublishOnly still requires its matching public notarized Mac release.
Do not publish an unsigned substitute or bypass lifecycle hooks.

## Exact prerequisites and remaining acceptance

1. A real compatible native Mac environment connected to this cloud coordination
   owner, with a verifiable environment/task identifier and execution receipts.
   Xcode/Swift 6+, macOS 14+, actool, lipo, codesign, hdiutil, notarytool, stapler,
   Gatekeeper, gh and the required Node/npm runtime must be available.
2. Protected cloud Developer ID signing identity and Apple notarization profile;
   GitHub release-write authorization and npm publication authorization.
   Credentials must be provisioned securely, never copied from a personal
   Keychain, profile or credential file. No credentials are in this record.
3. Run the existing qualified release path from the then-current clean merged
   main, confirm matching notarized Mac release and all uploaded digests, publish
   npm through its hook, then observe both public 0.2.72 versions.
4. Install/update the actual signed customer bundle. Record version and verify
   Finder/Applications icon has no grey surround on the affected macOS version,
   badge optical alignment through moving poses, idle animation with popover
   closed, saved OFF state after relaunch and all menu owl motion stopped with
   Reduce Motion. If the installed icon still has a grey border, fix it and
   requalify rather than declaring success.
5. Native Intel acceptance needs real Intel Mac hardware; Rosetta and Linux do
   not establish it. Record Apple Silicon and Intel receipts separately.
6. Verify updater and website release/download resolution, downloaded checksums
   and installed Gatekeeper acceptance.

No release was built, signed, notarized, uploaded or published in this task.
No installed-app QA was performed. No workflow was enabled, no schedule created,
no paid runner provisioned and no spending/billing settings changed.

## Links

- CI dashboard: https://github.com/AskExe/exe-watcher/actions/runs/40099737590
- Current release: https://github.com/AskExe/exe-watcher/releases/tag/mac-v0.2.71
- Releases: https://github.com/AskExe/exe-watcher/releases
- npm: https://www.npmjs.com/package/exe-watcher

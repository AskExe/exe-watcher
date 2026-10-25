# Watcher working agreements

Read the profile-wide working agreements before work. Preserve dirty changes.

## Hybrid CI/CD ownership — 2026-10-25

The user explicitly authorized doing as much as possible in ChatGPT Cloud and
performing required native steps on this Mac. This supersedes the earlier
Watcher cloud-only/personal-Mac prohibition. Cloud CICD chat
`01a16ead-c8de-7682-9cde-a26848ef50b3` owns available cloud work; the local Watcher
chat owns native Mac build, signing/notarization, publication and installed UI QA.
Use one publisher at a time and reuse passing remote checks where applicable.

The cloud environment supports the Node CLI, not native Mac signing or Finder.
Do not claim native Intel hardware acceptance from Linux, Rosetta or a universal
cross-build. Keep the hosted Mac release workflow disabled until deliberately
configured. No paid runners, budget increases, EAS or new schedules are authorized.
Never copy personal Keychains, profiles or credentials into a cloud handoff.
Keep credentials in their existing protected local storage.

Keep paired npm/Mac gates in `mac/Scripts/publish-release.mjs`: clean actual merged
main, successful CI, matching version/source tree, signed and stapled notarized
artifacts, Gatekeeper acceptance and verified uploaded digests. Observe actual npm
latest, updater assets and installed app before claiming delivery. See
`mac/README.md` and `docs/cloud-release-0.2.72-status.md`.

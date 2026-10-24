# Watcher working agreements

Read the profile-wide working agreements before work. Preserve dirty changes.

## Release ownership

As of 2026-10-24, CI/CD coordination defaults to ChatGPT Cloud. Native Mac
builds, signing/notarization and release QA require a compatible remote Mac
runner; Intel hardware acceptance requires real Intel hardware. Do not run
release CI/CD on the personal Mac without a direct user exception.

Watcher cloud release owner and remote signing runner are not configured yet.
The hosted release workflow remains disabled and repository signing secrets
are absent. Do not claim migration is complete, enable schedules, provision
paid runners, or copy personal Keychains/profiles/credential files. Use protected
cloud credentials when an authorized release path is available.

Keep paired npm/Mac publication gates in `mac/Scripts/publish-release.mjs`:
clean actual merged main, successful CI, matching source tree/version, signed
and stapled notarized artifacts, and verified uploaded checksums. See
`mac/README.md` and `docs/menu-bar-icon-status.md`. An approved per-release
exception does not change the default ownership policy.

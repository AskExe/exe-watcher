# Watcher icon and menu bar update

Branch: `codex/watcher-icon-animation`, based on released 0.2.71.

The app shipped only a pre-rounded legacy ICNS. Tahoe expects square unmasked
artwork and applies the enclosure itself. Packaging now compiles the opaque
`mac/Assets.xcassets` AppIcon with `actool`, declares CFBundleIconName and retains
the independent legacy ICNS for older systems. The source generator owns the
unmasked SVG and all catalog sizes. Reference:
https://developer.apple.com/design/human-interface-guidelines/app-icons/

The menu badge draws the actual text ink and owl silhouette on one optical
center. Continuous gentle looks/blinks run even with the popover closed; Settings
contains a persisted default-on animation toggle. Off and Reduce Motion stop all
menu owl motion. The animation sleeps between motions and during system sleep.

Checks: 211 native tests pass serially, including rendered-ink alignment within
one pixel, live moving poses, cancellation and no callbacks after disabling.
The first parallel run hit existing cache/history timing assertions on a host
with load average around 290; the unchanged tests passed serially. Asset catalog
compilation, shell syntax and git diff checks passed. An isolated ad-hoc native
app showed the new setting and persisted its off choice. The preview was stopped;
installed production Watcher was not replaced. AppKit resolved the new icon;
Finder/Launchpad cache presentation should be rechecked after installing the
next signed update. No public release or Intel hardware qualification performed.

Next: review the change and run CI; release only through the authorized cloud
coordination/native runner process. Token usage unavailable.

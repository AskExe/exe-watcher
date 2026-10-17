# Watcher README owl animation

Branch: `codex/watcher-floating-quota`. Deliverable complete; no commit made.

- Embed `assets/owls/readme-owl.gif` in README; fallback is `assets/owls/readme-owl-still.png`.
- 512 × 512, 6.000 seconds, 90 frames at 15 fps, infinite loop, 225,514 bytes (220 KiB), silent.
- `assets/watcher-source.svg` is the unchanged supplied SVG. Gold body path, beak/wing cutouts, centered pupil holes, palette, and EXE placement are preserved. Animation adds two subtle glances, two blinks, and a 1.66px breathing movement. EXE stays fixed.
- HyperFrames 0.8.162 source: `index.html`, `index.motion.json`, `shot-plan.json`, `BRIEF.md`. Reproduce with `npx hyperframes render . --format gif --fps 15 --gif-loop 0 --workers 2 -o renders/readme-owl.gif`. Copy the result to the final asset path.
- `proofs/check.json`: lint, runtime, layout, motion assertions and contrast all pass with zero errors and warnings. Inspected opening, glance, blink and ending snapshots, plus final decoded contact sheet (`proofs/decoded-contact-sheet.png`).
- `proofs/gif-metadata.json`: decoded frame count, duration, loop and seam delta. Final-to-first average pixel channel difference is below 0.007/255; both poses are centered and fully open.
- Capture: screenshot path, hardware Apple GPU. No audio or external media. GIF uses an indexed palette; edges differ slightly from vector anti-aliasing.
- Editable preview: http://localhost:3002/#project/watcher-owl-motion. Studio preview remains running for review. Framey desktop editor: https://hyperframes.dev/studio/download.
- Latest usage: weekly 48% used / 52% remaining, resets 2026-10-22 06:13 UTC. Token counts unavailable.

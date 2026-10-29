# Third-party notices

## CodeBurn by AgentSeal

Exe Watcher includes code derived from [CodeBurn](https://github.com/getagentseal/codeburn), originally developed by [AgentSeal](https://github.com/getagentseal).

The initial source import on April 24, 2026 matches the 112 corresponding files in upstream revision `d3c4de03759f0ded38052874fa829709d27fe7c6` (package version 0.8.9). Its CLI/TUI, provider integrations, macOS app, subscription tracking, and analysis tools form Watcher's original foundation. Exe AI subsequently developed Watcher's branding, integrations, and other changes. See the repository's `docs/codeburn-upstream-review.md` for the comparison.

The native multi-provider quota adapters and response mapping also adapt the Codex, Kimi, Cursor, Copilot and Gemini readers from CodeBurn revision `9a40cc603fcd194caca9daa8c5134a61ea7e0e2b` (`src/quota/`). Watcher's adaptation uses independent native request admission and read-only credential access; it does not import the upstream OAuth rotation/write-back flows or provider vectors.

CodeBurn's original license is reproduced verbatim below. Exe AI's additional copyright notice appears in the root `LICENSE`.

```text
MIT License

Copyright (c) 2026 AgentSeal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Runtime dependencies and other bundled assets retain their own licenses. This CodeBurn notice does not replace them. Check the applicable upstream notices before importing further code or assets; current CodeBurn includes components with additional third-party terms.

## Odd Core Analytics

The CLI bundles the MIT-licensed `@odd-core/analytics/privacy` implementation.
The pinned source and artifact hashes are in `vendor/odd-core-analytics/PROVENANCE.json`;
its full license is included at `vendor/odd-core-analytics/LICENSE`. The native
Swift adapter follows the same restricted collection protocol.

## Odd Core Recovery

Watcher's account backup uses a pinned subset of Odd Core's MIT-licensed
`@odd/crypto` account recovery and backup engine. Source hashes and the small
Watcher/type-checking adaptations are in `vendor/odd-core-recovery/PROVENANCE.json`;
its license is included alongside it.

## Odd Community account typography

Account screens bundle the same unmodified Satoshi and Grandstander font files
as odd.community. Satoshi is by Indian Type Foundry and uses the
[ITF Free Font License](https://www.fontshare.com/licenses/itf-ffl), rather than
Watcher's MIT license. Grandstander uses the SIL Open Font License; its full
notice is bundled as `Grandstander-OFL.txt` in the Mac resources.

# Vendored browser modules

The Gaffer App has no build step (ADR 0014). These files are the packages' own ES module builds, byte for byte as
published on npm, served from here; the page maps the bare names to them with an import map (`index.html`). The
tests resolve the same names to the same files (`vitest.config.ts`).

| File | Package | Licence | sha256 |
|---|---|---|---|
| `preact.module.js` (+ `.map`) | `preact@10.29.8` (`dist/`), published 2026-08-01 | MIT, `LICENSE-preact.txt` | `c30e721ebfdc6e2ad4c18c14d2dfb82667829c8aec27de1207774e3fc16858a8` |
| `hooks.module.js` (+ `.map`) | `preact@10.29.8` (`hooks/dist/`) | MIT, `LICENSE-preact.txt` | `a6ee626f2d01570592dd569a792e3f050154aa02890eead8c223fa3ed5aa3d5a` |
| `htm.module.js` | `htm@3.1.1` (`dist/`), published 2022-04-26 | Apache-2.0, `LICENSE-htm.txt` | `ab33dd3f38059b9be4d5f5350128eefb2356639c4e0bbe9d9e8b3ba75847e9e4` |

Preact 11.0 (2026-09-30) is not used yet (research 11 §5.3). To check or update: `npm pack preact@<v> htm@<v>`,
copy the files above, and compare the sums.

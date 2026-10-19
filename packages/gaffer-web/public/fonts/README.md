# Self-hosted fonts

The App makes no third-party request (NFR-PRIV-02), so its fonts are served from here. WOFF2 files from Fontsource's
npm packages, Latin (and, for the display and body faces, Latin Extended, for names like Šeško); `style.css` maps them
with the same `unicode-range`s Fontsource uses. All are under the SIL Open Font License 1.1 (the `LICENSE-*.txt` files).

| Family | Weights | Package |
|---|---|---|
| Barlow Condensed (display) | 600, 700 | `@fontsource/barlow-condensed@5.2.6` |
| IBM Plex Sans (body) | 400, 500, 600 | `@fontsource/ibm-plex-sans@5.2.8` |
| IBM Plex Mono (figures) | 400, 500, 600 | `@fontsource/ibm-plex-mono@5.2.7` |

`shasum -a 256 *.woff2` is recorded in BUILD.md (M1.1-3).

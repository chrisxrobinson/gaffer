# Self-hosted fonts

The App makes no third-party request (NFR-PRIV-02), so its fonts are served from here. WOFF2 files from Fontsource's
npm packages, Latin (and, for the display and body faces, Latin Extended, for names like Šeško); `style.css` maps them
with the same `unicode-range`s Fontsource uses. All are under the SIL Open Font License 1.1 (the `LICENSE-*.txt` files).

| Family | Weights | Package |
|---|---|---|
| Barlow Condensed (display) | 600, 700 | `@fontsource/barlow-condensed@5.2.6` |
| IBM Plex Sans (body) | 400, 500, 600 | `@fontsource/ibm-plex-sans@5.2.8` |
| IBM Plex Mono (figures) | 400, 500, 600 | `@fontsource/ibm-plex-mono@5.2.7` |

`shasum -a 256 *.woff2`, as vendored in M1.1-3:

```
0b281bf2f4179c06ba68f0a427f2341287c41eacc2ce9d534c6f5c513ac633fb  barlow-condensed-latin-600-normal.woff2
8320299532b4b81498d5b3714d49c9d5938883b55f4c2a1efe6f105bf4a942bd  barlow-condensed-latin-700-normal.woff2
13151e40ec9c07448e8a25535fb699661a3694ab2821ba62b3a49e365f62ea43  barlow-condensed-latin-ext-600-normal.woff2
9dbbaa9e884efd355c99d77730d93cce026c7a39fa50717e87de85b638007a3e  barlow-condensed-latin-ext-700-normal.woff2
08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7  ibm-plex-mono-latin-400-normal.woff2
01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22  ibm-plex-mono-latin-500-normal.woff2
0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83  ibm-plex-mono-latin-600-normal.woff2
3b646991d30055a93a4ecc499713d4347953a74a947ecab435ab72070cbdab0e  ibm-plex-sans-latin-400-normal.woff2
0717336fb31fcdcde4b8deb3675bb4a0f7f6d484864afcd6751ac29975962203  ibm-plex-sans-latin-500-normal.woff2
8960851d691c054ed38e259bdcf1a6190d157b4203ed5bb32c632a863fb8ec2f  ibm-plex-sans-latin-600-normal.woff2
c93d2a12aaa280f68b9ab7b726ff8dfedda67c99ef9abed047c1847a1cc6d583  ibm-plex-sans-latin-ext-400-normal.woff2
2846035d85100f84c79393f80f1442d4ee720129ab8b3ffa8969aae281db8c6c  ibm-plex-sans-latin-ext-500-normal.woff2
b25dfd4f979e442ae1e25cd0894463434cf01ba21ac1a35d39f4a82bd4cc060e  ibm-plex-sans-latin-ext-600-normal.woff2
```

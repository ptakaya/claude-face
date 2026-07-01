# Attribution & Licensing

## Project code
All source code in this repository is dedicated to the public domain under
**CC0 1.0 Universal** (see `LICENSE`). No attribution required — use, modify,
and redistribute freely, including for commercial purposes.

## 3D head mesh
`phase1/vendor/head-default.glb` — the single head shipped with this
project — is **CC0 / public domain**. It was built from a
[MakeHuman](http://www.makehumancommunity.org/) base body plus stock
eyes / teeth / tongue from the MPFB (MakeHuman Plugin for Blender) asset
library; both release their generated meshes under CC0. No attribution is
required to use, modify, or redistribute it.

## Runtime dependencies (installed separately, not bundled in this repo)
- **three.js** — MIT License. Installed via `npm install` (see
  `phase1/package.json`); not redistributed here.
- **HeadTTS** (optional, voice only) — MIT License, © Mika Suominen.
  Cloned separately from <https://github.com/met4citizen/HeadTTS> if you
  want speech; not bundled here.

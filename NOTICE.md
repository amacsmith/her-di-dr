# Notice

This repository is derived from **Herdr Studio** (formerly `herdr-gui`) by
Arthur — <https://github.com/powerfooI/herdr-studio> — used under the MIT
License.

## What that means here

- `LICENSE` carries the upstream copyright notice and permission notice
  **verbatim**, and is not edited. That is the whole of what the MIT License
  asks for, and it stays true of every copy of this code.
- The git history retains every upstream commit with its original author and
  date. That history, not this file, is the authoritative record of what came
  from where — a paragraph can go stale, `git log` cannot.
- Third-party notices inherited from upstream live in `LICENSES/`
  (Lobe Icons, Nerd Fonts, PI). They travel with the code for the same reason.

## Changes made here

Changes in this repository are Copyright (c) 2026 Alex Macdonald-Smith and are
released under the same MIT License, so anything downstream inherits one set of
terms rather than two.

## Staying current

`upstream` remains a configured remote. Upstream fixes are merged rather than
reimplemented, which keeps the attribution honest: work that is Arthur's
arrives as his commits.

```bash
git fetch upstream && git merge upstream/main
```

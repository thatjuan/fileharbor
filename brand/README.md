# File Harbor brand

The mark is a page drawn as a harbor seen from above. The page outline is the
breakwater, the open dog-ear corner is the harbor mouth, the folded flap is a
sail (send, amber) and the first line of text is a wave (receive, green). The
second line stays text, so it still reads as a document.

## Files

| File | Use |
| --- | --- |
| `logo-fileharbor.svg` | Full colour lockup, live text (needs Fraunces installed) |
| `logo-fileharbor-outlined.svg` | Full colour lockup, text as paths. Use this one by default |
| `logo-fileharbor-dark.svg` | Lockup in the night palette, for dark grounds |
| `logo-fileharbor-mono.svg` | Lockup in ink only |
| `logo-fileharbor-reversed.svg` | Lockup in white only, for dark or photographic grounds |
| `logo-fileharbor-icon.svg` | Mark alone, full colour |
| `logo-fileharbor-icon-dark.svg` | Mark alone, night palette |
| `logo-fileharbor-icon-mono.svg` | Mark alone, ink only |

## Geometry

The mark sits on a 128-unit grid (`viewBox="0 0 128 128"`):

- Walls: `M74 12H36A12 12 0 0 0 24 24V104A12 12 0 0 0 36 116H92A12 12 0 0 0 104 104V42`, stroke 12, round caps and joins.
- Sail: `M60 24Q83 33 92 56H60Z`, filled.
- Wave: `M40 67Q46 62 52 67T64 67T76 67T88 67`, stroke 8, round caps.
- Line: `M40 88H72`, stroke 8, round caps.

Lockups use `viewBox="18 6 479 116"`. The wordmark is Fraunces (SIL OFL) at
weight 560 with `opsz` 72, `SOFT` 100 and `WONK` 0, cap height 50 units,
centred on the page.

## Colour

| Role | Light | Night |
| --- | --- | --- |
| Walls, line, wordmark | `#1a1917` | `#f4f1ed` |
| Sail (send) | `#c4841a` | `#e0a04a` |
| Wave (receive) | `#2a9f5c` | `#3dba7a` |

These match `--color-ink`, `--color-send` and `--color-positive` in
`apps/web/src/styles/tokens.css`.

Keep clear space of at least the wall thickness × 2 (24 units) around the
mark. Below 24px, use the mark alone without the wordmark.

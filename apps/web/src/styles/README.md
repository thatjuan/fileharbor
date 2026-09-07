# Web styling system

The visual system is three files, imported by `main.tsx` in this order:

- `tokens.css` — every design token from `DESIGN.md` as a CSS custom property.
- `components.css` — the component grammar: shell, panels, tables, buttons,
  inputs, status, and the auth/public surfaces. Single source of truth.
- `../styles.css` — reset, element defaults, and generic text/layout
  utilities.

Order matters: `tokens.css` first, so the other two can consume the
variables.

## Source of truth

The canonical aesthetic spec is `DESIGN.md` at the repo root. Token names
mirror the DESIGN.md keys: `--color-accent` ← `{colors.accent}`,
`--font-size-body` ← `{typography.body}`, `--radius-card` ←
`{rounded.card}`, `--space-lg` ← `{spacing.lg}`.

Anything not in DESIGN.md should not be invented in this layer. Pages
compose the existing utilities and bring their own layout; they do not
redefine tokens and do not add grammar.

## Fonts

IBM Plex Mono, self-hosted via `@fontsource/ibm-plex-mono` at weights 400,
500 and 600 (imported in `main.tsx`). The stack falls back through
`ui-monospace`, `SFMono-Regular`, `Roboto Mono`, `Menlo`.

The console is monospace end to end. That is not a stylistic tic: short
codes, byte counts, timestamps and quota figures all sit in table columns,
and a proportional face would break the alignment that makes those columns
readable at a glance.

## Light and dark

Color tokens live in two blocks in `tokens.css`: `:root, [data-theme='dark']`
and `[data-theme='light']`. Dark is also the fallback if `data-theme` has
not been stamped yet. Light is a separately tuned ladder in the same hue
family, not an invert — status colours and hairlines are retuned so 14px
labels stay legible on paper. See "Light and dark" in `DESIGN.md`.

`data-theme` is written onto `<html>` by `/theme-boot.js` before first
paint (a static file, so it survives CSP `script-src 'self'`), then
re-applied by `ThemeProvider`. The stored preference is `fh:theme` =
`system | light | dark`. Default is `system`, which follows
`prefers-color-scheme`. The switcher lives in admin chrome, public nav,
and auth pages.

## Component grammar

`components.css` is organised in numbered sections, in this order:

1. Shell — `.app-shell` `.top-nav` `.rail` `.workspace` `.app-footer`
2. Page head — `.back-link` `.page-head` `.page-head-actions`
3. Containers — `.container` `.container-form` `.container-auth`
4. Panels and cards — `.panel` (+ head/body/foot/title/count), `.card`
5. Data tables — `.data-table` with `.num` `.cell-strong` `.cell-code`
   `.cell-actions` `.data-table-message`
6. Meta strip — `.meta-strip` `.meta-item` `.meta-label` `.meta-value`
7. Buttons — `.btn` × `.btn-accent` `.btn-ghost` `.btn-danger`, plus
   `.btn-icon` and `.btn-icon-bare`
8. Inputs — `.field` `.field-label` `.input` `.textarea` `.field-row`
9. Status and chips — `.status` + state, `.chip-receive` `.chip-send`
10. Share block — `.share-block` `.share-url` `.share-url-code`
11. Progress — `.progress` `.progress-track` `.progress-fill`
12. Drop zone — `.dropzone`, `.drop-overlay`
13. File rows — `.file-row` `.file-name` `.file-meta` `.file-actions`
14. Empty state — `.empty` `.empty-title` `.empty-hint`
15. Auth surfaces — `.auth-page` `.auth-layout` `.auth-panel` `.auth-aside`
16. Public surfaces — `.public-page` `.public-nav` `.public-column`

Icons are a separate concern: `components/Icons.tsx` holds the whole family
as 24×24 `currentColor` outlines at stroke 1.6. Pages import from there
rather than inlining SVG.

## Adding a page

Compose the existing classes: `.page-head`, a container, a `.panel` or
`.card`, and the field or table grammar inside it. Where a page needs a
one-off value (a specific gap, a progress width), use an inline style that
references a token — `style={{ marginTop: 'var(--space-md)' }}` — rather
than adding a class here.

## Adding a grammar

Don't, without discussing it first. The vocabulary is intentionally small:
sixteen sections cover ten screens, and it stays legible only while every
page draws from the same set. If two pages need the same new thing, that is
the signal to add it — one page needing it is the signal to use an inline
token style.

## What is intentionally NOT in this layer

- **No second accent.** Green is the only interactive colour. Blue marks the
  send/download direction and is never available for emphasis.
- **No extra elevation.** `--shadow-panel` is the only shadow, on `.panel`
  and floating menus. Depth otherwise comes from the surface ladder.
- **No gradients, no imagery, no illustration.**
- **No per-component focus styles.** The global `:focus-visible` ring in
  `styles.css` covers everything.
- **No invented data affordances.** If the API does not return it, the
  system has no class for displaying it.

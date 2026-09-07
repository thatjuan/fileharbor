# File Harbor — Harbor Console

## Overview

File Harbor is a tool an operator lives in, not a product they get sold. The
interface is an **operator console**: a near-black or paper canvas in the
same cool green-gray family, monospace throughout, one green accent, and
dense tables that stay legible after an hour of reading. Nothing on screen
is decorative, and nothing on screen is invented — every number the console
prints is one the server actually returned.

The chassis is fixed and the content scrolls. A slim top nav carries the
wordmark and the operator's identity; a left rail carries the link inventory
and the status filters; the workspace between them is the only thing that
moves. That layout exists for one reason: the operator can read to the bottom
of a long table without losing the counts or the create actions.

**Key characteristics:**

- Monospace everywhere (IBM Plex Mono). Short codes, byte counts, timestamps
  and labels all share one grid, which is what makes the tables scannable.
- A six-step surface ladder in one hue family, each step a few points apart.
  Depth reads as a change in weight, never as a change in hue. Dark is
  near-black; light is paper. Nearer surfaces are always lighter.
- Green is the single interactive accent. Blue marks the send/download
  direction, so a mixed list is readable without parsing the word.
- Caps and wide tracking mark chrome (column heads, field labels, rail
  headings). Content is never in caps.
- One elevation. `.panel` casts the only shadow in the system.
- No gradients, no imagery, no illustration, no second accent.
- Light and dark, switchable. Default follows the OS (`prefers-color-scheme`).
  See "Light and dark" below.

## Colors

Color tokens are theme-specific. Shared roles (canvas, rail, ink, accent)
keep the same names; the hexes change with `data-theme` on `<html>`.

### Surfaces

A ladder, not a palette. Every surface sits in the same cool green-gray
hue family; the steps are small so a nested container reads as _slightly
nearer_ rather than as a different material. Nearer is always lighter.

Dark (near-black):

- **Canvas** (`{colors.canvas}` — #090c0e): the page itself.
- **Rail** (`{colors.surface-rail}` — #0c1012): the left column.
- **Chrome** (`{colors.surface-chrome}` — #0d1113): top nav, footer, table
  header rows.
- **Panel** (`{colors.surface-panel}` — #0e1315): table and list containers.
- **Card** (`{colors.surface-card}` — #0f1416): rail cards, form sections,
  meta strips, share blocks.
- **Raised** (`{colors.surface-raised}` — #131719): inputs, chips, count
  badges, hovered rows.

Light (paper):

- **Canvas** — #e8ece9
- **Rail** — #ecefed
- **Chrome** — #eef1ee
- **Panel** — #f3f6f3
- **Card** — #f6f8f6
- **Raised** — #fbfcfb

### Hairlines

Two weights, and only two. More would turn a dense table into a grid of
boxes. Light hairlines are a step stronger than dark ones, because paper
needs more edge to separate surfaces that are only a few points apart.

- **Hairline** (`{colors.hairline}`): separates a container from the canvas.
  Dark #2a3032 · light #b7c0bb.
- **Hairline soft** (`{colors.hairline-soft}`): separates rows inside a
  container. Dark #1c2224 · light #d0d7d2.

### Text

Four steps. Anything below `muted` is decoration, not content. Neither
theme uses pure white or pure black — those glare over a long session.

- **Ink** (`{colors.ink}`): primary reading colour. Dark #d8dad7 · light
  #1c221f.
- **Ink secondary** (`{colors.ink-secondary}`): table cells, supporting
  copy. Dark #aeb1b0 · light #3e4742.
- **Ink muted** (`{colors.ink-muted}`): labels, captions, placeholders.
  Dark #909896 · light #5e6863.
- **Ink faint** (`{colors.ink-faint}`): disabled text, fine print. Dark
  #5d6664 · light #8b948e.

### Accent and status

The roles are identical in both themes. Light values are darkened so a
14px label still clears contrast against the paper canvas.

- **Accent** (`{colors.accent}`): the single interactive colour. Links,
  primary buttons, focus rings, active status. Dark #62c75a · light
  #247a30. Dimmed (`{colors.accent-dim}`) for borders and washed
  (`{colors.accent-wash}` — 12% alpha) for fills.
- **Send** (`{colors.send}`): the send/download direction only. It is an
  axis marker, not a second brand colour — it never appears on a button
  or a link. Dark #4699e5 · light #1a6fa8.
- **Warning** (`{colors.warning}`): quota exhausted. Dark #edb719 · light
  #8a6700.
- **Danger** (`{colors.danger}`): expired links, destructive actions. Dark
  #e2573f · light #c13c28.
- **Neutral** (`{colors.neutral}`): disabled links — the absence of a
  state rather than a state of its own. Dark #6d7674 · light #5c6562.

Each status colour also has a 12–14% wash used for chip and button fills.
Status text stays close to its hue but never so saturated that it becomes
hard to read against the canvas; the dot carries the colour, the label
carries the meaning.

## Typography

### Font family

`IBM Plex Mono`, falling back through `ui-monospace`, `SFMono-Regular`,
`Roboto Mono`, `Menlo`. Self-hosted via `@fontsource/ibm-plex-mono` at
weights 400, 500 and 600.

Monospace is the whole voice of the product. A proportional face for prose
would break the column alignment that makes a link table readable at a
glance, and the console has very little prose to begin with.

### Hierarchy

| Token                     | Size | Line height | Use                                   |
| ------------------------- | ---- | ----------- | ------------------------------------- |
| `{typography.title}`      | 20px | 1.30        | Page title (`h1`), weight 600         |
| `{typography.heading}`    | 17px | 1.35        | Section heading (`h2`), wordmark      |
| `{typography.subheading}` | 15px | 1.40        | Sub-heading (`h3`), empty-state title |
| `{typography.body}`       | 14px | 1.55        | Default body                          |
| `{typography.secondary}`  | 13px | 1.50        | Table cells, buttons, inputs, links   |
| `{typography.label}`      | 12px | 1.40        | Caps labels, panel titles             |
| `{typography.micro}`      | 11px | 1.35        | Column heads, hints, fine print       |

Weights: 400 default, 500 for emphasis, 600 for page titles only.

### Principles

- **Mono runs large.** The body step sits at 14px and the display steps stay
  restrained: a 20px title is a big title here. Borrowing a proportional
  type scale would make every screen shout.
- **Caps + tracking (`0.08em`) marks chrome.** Column heads, field labels,
  rail headings, panel titles. It signals "this is a name for the thing
  below", never content the operator reads for meaning.
- **Tabular numerals on anything countable.** Quota columns, byte counts,
  dates and counts all carry `font-variant-numeric: tabular-nums` so digits
  line up down the column.

## Layout

### Spacing

4px base: `{spacing.xxs}` 4 · `{spacing.xs}` 8 · `{spacing.sm}` 12 ·
`{spacing.md}` 16 · `{spacing.lg}` 24 · `{spacing.xl}` 32 ·
`{spacing.xxl}` 48.

Workspace padding is `lg`. Panel and card interiors are `md` and `lg`
respectively. Table cells are `sm` vertical / `md` horizontal — the density
that keeps twenty rows on screen without them touching.

### Shell

- Top nav: 52px, fixed.
- Left rail: 260px, fixed, scrolls independently.
- Workspace: the only scrolling region, max width 1460px.
- Below 900px the rail stops being a column and becomes a horizontally
  scrolling strip above the content. The counts are still worth seeing; the
  fixed column is not.

### Radius

`{rounded.xs}` 4 · `{rounded.sm}` 5 · `{rounded.card}` 6 ·
`{rounded.control}` 7 · `{rounded.lg}` 8 · `{rounded.pill}` full.

Containers use 6, controls use 7, and dots use full. Nothing in the console
is more rounded than 8px.

### Elevation

One shadow, same offset in both themes, applied to `.panel` and to
floating menus: dark `0 7px 3px rgba(0, 0, 0, 0.4)`, light
`0 7px 3px rgba(28, 34, 31, 0.12)`. Cards, inputs, buttons and chips are
flat — they are distinguished by their surface step and hairline, not by
depth.

## Components

The full vocabulary lives in `apps/web/src/styles/components.css`, which is
the single source of truth. In summary:

- **Shell** — `.app-shell` `.top-nav` `.rail` `.workspace` `.app-footer`
- **Page head** — `.back-link` `.page-head` `.page-head-actions`
- **Panels** — `.panel` `.panel-head` `.panel-title` `.panel-count`
  `.panel-body` `.panel-foot`, plus the standalone `.card`
- **Tables** — `.data-table` with `.num` `.cell-strong` `.cell-code`
  `.cell-actions` `.data-table-message`
- **Meta strip** — `.meta-strip` `.meta-item` `.meta-label` `.meta-value`
- **Buttons** — `.btn` × `.btn-accent` `.btn-ghost` `.btn-danger`, plus
  `.btn-icon` and `.btn-icon-bare`
- **Inputs** — `.field` `.field-label` `.input` `.textarea` `.field-row`
- **Status** — `<StatusBadge>` (`.status` + state), `.chip-receive`,
  `.chip-send`
- **Share block** — `.share-block` `.share-url` `.share-url-code`
- **Progress** — `.progress` `.progress-track` `.progress-fill`
- **Drop zone** — `.dropzone`, plus the full-viewport `.drop-overlay`
- **Empty state** — `.empty` `.empty-title` `.empty-hint`
- **Notice** — `.notice` `.notice-danger` `.notice-warning`
- **Auth** — `.auth-page` `.auth-layout` `.auth-panel` `.auth-aside`, plus
  `.auth-theme` for the theme switcher
- **Public** — `.public-page` `.public-nav` `.public-column`
- **Theme** — `<ThemeSwitcher>` (system / light / dark), default system

### Button grammar

Four roles and no more:

- **Accent** — the single primary action on a screen. If two buttons on one
  screen are accent, one of them is wrong.
- **Ghost** — everything else, including Cancel and secondary navigation.
- **Danger** — destructive only (Revoke, Delete).
- **Icon** — chrome (the notification bell) and per-row actions.

## Principles

### Never render a number the server did not return

The console shows link counts, status counts, quotas, download tallies, file
sizes and timestamps — all of which come from the API. It deliberately does
**not** show storage totals, host uptime, node health, uploader identity, or
per-file analytics, because File Harbor does not collect them. A console
that displays an invented number is worse than one that shows fewer numbers:
the operator has no way to know which figures they can trust.

### Actions live on detail screens

The dashboard table is read-only. Copying a URL, disabling a link, revoking
it, and deleting a file all happen on that link's detail screen, which stays
the single place a link can change. This keeps the inventory quiet and makes
destructive actions require a deliberate navigation.

### Public pages drop every operator affordance

`/r/:code` and `/s/:code` are seen by people who have never met the product.
They wear the same skin — same canvas, same type, same status colours — but
have no rail, no counts, and no admin nav. One centred column, and only the
information the visitor needs to complete their transfer.

### Light and dark

The console is a working surface read for long stretches. Dark was the
original skin: a near-black canvas with status colours tuned against
#090c0e, and a six-step ladder doing the work that borders and shadows
would otherwise have to do. Light is not an invert of that — it is the
same roles retuned against paper, so a 14px accent label and a hairline
still separate. Both palettes live in `tokens.css`, switched by
`data-theme` on `<html>`.

The stored preference is `system | light | dark` under `fh:theme`.
Default is `system`, which follows `prefers-color-scheme` and tracks it
live. A blocking boot script (`/theme-boot.js`) stamps `data-theme`
before CSS arrives so the first paint matches the OS (or the stored
override). The switcher sits in admin chrome, public nav, and the auth
pages — same three options everywhere.

## Iteration guide

- Compose the existing classes. Pages own their layout, never the
  vocabulary.
- Do not add a token. If a value isn't in `tokens.css`, either it should be
  and the whole system should adopt it, or the design should use an existing
  step.
- Do not add a second accent. Blue is the direction axis; it is not
  available for emphasis.
- Do not add a shadow. Depth comes from the surface ladder.
- Keep hover states subtle: a surface step, a border tint. The focus ring is
  handled globally and should not be redefined per component.

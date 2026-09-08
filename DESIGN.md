# File Harbor

## Overview

File Harbor is a tool an operator lives in, not a product they get sold. The
interface is a **light editorial ops console**: Inter for reading, a warm
paper canvas, near-black primary actions, and tables with enough air that a
long session does not feel like a terminal. Green is a status colour, not
the brand. Nothing on screen is decorative, and nothing on screen is
invented — every number the product prints is one the server actually
returned.

The chassis is fixed and the content scrolls. A slim top nav carries the
wordmark and the operator's identity; a left rail carries the link inventory
and the status filters; the workspace between them is the only thing that
moves. That layout exists for one reason: the operator can read to the bottom
of a long table without losing the counts or the create actions.

**Key characteristics:**

- Inter for words. Roboto Mono only for short codes. Tables stay scannable
  because labels are sentence-case and rows are tall, not because every
  glyph sits on a coding grid.
- Light-first: `#fbf8f5` canvas, white nav, warm rail, `#e0ddda` hairlines.
  Dark is the same roles at night, not a CRT restyle.
- Near-black (`#1a1917`) is the single interactive colour: solid buttons,
  links, focus rings. Green marks Active / receive. Amber marks send and
  Expired. Red marks quota exhausted and destructive actions.
- Sentence-case chrome. Column heads, field labels, and page copy read as
  English. Rail section labels are the exception: small uppercase tracking.
- One quiet elevation. `.panel` casts `0 1px 2px` and nothing else. The
  dashboard inventory table sits on the canvas, not in a card.
- No gradients, no imagery, no illustration.
- Light and dark, switchable. Default follows the OS (`prefers-color-scheme`).

## Colors

Color tokens are theme-specific. Shared roles (canvas, rail, ink, accent)
keep the same names; the hexes change with `data-theme` on `<html>`.

### Surfaces

Light is white cards on warm paper. Dark is the same idea on a warm
near-black page. Surfaces are distinguished by hairlines, not by a
six-step CRT ladder.

Light:

- **Canvas** (`{colors.canvas}` — #fbf8f5): the page itself.
- **Rail** — #fdfbf9.
- **Chrome / panel / card** — #ffffff.
- **Raised** (`{colors.surface-raised}` — #f0eeec): hovered rows, selected
  rail, chips.

Dark:

- **Canvas** — #141311.
- **Rail** — #181614.
- **Chrome** — #1c1a18.
- **Panel / card** — #1f1d1b.
- **Raised** — #262320.

### Hairlines

Two weights, and only two. More would turn a dense table into a grid of
boxes. Light hairlines are a step stronger than dark ones, because paper
needs more edge to separate surfaces that are only a few points apart.

- **Hairline** (`{colors.hairline}`): separates a container from the canvas.
  Light #e0ddda · dark #3a3632.
- **Hairline soft** (`{colors.hairline-soft}`): separates rows inside a
  container. Light #ece9e6 · dark #2c2926.

### Text

Four steps. Anything below `muted` is decoration, not content. Neither
theme uses pure white or pure black — those glare over a long session.

- **Ink** (`{colors.ink}`): primary reading colour. Light #1a1917 · dark
  #f4f1ed.
- **Ink secondary** (`{colors.ink-secondary}`): table cells, supporting
  copy. Light #3d3a36 · dark #c9c3bb.
- **Ink muted** (`{colors.ink-muted}`): labels, captions, placeholders.
  Light #6b6762 · dark #8e887f.
- **Ink faint** (`{colors.ink-faint}`): disabled text, fine print. Light
  #9a958f · dark #6b665f.

### Accent and status

The roles are identical in both themes. Light values are darkened so a
14px label still clears contrast against the paper canvas.

- **Accent** (`{colors.accent}`): the single interactive colour. Links,
  focus rings, solid buttons. Light #1a1917 · dark #f4f1ed. Solid buttons
  use `{colors.accent-solid}` with `{colors.on-accent}` type (white on
  light, ink on dark). Washed (`{colors.accent-wash}`) for selected rail
  rows.
- **Positive** (`{colors.positive}`): Active status and the receive
  direction. Light #2a9f5c · dark #3dba7a. Never used on a button.
- **Send** (`{colors.send}`): the send/download direction only. It is an
  axis marker, not a second brand colour — it never appears on a button
  or a link. Light #c4841a · dark #e0a04a.
- **Warning** (`{colors.warning}`): expired links. Light #c47b12 · dark
  #e0a04a.
- **Danger** (`{colors.danger}`): quota exhausted, destructive actions.
  Light #e24b3c · dark #e24b3c.
- **Neutral** (`{colors.neutral}`): disabled links — the absence of a
  state rather than a state of its own. Light #6b6b6b · dark #7a847f.

Each status colour also has a 12–14% wash used for chip and button fills.
Status text stays close to its hue but never so saturated that it becomes
hard to read against the canvas; the dot carries the colour, the label
carries the meaning.

## Typography

### Font family

`Inter` at 400 / 500 / 600 / 700 for everything an operator reads. `Roboto
Mono` at 400 / 500 only for short codes. Both self-hosted via `@fontsource`.

A proportional face is the point: the old CRT look made every label feel
like a syslog. Codes stay mono so they still look like data.

### Hierarchy

| Token                     | Size | Line height | Use                                   |
| ------------------------- | ---- | ----------- | ------------------------------------- |
| `{typography.title}`      | 36px | 1.15        | Page title (`h1`), weight 700         |
| `{typography.heading}`    | 16px | 1.35        | Section heading (`h2`)                |
| `{typography.subheading}` | 15px | 1.40        | Sub-heading (`h3`), empty-state title |
| `{typography.body}`       | 14px | 1.50        | Default body, table cells, buttons    |
| `{typography.secondary}`  | 14px | 1.45        | Supporting copy                       |
| `{typography.label}`      | 13px | 1.40        | Field labels                          |
| `{typography.micro}`      | 12px | 1.35        | Column heads, hints, fine print       |

Weights: 400 default, 500 for labels and emphasis, 700 for titles and the
wordmark.

### Principles

- **Sentence case for chrome.** Column heads, field labels, page copy.
  Rail section labels (`Inventory`, `Filter by status`) are the one
  uppercase exception, set small with tracking.
- **Mono is a data face.** Short codes only. Not timestamps, not labels.
- **Tabular numerals on anything countable.** Quota columns, byte counts,
  dates and counts carry `font-variant-numeric: tabular-nums`.

## Layout

### Spacing

4px base: `{spacing.xxs}` 4 · `{spacing.xs}` 8 · `{spacing.sm}` 12 ·
`{spacing.md}` 16 · `{spacing.lg}` 24 · `{spacing.xl}` 32 ·
`{spacing.xxl}` 48.

Workspace padding is `xl`. Panel and card interiors are `md` and `lg`
respectively. Table cells are 16px vertical / 16px horizontal — dense
enough for a long inventory, tall enough to read.

### Shell

- Top nav: 72px, fixed.
- Left rail: 300px, fixed, scrolls independently.
- Workspace: the only scrolling region, max width 1460px.
- Below 900px the rail stops being a column and becomes a horizontally
  scrolling strip above the content. The counts are still worth seeing; the
  fixed column is not.

### Radius

`{rounded.xs}` 4 · `{rounded.sm}` 8 · `{rounded.card}` 14 ·
`{rounded.control}` 12 · `{rounded.lg}` 16 · `{rounded.pill}` full.

Cards and controls are generously rounded. Dots use full.

### Elevation

One quiet shadow on `.panel` and floating menus: light
`0 1px 2px rgba(26, 25, 23, 0.04)`, dark `0 1px 3px rgba(0, 0, 0, 0.35)`.
Hairlines do the rest. The dashboard inventory uses `.panel-plain` and
casts no shadow.

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
- **Buttons** — `.btn` × `.btn-accent` `.btn-soft` `.btn-ghost` `.btn-danger`,
  plus `.btn-icon` and `.btn-icon-bare`
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

- **Accent** — the single primary action on a screen (solid near-black,
  white type). If two buttons on one screen are accent, one of them is
  wrong. "New receive link" in the rail is accent.
- **Ghost** — everything else, including Cancel, "New send link", and
  secondary navigation.
- **Danger** — destructive only (Revoke, Delete).
- **Icon** — per-row actions. Nav chrome is labelled `.nav-item` text,
  not icon-only.

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

Light is the designed default of this visual language (12ui candidate A).
Dark keeps the same roles at night. Both palettes live in `tokens.css`,
switched by `data-theme` on `<html>`.

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
- Do not add a second shadow. `--shadow-panel` is the only elevation.
- Keep hover states subtle: a surface step, a border tint. The focus ring is
  handled globally and should not be redefined per component.

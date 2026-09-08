# File Harbor

## Overview

File Harbor is a tool an operator lives in, not a product they get sold. The
interface is a **quiet harbor office**: Inter for reading, a near-white
canvas with white cards, one forest-green accent, and tables with enough
air that a long session does not feel like a terminal. Nothing on screen
is decorative, and nothing on screen is invented — every number the product
prints is one the server actually returned.

The chassis is fixed and the content scrolls. A slim top nav carries the
wordmark and the operator's identity; a left rail carries the link inventory
and the status filters; the workspace between them is the only thing that
moves. That layout exists for one reason: the operator can read to the bottom
of a long table without losing the counts or the create actions.

**Key characteristics:**

- Inter for words. Roboto Mono only for short codes. Tables stay scannable
  because labels are sentence-case and rows are tall, not because every
  glyph sits on a coding grid.
- Light-first: `#fefdfd` canvas, white rail/nav/cards, `#e7e7e7` hairlines.
  Dark is the same roles at night, not a CRT restyle.
- Forest green (`#137c43` solid, `#28704d` text) is the single interactive
  accent. A quieter blue marks the send/download direction.
- Sentence-case chrome. Column heads, field labels, and rail headings read
  as English, not as a mainframe panel.
- One quiet elevation. `.panel` casts `0 1px 3px` and nothing else.
- No gradients, no imagery, no illustration, no second accent.
- Light and dark, switchable. Default follows the OS (`prefers-color-scheme`).

## Colors

Color tokens are theme-specific. Shared roles (canvas, rail, ink, accent)
keep the same names; the hexes change with `data-theme` on `<html>`.

### Surfaces

Light is white cards on a near-white page. Dark is the same idea on a
near-black page. Surfaces are distinguished by hairlines, not by a
six-step CRT ladder.

Light:

- **Canvas** (`{colors.canvas}` — #fefdfd): the page itself.
- **Rail / chrome / panel / card** — #ffffff.
- **Raised** (`{colors.surface-raised}` — #fafafa): hovered rows, chips.

Dark:

- **Canvas** — #111413.
- **Rail / chrome** — #161a18.
- **Panel / card** — #1c211e.
- **Raised** — #242a27.

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
  Light #e7e7e7 · dark #2c3430.
- **Hairline soft** (`{colors.hairline-soft}`): separates rows inside a
  container. Light #ececec · dark #232a27.

### Text

Four steps. Anything below `muted` is decoration, not content. Neither
theme uses pure white or pure black — those glare over a long session.

- **Ink** (`{colors.ink}`): primary reading colour. Light #191919 · dark
  #f2f4f2.
- **Ink secondary** (`{colors.ink-secondary}`): table cells, supporting
  copy. Light #393939 · dark #c5cbc6.
- **Ink muted** (`{colors.ink-muted}`): labels, captions, placeholders.
  Light #555555 · dark #8b938e.
- **Ink faint** (`{colors.ink-faint}`): disabled text, fine print. Light
  #8b8b8b · dark #6b746f.

### Accent and status

The roles are identical in both themes. Light values are darkened so a
14px label still clears contrast against the paper canvas.

- **Accent** (`{colors.accent}`): the single interactive colour. Links,
  focus rings, active status, quiet fills. Light #28704d · dark #3dba7a.
  Solid buttons use `{colors.accent-solid}` (#137c43) with white type.
  Washed (`{colors.accent-wash}`) for selected rail rows and receive chips.
- **Send** (`{colors.send}`): the send/download direction only. It is an
  axis marker, not a second brand colour — it never appears on a button
  or a link. Light #3d6a8a · dark #6aa3d4.
- **Warning** (`{colors.warning}`): quota exhausted. Light #c47b12 · dark
  #e0a04a.
- **Danger** (`{colors.danger}`): expired links, destructive actions. Light
  #e24b3c · dark #e24b3c.
- **Neutral** (`{colors.neutral}`): disabled links — the absence of a
  state rather than a state of its own. Light #6b6b6b · dark #7a847f.

Each status colour also has a 12–14% wash used for chip and button fills.
Status text stays close to its hue but never so saturated that it becomes
hard to read against the canvas; the dot carries the colour, the label
carries the meaning.

## Typography

### Font family

`Inter` at 400 / 500 / 600 for everything an operator reads. `Roboto Mono`
at 400 / 500 only for short codes. Both self-hosted via `@fontsource`.

A proportional face is the point: the old CRT look made every label feel
like a syslog. Codes stay mono so they still look like data.

### Hierarchy

| Token                     | Size | Line height | Use                                   |
| ------------------------- | ---- | ----------- | ------------------------------------- |
| `{typography.title}`      | 22px | 1.30        | Page title (`h1`), weight 600         |
| `{typography.heading}`    | 16px | 1.35        | Section heading (`h2`), wordmark      |
| `{typography.subheading}` | 15px | 1.40        | Sub-heading (`h3`), empty-state title |
| `{typography.body}`       | 14px | 1.50        | Default body, table cells, buttons    |
| `{typography.secondary}`  | 14px | 1.45        | Supporting copy                       |
| `{typography.label}`      | 13px | 1.40        | Field labels, rail headings           |
| `{typography.micro}`      | 12px | 1.35        | Column heads, hints, fine print       |

Weights: 400 default, 500 for labels and emphasis, 600 for titles and the
wordmark.

### Principles

- **Sentence case for chrome.** Column heads, field labels, rail headings.
  Caps tracking is gone.
- **Mono is a data face.** Short codes only. Not timestamps, not labels.
- **Tabular numerals on anything countable.** Quota columns, byte counts,
  dates and counts carry `font-variant-numeric: tabular-nums`.

## Layout

### Spacing

4px base: `{spacing.xxs}` 4 · `{spacing.xs}` 8 · `{spacing.sm}` 12 ·
`{spacing.md}` 16 · `{spacing.lg}` 24 · `{spacing.xl}` 32 ·
`{spacing.xxl}` 48.

Workspace padding is `lg`. Panel and card interiors are `md` and `lg`
respectively. Table cells are 14px vertical / 16px horizontal — dense
enough for a long inventory, tall enough to read.

### Shell

- Top nav: 64px, fixed.
- Left rail: 280px, fixed, scrolls independently.
- Workspace: the only scrolling region, max width 1460px.
- Below 900px the rail stops being a column and becomes a horizontally
  scrolling strip above the content. The counts are still worth seeing; the
  fixed column is not.

### Radius

`{rounded.xs}` 4 · `{rounded.sm}` 6 · `{rounded.card}` 8 ·
`{rounded.control}` 8 · `{rounded.lg}` 10 · `{rounded.pill}` full.

Cards and controls share 8px. Dots use full.

### Elevation

One quiet shadow on `.panel` and floating menus: light
`0 1px 3px rgba(0, 0, 0, 0.04)`, dark `0 1px 3px rgba(0, 0, 0, 0.35)`.
Hairlines do the rest.

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

- **Accent** — the single primary action on a screen (solid green, white
  type). If two buttons on one screen are accent, one of them is wrong.
- **Soft** — a quieter green fill, used for "New receive link" in the rail.
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

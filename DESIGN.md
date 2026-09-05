# File Harbor — Harbor Console

## Overview

File Harbor is a tool an operator lives in, not a product they get sold. The
interface is a **dark operator console**: a near-black canvas, monospace
throughout, one green accent, and dense tables that stay legible after an
hour of reading. Nothing on screen is decorative, and nothing on screen is
invented — every number the console prints is one the server actually
returned.

The chassis is fixed and the content scrolls. A slim top nav carries the
wordmark and the operator's identity; a left rail carries the link inventory
and the status filters; the workspace between them is the only thing that
moves. That layout exists for one reason: the operator can read to the bottom
of a long table without losing the counts or the create actions.

**Key characteristics:**

- Monospace everywhere (IBM Plex Mono). Short codes, byte counts, timestamps
  and labels all share one grid, which is what makes the tables scannable.
- A six-step near-black surface ladder, each step one to three points apart.
  Depth reads as a change in weight, never as a change in hue.
- Green is the single interactive accent. Blue marks the send/download
  direction, so a mixed list is readable without parsing the word.
- Caps and wide tracking mark chrome (column heads, field labels, rail
  headings). Content is never in caps.
- One elevation. `.panel` casts the only shadow in the system.
- No gradients, no imagery, no illustration, no second accent.
- Dark only. There is no light mode — see "Why dark only" below.

## Colors

### Surfaces

A ladder, not a palette. Every surface is a near-black in the same hue
family; the steps are deliberately small so a nested container reads as
_slightly nearer_ rather than as a different material.

- **Canvas** (`{colors.canvas}` — #090c0e): the page itself.
- **Rail** (`{colors.surface-rail}` — #0c1012): the left column.
- **Chrome** (`{colors.surface-chrome}` — #0d1113): top nav, footer, table
  header rows.
- **Panel** (`{colors.surface-panel}` — #0e1315): table and list containers.
- **Card** (`{colors.surface-card}` — #0f1416): rail cards, form sections,
  meta strips, share blocks.
- **Raised** (`{colors.surface-raised}` — #131719): inputs, chips, count
  badges, hovered rows.

### Hairlines

Two weights, and only two. More would turn a dense table into a grid of
boxes.

- **Hairline** (`{colors.hairline}` — #2a3032): separates a container from
  the canvas.
- **Hairline soft** (`{colors.hairline-soft}` — #1c2224): separates rows
  inside a container.

### Text

Four steps. Anything below `muted` is decoration, not content.

- **Ink** (`{colors.ink}` — #d8dad7): primary reading colour. Not pure white
  — white on near-black glares over a long session.
- **Ink secondary** (`{colors.ink-secondary}` — #aeb1b0): table cells,
  supporting copy.
- **Ink muted** (`{colors.ink-muted}` — #909896): labels, captions,
  placeholders.
- **Ink faint** (`{colors.ink-faint}` — #5d6664): disabled text, fine print.

### Accent and status

- **Accent** (`{colors.accent}` — #62c75a): the single interactive colour.
  Links, primary buttons, focus rings, active status. Dimmed
  (`{colors.accent-dim}` — #43833d) for borders and washed
  (`{colors.accent-wash}` — 12% alpha) for fills.
- **Send** (`{colors.send}` — #4699e5): the send/download direction only. It
  is an axis marker, not a second brand colour — it never appears on a
  button or a link.
- **Warning** (`{colors.warning}` — #edb719): quota exhausted.
- **Danger** (`{colors.danger}` — #e2573f): expired links, destructive
  actions.
- **Neutral** (`{colors.neutral}` — #6d7674): disabled links — the absence of
  a state rather than a state of its own.

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

One shadow: `0 7px 3px rgba(0, 0, 0, 0.4)`, applied to `.panel` and to
floating menus. Cards, inputs, buttons and chips are flat — they are
distinguished by their surface step and hairline, not by depth.

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
- **Auth** — `.auth-page` `.auth-layout` `.auth-panel` `.auth-aside`
- **Public** — `.public-page` `.public-nav` `.public-column`

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

### Why dark only

The console is a working surface read for long stretches, and the near-black
canvas is load-bearing: the four status colours are tuned against #090c0e,
and the six-step surface ladder does the work that borders and shadows would
otherwise have to do. A light counterpart would need its own tuning of all
ten of those values to stay legible, which is a second design system rather
than a token swap. Until there is a reason to carry two, there is one.

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

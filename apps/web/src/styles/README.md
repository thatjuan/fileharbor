# Web styling system

The visual system is defined in three files:

- `tokens.css` — every design token from `DESIGN.md` as a CSS custom property.
- `components.css` — utility classes for buttons, cards, tiles, inputs, nav, footer, status badge. Single source of truth.
- `styles.css` — base reset, typography defaults, generic layout utilities (`.page`, `.stack`, `.row`, etc.).

All three are imported by `main.tsx`; the order matters (`tokens.css` first so the rest can consume the variables).

## Source of truth

The canonical aesthetic spec is `DESIGN.md` at the repo root. Token names mirror the DESIGN.md keys: `--color-primary` ← `{colors.primary}`, `--font-size-body` ← `{typography.body}`, `--radius-pill` ← `{rounded.pill}`, `--space-section` ← `{spacing.section}`.

Anything not in DESIGN.md should not be invented in this layer. Specific surfaces (pages, components) compose the existing utilities and bring their own layout logic; they do not redefine tokens or grammar classes.

## Fonts

DESIGN.md's "Note on Font Substitutes" prescribes:

- `system-ui, -apple-system, BlinkMacSystemFont` first → macOS/iOS visitors get real SF Pro.
- **Inter** as the cross-platform substitute. Self-hosted via `@fontsource-variable/inter`.

Variable Inter ships all weights in one file, so the 300 / 400 / 600 / 700 ladder DESIGN.md uses is available without per-weight imports.

## Dark mode

`@media (prefers-color-scheme: dark)` in `tokens.css` overrides surface, text, and hairline tokens. The interactive accent `--color-primary` (Action Blue) **does not change** across modes per DESIGN.md's "single accent is non-negotiable" rule.

DESIGN.md "Known Gaps" admits that dark-mode card/input tokens were not surfaced in the analyzed pages. The mapping below is an extrapolation grounded in the existing near-black tile family:

| Light token                               | Dark override                               |
| ----------------------------------------- | ------------------------------------------- |
| `--color-canvas` (#ffffff)                | `--color-surface-tile-1` (#272729)          |
| `--color-canvas-parchment` (#f5f5f7)      | `--color-surface-tile-2` (#2a2a2c)          |
| `--color-surface-pearl` (#fafafc)         | `--color-surface-tile-3` (#252527)          |
| `--color-ink`, `--color-body` (#1d1d1f)   | `#ffffff` (`body-on-dark`)                  |
| `--color-ink-muted-80` (#333)             | `rgba(255, 255, 255, 0.7)`                  |
| `--color-ink-muted-48` (#7a7a7a)          | `rgba(255, 255, 255, 0.45)`                 |
| `--color-hairline` (#e0e0e0)              | `rgba(255, 255, 255, 0.08)`                 |
| `--color-divider-soft` (rgba(0,0,0,0.04)) | `rgba(255, 255, 255, 0.04)`                 |
| `--color-primary` (#0066cc)               | **unchanged**                               |
| `--color-primary-on-dark` (#2997ff)       | **unchanged** (already the on-dark variant) |

Inline links rendered on a `.tile-dark*` surface should pick up the brighter Sky Link Blue by adding the `text-link-on-dark` class or wrapping a region with the `.on-dark` scope.

## Component grammars

`components.css` provides:

- **Buttons**: `.btn-primary`, `.btn-secondary-pill`, `.btn-dark-utility`, `.btn-pearl-capsule`, `.btn-store-hero`, `.btn-icon-circular`. All carry the `transform: scale(0.95)` active state and the focus-visible ring.
- **Inputs**: `.input-pill` (pill radius — search input grammar) and `.input-rect` (11px radius). Pair with `.input-label`.
- **Tiles**: `.tile` plus surface variants `.tile-light`, `.tile-parchment`, `.tile-dark`, `.tile-dark-2`, `.tile-dark-3`. Each is full-bleed and pads `--space-section` vertically.
- **Cards**: `.store-card` (column layout), `.store-card-row` (horizontal layout), and `.store-card-grid` (3 / 2 / 1 column responsive grid).
- **Containers**: `.container-wide` (1440px), `.container-narrow` (980px), `.container-form` (640px), `.container-auth` (480px).
- **Nav**: `.global-nav`, `.sub-nav`, `.admin-footer`.
- **Status**: `.status-badge` + variants `.status-badge-active`, `.status-badge-disabled`, `.status-badge-expired`, `.status-badge-quota_exhausted`. The `<StatusBadge>` component renders these.

## Adding a new locale, page, or component

Adding a new **page**: compose existing utilities (`.page`, `.container-narrow`, `.tile-parchment`, `.btn-primary`). Do not write inline styles unless the value isn't expressible as a token.

Adding a new **grammar**: do not. Talk to the codebase owner first; the system intentionally has a small vocabulary.

Adding a **dark-mode fix**: extend the dark-mode block in `tokens.css`, never override per-component in `components.css`.

## What's intentionally NOT in this layer

- No hover states. DESIGN.md "Iteration Guide": default + active only.
- No drop shadows on UI elements. The single `--shadow-product` is reserved for product imagery (currently unused — File Harbor has no product imagery surface).
- No second accent. Action Blue is the only interactive colour.
- No gradient tokens. Atmosphere comes from imagery, not CSS.
- No weight 500. Ladder is 300 / 400 / 600 / 700.

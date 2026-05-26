# Execution Plan: Web UI Redesign per DESIGN.md (#44–#51)

## Overview

Translate `DESIGN.md` (Apple-inspired refined minimal) into the codebase across every web surface. Foundation token layer → admin chrome + shared primitives → each surface in parallel. Bundled into a single PR with one commit per wave so reviewers can step through.

## Goals

1. CSS-variable token system covering every `{colors.*}` / `{typography.*}` / `{spacing.*}` / `{rounded.*}` / shadow token in DESIGN.md.
2. Inter via `@fontsource/inter`; system-ui first in the stack so macOS gets SF Pro.
3. Auto dark mode via `prefers-color-scheme: dark` with an explicit token mapping.
4. AdminShell + global-nav + sub-nav-frosted + footer chrome.
5. Shared component primitives (StatusBadge, button + card utility classes) defined once in W2 and reused by all surface slices.
6. Public pages (`/r/:code`, `/s/:code`), auth (`LoginPage`, `SetupPage`), Dashboard, New-link forms, Detail pages, Notifications all redesigned.
7. i18n preserved — no translation keys changed; only markup/styling.
8. No backend changes; no behavioral changes to upload/download/auth flows.

## Architectural Rules (apply to every wave)

> **DESIGN.md is canonical.** The `frontend-design` skill is consulted only for craft-quality guidance (spacing precision, typography refinement, motion restraint). DESIGN.md explicitly chooses Inter as the SF Pro substitute and the refined-minimal aesthetic — `frontend-design`'s "no Inter / no generic / be maximalist" guidance does NOT apply here. Single accent (Action Blue), no decorative gradients, no shadows except the one product shadow.

> **Shared primitives are W2's job.** `StatusBadge`, `AdminShell`, and any new shared component / utility CSS class lands in W2. W3 surface agents must NOT modify W2 outputs — they consume the classes/components as-is.

> **i18n preserved.** PR #43 wired translation keys into `PublicReceivePage` and `PublicSendPage`. The redesign must preserve every `t('...')` and `<Trans>` call exactly; only markup/styling changes.

> **Dark mode token mapping (explicit).** DESIGN.md does not surface dark-card/input tokens. W1 will define:
>
> - `--color-canvas` → `--color-surface-tile-1` (#272729)
> - `--color-canvas-parchment` → `--color-surface-tile-2` (#2a2a2c)
> - `--color-surface-pearl` → `--color-surface-tile-3` (#252527)
> - `--color-ink`, `--color-body` → `--color-body-on-dark` (#ffffff)
> - `--color-ink-muted-80` → `rgba(255, 255, 255, 0.7)`
> - `--color-ink-muted-48` → `rgba(255, 255, 255, 0.45)`
> - `--color-hairline` → `rgba(255, 255, 255, 0.08)`
> - `--color-divider-soft` → `rgba(255, 255, 255, 0.04)`
> - `--color-primary` stays `#0066cc`. Inline links on dark surfaces use `--color-primary-on-dark` (#2997ff) — automatic via a `.on-dark` scope class where needed.

## Execution Waves

### Wave 1 — `#44` tokens, fonts, base styles

Single agent (orchestrator).

- `apps/web/package.json` adds `@fontsource/inter` (Variable). Import at `apps/web/src/main.tsx`: `import '@fontsource-variable/inter';` (covers all weights). Use the variable font for full 300/400/600/700 ladder DESIGN.md needs.
- Create `apps/web/src/styles/tokens.css`:
  - `:root` block — every color/type/space/radius/shadow token as a CSS custom prop.
  - `@media (prefers-color-scheme: dark) { :root { ... } }` block — override surface/text/hairline tokens per the explicit mapping above.
- Rewrite `apps/web/src/styles.css` as a base sheet consuming the tokens. Keep existing utility classes (`.page`, `.stack`, `.row`, `.row.between`, `.muted`, `.small`, `.error`, `.success`, `.list-reset`, `.card`, `.button-link`, `.button-danger`) but redefine them in token terms. Drop or relocate the badge/admin-nav rules — W2 redefines those.
- Document the mapping at `apps/web/src/styles/README.md`.
- Acceptance: every page renders without broken layouts. `npm run build` clean. Lint clean.

### Wave 2 — `#45` chrome + shared primitives

Single agent (orchestrator).

- **Global nav**: redesign `AdminShell.tsx`. Black `--color-surface-black` strip, 44px height, fixed top. Brand link in `--font-size-nav-link` (12px / 400 / `-0.12px`). Right cluster: `NotificationBell` restyled as `button-icon-circular` (44×44) with Action Blue dot for unread.
- **Sub-nav-frosted**: introduce a new component `SubNav` accepting `title: string` and optional `cta: ReactNode`. Parchment 80% + `backdrop-filter: saturate(180%) blur(20px)`. Below the global nav, sticky.
- **Footer**: new `AdminFooter` component rendered at the bottom of `AdminShell`. Parchment background, `dense-link` columns. Footer content sourced from a constant — operator info, GitHub link, version.
- **Shared component primitives** (other waves consume — never edit):
  - `StatusBadge.tsx` — restyled per DESIGN.md `configurator-option-chip` grammar: pill, `--color-canvas` background, `--color-ink` text, 1px hairline. Status variants use background tinting only (no second accent). Active → Action Blue text. Disabled → ink-muted-48. Expired/quota_exhausted → ink-muted-80 with hairline. Single source of truth.
  - **Button utility classes** in a new `apps/web/src/styles/components.css`:
    - `.btn-primary` (Action Blue pill, 11×22 padding, scale-95 active, focus ring)
    - `.btn-secondary-pill` (transparent + Action Blue ring + Action Blue text)
    - `.btn-dark-utility` (#1d1d1f, 8px radius, 8×15 padding, white text)
    - `.btn-pearl-capsule` (pearl background, 11px radius, ink text)
    - `.btn-icon-circular` (44×44 circle, surface-chip-translucent)
    - `.btn-store-hero` (pill, 18px / 300, 14×28 padding)
    - `.text-link`, `.text-link-on-dark`
  - **Card utility classes** in the same file:
    - `.tile` (full-bleed `--space-section` vertical padding)
    - `.tile-light`, `.tile-parchment`, `.tile-dark`, `.tile-dark-2`, `.tile-dark-3`
    - `.store-card` (white, 18px radius, hairline, 24px padding)
    - `.input-pill` (44px, pill, hairline)
- **Layout container**: `.container-wide` (max-width 1440px, gutters absorb extra), `.container-narrow` (max-width 980px).
- Acceptance: build clean. All admin routes still render. Public/auth/setup routes unaffected by this wave.

### Wave 3 — `#46`–`#51` surface redesigns (parallel)

Six parallel execution agents. Each gets:

- The relevant issue body (`gh issue view N`).
- This execution-plan.md as constraints.
- DESIGN.md as source of truth.
- The constraint: "DO NOT modify `components/AdminShell.tsx`, `components/StatusBadge.tsx`, `styles/tokens.css`, `styles/components.css`, or `styles.css`. Consume the existing classes only. If you need a new shared class, stop and report."

Surface assignments:

- **Agent A — `#46` Public pages** (`PublicReceivePage`, `PublicSendPage`). Replace existing JSX structure to use `.tile-parchment` chassis + `.input-pill` inputs + `.btn-primary` / `.btn-secondary-pill` actions + `.store-card` for the file list. Restyle `LanguageSwitcher` to match (`.btn-pearl-capsule` with chevron). Preserve every `t()` / `<Trans>` call unchanged.

- **Agent B — `#47` Auth/Setup** (`LoginPage`, `SetupPage`). Centered single-column on parchment, `display-md` heading, `.input-pill` fields, `.btn-primary` submit. LoginPage uses `.btn-dark-utility` for provider buttons.

- **Agent C — `#48` Dashboard** (`DashboardPage`). Render link inventory as a `.store-card` grid (3 / 2 / 1 col responsive). Group by type (receive / send) with section headings in `display-md`. Use the restyled `StatusBadge`. Empty state with `lead-airy` copy + `.btn-primary`.

- **Agent D — `#49` New-link forms** (`NewReceiveLinkPage`, `NewSendLinkPage`). Centered form chassis on parchment, `.input-pill` inputs, `.btn-primary` + `.btn-secondary-pill` submit row. Send page's file-attach uses `.btn-secondary-pill`; selected files render as a vertical stack of `.store-card` rows.

- **Agent E — `#50` Detail pages** (`ReceiveLinkDetailPage`, `SendLinkDetailPage`). Hero block on parchment with label in `display-md` + public URL in `body` + copy `.btn-icon-circular`. Action row: `.btn-primary` + `.btn-secondary-pill`. File inventory: `.store-card` rows.

- **Agent F — `#51` Notifications** (`NotificationsPage`, `NotificationBell`). Bell already restyled in W2 — agent only edits `NotificationsPage`. List of notifications as `.store-card` rows; unread shows left Action Blue rail + `body-strong` title; read renders plain. Empty state.

Each agent runs `npm run build` and `npm run lint` on completion.

## Verification

- `npm run build` (web + server) clean.
- `tsc -b` clean.
- `npm run lint` clean.
- `npm run format:check` clean for touched files (run `prettier --write` if not).
- Best-effort browser smoke: spin `vite dev` and load static `/login`, `/r/:code` (will 404 backend without server stack — acceptable, only validates initial render + assets).
- Document missed browser checks honestly in PR test plan.

## Commit structure

- W1 commit: `feat(#44): design tokens, fonts, base styles`
- W2 commit: `feat(#45): admin chrome + shared component primitives`
- W3 commits: one per surface agent (6 commits total — `feat(#46):`, `feat(#47):`, ...) OR a single squashed `feat(#46-#51): surface redesigns` if parallel agents land overlapping work. Prefer 6 distinct commits.

Total: 8 commits, one PR closing all 8 issues.

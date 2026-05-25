# Contributing to File Harbor

## How this project plans work

File Harbor uses **GitHub issues as the home for product requirements**, not in-repo markdown. PRDs are work artifacts — alive until shipped, then archived by closing the issue.

### One mega-PRD per release

Each release (v1, v2, ...) has a single PRD issue covering the whole release. We do not split into per-feature PRDs unless a release is delivered in genuinely independent slices.

Title format: `PRD: File Harbor vN — <short tagline>`

### PRD template

New PRDs are created from `.github/ISSUE_TEMPLATE/prd.md`. The template has required sections (Problem, Solution, User Stories, Out of Scope) and optional sections (Implementation Decisions, Testing Decisions, Further Notes) that may be omitted for small PRDs.

### Labels

| Label | Where it goes | Meaning |
|---|---|---|
| `prd` | The PRD issue itself | This issue is a PRD |
| `prd:vN` | Every execution child of PRD vN | Groups all work for a release |
| `ready-for-agent` | Any issue ready for an execution agent | Orthogonal workflow state |

`prd:vN` is what `gh issue list --label prd:v1` filters on. Sub-issue API is the structural link (see below); the label exists for ad-hoc CLI filtering and survives if sub-issue UX changes.

### Sub-issues, not task lists

Execution issues are linked to their PRD using GitHub's native sub-issue feature, not task-list checkboxes in the PRD body. Reasons:

- No PRD-body churn as children land.
- Parent/child queryable via API.
- GitHub renders progress automatically.

When `to-issues` splits a PRD, it should:

1. Create each execution issue as a sub-issue of the PRD.
2. Apply the `prd:vN` label.
3. Post a single comment on the PRD listing the children created (chronological audit trail).

> **Note:** the bundled `to-issues` skill currently writes a `## Parent` markdown reference instead of using the sub-issue API. It needs a project-local tweak to (a) call the sub-issue endpoint and (b) apply the `prd:vN` label. Until that's done, do those two steps manually after running the skill.

### Amendments

When a PRD's scope changes mid-build (decision reversed, scope cut, ambiguity resolved):

1. **Edit the PRD body** so it remains canonical — one read of the body is current truth.
2. **Add a comment** on the issue summarising the change and why (`AMENDMENT (2026-06-02): max_uploads now nullable based on home-lab feedback`).

Edit-only loses rationale. Comment-only forces readers to reconcile body vs comments. Doing both keeps the body readable and the history honest.

If a change is large enough that it effectively defines a new release, open a new PRD instead of amending.

### Architectural decisions live in the PRD

File Harbor does **not** keep a separate `docs/adr/` directory or `CONTEXT.md` glossary. Architectural decisions and domain terminology live inside the PRD's *Implementation Decisions* and *Architectural decisions* sections. The PRD is the single source.

The trade-off: when a PRD closes, its decisions go with it (still readable via `gh issue view N`, but no longer surfaced in repo browsing). Acceptable for the current project scale; revisit if v2+ inherits a meaningful number of decisions from v1.

### Archival on ship

When a release ships, the PRD issue is **closed** (plain `gh issue close`). No final summary comment, no conversation lock. The closed issue remains readable via `gh issue view N`.

### Discoverability

- `README.md` points to open issues for the current PRD and milestones.
- This file (`CONTRIBUTING.md`) documents the convention itself.

## Commits, PRs, branches

To be added when the first execution issues land. For now, follow the project conventions implied by `.claude/` and the `commitpush` skill.

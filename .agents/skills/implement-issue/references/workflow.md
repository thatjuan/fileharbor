# Workflow Details

Detailed step-by-step behavior, edge cases, and command references for the `implement-issue` skill. SKILL.md gives the shape; this file gives the specifics.

## Table of Contents

0. [Precondition: team-executor presence](#precondition-team-executor-presence)
1. [Input parsing](#input-parsing)
2. [Issue fetch](#issue-fetch)
3. [Repo convention detection](#repo-convention-detection)
4. [Branch creation](#branch-creation)
5. [Path determination — when to skip planning](#path-determination)
6. [Planning team handoff](#planning-team-handoff)
7. [Autonomous-decision mode](#autonomous-decision-mode)
8. [TL;DR confirmation gate](#tldr-confirmation-gate)
9. [Issue comment format](#issue-comment-format)
10. [Execution team handoff](#execution-team-handoff)
11. [Verification](#verification)
12. [Pull request](#pull-request)
13. [Recovery from partial state](#recovery-from-partial-state)

## Precondition: team-executor presence

This skill is a thin orchestrator around `team-executor`. Without it, planning + execution cannot run.

Check order:

```bash
for p in \
  "$HOME/.claude/skills/team-executor/SKILL.md" \
  ".claude/skills/team-executor/SKILL.md" \
  "./team-executor/SKILL.md" \
  "/mnt/skills/team-executor/SKILL.md"; do
  [ -f "$p" ] && echo "FOUND: $p" && break
done
```

Also check `skills-lock.json` for an installed entry:

```bash
[ -f skills-lock.json ] && grep -q '"team-executor"' skills-lock.json && echo "lock-entry present"
```

If nothing resolves, present this to the user verbatim:

```
team-executor not found in any of:
  - ~/.claude/skills/team-executor/
  - .claude/skills/team-executor/
  - ./team-executor/
  - /mnt/skills/team-executor/
  - skills-lock.json

implement-issue drives team-executor for planning + execution. It cannot proceed without it.

Install and continue?  →  npx skills add thatjuan/agent-skills --skill team-executor
Or abort?
```

Wait for explicit user response. On (a) install + continue: run the install command, re-check, then proceed. On (b) abort: stop. Never fabricate the planning/execution layer locally — the value of this skill is the team-executor handoff.

Cache the resolved `SKILL.md` path; pass it to planning + execution agents in their "Available Skill" prompt slot.

## Input parsing

Accepted forms:

| Input | Interpretation |
|-------|----------------|
| `123` | Issue 123 in current repo |
| `#123` | Issue 123 in current repo |
| `owner/repo#123` | Issue 123 in `owner/repo` |
| `https://github.com/owner/repo/issues/123` | Issue 123 in `owner/repo` |
| `https://github.com/owner/repo/pull/123` | Reject — this is a PR, not an issue. Ask the user. |

For non-current-repo issues, all `gh` commands need `-R owner/repo`.

## Issue fetch

```bash
gh issue view <N> --json number,title,state,body,labels,assignees,milestone,url,author,comments
```

Read **all comments**, not just the body. The team frequently negotiates scope and approach in the comments — that context is load-bearing.

If `state` ∈ {CLOSED, LOCKED}: confirm intent before proceeding (see SKILL.md step 1).

## Repo convention detection

Before any team is dispatched, scan:

| File | What to extract |
|------|-----------------|
| `CLAUDE.md`, `AGENTS.md` | Coding conventions, commit-message style, test commands, "do not do X" rules |
| `CONTRIBUTING.md` | Branch naming, PR template, review process |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR body structure to follow |
| `README.md` | Project purpose, stack, build/test commands |
| `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` | Language, framework, scripts |
| `.editorconfig`, `.prettierrc`, `eslint.config.*`, `ruff.toml` | Style |
| Recent branches: `git branch -a --sort=-committerdate \| head -20` | Naming pattern |
| Recent commits: `git log --oneline -20` | Message style (Conventional Commits? plain? scoped?) |

Pass this context into every planning agent — it's how they make convention-consistent recommendations.

## Branch creation

```bash
default_branch=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
git fetch origin
slug=$(gh issue view <N> --json title -q .title | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | cut -c1-50)
git switch -c "issue-<N>-${slug}" "origin/${default_branch}"
```

If the repo uses a different branch naming convention (detected from recent branches — e.g., `feat/issue-N-...`, `username/issue-N-...`), match it.

If the working tree is dirty, stop. Ask the user.

## Path determination

**Skip the planning team** when the issue body or pinned comments contain explicit, file-level implementation directions: a checklist of files to change, a code snippet to apply, specific function signatures, or a PR-ready spec. In that case the issue itself is the plan — proceed to comment + execute.

**Run the planning team** when the issue describes intent without prescribing the *how*:

- "Add support for X" with no implementation detail.
- "Bug: Y happens when Z" with no root-cause analysis.
- "Refactor M to improve N" with no chosen approach.
- "Investigate and decide between A or B."

Edge case: issue has *partial* directions (e.g., "use library X" but no file paths). Run the planning team but pass the directions as hard constraints.

## Planning team handoff

Follow `team-executor` Phase 1, Steps 1–8. Two specializations for this workflow:

1. **Goal analysis input** is the issue body + all comments + the user's invocation message (which may add context the issue doesn't have).

2. **Every planning agent prompt** must include this constraint block, verbatim:

   > The implementation will be carried out by other coding agents. Human time, speed, and effort estimates DO NOT apply — do not shy away from a more robust solution because a human would find it slow. Account for risk, security, maintainability, and consistency with existing project conventions. Prefer the most robust, well-engineered option that uses existing tooling/styles/components in this repo. Do not introduce parallel patterns when an existing one fits.

See [team-composition.md](./team-composition.md) for how to pick which agents and which skills.

Outputs land in `docs/plans/issue-<N>/`:

- `goal-analysis.md`
- `research/*.md` (if R&D ran)
- per-agent analyses
- `execution-plan.md` (the final synthesis)

## Autonomous-decision mode

Trigger phrases in the user's invocation: "decide", "decide for me", "make all decisions", "no confirmation", "autonomous", "you choose", "use your judgment", "proceed".

Behavior:

- Skip the TL;DR gate.
- After the planning team and the Principal-Engineer review gate produce the consolidated plan, accept it as-is.
- Tie-breaking rule: choose the option that (a) follows existing repo patterns, (b) uses already-installed dependencies over new ones, (c) has the smallest blast radius for failure, and (d) is the most testable.

## TL;DR confirmation gate

When confirmation is required, present to the user:

```markdown
**Approach**: <1 sentence>

- <bullet: key technical choice + why>
- <bullet: scope — what files/modules>
- <bullet: trade-off accepted>
- <bullet: notable risk + mitigation>
- <bullet: out-of-scope items, if any>

Proceed?
```

Keep it ≤6 bullets. The full plan is already in `docs/plans/issue-<N>/execution-plan.md` for the user to read if they want depth.

If the user redirects, loop back to the planning step with their feedback as additional input — do not just patch the TL;DR.

## Issue comment format

Post via:

```bash
gh issue comment <N> --body-file docs/plans/issue-<N>/approach-comment.md
```

Comment structure:

```markdown
## Implementation Approach

<one-paragraph summary>

### Why this path
<trade-offs considered, alternatives rejected with reasoning>

### Scope
- Files to modify: <list>
- Files to create: <list>
- Migrations / config changes: <list, or "none">

### Steps
1. <ordered, detailed, executable steps>
2. ...

### Out of scope
- <items deferred to follow-up issues>

### Verification
- Commands to run: <list>
- Manual checks: <list>

---
_Posted by an AI coding agent. The PR will reference this comment._
```

The comment must be self-contained — a reader who only sees this comment (not the planning docs) should be able to follow it.

## Execution team handoff

Follow `team-executor` Phase 2, Steps 9–12. Specializations:

- Execution agents receive the issue URL, the posted comment URL, and `docs/plans/issue-<N>/execution-plan.md`.
- They do NOT receive the Phase-1 deliberation history — that's `team-executor`'s deliberate design.
- For UI work, an agent must start the dev server and exercise the feature. If browser verification is impossible in this environment, the agent reports that explicitly rather than claiming success.

## Verification

Detect the verification surface:

| Repo signal | Run |
|-------------|-----|
| `package.json` with `test` script | `npm test` (or `pnpm test` / `yarn test` / `bun test` matching the lockfile) |
| `package.json` with `lint` / `typecheck` | Run them |
| `pyproject.toml` / `pytest` config | `pytest` |
| `Makefile` with `test` target | `make test` |
| `Cargo.toml` | `cargo test` + `cargo clippy` |
| `go.mod` | `go test ./...` + `go vet ./...` |
| `.github/workflows/*.yml` | Read the CI commands and run the equivalent locally |

Fix failures via targeted follow-up agents before opening the PR. Never open a PR with failing CI-blocking checks.

## Pull request

```bash
git push -u origin <branch>
gh pr create --title "<title>" --body-file docs/plans/issue-<N>/pr-body.md
```

PR body structure (or match `.github/PULL_REQUEST_TEMPLATE.md` if present):

```markdown
## Summary
- <bullet 1>
- <bullet 2>

## Approach
See the implementation-approach comment on the issue: <link>

## Test plan
- [ ] <test 1>
- [ ] <test 2>

Closes #<N>
```

Title: short, ≤70 chars, matching the repo's commit-message convention (Conventional Commits if detected: `feat:`, `fix:`, etc.).

Return the PR URL to the user as the final output.

## Recovery from partial state

If invoked again on an issue that already has a branch / comment / open PR:

| Found | Action |
|-------|--------|
| Branch `issue-<N>-*` exists locally | Ask: continue on it, or branch fresh? |
| Branch exists remotely | Same prompt. |
| Issue already has an "Implementation Approach" comment from a prior run | Ask: replace it, append a revision, or proceed using it as the plan? |
| Open PR linked to the issue | Stop. Surface the PR URL; ask whether to add commits to it or open a new one. |

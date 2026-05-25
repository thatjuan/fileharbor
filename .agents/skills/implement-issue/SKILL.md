---
name: implement-issue
description: Implement a GitHub issue end-to-end using the team-executor skill. Given an issue number (or URL), opens a feature branch, dispatches a planning team specialized to the project stack to decide the implementation path (unless the issue dictates the path), confirms a TL;DR with the user (or decides autonomously when asked), posts the agreed approach as an issue comment, launches a fresh execution team to build it, and opens a pull request. Use when the user provides only a GitHub issue number, an issue URL, or asks to "implement issue #N", "work on issue N", "ship issue N", "do issue N", or "build out the issue". Bare numeric input from the user should be treated as a GitHub issue reference in the current repo.
---

# Implement Issue

End-to-end GitHub issue delivery via `team-executor`. Robust solutions preferred over fast ones — human time/speed/estimate constraints do not apply to execution agents; risk and consistency do.

## Bundled Resources

| File | Purpose |
|------|---------|
| [references/workflow.md](references/workflow.md) | Detailed step-by-step workflow and edge cases |
| [references/team-composition.md](references/team-composition.md) | How to pick planning agents and skill assignments based on project stack |

## Inputs

- A GitHub issue number (bare integer → current repo), an `owner/repo#N` slug, or a full `https://github.com/.../issues/N` URL.
- Optional flag in user message: "decide" / "make all decisions" / "no confirmation" → skip the TL;DR confirmation gate and choose the most robust, convention-consistent approach autonomously.

## Outputs

- Feature branch named `issue-<N>-<slug>` (or matching the repo's branch convention if one is detected).
- Plan documents under `docs/plans/issue-<N>/` (from `team-executor`).
- A comment on the issue documenting the agreed implementation approach in enough detail that a fresh team can follow it.
- Implementation commits on the feature branch.
- A pull request linked to the issue (`Closes #N`).

## Workflow

### 0. Precondition: `team-executor` must be installed

Before any other step, verify `team-executor` is reachable. Check, in order:

1. `~/.claude/skills/team-executor/SKILL.md`
2. `.claude/skills/team-executor/SKILL.md` (project)
3. `./team-executor/SKILL.md` (this repo, when running in-place)
4. `/mnt/skills/team-executor/SKILL.md`
5. `skills-lock.json` entry for `team-executor`

If none found: **stop and warn the user**. Report which paths were checked and that this skill drives `team-executor` for planning + execution. Ask whether to:

- (a) install it (`npx skills add thatjuan/agent-skills --skill team-executor`) and continue, or
- (b) abort.

Wait for explicit confirmation. Do not proceed without it. Cache the resolved path for later steps.

### 1. Resolve the issue

- Parse the user's input. If it's a bare integer, treat it as an issue number in the current repo.
- Run `gh issue view <N> --json number,title,state,body,labels,assignees,milestone,url,author,comments` and read everything, including comments — prior discussion may already constrain the approach.
- If `state != "OPEN"`:
  - Report the current state (closed / merged / locked) to the user.
  - Ask whether to (a) reopen, (b) proceed anyway on a new branch, or (c) abort. Wait for their choice.
- Detect repo conventions: read `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, branch-naming hints from recent branches (`git branch -a --sort=-committerdate | head -20`), commit-message style from `git log --oneline -20`.

### 2. Create the feature branch

- Branch from the repo's default branch (resolve via `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`).
- Branch name: `issue-<N>-<kebab-title>` truncated to 60 chars, unless the repo's convention dictates otherwise.
- `git fetch origin` first; create the branch off `origin/<default>`.

### 3. Determine the implementation path

The issue states *what*. This skill (with `team-executor`) decides *how* — unless the issue body explicitly prescribes the implementation.

**If the issue contains explicit implementation directions** (specific files, APIs, code patterns, or a checklist a coder could follow verbatim):
  - Skip the planning team. Use the issue body as the plan. Proceed to step 5.

**Otherwise**: dispatch a planning team via `team-executor`.

- Read the `team-executor` skill: `~/.claude/skills/team-executor/SKILL.md` (or `./team-executor/SKILL.md` if installed in-project).
- Follow `team-executor` Phase 1 (Planning) — Steps 1–8 — with the issue body + comments as input to "Organize the Input".
- See [references/team-composition.md](references/team-composition.md) for how to pick agents and skill assignments for this project's stack.

Constraints to pass into every planning agent prompt:

> The implementation will be carried out by other coding agents. Human time, speed, and effort estimates DO NOT apply — do not shy away from a more robust solution because a human would find it slow. Account for risk, security, maintainability, and consistency with existing project conventions. Prefer the most robust, well-engineered option that uses existing tooling/styles/components in this repo. Do not introduce parallel patterns when an existing one fits.

### 4. Confirm the path (or decide autonomously)

- If the user's invocation asked you to decide ("decide", "make all decisions", "no confirmation", "autonomous"), skip confirmation. Pick the most robust, convention-consistent option from the planning output and proceed.
- Otherwise, present a **very summarized TL;DR** to the user: 3–6 bullets covering chosen approach, key trade-offs, affected areas, and risks. Wait for confirmation or redirection.
- After confirmation (or autonomous decision), write the final plan to `docs/plans/issue-<N>/execution-plan.md` per `team-executor` Step 8.

### 5. Comment the approach on the issue

Post a comment via `gh issue comment <N> --body-file <path>` containing:

- **Approach** — chosen path in 1–2 paragraphs.
- **Why this path** — trade-offs vs. alternatives considered.
- **Scope** — files/modules touched, new files, migrations.
- **Steps** — ordered, detailed enough that a fresh team can execute without ambiguity (file paths, function signatures, library calls, test expectations).
- **Out of scope** — what this PR will not address.
- **Verification** — how reviewers should validate (commands to run, manual checks).

This comment is the durable execution brief. It must stand alone.

### 6. Execute

Launch `team-executor` Phase 2 (Execution) — Steps 9–12 — pointing agents at:

- The issue (`gh issue view <N>`) for original requirements.
- The posted issue comment / `docs/plans/issue-<N>/execution-plan.md` for the chosen approach.
- Project context (CLAUDE.md, AGENTS.md, README, relevant source files).

Execution agents run autonomously, in parallel where steps are independent, sequentially where dependent.

### 7. Verify

- Run the repo's test suite, linter, type-checker, and build (whatever exists). Detect via `package.json` scripts, `Makefile`, `pyproject.toml`, etc.
- For UI changes: start the dev server and exercise the feature; report explicitly if browser verification was not possible.
- Fix failures via targeted follow-up agents before opening the PR.

### 8. Open the pull request

- Commit and push the feature branch.
- `gh pr create` with:
  - Title: short, ≤70 chars, matching the repo's commit-message convention.
  - Body sections: **Summary** (bullets), **Approach** (link to issue comment), **Test plan** (checklist), **Closes #<N>**.
- Return the PR URL to the user.

## Failure Modes

| Condition | Response |
|-----------|----------|
| `team-executor` not installed | Stop. Warn the user, show paths checked, offer install command, wait for confirm. |
| Issue not found / no access | Surface the `gh` error verbatim; ask the user to verify the number / auth. |
| Issue closed/locked | Confirm intent with user before proceeding (see step 1). |
| `gh` not installed or not authenticated | Stop; instruct the user to install / `gh auth login`. |
| Not inside a git repo | Stop; report and ask the user where to run. |
| Planning team produces conflicting recommendations the Project Lead can't reconcile | Surface the conflict in the TL;DR; ask the user to break the tie. |
| Tests fail after execution | Spawn a targeted fix agent; never open a PR with failing CI-blocking checks. |
| Pre-existing uncommitted changes on the working tree | Stop; ask the user how to handle (stash / commit / abort). |

## Related Skills

- [team-executor](../team-executor/) — the planning + execution engine this skill drives.
- [commitpush](../commitpush/) — for the commit step if the user prefers its safety checks.
- [git-github-cli](https://github.com/anthropics/claude-code) — Git/GitHub CLI reference for branch and PR operations.

# implement-issue

> End-to-end GitHub issue delivery via `team-executor`. Given an issue number, opens a feature branch, dispatches a stack-specialized planning team to decide the implementation path, confirms a TL;DR with the user (or decides autonomously), posts the agreed approach as an issue comment, launches a fresh execution team, and opens a pull request.

## What it does

`implement-issue` is the upper layer that drives `team-executor` for the specific case of "ship this GitHub issue." It owns the GitHub-side workflow — issue resolution, branch creation, approach negotiation, comment-as-execution-brief, and PR creation — and delegates the heavy thinking and building to two `team-executor` teams.

The core philosophy: **robust over fast**. Execution agents have no human time/speed/estimate constraints, so the planning team is told explicitly to pick the most robust, convention-consistent option rather than the quickest one. Risk, maintainability, and consistency are still in scope; "this would take a human too long" is not.

## When to use it

Invoke this skill when the user provides a GitHub issue and wants it shipped:

- *"Implement issue #142."*
- *"Work on 87."* (bare number → current repo)
- *"Ship `owner/repo#23`."*
- *"https://github.com/foo/bar/issues/9 — make it happen."*
- *"Do issue 55, decide for me."* (autonomous mode)

**Not the right skill for**: vague requests with no issue reference, scoping discussions, or issue triage. Use `team-executor` directly for unstructured braindumps.

## How it works

```
0. Precondition check
     team-executor must be installed (~/.claude/skills/, .claude/skills/, ./, /mnt/skills/, or skills-lock.json)
     If missing → warn, show install command, wait for user confirmation, abort if not approved

1. Resolve the issue
     gh issue view <N>          → body + comments + state
     if not open: confirm intent

2. Create the feature branch
     branch off the repo's default branch
     name: issue-<N>-<kebab-title>

3. Determine the path
     If the issue body has explicit directions  → use it as the plan
     Otherwise → dispatch team-executor Phase 1 (Planning)
                 stack-specialized agents (see references/team-composition.md)
                 every agent is told: robust > fast, no human-time constraints

4. Confirm
     Autonomous-decision mode? → decide using "most robust + most consistent"
     Otherwise                  → ≤6-bullet TL;DR, wait for user OK

5. Comment the approach on the issue
     gh issue comment <N> --body-file …
     Self-contained brief: approach, scope, steps, out-of-scope, verification

6. Execute
     team-executor Phase 2: fresh team, autonomous build

7. Verify
     Run the repo's tests / lint / typecheck / build
     For UI: dev server + browser exercise

8. Open the pull request
     gh pr create … "Closes #<N>"
     Return URL to the user
```

## Example walkthrough

**Prompt**

> 142

**What the skill does**

```
Step 1: Resolve
  gh issue view 142
  → "Add CSV export to the dashboard"
  → state: OPEN, no implementation directions

Step 2: Branch
  → issue-142-add-csv-export-to-the-dashboard

Step 3: Path
  Stack detected: Next.js, drizzle-orm, heroui, vitest
  Planning team (5 agents + Project Lead + Principal reviewer):
    • Frontend engineer  (with heroui skill)
    • Backend engineer   (with drizzle-orm skill)
    • Data modeler       (export query semantics)
    • QA/testing         (vitest patterns in repo)
    • Security           (PII review for export contents)
  → docs/plans/issue-142/execution-plan.md

Step 4: TL;DR shown to user
  - Streaming server-side export via a new /api/dashboard/export route
  - Reuses existing Drizzle query layer; no schema changes
  - Frontend: HeroUI Button + Modal for column selection
  - PII columns gated behind a per-role check
  - Vitest unit tests + a Playwright e2e for the download flow
  Proceed? → yes

Step 5: Issue comment posted
  https://github.com/.../issues/142#issuecomment-...

Step 6: Execute (fresh team)
  3 execution agents, parallel where independent
  → 8 files modified, 2 created, 11 tests added

Step 7: Verify
  pnpm test … pass
  pnpm lint … pass
  pnpm typecheck … pass

Step 8: PR opened
  https://github.com/.../pull/189
  → returned to user
```

## Installation

```bash
npx skills add thatjuan/agent-skills --skill implement-issue
```

This skill calls into `team-executor`, so install that too if you don't already have it:

```bash
npx skills add thatjuan/agent-skills --skill team-executor
```

## Bundled resources

| File | Purpose |
|------|---------|
| `SKILL.md` | Workflow shape — 8 steps from "got an issue number" to "PR opened" |
| `references/workflow.md` | Step-by-step specifics, edge cases, exact `gh` / `git` commands, recovery from partial state |
| `references/team-composition.md` | Stack detection, agent picks per issue type, skill-to-agent mapping, the Principal-Engineer review gate |

## Tips

- **Bare numbers work.** "142" or "#142" both resolve to the current repo's issue 142.
- **Autonomous mode is opt-in.** Say "decide for me", "make all decisions", or "no confirmation" to skip the TL;DR gate. Default is to confirm.
- **Tell it to ignore conventions only when you mean it.** Default behavior reuses existing tooling/styles/components. If you want a clean-room implementation, say so in the invocation.
- **The issue comment is the execution brief.** It's deliberately verbose enough that a fresh team can follow it without re-reading the planning docs.
- **Verification is mandatory before PR.** If the repo has tests/lint/typecheck/build, they run. UI changes get exercised in a browser when possible — if not, the agent says so rather than claiming success.
- **Re-running on the same issue is safe.** If a branch, comment, or PR already exists from a prior run, the skill stops and asks how to proceed.

## Related skills

- [`team-executor`](../team-executor/) — the planning + execution engine this skill drives.
- [`commitpush`](../commitpush/) — used at commit time for secrets/sensitive-file screening.

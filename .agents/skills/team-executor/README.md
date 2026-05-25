# team-executor

> Multi-agent orchestration that transforms scattered braindumps into executed results. Assembles expert planning teams (3-7 agents), produces a comprehensive execution plan, then deploys fresh execution teams for autonomous delivery.

## What it does

`team-executor` is a meta-skill for complex work. It operates in two distinct phases:

**Phase 1 — Planning**
1. Organizes a raw braindump into `docs/plans/goal-analysis.md` (deduplicated, ordered, gaps inferred)
2. Scans available skills (`~/.claude/skills/`, `.claude/skills/`, `/mnt/skills/`) to build a capability inventory
3. Determines whether R&D is needed; if so, spawns R&D agents first
4. Assembles a team of 3-7 expert agents (architect, backend, frontend, DevOps, QA, security, data, PM)
5. Each agent analyzes the goal from their domain and produces a section of the plan
6. Consolidates into a single executable plan

**Phase 2 — Execution**
A fresh team of agents autonomously executes the plan to completion — no human intervention required between steps. Each agent is spawned with the specific section of the plan relevant to their role.

The philosophy: **experts plan, experts execute, output is production-ready.**

Works across Claude Code, Codex, and any platform that supports agent spawning.

## When to use it

Invoke this skill for **substantial, multi-faceted work** — not single-task requests:

- *"Here's everything I've been thinking about for our onboarding redesign: [paste of scattered notes]. Plan and build it."*
- *"Execute this spec."*
- *"Make this happen."* (followed by a large braindump)
- *"I have a feature idea I want fully scoped and shipped end-to-end."*
- *"Take this PRD and run it."*

**Not the right skill for**: single-file changes, bug fixes, quick refactors, simple Q&A. The orchestration overhead only pays off when the work genuinely benefits from multiple perspectives.

## Example walkthrough

**Prompt**

> We need to add team workspaces to our app. Users should be able to invite others, set roles, see a team dashboard. It should work on web and mobile. Make this happen.

**What the skill does**

```
Phase 1 — Planning

  Step 1: Organize input
    → docs/plans/goal-analysis.md written

  Step 2: Skill scan
    Found: heroui, drizzle-orm, commitpush — capabilities noted

  Step 3: R&D needed?
    Yes — spawn R&D agent to investigate existing auth model
    → docs/plans/research/existing-auth.md

  Step 4: Assemble team (6 agents)
    • Architect — overall data model, service boundaries
    • Backend — workspace CRUD, invite flow, RBAC
    • Frontend Web — team dashboard, invite UI (with heroui)
    • Frontend Mobile — mobile parity
    • Database — schema migration (with drizzle-orm)
    • Security — invite token security, permission audit

  Step 5-6: Each agent writes their plan section
    → docs/plans/01-architecture.md
    → docs/plans/02-backend.md
    → docs/plans/03-frontend-web.md
    → docs/plans/04-frontend-mobile.md
    → docs/plans/05-database.md
    → docs/plans/06-security.md

  Step 7: Consolidated plan reviewed with user

Phase 2 — Execution

  Fresh execution team spawned. Each agent:
    • Reads their section of the plan
    • Implements autonomously
    • Reports back with files changed + tests added

  → Feature delivered end-to-end
```

## Installation

```bash
npx skills add thatjuan/agent-skills --skill team-executor
```

## Bundled resources

| File | Purpose |
|------|---------|
| `SKILL.md` | The full 12-step planning + execution workflow |
| `agent-templates.md` | Persona construction framework and ready-to-use templates for R&D, architect, frontend, backend, DevOps, QA, security, data, and project lead agents |
| `orchestration-workflow.md` | Agent spawning (Claude Code Agent tool, Codex subagents, sequential fallback), output collection, conflict resolution, phase transitions |
| `scan-project.sh` | Gathers project context (directory structure, config files, technologies, available skills) for agent prompts |
| `init-plan-dirs.sh` | Initializes the `docs/plans/` directory structure for agent outputs |

## Tips

- **Works best on existing codebases.** Agents read the project to make convention-consistent decisions. On a blank slate, output is more generic — feed it conventions explicitly.
- **Review the plan before Phase 2.** The consolidated plan is your gate. Once execution starts, agents run autonomously.
- **Watch the scope.** 3-7 agents is intentional — more agents means more coordination overhead. If your task truly needs 12 roles, break it into sub-projects.
- **Pair with installed skills.** `team-executor` will hand off skills like `drizzle-orm` or `heroui` to relevant agents, and they'll use them during execution. Install skills your team would actually use.

## Related skills

- [`superpowers:writing-plans`](https://github.com/obra/superpowers) — lighter-weight planning workflow for single-contributor tasks
- [`superpowers:executing-plans`](https://github.com/obra/superpowers) — manual plan execution with checkpoints (vs. team-executor's autonomous mode)

---
name: commitpush
description: Safe commit-and-push workflow with secrets detection, sensitive file screening, and submodule-aware prompting. Use when committing and pushing changes to git, especially in repos with submodules or when security-conscious commits are needed.
---

# Commit and Push

A safe commit-and-push workflow that screens for secrets and sensitive files before staging, detects submodules for targeted commits, and handles the full commit-push cycle including push failure recovery.

## Workflow

### Phase 1: Security Screening

The security screen runs before any staging. It surfaces files and content that pose risks if committed.

**Detection targets:**
- Secrets and credentials (API keys, tokens, passwords, private keys)
- Environment and configuration files with sensitive values (`.env`, `.env.*`, credentials files)
- Certificate and key files (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`)
- Cloud provider credential files (AWS, GCP, Azure configs)
- Database connection strings and dump files
- Large binaries and build artifacts

**Screening process:**
1. `git status` output is checked against known sensitive file patterns (see [sensitive-patterns.md](references/sensitive-patterns.md))
2. `git diff` content is scanned for inline secrets — high-entropy strings, API key prefixes, hardcoded passwords, connection strings
3. Flagged files or content are surfaced to the user with a recommendation to exclude, proceed, or abort

Unclear cases (e.g., a config file that may or may not contain real credentials) are presented to the user for clarification before proceeding.

### Phase 2: Submodule Detection

Repos with submodules (bridge repos) require explicit user direction on commit scope.

**Detection:** `git submodule status --recursive` identifies submodules and their change state (`+` prefix indicates uncommitted changes).

**When submodules with changes exist and scope is unspecified:**
- The list of changed submodules and the parent repo is presented to the user
- The user selects which to include in this commit cycle
- Selected submodules are committed and pushed first (depth-first), then the parent repo stages the updated submodule references

**When no submodules exist or scope is already specified:** This phase is skipped.

### Phase 3: Change Analysis

Analysis of staged and unstaged changes informs commit message generation.

**Inputs:**
- `git status` — overview of changed, staged, and untracked files
- `git diff` and `git diff --staged` — detailed change content
- `git log --oneline -5` — recent commit style for consistency

**Commit message generation:**
- Conventional commit format is used when the repo follows it (detected from recent history)
- Message focuses on the "why" rather than the "what"
- Scope is included when changes are localized (e.g., `fix(auth): ...`)
- Commit messages contain the change description only — no co-authorship attribution

### Phase 4: Stage, Commit, Push

**Staging:** Files approved through Phase 1 screening are staged via `git add` with explicit file paths — not blanket commands like `git add .` or `git add -A`.

**Commit:** Created with the generated message from Phase 3.

**Push:** `git push` sends changes to the remote. `git push -u origin <branch>` is used when no upstream tracking exists.

### Phase 5: Push Failure Recovery

**Rejected push (non-fast-forward):** `git fetch` + `git rebase` is attempted, then push is retried.

**Force push:** Requires explicit user authorization. Uses `--force-with-lease` (not `--force`).

**Conflicts or unresolvable errors:** Reported to the user with full context for manual resolution.

## Reference

| File | When to Read |
|------|--------------|
| [sensitive-patterns.md](references/sensitive-patterns.md) | During Phase 1 — comprehensive list of sensitive file patterns and inline secret indicators |

## Arguments

Optional user-provided context: specific files to commit, commit message override, scope directives (e.g., "only the parent repo", "submodule X only").

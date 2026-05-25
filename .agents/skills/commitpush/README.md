# commitpush

> Safe commit-and-push workflow that screens for secrets, handles submodules explicitly, generates a conventional commit message, and recovers from push failures.

## What it does

`commitpush` replaces the ad-hoc "stage everything, write a one-liner, hope it works" pattern with a deliberate 5-phase cycle:

1. **Security Screening** — scans `git status` and `git diff` for sensitive filenames (`.env`, `.pem`, credentials) and inline secrets (high-entropy strings, API key prefixes, hardcoded passwords). Flags anything suspicious for review **before** staging.
2. **Submodule Detection** — in repos with submodules, surfaces changed submodules and prompts for scope before committing parent references.
3. **Change Analysis** — reads `git log` to match the repo's existing message style, then drafts a conventional-commit message focused on *why*, not *what*.
4. **Stage, Commit, Push** — stages approved files explicitly (never `git add .`), commits, pushes, sets upstream if needed.
5. **Push Failure Recovery** — on rejection, fetches and rebases before retrying. Force pushes require explicit authorization and use `--force-with-lease`.

## When to use it

Invoke this skill when you hear requests like:

- *"Commit and push this."*
- *"Let's get this to main."*
- *"Ship it."*
- *"Write a commit message and push."*
- *"Commit just the backend changes, skip the migration file for now."*

Particularly valuable in:
- Bridge repos with submodules (prevents accidental submodule reference bumps)
- Monorepos where staging the wrong files leaks WIP
- Security-conscious teams who've been burned by committed `.env` files

## Example walkthrough

**Prompt**

> Commit and push.

**What the skill does**

```
Phase 1 — Security Screening
  ✓ Scanned 12 changed files
  ⚠ Flagged: .env.local (matches sensitive pattern)
  ⚠ Flagged: src/config.ts:42 — looks like an AWS access key (AKIA...)

  Proceed? Options:
    [a] Exclude both and commit the rest
    [b] I'll handle these manually, abort
    [c] Override — these are intentional

  → User: a

Phase 2 — Submodule Detection
  Found 1 submodule with changes: vendor/design-system
  Scope? [parent only / submodule only / both] → parent only

Phase 3 — Change Analysis
  Recent style: conventional commits (feat/fix/chore)
  Drafting: "fix(auth): reject tokens missing iat claim"

Phase 4 — Stage, Commit, Push
  $ git add src/auth/token.ts src/auth/token.test.ts
  $ git commit -m "fix(auth): reject tokens missing iat claim"
  $ git push
  ✓ Pushed to origin/main
```

## Installation

```bash
npx skills add thatjuan/agent-skills --skill commitpush
```

## Bundled resources

| File | Purpose |
|------|---------|
| `SKILL.md` | The 5-phase workflow |
| `references/sensitive-patterns.md` | Comprehensive sensitive file patterns, API key prefixes, inline secret indicators, cloud provider files, and false-positive guidance |

## Tips

- **Give scope hints upfront.** *"Commit only the backend changes"* or *"parent repo only"* skips the submodule prompt and produces tighter commits.
- **Override when you mean it.** If a flagged file is genuinely safe (e.g., `.env.example` committed intentionally), explicitly say so — the skill won't second-guess you after authorization.
- **The skill never uses `git add .` or `-A`.** Files are always staged by explicit path, which means it can't accidentally sweep in an untracked secret.
- **No co-author attribution.** Commit messages contain only the change description — not `Co-Authored-By` or tool attribution lines.

## Related skills

- [`git-github-cli`](https://github.com/thatjuan/agent-skills) — for broader Git/GitHub operations beyond the commit-push cycle (branches, PRs, rebasing, troubleshooting)

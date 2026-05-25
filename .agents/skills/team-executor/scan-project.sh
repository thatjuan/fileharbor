#!/usr/bin/env bash
# scan-project.sh — Gathers project context for agent prompts
# Usage: bash scan-project.sh [project_root]

set -euo pipefail

PROJECT_ROOT="${1:-.}"

echo "# Project Context Scan"
echo "## Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# --- Directory structure ---
echo "## Directory Structure"
echo '```'
if command -v tree &>/dev/null; then
    tree -L 3 -I 'node_modules|.git|__pycache__|.venv|venv|dist|build|.next|.cache|coverage|.nyc_output' "$PROJECT_ROOT" 2>/dev/null || find "$PROJECT_ROOT" -maxdepth 3 -not -path '*/\.*' -not -path '*/node_modules/*' | head -200
else
    find "$PROJECT_ROOT" -maxdepth 3 \
        -not -path '*/\.*' \
        -not -path '*/node_modules/*' \
        -not -path '*/__pycache__/*' \
        -not -path '*/venv/*' \
        -not -path '*/.venv/*' \
        -not -path '*/dist/*' \
        -not -path '*/build/*' \
        | head -200
fi
echo '```'
echo ""

# --- Key config files ---
echo "## Key Configuration Files"
for f in package.json pyproject.toml Cargo.toml go.mod Makefile Dockerfile docker-compose.yml .env.example tsconfig.json; do
    if [ -f "$PROJECT_ROOT/$f" ]; then
        echo "### $f"
        echo '```'
        head -50 "$PROJECT_ROOT/$f"
        echo '```'
        echo ""
    fi
done

# --- README ---
if [ -f "$PROJECT_ROOT/README.md" ]; then
    echo "## README.md (first 100 lines)"
    echo '```markdown'
    head -100 "$PROJECT_ROOT/README.md"
    echo '```'
    echo ""
fi

# --- Existing docs ---
if [ -d "$PROJECT_ROOT/docs" ]; then
    echo "## Existing Documentation"
    echo '```'
    find "$PROJECT_ROOT/docs" -type f -name '*.md' | head -20
    echo '```'
    echo ""
fi

# --- Available skills ---
echo "## Available Skills"
SKILL_DIRS=(
    "$HOME/.claude/skills"
    "$PROJECT_ROOT/.claude/skills"
    "/mnt/skills"
)
found_skills=0
for search_dir in "${SKILL_DIRS[@]}"; do
    if [ -d "$search_dir" ]; then
        while IFS= read -r skill_md; do
            if [ -f "$skill_md" ]; then
                skill_dir=$(dirname "$skill_md")
                skill_name=$(basename "$skill_dir")
                # Extract description from frontmatter
                desc=$(sed -n '/^---$/,/^---$/{ /^description:/{ s/^description: *//; p; } }' "$skill_md" 2>/dev/null | head -1)
                if [ -n "$desc" ]; then
                    echo "- **$skill_name** ($skill_md): $desc"
                else
                    echo "- **$skill_name** ($skill_md)"
                fi
                found_skills=$((found_skills + 1))
            fi
        done < <(find "$search_dir" -name "SKILL.md" -type f 2>/dev/null)
    fi
done
if [ "$found_skills" -eq 0 ]; then
    echo "- No skills found in searched locations: ${SKILL_DIRS[*]}"
fi
echo ""

# --- Language / framework detection ---
echo "## Detected Technologies"
[ -f "$PROJECT_ROOT/package.json" ] && echo "- Node.js / JavaScript/TypeScript"
[ -f "$PROJECT_ROOT/pyproject.toml" ] || [ -f "$PROJECT_ROOT/setup.py" ] || [ -f "$PROJECT_ROOT/requirements.txt" ] && echo "- Python"
[ -f "$PROJECT_ROOT/Cargo.toml" ] && echo "- Rust"
[ -f "$PROJECT_ROOT/go.mod" ] && echo "- Go"
[ -f "$PROJECT_ROOT/Gemfile" ] && echo "- Ruby"
[ -f "$PROJECT_ROOT/pom.xml" ] || [ -f "$PROJECT_ROOT/build.gradle" ] && echo "- Java/Kotlin"
[ -f "$PROJECT_ROOT/Dockerfile" ] && echo "- Docker"
[ -f "$PROJECT_ROOT/docker-compose.yml" ] && echo "- Docker Compose"
[ -f "$PROJECT_ROOT/tsconfig.json" ] && echo "- TypeScript"
[ -d "$PROJECT_ROOT/.github" ] && echo "- GitHub Actions"
echo ""

echo "## Scan Complete"

# PostgreSQL Migrations

Complete guide to managing PostgreSQL schema changes with drizzle-kit.

## Table of Contents

- [drizzle.config.ts Reference](#drizzleconfigt-reference)
- [Migration Strategies](#migration-strategies)
- [Migration Workflow](#migration-workflow)
- [Programmatic Migrations](#programmatic-migrations)
- [Custom Migrations](#custom-migrations)
- [Production Patterns](#production-patterns)
- [Team Workflows](#team-workflows)
- [Troubleshooting](#troubleshooting)

## drizzle.config.ts Reference

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Required
  dialect: 'postgresql',
  schema: './src/db/schema.ts',

  // Schema path patterns
  // schema: './src/db/schema/*.ts',        // glob pattern
  // schema: ['./src/users.ts', './src/posts.ts'], // array of files

  // Output directory for migration files (default: './drizzle')
  out: './drizzle',

  // Database connection
  dbCredentials: {
    url: process.env.DATABASE_URL!,
    // OR individual fields:
    // host: 'localhost',
    // port: 5432,
    // user: 'postgres',
    // password: 'password',
    // database: 'mydb',
    // ssl: true,
  },

  // Driver override (auto-detected from dialect in most cases)
  // driver: 'pglite' | 'aws-data-api',

  // Migration tracking
  migrations: {
    table: '__drizzle_migrations',  // migration log table name
    schema: 'drizzle',              // schema for migration table (PG only)
    prefix: 'timestamp',            // 'timestamp' | 'supabase' | 'unix' | 'none'
  },

  // Table/schema filtering
  tablesFilter: ['users', 'posts', 'project_*'],  // glob patterns
  schemaFilter: ['public', 'tenant_*'],            // default: ['public']

  // Extension filtering (ignore tables created by extensions)
  extensionsFilters: ['postgis'],

  // Introspection settings (for `pull` command)
  introspect: {
    casing: 'camel',  // 'preserve' | 'camel'
  },

  // Role management (Neon/Supabase)
  entities: {
    roles: {
      provider: 'neon',  // 'neon' | 'supabase'
      // include: ['specific_role'],
      // exclude: ['excluded_role'],
    },
  },

  // Behavior flags
  strict: false,    // require confirmation before push (default: false)
  verbose: true,    // print detailed SQL (default: true)
  breakpoints: true, // insert statement separators (default: true)
});
```

### Multi-Environment Configuration

```bash
# Dev config
npx drizzle-kit generate --config=drizzle-dev.config.ts

# Production config
npx drizzle-kit migrate --config=drizzle-prod.config.ts
```

## Migration Strategies

### Strategy 1: Generate + Migrate (Recommended for Production)

Schema is the source of truth. drizzle-kit generates SQL migration files, which are version-controlled and applied explicitly.

```bash
# 1. Edit schema files
# 2. Generate migration SQL
npx drizzle-kit generate

# 3. Review generated SQL in ./drizzle/XXXX_migration_name/migration.sql
# 4. Apply to database
npx drizzle-kit migrate
```

Each `generate` run creates a timestamped directory:
```
drizzle/
├── 0000_initial/
│   ├── migration.sql
│   └── snapshot.json
├── 0001_add_posts/
│   ├── migration.sql
│   └── snapshot.json
└── meta/
    └── _journal.json
```

The `snapshot.json` records schema state. The `_journal.json` tracks migration order. Migration files are immutable once applied — new changes require new migrations.

### Strategy 2: Push (Development / Prototyping)

Applies schema changes directly without generating migration files. No audit trail.

```bash
npx drizzle-kit push
```

Useful for:
- Rapid prototyping
- Local development iterations
- Databases that can be recreated from scratch

### Strategy 3: Pull (Database-First)

The database is the source of truth. Extract the schema into TypeScript files.

```bash
npx drizzle-kit pull
```

Generates TypeScript schema files from the current database state. Useful for:
- Existing databases managed by external tools
- Reverse-engineering a database into Drizzle
- One-time import before switching to code-first

### Strategy 4: Export (External Tools)

Export schema as SQL for use with external migration tools (Atlas, Liquibase, Flyway).

```bash
npx drizzle-kit export
```

## Migration Workflow

### Generating Migrations

```bash
# Standard generation
npx drizzle-kit generate

# With custom name
npx drizzle-kit generate --name=add-user-roles

# Custom empty migration for manual SQL
npx drizzle-kit generate --custom --name=seed-users
```

#### Rename Detection

When drizzle-kit detects a column or table rename, it prompts interactively to confirm intent, preventing accidental data loss from misidentified renames vs. drop+create.

### Applying Migrations

```bash
# Apply all pending migrations
npx drizzle-kit migrate
```

drizzle-kit tracks applied migrations in the `__drizzle_migrations` table (configurable). Each migration runs once.

### Verifying Migrations

```bash
# Check for race conditions in generated migrations
npx drizzle-kit check

# Upgrade migration snapshots (after drizzle-kit version upgrade)
npx drizzle-kit up
```

### Visual Database Browser

```bash
npx drizzle-kit studio
```

Opens Drizzle Studio — a web-based GUI for browsing and editing database data.

## Programmatic Migrations

Apply migrations at application startup or in CI/CD pipelines:

### node-postgres

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const db = drizzle(process.env.DATABASE_URL!);
await migrate(db, { migrationsFolder: './drizzle' });
```

### postgres.js

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const migrationClient = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(migrationClient);
await migrate(db, { migrationsFolder: './drizzle' });
await migrationClient.end();
```

### Neon Serverless

```typescript
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);
await migrate(db, { migrationsFolder: './drizzle' });
```

### Vercel Postgres

```typescript
import { drizzle } from 'drizzle-orm/vercel-postgres';
import { migrate } from 'drizzle-orm/vercel-postgres/migrator';
import { sql } from '@vercel/postgres';

const db = drizzle(sql);
await migrate(db, { migrationsFolder: './drizzle' });
```

## Custom Migrations

For operations drizzle-kit cannot auto-generate (data migrations, seeding, custom DDL):

```bash
npx drizzle-kit generate --custom --name=seed-users
```

This creates an empty migration file for manual SQL:

```sql
-- drizzle/0002_seed-users/migration.sql
INSERT INTO "users" ("name", "email") VALUES ('Admin', 'admin@example.com');
INSERT INTO "users" ("name", "email") VALUES ('Demo', 'demo@example.com');
```

Custom migrations run in order alongside generated migrations via `drizzle-kit migrate`.

### Common Custom Migration Use Cases

- Data seeding / backfill
- Creating PostgreSQL extensions (`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
- Creating custom functions / triggers
- Row-level security policies
- Partition table setup
- Granting permissions

## Production Patterns

### CI/CD Pipeline Integration

```yaml
# Example GitHub Actions step
- name: Run migrations
  run: npx drizzle-kit migrate
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

### Application Startup Migration

```typescript
// src/db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle({ client: pool, schema });

// Run migrations before accepting requests
await migrate(db, { migrationsFolder: './drizzle' });

export { db };
```

### Migration Safety Checklist

| Check | Description |
|-------|-------------|
| Review generated SQL | Inspect every `migration.sql` before applying |
| Test on staging first | Run migrations against a staging database |
| Backup before migrating | `pg_dump` before applying destructive changes |
| Avoid renaming in production | Rename detection can misidentify changes |
| One migration per deploy | Avoid batching unrelated schema changes |
| Lock timeout | Set `statement_timeout` to prevent long locks |

### Handling Destructive Changes

When dropping columns or tables:

1. Deploy code that no longer reads the column
2. Generate migration that drops the column
3. Apply migration in a separate deploy

For column renames:

1. Add new column with migration
2. Backfill data with a custom migration
3. Deploy code using new column
4. Drop old column in a later migration

## Team Workflows

### Git Workflow

Migration files are committed to version control:

```
drizzle/
├── 0000_initial/
│   ├── migration.sql    # committed
│   └── snapshot.json    # committed
├── meta/
│   └── _journal.json    # committed
```

### Handling Merge Conflicts

If two developers generate migrations concurrently:

1. Both merge their branches
2. Run `npx drizzle-kit check` to detect conflicts
3. If conflicts found, regenerate: delete conflicting migration, run `npx drizzle-kit generate` again

### Migration Ordering

Migrations are ordered by their timestamp prefix. The `_journal.json` file tracks the canonical order. When merging branches with concurrent migrations, timestamps ensure proper ordering.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Migration already applied" | Migration tracking table records applied migrations — do not re-run |
| Snapshot mismatch | Run `npx drizzle-kit up` to upgrade snapshot format |
| Column rename misdetected | Use `--custom` migration for manual rename SQL |
| Push conflicts with existing data | `push` cannot handle data migrations — use `generate` + `migrate` |
| Migration table in wrong schema | Configure `migrations.schema` in `drizzle.config.ts` |
| Concurrent migration runs | Use advisory locks or run migrations in a single-instance context |

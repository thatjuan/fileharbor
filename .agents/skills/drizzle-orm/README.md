# drizzle-orm

> TypeScript-first SQL ORM with zero dependencies, compile-time type safety, and SQL-like syntax. Optimized for edge runtimes, serverless environments, and PostgreSQL.

## What it does

`drizzle-orm` turns your agent into a Drizzle expert. Unlike ORMs that hide SQL, Drizzle surfaces it — queries read like SQL but are fully type-checked at compile time with zero runtime overhead. This skill covers:

- **Schema definition** — `pgTable`, `pgEnum`, `pgSchema`, `pgView`, column types, defaults, generated columns, constraints
- **Relations** — one-to-one, one-to-many, many-to-many with the relational query builder (`db.query.users.findMany({ with: { posts: true } })`)
- **CRUD + joins** — from simple inserts to lateral joins, CTEs, subqueries, window functions
- **Migrations** — `drizzle-kit generate` / `migrate` / `push` / `pull`, programmatic migrations, production patterns, team workflows
- **Advanced PostgreSQL** — branded types, enums, arrays, JSONB patterns, composite keys, foreign key actions, self-referencing tables, multi-schema architecture, materialized views
- **Performance** — connection pooling, prepared statements, N+1 prevention, index strategy, edge runtime/serverless integration, bundle size
- **Prisma migration** — feature-by-feature comparison, performance benchmarks, schema/query syntax differences, full migration playbook

It triggers automatically when code imports `drizzle-orm`, `drizzle-kit`, or `drizzle-orm/pg-core`.

## When to use it

Invoke this skill when you hear:

- *"Set up Drizzle with PostgreSQL in my Next.js app."*
- *"Design a schema for a multi-tenant SaaS with row-level security."*
- *"Write a Drizzle query that joins users with their most recent post."*
- *"Generate and run migrations for this schema change."*
- *"Migrate our Prisma codebase to Drizzle."*
- *"Optimize this Drizzle query — it's doing N+1."*
- *"Set up Drizzle on a Vercel edge function with Neon."*

## Example walkthrough

**Prompt**

> Define a `posts` table with a many-to-one relation to `users`, then write a query that gets the latest 10 posts with their author info.

**What the skill produces**

**Schema**

```typescript
import { pgTable, text, timestamp, integer } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  email: text().notNull().unique(),
});

export const posts = pgTable('posts', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  title: text().notNull(),
  body: text().notNull(),
  authorId: integer().references(() => users.id).notNull(),
  createdAt: timestamp().defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
```

**Query (relational query builder — preferred)**

```typescript
const latest = await db.query.posts.findMany({
  with: { author: { columns: { name: true, email: true } } },
  orderBy: (posts, { desc }) => [desc(posts.createdAt)],
  limit: 10,
});
// Fully typed: latest[0].author.name is inferred correctly
```

**Query (core query builder — for when you need SQL control)**

```typescript
const latest = await db
  .select({
    post: posts,
    author: { name: users.name, email: users.email },
  })
  .from(posts)
  .leftJoin(users, eq(users.id, posts.authorId))
  .orderBy(desc(posts.createdAt))
  .limit(10);
```

The skill will also explain **when to use which builder**: relational for clean object shapes, core for fine-grained SQL control (CTEs, lateral joins, window functions).

## Installation

```bash
npx skills add thatjuan/agent-skills --skill drizzle-orm
```

## Bundled resources

| File | Purpose |
|------|---------|
| `SKILL.md` | Setup, schema definition, column types, relations, CRUD queries, transactions, migration basics, views, CTEs |
| `references/pg-migrations.md` | `drizzle.config.ts` reference, migration strategies (generate/migrate/push/pull), programmatic migrations, custom migrations, production patterns, team workflows |
| `references/advanced-schemas.md` | Branded types, PostgreSQL enums, arrays, JSONB patterns, composite keys, foreign key actions, self-referencing tables, multi-schema architecture, views, materialized views |
| `references/query-patterns.md` | Subqueries, CTEs, raw SQL, prepared statements, dynamic queries, aggregations, batch operations, cursor pagination, streaming, lateral joins |
| `references/performance.md` | Connection pooling, prepared statements, N+1 prevention, query optimization, index strategy, edge runtime/serverless integration, bundle size |
| `references/vs-prisma.md` | Feature comparison, performance benchmarks, schema/query syntax comparison, migration system differences, migration guide from Prisma to Drizzle |

## Tips

- **`push` is for prototyping, `migrate` is for production.** `drizzle-kit push` writes schema directly to the DB (great for local iteration). `drizzle-kit generate` + `migrate` produces versioned SQL files (the right pattern for team workflows).
- **Prepare hot queries.** `db.select().from(users).where(eq(users.id, placeholder('id'))).prepare('get_user')` reuses the query plan — significant speedup on serverless cold paths.
- **The relational query builder isn't slow.** It generates a single optimized query with JSON aggregation — not N+1. Use it freely for nested reads.
- **Drizzle Studio > hand-rolling admin UIs.** `npx drizzle-kit studio` spins up a local DB browser that understands your schema.
- **Edge runtimes.** Prefer `drizzle-orm/neon-http` or `drizzle-orm/postgres-js` over `node-postgres` in edge environments — the former two are edge-compatible.

## Related skills

- None in this repo yet — pair with `claude-api` for AI-backed DB work, or `temporal` for long-running transactional workflows.

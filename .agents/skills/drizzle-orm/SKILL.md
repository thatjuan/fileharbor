---
name: drizzle-orm
description: "Type-safe SQL ORM for TypeScript with zero runtime overhead. Use when code imports drizzle-orm, drizzle-kit, or drizzle-orm/pg-core, user asks about Drizzle schema design, queries, relations, migrations, or database management with Drizzle ORM. Covers PostgreSQL focus with pgTable, pgEnum, pgSchema, pgView, and drizzle-kit CLI."
---

# Drizzle ORM

TypeScript-first SQL ORM with zero dependencies, compile-time type safety, and SQL-like syntax. Optimized for edge runtimes, serverless environments, and PostgreSQL.

## Installation

```bash
# Core ORM + PostgreSQL driver
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg

# Alternative drivers
npm install postgres          # postgres.js
npm install @neondatabase/serverless  # Neon serverless
npm install @electric-sql/pglite     # PGlite embedded
```

## Database Connection

```typescript
// Simple connection string
import { drizzle } from 'drizzle-orm/node-postgres';
const db = drizzle(process.env.DATABASE_URL!);

// With connection pool
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle({ client: pool });

// With schema for relational queries
import * as schema from './schema';
const db = drizzle({ client: pool, schema });

// With SSL
const db = drizzle({
  connection: { connectionString: process.env.DATABASE_URL!, ssl: true }
});
```

## Schema Definition (PostgreSQL)

### Table Declaration

```typescript
import { pgTable, serial, text, varchar, integer, boolean,
  timestamp, json, jsonb, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: varchar({ length: 255 }).notNull().unique(),
  name: text().notNull(),
  role: text({ enum: ['admin', 'user', 'guest'] }).default('user'),
  metadata: jsonb().$type<{ theme: string; locale: string }>(),
  isActive: boolean().default(true),
  createdAt: timestamp().defaultNow().notNull(),
  updatedAt: timestamp().defaultNow().notNull(),
});
```

### Type Inference

```typescript
type User = typeof users.$inferSelect;   // SELECT result type
type NewUser = typeof users.$inferInsert; // INSERT input type
```

### PostgreSQL Column Types

| Type | Import | TypeScript | Notes |
|------|--------|------------|-------|
| `integer()` | pg-core | `number` | 4-byte signed |
| `smallint()` | pg-core | `number` | 2-byte signed |
| `bigint({ mode: 'number' })` | pg-core | `number` | 8-byte, mode selects JS type |
| `serial()` | pg-core | `number` | Auto-increment 4-byte |
| `bigserial({ mode: 'number' })` | pg-core | `number` | Auto-increment 8-byte |
| `text()` | pg-core | `string` | Unlimited length |
| `varchar({ length: 255 })` | pg-core | `string` | Variable with max |
| `char({ length: 10 })` | pg-core | `string` | Fixed-length |
| `boolean()` | pg-core | `boolean` | |
| `timestamp()` | pg-core | `Date` | `{ withTimezone: true }`, `{ mode: 'string' }` |
| `date()` | pg-core | `Date` | `{ mode: 'string' }` for raw |
| `time()` | pg-core | `string` | `{ withTimezone: true }` |
| `interval()` | pg-core | `string` | `{ fields: 'day' }` |
| `json()` | pg-core | `unknown` | Use `.$type<T>()` |
| `jsonb()` | pg-core | `unknown` | Binary JSON, use `.$type<T>()` |
| `uuid()` | pg-core | `string` | `.defaultRandom()` for auto-gen |
| `numeric({ precision, scale })` | pg-core | `string` | `{ mode: 'number' }` for JS number |
| `real()` | pg-core | `number` | 4-byte float |
| `doublePrecision()` | pg-core | `number` | 8-byte float |
| `bytea()` | pg-core | `Buffer` | Binary data |
| `point()` | pg-core | `[number, number]` | `{ mode: 'xy' }` for object |

### Enums

```typescript
import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['admin', 'user', 'guest']);

export const users = pgTable('users', {
  id: serial().primaryKey(),
  role: roleEnum().default('user'),
});
```

### Identity Columns (PostgreSQL 10+)

```typescript
// Preferred over serial() for new schemas
id: integer().primaryKey().generatedAlwaysAsIdentity({ startWith: 1000 }),
id: integer().primaryKey().generatedByDefaultAsIdentity(),
```

## Indexes & Constraints

```typescript
import { pgTable, serial, text, integer, index, uniqueIndex,
  primaryKey, foreignKey, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const posts = pgTable('posts', {
  id: serial().primaryKey(),
  title: text().notNull(),
  authorId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  slug: text().notNull(),
  status: text({ enum: ['draft', 'published'] }),
}, (table) => [
  index('title_idx').on(table.title),
  uniqueIndex('slug_idx').on(table.slug),
  check('status_check', sql`${table.status} in ('draft', 'published')`),
]);

// Composite primary key (junction tables)
export const usersToGroups = pgTable('users_to_groups', {
  userId: integer().notNull().references(() => users.id),
  groupId: integer().notNull().references(() => groups.id),
}, (table) => [
  primaryKey({ columns: [table.userId, table.groupId] }),
]);

// Composite unique constraint
export const example = pgTable('example', {
  a: integer(),
  b: text(),
}, (table) => [
  unique('ab_unique').on(table.a, table.b),
  unique('nulls_example').on(table.a).nullsNotDistinct(), // PG 15+
]);
```

## Relations

Relations are application-level abstractions, separate from database foreign keys. They enable the relational query API (`db.query`).

```typescript
import { relations } from 'drizzle-orm';

// One-to-many
export const authorsRelations = relations(authors, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(authors, {
    fields: [posts.authorId],
    references: [authors.id],
  }),
}));

// Many-to-many (through junction table)
export const usersRelations = relations(users, ({ many }) => ({
  usersToGroups: many(usersToGroups),
}));
export const usersToGroupsRelations = relations(usersToGroups, ({ one }) => ({
  user: one(users, { fields: [usersToGroups.userId], references: [users.id] }),
  group: one(groups, { fields: [usersToGroups.groupId], references: [groups.id] }),
}));

// Disambiguating multiple relations to same table
export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, {
    fields: [posts.authorId], references: [users.id],
    relationName: 'author',
  }),
  reviewer: one(users, {
    fields: [posts.reviewerId], references: [users.id],
    relationName: 'reviewer',
  }),
}));
```

## Queries

### SELECT

```typescript
import { eq, ne, gt, gte, lt, lte, like, ilike, inArray,
  isNull, isNotNull, and, or, between, sql, desc, asc, count } from 'drizzle-orm';

// Basic
const allUsers = await db.select().from(users);

// Partial select
const names = await db.select({ id: users.id, name: users.name }).from(users);

// Filtering
await db.select().from(users).where(eq(users.email, 'user@example.com'));
await db.select().from(users).where(
  and(eq(users.role, 'admin'), gt(users.createdAt, new Date('2024-01-01')))
);
await db.select().from(users).where(inArray(users.id, [1, 2, 3]));

// Sorting & pagination
await db.select().from(users).orderBy(desc(users.createdAt)).limit(10).offset(20);

// Distinct / Distinct On (PostgreSQL)
await db.selectDistinct().from(users);
await db.selectDistinctOn([users.id]).from(users).orderBy(users.id);
```

### INSERT

```typescript
// Single row with returning
const [newUser] = await db.insert(users)
  .values({ email: 'user@example.com', name: 'John' })
  .returning();

// Multiple rows
await db.insert(users).values([
  { email: 'a@example.com', name: 'A' },
  { email: 'b@example.com', name: 'B' },
]);

// Upsert
await db.insert(users)
  .values({ id: 1, email: 'new@example.com', name: 'Dan' })
  .onConflictDoUpdate({
    target: users.email,
    set: { name: 'Dan Updated' },
  });

await db.insert(users)
  .values({ id: 1, email: 'new@example.com', name: 'Dan' })
  .onConflictDoNothing({ target: users.email });

// Insert from select
await db.insert(employees).select(
  db.select({ name: users.name }).from(users).where(eq(users.role, 'employee'))
);
```

### UPDATE

```typescript
await db.update(users).set({ name: 'Jane' }).where(eq(users.id, 1));
await db.update(users).set({ updatedAt: sql`NOW()` }).where(eq(users.id, 1));

// With returning
const updated = await db.update(users)
  .set({ name: 'Jane' })
  .where(eq(users.id, 1))
  .returning();

// UPDATE...FROM
await db.update(users)
  .set({ cityId: cities.id })
  .from(cities)
  .where(and(eq(cities.name, 'Seattle'), eq(users.name, 'John')));
```

### DELETE

```typescript
await db.delete(users).where(eq(users.id, 1));
const deleted = await db.delete(users).where(eq(users.id, 1)).returning();
```

### Joins

```typescript
// Inner join
const result = await db.select({ user: users, post: posts })
  .from(users)
  .innerJoin(posts, eq(users.id, posts.authorId));

// Left join (pet fields become nullable)
await db.select().from(users).leftJoin(posts, eq(users.id, posts.authorId));

// Aggregation with join
await db.select({
  authorName: authors.name,
  postCount: count(posts.id),
}).from(authors)
  .leftJoin(posts, eq(authors.id, posts.authorId))
  .groupBy(authors.id);

// Self-join with alias
import { alias } from 'drizzle-orm/pg-core';
const parent = alias(users, 'parent');
await db.select().from(users).leftJoin(parent, eq(parent.id, users.parentId));
```

### Relational Queries

```typescript
// Requires schema passed to drizzle() constructor
const usersWithPosts = await db.query.users.findMany({
  with: { posts: { with: { comments: true } } },
  columns: { id: true, name: true },
  where: (users, { eq }) => eq(users.role, 'admin'),
  orderBy: (users, { desc }) => [desc(users.createdAt)],
  limit: 10,
});

const user = await db.query.users.findFirst({
  where: (users, { eq }) => eq(users.id, 1),
  with: { posts: true },
});
```

## Transactions

```typescript
// Auto-rollback on error
await db.transaction(async (tx) => {
  await tx.update(accounts).set({ balance: sql`${accounts.balance} - 100` })
    .where(eq(accounts.id, 1));
  await tx.update(accounts).set({ balance: sql`${accounts.balance} + 100` })
    .where(eq(accounts.id, 2));
});

// Conditional rollback
await db.transaction(async (tx) => {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, 1));
  if (account.balance < 100) {
    tx.rollback();
    return;
  }
  await tx.update(accounts).set({ balance: sql`${accounts.balance} - 100` })
    .where(eq(accounts.id, 1));
});

// Nested transactions (savepoints)
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'John', email: 'john@ex.com' });
  await tx.transaction(async (tx2) => {
    await tx2.insert(posts).values({ title: 'Post', authorId: 1 });
  });
});

// PostgreSQL isolation levels
await db.transaction(async (tx) => { /* ... */ }, {
  isolationLevel: 'serializable',
  accessMode: 'read write',
  deferrable: true,
});
```

## Migrations with drizzle-kit

### Configuration

```typescript
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

### Core Commands

```bash
# Generate SQL migration from schema changes
npx drizzle-kit generate

# Apply migrations to database
npx drizzle-kit migrate

# Push schema directly (no migration files — for rapid prototyping)
npx drizzle-kit push

# Pull existing database schema into TypeScript
npx drizzle-kit pull

# Generate custom empty migration
npx drizzle-kit generate --custom --name=seed-users

# Verify migration consistency
npx drizzle-kit check

# Launch visual database browser
npx drizzle-kit studio
```

### Programmatic Migration

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const db = drizzle(process.env.DATABASE_URL!);
await migrate(db, { migrationsFolder: './drizzle' });
```

See **[PostgreSQL Migrations](./references/pg-migrations.md)** for complete migration strategies, team workflows, and production patterns.

## PostgreSQL Schemas

```typescript
import { pgSchema, serial, text } from 'drizzle-orm/pg-core';

export const tenantSchema = pgSchema('tenant_1');
export const tenantUsers = tenantSchema.table('users', {
  id: serial().primaryKey(),
  name: text().notNull(),
});
// Generates: CREATE SCHEMA "tenant_1"; CREATE TABLE "tenant_1"."users" (...)
```

## Views

```typescript
import { pgView, pgMaterializedView } from 'drizzle-orm/pg-core';

export const activeUsers = pgView('active_users').as((qb) =>
  qb.select().from(users).where(eq(users.isActive, true))
);

export const userStats = pgMaterializedView('user_stats').as((qb) =>
  qb.select({
    userId: users.id,
    postCount: count(posts.id),
  }).from(users).leftJoin(posts, eq(users.id, posts.authorId)).groupBy(users.id)
);

// Refresh at runtime
await db.refreshMaterializedView(userStats);
await db.refreshMaterializedView(userStats).concurrently();
```

## Common Table Expressions (CTEs)

```typescript
const sq = db.$with('active').as(
  db.select().from(users).where(eq(users.isActive, true))
);
const result = await db.with(sq).select().from(sq);

// CTE with INSERT
const inserted = db.$with('new_user').as(
  db.insert(users).values({ name: 'John', email: 'john@ex.com' }).returning()
);
await db.with(inserted).select().from(inserted);
```

## Red Flags

| Problem | Risk |
|---------|------|
| `any`/`unknown` on JSON columns without `.$type<T>()` | Lost type safety |
| Raw string concatenation instead of `sql` template | SQL injection |
| Multi-step mutations outside `db.transaction()` | Partial writes |
| `select()` without `.limit()` on large tables | Memory exhaustion |
| Missing indexes on foreign key columns | Slow joins |
| Missing indexes on frequently filtered columns | Full table scans |
| Using `serial()` instead of `generatedAlwaysAsIdentity()` | `serial` is legacy in PG 10+ |

## References

- **[PostgreSQL Migrations](./references/pg-migrations.md)** — drizzle-kit configuration, migration strategies, team workflows, production patterns, custom migrations, programmatic migration API. Load when managing database schema changes.

- **[Advanced Schemas](./references/advanced-schemas.md)** — Custom types, branded types, composite keys, arrays, multi-schema, views, materialized views, pgEnum patterns. Load when designing complex database schemas.

- **[Query Patterns](./references/query-patterns.md)** — Subqueries, CTEs, raw SQL, prepared statements, dynamic queries, batch operations, aggregations, window functions. Load when optimizing queries or handling complex filtering.

- **[Performance](./references/performance.md)** — Connection pooling, prepared statements, N+1 prevention, query optimization, edge runtime integration, serverless patterns. Load when scaling or optimizing database performance.

- **[Drizzle vs Prisma](./references/vs-prisma.md)** — Feature comparison, migration guide, architectural differences, when to choose Drizzle. Load when evaluating ORMs or migrating from Prisma.

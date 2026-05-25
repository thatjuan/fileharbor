# Drizzle vs Prisma

Feature comparison, architectural differences, and migration guide for teams evaluating or switching between Drizzle ORM and Prisma.

## Table of Contents

- [Architecture Comparison](#architecture-comparison)
- [Feature Matrix](#feature-matrix)
- [Performance Comparison](#performance-comparison)
- [Schema Definition](#schema-definition)
- [Query Syntax](#query-syntax)
- [Migration Systems](#migration-systems)
- [When to Choose Drizzle](#when-to-choose-drizzle)
- [When to Choose Prisma](#when-to-choose-prisma)
- [Migration Guide: Prisma to Drizzle](#migration-guide-prisma-to-drizzle)

## Architecture Comparison

| Aspect | Drizzle | Prisma |
|--------|---------|--------|
| Query engine | Pure TypeScript, runs in-process | Rust binary (Query Engine), separate process |
| Type generation | Runtime inference (`$inferSelect`) | Build-time code generation (`prisma generate`) |
| Schema format | TypeScript files | `.prisma` DSL |
| Dependencies | Zero runtime deps | `@prisma/client`, `@prisma/engines` |
| SQL access | Direct SQL-like API + raw SQL | Abstracted API + `$queryRaw` |
| Connection handling | Bring-your-own driver | Managed by Prisma engine |

## Feature Matrix

| Feature | Drizzle | Prisma |
|---------|---------|--------|
| Type-safe queries | Yes (inferred) | Yes (generated) |
| Relations/nested reads | Yes (relational query API) | Yes (include/select) |
| Raw SQL | `sql` template tag | `$queryRaw`, `$executeRaw` |
| Transactions | Yes (callback + nested savepoints) | Yes (interactive + sequential) |
| Migrations | drizzle-kit generate/migrate/push | prisma migrate dev/deploy |
| Introspection | `drizzle-kit pull` | `prisma db pull` |
| Database GUI | Drizzle Studio | Prisma Studio |
| Connection pooling | BYO (pg Pool, postgres.js) | Built-in + Prisma Accelerate |
| Edge runtime | Native support | Via Prisma Accelerate/Driver Adapters |
| PostgreSQL | Full support | Full support |
| MySQL | Full support | Full support |
| SQLite | Full support | Full support |
| MSSQL | Full support | Preview |
| CockroachDB | Full support | Full support |
| Views | pgView, pgMaterializedView | `@@view` (preview) |
| Enums | pgEnum (native) | enum in schema |
| JSON typed columns | `.$type<T>()` | `Json` type (no granular typing) |
| Composite PKs | Yes | Yes (@@id) |
| Partial indexes | Via raw SQL | Not supported |
| Prepared statements | `.prepare()` with placeholders | Automatic (internal) |
| Streaming/iterators | `.iterator()` | `findManyStream()` (preview) |
| Middleware/extensions | No (use SQL hooks) | Yes (Prisma Client extensions) |

## Performance Comparison

| Metric | Drizzle | Prisma |
|--------|---------|--------|
| Bundle size | ~35KB | ~230KB |
| Cold start | ~10ms | ~250ms |
| Simple SELECT | Baseline | ~2-3x slower |
| Complex JOIN | Baseline | ~2-5x slower |
| Memory usage | ~10MB | ~50MB |
| INSERT (batch) | Baseline | ~1.5x slower |

Drizzle's performance advantage comes from:
- No separate query engine process
- No serialization/deserialization between JS and Rust
- Direct driver communication
- Minimal abstraction layer

Prisma's overhead comes from:
- Rust Query Engine binary communication via JSON-RPC
- Schema validation layer
- Query plan compilation in the engine

## Schema Definition

### Prisma

```prisma
// schema.prisma
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String
  role      Role     @default(USER)
  posts     Post[]
  createdAt DateTime @default(now())
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}

enum Role {
  ADMIN
  USER
}
```

### Drizzle Equivalent

```typescript
// schema.ts
import { pgTable, serial, text, varchar, integer, timestamp,
  pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const roleEnum = pgEnum('role', ['admin', 'user']);

export const users = pgTable('users', {
  id: serial().primaryKey(),
  email: varchar({ length: 255 }).notNull().unique(),
  name: text().notNull(),
  role: roleEnum().default('user'),
  createdAt: timestamp().defaultNow(),
});

export const posts = pgTable('posts', {
  id: serial().primaryKey(),
  title: text().notNull(),
  authorId: integer().notNull().references(() => users.id),
});

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
```

## Query Syntax

### Find Many

```typescript
// Prisma
const users = await prisma.user.findMany({
  where: { role: 'ADMIN' },
  include: { posts: true },
  orderBy: { createdAt: 'desc' },
  take: 10,
});

// Drizzle (relational)
const users = await db.query.users.findMany({
  where: (users, { eq }) => eq(users.role, 'admin'),
  with: { posts: true },
  orderBy: (users, { desc }) => [desc(users.createdAt)],
  limit: 10,
});

// Drizzle (SQL-like)
const users = await db.select().from(usersTable)
  .where(eq(usersTable.role, 'admin'))
  .orderBy(desc(usersTable.createdAt))
  .limit(10);
```

### Create

```typescript
// Prisma
const user = await prisma.user.create({
  data: { email: 'a@b.com', name: 'John' },
});

// Drizzle
const [user] = await db.insert(users)
  .values({ email: 'a@b.com', name: 'John' })
  .returning();
```

### Upsert

```typescript
// Prisma
await prisma.user.upsert({
  where: { email: 'a@b.com' },
  create: { email: 'a@b.com', name: 'John' },
  update: { name: 'John Updated' },
});

// Drizzle
await db.insert(users)
  .values({ email: 'a@b.com', name: 'John' })
  .onConflictDoUpdate({
    target: users.email,
    set: { name: 'John Updated' },
  });
```

### Transaction

```typescript
// Prisma
const result = await prisma.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { name: 'John', email: 'j@b.com' } });
  const post = await tx.post.create({ data: { title: 'Hello', authorId: user.id } });
  return { user, post };
});

// Drizzle
const result = await db.transaction(async (tx) => {
  const [user] = await tx.insert(users).values({ name: 'John', email: 'j@b.com' }).returning();
  const [post] = await tx.insert(posts).values({ title: 'Hello', authorId: user.id }).returning();
  return { user, post };
});
```

## Migration Systems

| Aspect | Drizzle Kit | Prisma Migrate |
|--------|-------------|----------------|
| Schema format | TypeScript | Prisma DSL |
| Generate | `drizzle-kit generate` | `prisma migrate dev` |
| Apply (dev) | `drizzle-kit migrate` | `prisma migrate dev` |
| Apply (prod) | `drizzle-kit migrate` | `prisma migrate deploy` |
| Push (no files) | `drizzle-kit push` | `prisma db push` |
| Introspect | `drizzle-kit pull` | `prisma db pull` |
| Custom SQL | `--custom` flag | Manual SQL in migration dir |
| Rename detection | Interactive prompt | Automatic (sometimes wrong) |
| Migration format | SQL files | SQL files |
| Shadow database | Not needed | Required for `dev` |

Key differences:
- Prisma requires a shadow database for development migrations; Drizzle does not
- Drizzle generates pure SQL; Prisma wraps SQL in its migration engine
- Drizzle prompts interactively for ambiguous renames; Prisma guesses

## When to Choose Drizzle

- Edge runtime / serverless deployment (Cloudflare Workers, Vercel Edge)
- Bundle size matters (mobile, embedded, edge)
- Cold start latency matters
- Team prefers SQL-like syntax over abstracted APIs
- Need direct control over SQL output
- Need PostgreSQL-specific features (lateral joins, materialized views, partial indexes)
- Want zero runtime dependencies
- TypeScript-only codebase (no extra DSL)

## When to Choose Prisma

- Team prefers high-level abstraction over SQL
- Prisma Client Extensions ecosystem is needed
- Need built-in middleware/hooks for query interception
- Using Prisma Accelerate for global edge caching
- Team has existing Prisma infrastructure and expertise
- Need auto-generated CRUD operations with minimal code
- Rapid prototyping with less SQL knowledge required

## Migration Guide: Prisma to Drizzle

### Step 1: Install Drizzle

```bash
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg
```

### Step 2: Introspect Existing Database

```bash
npx drizzle-kit pull
```

This generates TypeScript schema files from the Prisma-managed database.

### Step 3: Review Generated Schema

Check `drizzle/schema.ts` against the Prisma schema for accuracy. Add relations:

```typescript
// Generated tables are correct, but relations need manual addition
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));
```

### Step 4: Set Up drizzle.config.ts

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

### Step 5: Replace Queries Incrementally

Replace Prisma client calls with Drizzle queries one module at a time. Both ORMs can coexist during migration since they connect to the same database independently.

### Step 6: Remove Prisma

Once all queries are migrated:

```bash
npm uninstall prisma @prisma/client
rm -rf prisma/
```

### Type Mapping

| Prisma Type | Drizzle Equivalent |
|-------------|-------------------|
| `Int` | `integer()` |
| `BigInt` | `bigint({ mode: 'number' })` |
| `String` | `text()` or `varchar()` |
| `Boolean` | `boolean()` |
| `DateTime` | `timestamp()` |
| `Json` | `jsonb().$type<T>()` |
| `Float` | `real()` or `doublePrecision()` |
| `Decimal` | `numeric()` |
| `Bytes` | `bytea()` |
| `@id @default(autoincrement())` | `serial().primaryKey()` |
| `@id @default(uuid())` | `uuid().defaultRandom().primaryKey()` |
| `@default(now())` | `.defaultNow()` |
| `@unique` | `.unique()` |
| `@relation` | `relations()` + `.references()` |
| `@@index` | `index().on()` |
| `@@unique` | `unique().on()` |

# Performance

Connection pooling, query optimization, and runtime integration patterns for Drizzle ORM with PostgreSQL.

## Table of Contents

- [Connection Pooling](#connection-pooling)
- [Prepared Statements](#prepared-statements)
- [N+1 Prevention](#n1-prevention)
- [Query Optimization](#query-optimization)
- [Index Strategy](#index-strategy)
- [Edge Runtime and Serverless](#edge-runtime-and-serverless)
- [Bundle Size](#bundle-size)
- [Monitoring](#monitoring)

## Connection Pooling

### node-postgres Pool

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,              // max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const db = drizzle({ client: pool });
```

### postgres.js

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const client = postgres(process.env.DATABASE_URL!, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
});

const db = drizzle(client);
```

### External Poolers (PgBouncer, Supabase Pooler)

When using an external connection pooler, connect through the pooler URL and configure the client for single connections:

```typescript
// Through PgBouncer (transaction mode)
const pool = new Pool({
  connectionString: process.env.PGBOUNCER_URL,
  max: 1,  // pooler manages connections
});
const db = drizzle({ client: pool });
```

### Neon Serverless

```typescript
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

// HTTP mode — one query per request, no persistent connection
const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

// WebSocket mode — for transactions and multiple queries
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool } from '@neondatabase/serverless';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });
```

## Prepared Statements

Prepared statements eliminate repeated SQL parsing. Drizzle concatenates SQL once and reuses the compiled query plan.

```typescript
// Define once
const getUserById = db.select().from(users)
  .where(eq(users.id, sql.placeholder('id')))
  .prepare('get_user_by_id');

// Execute many times (SQL parsing happens once)
const user1 = await getUserById.execute({ id: 1 });
const user2 = await getUserById.execute({ id: 2 });
```

### When to Use Prepared Statements

| Scenario | Benefit |
|----------|---------|
| Hot path queries (auth, user lookup) | Eliminates repeated SQL generation |
| Complex joins / CTEs | Avoids expensive query planning on each call |
| High-throughput endpoints | Reduces CPU overhead |
| Queries executed in loops | Prevents N repeated preparations |

### When to Skip

- One-off admin queries
- Dynamic queries where the SQL structure changes per request
- Queries used only during initialization

## N+1 Prevention

### Problem: N+1 with Manual Joins

```typescript
// BAD: N+1 — 1 query for users + N queries for posts
const users = await db.select().from(usersTable);
for (const user of users) {
  const posts = await db.select().from(postsTable)
    .where(eq(postsTable.authorId, user.id));
}
```

### Solution 1: Relational Query API

The relational query builder fetches nested data in a single SQL query using lateral joins:

```typescript
// GOOD: single query with nested relations
const usersWithPosts = await db.query.users.findMany({
  with: { posts: true },
});
```

### Solution 2: Explicit JOIN

```typescript
// GOOD: single query, manual aggregation
const rows = await db.select({ user: users, post: posts })
  .from(users)
  .leftJoin(posts, eq(users.id, posts.authorId));

// Reduce to nested structure
const result = rows.reduce<Record<number, { user: User; posts: Post[] }>>((acc, row) => {
  if (!acc[row.user.id]) acc[row.user.id] = { user: row.user, posts: [] };
  if (row.post) acc[row.user.id].posts.push(row.post);
  return acc;
}, {});
```

### Solution 3: Batch Loading with IN

```typescript
// GOOD: 2 queries total
const users = await db.select().from(usersTable);
const userIds = users.map(u => u.id);
const posts = await db.select().from(postsTable)
  .where(inArray(postsTable.authorId, userIds));
```

## Query Optimization

### Select Only Needed Columns

```typescript
// BAD: fetches all columns
await db.select().from(users);

// GOOD: fetches only needed columns
await db.select({ id: users.id, name: users.name }).from(users);

// GOOD: exclude sensitive/large columns
const { password, bio, ...cols } = getTableColumns(users);
await db.select(cols).from(users);
```

### Use Pagination

```typescript
// Offset-based (simple, slower for deep pages)
await db.select().from(users).limit(20).offset(page * 20);

// Cursor-based (consistent performance)
await db.select().from(users)
  .where(gt(users.id, lastId))
  .orderBy(asc(users.id))
  .limit(20);
```

### Use Transactions for Multi-Step Writes

Transactions reduce round-trips and ensure atomicity:

```typescript
await db.transaction(async (tx) => {
  const [user] = await tx.insert(users).values({ name: 'John' }).returning();
  await tx.insert(profiles).values({ userId: user.id, bio: '...' });
  await tx.insert(auditLog).values({ action: 'user_created', targetId: user.id });
});
```

### Avoid Unnecessary Queries

```typescript
// BAD: query + update
const user = await db.select().from(users).where(eq(users.id, 1));
if (user) await db.update(users).set({ lastLogin: new Date() }).where(eq(users.id, 1));

// GOOD: single conditional update
await db.update(users)
  .set({ lastLogin: new Date() })
  .where(eq(users.id, 1))
  .returning();
```

## Index Strategy

### Foreign Key Indexes

PostgreSQL does not auto-index foreign key columns. Index them explicitly:

```typescript
export const posts = pgTable('posts', {
  id: serial().primaryKey(),
  authorId: integer().notNull().references(() => users.id),
  categoryId: integer().references(() => categories.id),
}, (table) => [
  index('posts_author_idx').on(table.authorId),
  index('posts_category_idx').on(table.categoryId),
]);
```

### Composite Indexes for Common Queries

```typescript
export const events = pgTable('events', {
  id: serial().primaryKey(),
  userId: integer().notNull(),
  type: text().notNull(),
  createdAt: timestamp().defaultNow(),
}, (table) => [
  // Covers: WHERE userId = ? AND type = ? ORDER BY createdAt
  index('events_user_type_created').on(table.userId, table.type, table.createdAt),
]);
```

### Unique Indexes

```typescript
export const users = pgTable('users', {
  id: serial().primaryKey(),
  email: varchar({ length: 255 }).notNull(),
}, (table) => [
  uniqueIndex('users_email_idx').on(table.email),
]);
```

## Edge Runtime and Serverless

### Bundle Size Comparison

| ORM | Bundle Size | Cold Start |
|-----|-------------|------------|
| Drizzle | ~35KB | ~10ms |
| Prisma | ~230KB | ~250ms |
| TypeORM | ~200KB | ~150ms |

### Cloudflare Workers / Vercel Edge

```typescript
// Neon HTTP — stateless, edge-compatible
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

export default {
  async fetch(request: Request) {
    const users = await db.select().from(usersTable);
    return Response.json(users);
  },
};
```

### PGlite (Embedded PostgreSQL)

```typescript
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';

const client = new PGlite();
const db = drizzle(client);
```

### Serverless Connection Management

For serverless environments, the connection pool configuration differs:

```typescript
// Lambda / Vercel Functions
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,  // single connection per function instance
});

// Use an external pooler (PgBouncer, Neon, Supabase) for connection reuse
```

## Bundle Size

Drizzle has zero runtime dependencies. The bundle includes only what is imported:

```typescript
// Minimal import — only what is used
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
```

Tree-shaking eliminates unused dialect code. Only the PostgreSQL core is bundled when using `drizzle-orm/pg-core`.

## Monitoring

### Query Logging

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';

const db = drizzle({
  client: pool,
  logger: true,  // logs all queries to console
});

// Custom logger
const db = drizzle({
  client: pool,
  logger: {
    logQuery(query, params) {
      console.log({ query, params, timestamp: Date.now() });
    },
  },
});
```

### Performance Timing

```typescript
const start = performance.now();
const result = await db.select().from(users);
const duration = performance.now() - start;
console.log(`Query took ${duration.toFixed(2)}ms, ${result.length} rows`);
```

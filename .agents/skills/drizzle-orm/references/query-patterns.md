# Query Patterns

Advanced query techniques with Drizzle ORM for PostgreSQL.

## Table of Contents

- [Subqueries](#subqueries)
- [Common Table Expressions (CTEs)](#common-table-expressions-ctes)
- [Raw SQL](#raw-sql)
- [Prepared Statements](#prepared-statements)
- [Dynamic Queries](#dynamic-queries)
- [Aggregations](#aggregations)
- [Batch Operations](#batch-operations)
- [Cursor-Based Pagination](#cursor-based-pagination)
- [Streaming Large Result Sets](#streaming-large-result-sets)
- [Column Utilities](#column-utilities)
- [Lateral Joins](#lateral-joins)

## Subqueries

### Inline Subqueries

```typescript
const sq = db.select({ id: users.id })
  .from(users)
  .where(eq(users.role, 'admin'))
  .as('admin_users');

// In FROM
const admins = await db.select().from(sq);

// In JOIN
const posts = await db.select()
  .from(posts)
  .innerJoin(sq, eq(posts.authorId, sq.id));

// In WHERE with inArray
const adminIds = db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
const adminPosts = await db.select().from(posts).where(inArray(posts.authorId, adminIds));
```

### Correlated Subqueries

```typescript
// Count posts per user as a subquery column
const usersWithPostCount = await db.select({
  ...getTableColumns(users),
  postCount: db.$count(posts, eq(posts.authorId, users.id)),
}).from(users);
```

### $count Utility

```typescript
// Standalone count
const totalUsers = await db.$count(users);
const activeUsers = await db.$count(users, eq(users.isActive, true));

// As subquery in select
const result = await db.select({
  id: users.id,
  name: users.name,
  postCount: db.$count(posts, eq(posts.authorId, users.id)),
}).from(users);
```

## Common Table Expressions (CTEs)

### Basic CTE

```typescript
const activeUsers = db.$with('active_users').as(
  db.select().from(users).where(eq(users.isActive, true))
);

const result = await db.with(activeUsers)
  .select()
  .from(activeUsers);
```

### CTE with Computed Columns

Computed fields in CTEs require `.as()` aliases:

```typescript
const userEmails = db.$with('user_emails').as(
  db.select({
    id: users.id,
    lowerEmail: sql<string>`lower(${users.email})`.as('lower_email'),
  }).from(users)
);

const result = await db.with(userEmails)
  .select({ email: userEmails.lowerEmail })
  .from(userEmails);
```

### CTE with INSERT

```typescript
const newUser = db.$with('new_user').as(
  db.insert(users).values({ name: 'John', email: 'john@ex.com' }).returning()
);

const result = await db.with(newUser).select().from(newUser);
```

### CTE with UPDATE

```typescript
const avgPrice = db.$with('avg_price').as(
  db.select({ value: sql`avg(${products.price})`.as('value') }).from(products)
);

await db.with(avgPrice)
  .update(products)
  .set({ cheap: true })
  .where(lt(products.price, sql`(select * from ${avgPrice})`));
```

### Multiple CTEs

```typescript
const cte1 = db.$with('active').as(
  db.select().from(users).where(eq(users.isActive, true))
);
const cte2 = db.$with('admins').as(
  db.select().from(users).where(eq(users.role, 'admin'))
);

const result = await db.with(cte1, cte2)
  .select()
  .from(cte1)
  .innerJoin(cte2, eq(cte1.id, cte2.id));
```

## Raw SQL

### sql Template Tag

The `sql` template tag provides safe parameterized SQL:

```typescript
import { sql } from 'drizzle-orm';

// In select
await db.select({
  id: users.id,
  fullName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
}).from(users);

// In where
await db.select().from(users).where(
  sql`${users.createdAt} > NOW() - INTERVAL '30 days'`
);

// Complete raw query
const result = await db.execute(
  sql`SELECT * FROM users WHERE email = ${email}`
);

// With typed results
const result = await db.execute<{ id: number; name: string }>(
  sql`SELECT id, name FROM users WHERE role = ${role}`
);
```

### sql.raw() for Unparameterized SQL

```typescript
// WARNING: only use with trusted, non-user input
const tableName = 'users';
await db.execute(sql`SELECT * FROM ${sql.raw(tableName)}`);

// Dynamic column ordering
const orderCol = 'created_at';
const direction = 'DESC';
await db.select().from(users).orderBy(sql.raw(`${orderCol} ${direction}`));
```

### sql.join() for Building Lists

```typescript
const conditions = [
  eq(users.role, 'admin'),
  gt(users.createdAt, new Date('2024-01-01')),
];

await db.select().from(users).where(
  sql.join(conditions, sql` AND `)
);
```

## Prepared Statements

### PostgreSQL Prepared Statements

PostgreSQL prepared statements require a name:

```typescript
import { sql } from 'drizzle-orm';

const getUserById = db.select().from(users)
  .where(eq(users.id, sql.placeholder('id')))
  .prepare('get_user_by_id');

// Reuse with different values
const user1 = await getUserById.execute({ id: 1 });
const user2 = await getUserById.execute({ id: 2 });
```

### Multiple Placeholders

```typescript
const searchUsers = db.select().from(users)
  .where(and(
    eq(users.role, sql.placeholder('role')),
    sql`lower(${users.name}) like ${sql.placeholder('name')}`,
  ))
  .limit(sql.placeholder('limit'))
  .prepare('search_users');

const results = await searchUsers.execute({
  role: 'admin',
  name: '%john%',
  limit: 10,
});
```

### Prepared Relational Queries

```typescript
const getUserWithPosts = db.query.users.findFirst({
  where: (users, { eq }) => eq(users.id, sql.placeholder('id')),
  with: { posts: true },
}).prepare('get_user_with_posts');

const user = await getUserWithPosts.execute({ id: 1 });
```

## Dynamic Queries

### Conditional WHERE Clauses

```typescript
async function searchUsers(filters: {
  name?: string;
  role?: string;
  minAge?: number;
}) {
  const conditions = [];

  if (filters.name) {
    conditions.push(ilike(users.name, `%${filters.name}%`));
  }
  if (filters.role) {
    conditions.push(eq(users.role, filters.role));
  }
  if (filters.minAge) {
    conditions.push(gte(users.age, filters.minAge));
  }

  return db.select().from(users)
    .where(conditions.length ? and(...conditions) : undefined);
}
```

### Dynamic Select

```typescript
async function getUsers(includeEmail: boolean) {
  return db.select({
    id: users.id,
    name: users.name,
    ...(includeEmail ? { email: users.email } : {}),
  }).from(users);
}
```

### Dynamic Order By

```typescript
type SortField = 'name' | 'createdAt' | 'email';
type SortDir = 'asc' | 'desc';

function getOrderBy(field: SortField, dir: SortDir) {
  const column = {
    name: users.name,
    createdAt: users.createdAt,
    email: users.email,
  }[field];

  return dir === 'asc' ? asc(column) : desc(column);
}

await db.select().from(users).orderBy(getOrderBy('name', 'desc'));
```

## Aggregations

### Built-in Aggregate Functions

```typescript
import { count, countDistinct, sum, sumDistinct,
  avg, avgDistinct, max, min } from 'drizzle-orm';

// Count
await db.select({ total: count() }).from(users);
await db.select({ total: count(users.id) }).from(users);
await db.select({ unique: countDistinct(users.role) }).from(users);

// Sum / Avg
await db.select({ totalScore: sum(scores.value) }).from(scores);
await db.select({ avgAge: avg(users.age) }).from(users);

// Min / Max
await db.select({
  oldest: min(users.createdAt),
  newest: max(users.createdAt),
}).from(users);
```

### GROUP BY and HAVING

```typescript
await db.select({
  role: users.role,
  userCount: count(users.id),
  avgAge: avg(users.age),
}).from(users)
  .groupBy(users.role)
  .having(({ userCount }) => gt(userCount, 5));
```

### Window Functions (via raw SQL)

```typescript
await db.select({
  id: users.id,
  name: users.name,
  rowNum: sql<number>`ROW_NUMBER() OVER (ORDER BY ${users.createdAt})`,
  rank: sql<number>`RANK() OVER (PARTITION BY ${users.role} ORDER BY ${users.createdAt})`,
}).from(users);
```

## Batch Operations

### Bulk Insert

```typescript
const newUsers = Array.from({ length: 1000 }, (_, i) => ({
  name: `User ${i}`,
  email: `user${i}@example.com`,
}));

// Single statement insert
await db.insert(users).values(newUsers);
```

### Bulk Upsert

```typescript
const records = [
  { id: 1, name: 'Updated A', email: 'a@ex.com' },
  { id: 2, name: 'Updated B', email: 'b@ex.com' },
];

await db.insert(users)
  .values(records)
  .onConflictDoUpdate({
    target: users.id,
    set: { name: sql`excluded.name` },
  });
```

### Batch Queries in Transaction

```typescript
const results = await db.transaction(async (tx) => {
  const newUser = await tx.insert(users)
    .values({ name: 'John', email: 'john@ex.com' })
    .returning();

  const newPost = await tx.insert(posts)
    .values({ title: 'Hello', authorId: newUser[0].id })
    .returning();

  return { user: newUser[0], post: newPost[0] };
});
```

## Cursor-Based Pagination

```typescript
async function getPage(cursor?: number, pageSize = 20) {
  return db.select()
    .from(users)
    .where(cursor ? gt(users.id, cursor) : undefined)
    .orderBy(asc(users.id))
    .limit(pageSize);
}

// Usage
const page1 = await getPage();
const page2 = await getPage(page1[page1.length - 1]?.id);
```

### Keyset Pagination with Multiple Columns

```typescript
async function getPage(cursor?: { createdAt: Date; id: number }, pageSize = 20) {
  return db.select()
    .from(posts)
    .where(cursor
      ? or(
          gt(posts.createdAt, cursor.createdAt),
          and(eq(posts.createdAt, cursor.createdAt), gt(posts.id, cursor.id))
        )
      : undefined
    )
    .orderBy(asc(posts.createdAt), asc(posts.id))
    .limit(pageSize);
}
```

## Streaming Large Result Sets

```typescript
const iterator = await db.select().from(users).iterator();

for await (const row of iterator) {
  processUser(row);
}

// With prepared statements
const query = db.select().from(users)
  .where(eq(users.isActive, true))
  .prepare('active_users');
const iter = await query.iterator();

for await (const row of iter) {
  processUser(row);
}
```

## Column Utilities

### getTableColumns

```typescript
import { getTableColumns } from 'drizzle-orm';

// All columns
const allCols = getTableColumns(users);
await db.select(allCols).from(users);

// Exclude columns
const { password, ...safeCols } = getTableColumns(users);
await db.select(safeCols).from(users);

// Add computed columns
await db.select({
  ...getTableColumns(users),
  fullName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
}).from(users);
```

## Lateral Joins

PostgreSQL lateral joins allow subqueries to reference columns from preceding FROM items:

```typescript
// Get top 3 posts per user
const topPosts = db.select().from(posts)
  .where(eq(posts.authorId, users.id))
  .orderBy(desc(posts.createdAt))
  .limit(3)
  .as('top_posts');

await db.select()
  .from(users)
  .leftJoinLateral(topPosts, sql`true`);

// Inner lateral join
await db.select()
  .from(users)
  .innerJoinLateral(topPosts, sql`true`);

// Cross lateral join
await db.select()
  .from(users)
  .crossJoinLateral(topPosts);
```

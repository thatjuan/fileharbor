# Advanced Schemas

Complex PostgreSQL schema patterns with Drizzle ORM.

## Table of Contents

- [Custom Types and Branded Types](#custom-types-and-branded-types)
- [PostgreSQL Enums](#postgresql-enums)
- [Arrays](#arrays)
- [JSON and JSONB Patterns](#json-and-jsonb-patterns)
- [Composite Primary Keys](#composite-primary-keys)
- [Foreign Key Actions](#foreign-key-actions)
- [Self-Referencing Tables](#self-referencing-tables)
- [Multi-Schema Architecture](#multi-schema-architecture)
- [Views and Materialized Views](#views-and-materialized-views)
- [Default Value Patterns](#default-value-patterns)
- [Check Constraints](#check-constraints)

## Custom Types and Branded Types

### Branded Types for Type Safety

```typescript
type UserId = number & { __brand: 'user_id' };
type PostId = number & { __brand: 'post_id' };

export const users = pgTable('users', {
  id: serial().$type<UserId>().primaryKey(),
  name: text().notNull(),
});

export const posts = pgTable('posts', {
  id: serial().$type<PostId>().primaryKey(),
  authorId: integer().$type<UserId>().notNull().references(() => users.id),
});

// Compiler prevents: posts.authorId = somePostId (type mismatch)
```

### Custom Column Defaults

```typescript
import { sql } from 'drizzle-orm';

export const items = pgTable('items', {
  id: uuid().defaultRandom().primaryKey(),
  slug: text().$defaultFn(() => generateSlug()),  // Runtime JS default
  code: varchar({ length: 10 }).$defaultFn(() => nanoid(10)),
  createdAt: timestamp().default(sql`NOW()`),
  sortOrder: integer().default(sql`nextval('items_sort_seq')`),
});
```

### $onUpdate for Automatic Updates

```typescript
export const users = pgTable('users', {
  id: serial().primaryKey(),
  name: text().notNull(),
  updatedAt: timestamp().$onUpdate(() => new Date()),
});
```

## PostgreSQL Enums

### Basic Enum

```typescript
import { pgEnum, pgTable, serial } from 'drizzle-orm/pg-core';

export const statusEnum = pgEnum('status', ['active', 'inactive', 'pending']);

export const users = pgTable('users', {
  id: serial().primaryKey(),
  status: statusEnum().default('pending').notNull(),
});
```

### Enum in Custom Schema

```typescript
import { pgSchema } from 'drizzle-orm/pg-core';

export const mySchema = pgSchema('my_schema');
export const colorEnum = mySchema.enum('color', ['red', 'green', 'blue']);

export const products = mySchema.table('products', {
  id: serial().primaryKey(),
  color: colorEnum().default('red'),
});
```

### Text Column with Enum Inference

For lightweight enum-like behavior without a PostgreSQL enum type:

```typescript
export const users = pgTable('users', {
  role: text({ enum: ['admin', 'user', 'guest'] }).default('user'),
});
// TypeScript type: 'admin' | 'user' | 'guest'
// Database type: text (no CREATE TYPE)
```

## Arrays

PostgreSQL array columns using the `array()` wrapper:

```typescript
import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core';

export const posts = pgTable('posts', {
  id: serial().primaryKey(),
  tags: text().array(),                    // text[]
  scores: integer().array(),               // integer[]
  matrix: integer().array().array(),       // integer[][]
});

// Querying arrays
import { sql, arrayContains, arrayContained, arrayOverlaps } from 'drizzle-orm';

await db.select().from(posts).where(arrayContains(posts.tags, ['typescript']));
await db.select().from(posts).where(arrayOverlaps(posts.tags, ['ts', 'js']));
await db.select().from(posts).where(
  sql`${posts.tags} @> ARRAY['typescript']::text[]`
);
```

## JSON and JSONB Patterns

### Typed JSON Columns

```typescript
interface UserPreferences {
  theme: 'light' | 'dark';
  locale: string;
  notifications: { email: boolean; push: boolean };
}

export const users = pgTable('users', {
  id: serial().primaryKey(),
  preferences: jsonb().$type<UserPreferences>().default({
    theme: 'light',
    locale: 'en',
    notifications: { email: true, push: false },
  }),
});
```

### Querying JSONB

```typescript
import { sql } from 'drizzle-orm';

// Access nested fields
await db.select({
  id: users.id,
  theme: sql<string>`${users.preferences}->>'theme'`,
}).from(users);

// Filter by JSON field
await db.select().from(users).where(
  sql`${users.preferences}->>'theme' = 'dark'`
);

// JSONB containment
await db.select().from(users).where(
  sql`${users.preferences} @> '{"theme": "dark"}'::jsonb`
);
```

## Composite Primary Keys

```typescript
import { pgTable, integer, text, primaryKey, timestamp } from 'drizzle-orm/pg-core';

// Junction table
export const userRoles = pgTable('user_roles', {
  userId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: integer().notNull().references(() => roles.id, { onDelete: 'cascade' }),
  assignedAt: timestamp().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.roleId] }),
]);

// With custom name
export const bookAuthors = pgTable('book_authors', {
  bookId: integer().notNull(),
  authorId: integer().notNull(),
}, (table) => [
  primaryKey({ name: 'book_author_pk', columns: [table.bookId, table.authorId] }),
]);
```

## Foreign Key Actions

```typescript
export const posts = pgTable('posts', {
  id: serial().primaryKey(),
  authorId: integer().notNull()
    .references(() => users.id, {
      onDelete: 'cascade',     // Delete posts when user deleted
      onUpdate: 'cascade',     // Update FK when user ID changes
    }),
});

// Standalone foreign key declaration (multi-column)
export const orderItems = pgTable('order_items', {
  orderId: integer().notNull(),
  productId: integer().notNull(),
  warehouseId: integer().notNull(),
}, (table) => [
  foreignKey({
    name: 'inventory_fk',
    columns: [table.productId, table.warehouseId],
    foreignColumns: [inventory.productId, inventory.warehouseId],
  }).onDelete('restrict').onUpdate('cascade'),
]);
```

### Action Reference

| Action | Behavior |
|--------|----------|
| `cascade` | Delete/update child rows automatically |
| `restrict` | Prevent parent modification (checked immediately) |
| `no action` | Prevent parent modification (checked at end of transaction, default) |
| `set null` | Set FK column to NULL on parent deletion |
| `set default` | Set FK column to its default on parent deletion |

## Self-Referencing Tables

```typescript
import { AnyPgColumn } from 'drizzle-orm/pg-core';

export const categories = pgTable('categories', {
  id: serial().primaryKey(),
  name: text().notNull(),
  parentId: integer().references((): AnyPgColumn => categories.id),
});

// Query with self-join
import { alias } from 'drizzle-orm/pg-core';
const parent = alias(categories, 'parent');

await db.select({
  category: categories.name,
  parentName: parent.name,
}).from(categories)
  .leftJoin(parent, eq(categories.parentId, parent.id));
```

## Multi-Schema Architecture

### Defining Multiple Schemas

```typescript
import { pgSchema, pgTable, serial, text } from 'drizzle-orm/pg-core';

// Public schema (default)
export const publicUsers = pgTable('users', {
  id: serial().primaryKey(),
  name: text().notNull(),
});

// Tenant schema
export const tenantSchema = pgSchema('tenant');
export const tenantOrders = tenantSchema.table('orders', {
  id: serial().primaryKey(),
  userId: integer().notNull(),
});

// Auth schema
export const authSchema = pgSchema('auth');
export const sessions = authSchema.table('sessions', {
  id: uuid().defaultRandom().primaryKey(),
  userId: integer().notNull(),
  expiresAt: timestamp().notNull(),
});
```

### Cross-Schema References

```typescript
export const tenantOrders = tenantSchema.table('orders', {
  id: serial().primaryKey(),
  userId: integer().notNull().references(() => publicUsers.id),
});
```

### drizzle-kit Schema Filtering

```typescript
// drizzle.config.ts
export default defineConfig({
  schemaFilter: ['public', 'tenant'],  // manage these schemas
  // tablesFilter: ['!_prisma_*'],      // exclude Prisma tables
});
```

## Views and Materialized Views

### Regular Views

```typescript
import { pgView } from 'drizzle-orm/pg-core';

export const activeUsers = pgView('active_users').as((qb) =>
  qb.select({
    id: users.id,
    name: users.name,
    email: users.email,
  }).from(users).where(eq(users.isActive, true))
);

// Query like a table
await db.select().from(activeUsers);
```

### Materialized Views

```typescript
import { pgMaterializedView } from 'drizzle-orm/pg-core';

export const userStats = pgMaterializedView('user_stats').as((qb) =>
  qb.select({
    userId: users.id,
    postCount: count(posts.id),
    lastPostAt: max(posts.createdAt),
  }).from(users)
    .leftJoin(posts, eq(users.id, posts.authorId))
    .groupBy(users.id)
);

// With storage parameters
export const heavyStats = pgMaterializedView('heavy_stats')
  .with({ fillfactor: 90, autovacuum_enabled: true })
  .tablespace('fast_ssd')
  .as((qb) => { /* ... */ });

// Refresh
await db.refreshMaterializedView(userStats);
await db.refreshMaterializedView(userStats).concurrently();
await db.refreshMaterializedView(userStats).withNoData();
```

### Existing Views

For views managed outside Drizzle (prevents drizzle-kit from generating CREATE VIEW):

```typescript
export const legacyReport = pgView('legacy_report', {
  id: serial(),
  total: numeric(),
  period: text(),
}).existing();
```

## Default Value Patterns

```typescript
import { sql } from 'drizzle-orm';

export const records = pgTable('records', {
  // Static defaults
  status: text().default('pending'),
  count: integer().default(0),
  isActive: boolean().default(true),

  // SQL expression defaults
  id: uuid().default(sql`gen_random_uuid()`),
  createdAt: timestamp().default(sql`NOW()`),
  sortKey: integer().default(sql`nextval('sort_seq')`),

  // Runtime JS defaults (executed at insert time)
  slug: text().$defaultFn(() => generateSlug()),
  code: text().$defaultFn(() => nanoid(12)),

  // Auto-generated UUID
  publicId: uuid().defaultRandom(),
});
```

## Check Constraints

```typescript
import { check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const products = pgTable('products', {
  id: serial().primaryKey(),
  name: text().notNull(),
  price: numeric({ precision: 10, scale: 2 }).notNull(),
  discountPrice: numeric({ precision: 10, scale: 2 }),
  quantity: integer().default(0),
}, (table) => [
  check('price_positive', sql`${table.price} > 0`),
  check('quantity_non_negative', sql`${table.quantity} >= 0`),
  check('discount_less_than_price',
    sql`${table.discountPrice} IS NULL OR ${table.discountPrice} < ${table.price}`
  ),
]);
```

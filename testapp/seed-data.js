/**
 * testapp/seed-data.js
 *
 * Populates testapp.db with realistic test tables and data using the
 * admindb SqliteDatabase adapter directly (no HTTP layer needed).
 *
 * Run: node seed-data.js
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase, createLogger } from '../dist/index.js';

// ESM replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'testapp.db');
const logger  = createLogger({ level: 'warn', prefix: 'seed' });
const db      = new SqliteDatabase(DB_FILE, logger);

async function run() {
  console.log('🌱 Seeding testapp.db …\n');

  // ── Schema ────────────────────────────────────────────────────────────────
  const schema = `
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL UNIQUE,
      email      TEXT    NOT NULL UNIQUE,
      role       TEXT    NOT NULL DEFAULT 'user'  CHECK(role IN ('admin','user','guest')),
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      is_active  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS categories (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT    NOT NULL UNIQUE,
      slug TEXT    NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      body        TEXT,
      author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      status      TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
      views       INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS post_tags (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
      PRIMARY KEY (post_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      sku         TEXT    NOT NULL UNIQUE,
      price       REAL    NOT NULL,
      stock       INTEGER NOT NULL DEFAULT 0,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      total       REAL    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','shipped','cancelled')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL REFERENCES orders(id)   ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      quantity   INTEGER NOT NULL,
      unit_price REAL    NOT NULL
    );
  `;

  for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean)) {
    const r = await db.run(stmt);
    if (!r.success) {
      console.warn('  ⚠ Schema warning:', r.error);
    }
  }
  console.log('  ✅ Schema created (8 tables)\n');

  // ── Data ──────────────────────────────────────────────────────────────────

  // Users
  const users = [
    ['admin',   'admin@example.com',   'admin'],
    ['alice',   'alice@example.com',   'user'],
    ['bob',     'bob@example.com',     'user'],
    ['charlie', 'charlie@example.com', 'user'],
    ['diana',   'diana@example.com',   'guest'],
  ];
  for (const [username, email, role] of users) {
    await db.run(
      `INSERT OR IGNORE INTO users (username, email, role) VALUES (?, ?, ?)`,
      [username, email, role]
    );
  }
  console.log(`  ✅ ${users.length} users`);

  // Categories
  const categories = [
    ['Technology', 'technology'],
    ['Science',    'science'],
    ['Business',   'business'],
    ['Lifestyle',  'lifestyle'],
  ];
  for (const [name, slug] of categories) {
    await db.run(
      `INSERT OR IGNORE INTO categories (name, slug) VALUES (?, ?)`,
      [name, slug]
    );
  }
  console.log(`  ✅ ${categories.length} categories`);

  // Tags
  const tags = ['nodejs', 'python', 'sql', 'devops', 'ai', 'ux', 'security', 'cloud'];
  for (const tag of tags) {
    await db.run(`INSERT OR IGNORE INTO tags (name) VALUES (?)`, [tag]);
  }
  console.log(`  ✅ ${tags.length} tags`);

  // Posts (10 posts, authored by users 1-4, category 1-4)
  const postTitles = [
    ['Getting Started with SQLite',           1, 1, 'published', 1240],
    ['Understanding Foreign Keys',            2, 1, 'published', 880],
    ['Building REST APIs with Express',       3, 1, 'published', 2100],
    ['AI in Modern Database Management',      1, 2, 'published', 560],
    ['Business Intelligence with SQL',        4, 3, 'published', 330],
    ['Draft: Upcoming PostgreSQL Features',   2, 1, 'draft',     0],
    ['Cloud Databases: Pros and Cons',        3, 3, 'published', 760],
    ['UI/UX for Data-Heavy Interfaces',       4, 4, 'published', 1540],
    ['Security Best Practices for DBs',       1, 1, 'published', 920],
    ['Archived: Old Migration Patterns',      2, 2, 'archived',  120],
  ];
  for (const [title, authorId, categoryId, status, views] of postTitles) {
    await db.run(
      `INSERT OR IGNORE INTO posts (title, author_id, category_id, status, views)
       VALUES (?, ?, ?, ?, ?)`,
      [title, authorId, categoryId, status, views]
    );
  }
  console.log(`  ✅ ${postTitles.length} posts`);

  // Comments (20 comments spread across posts/users)
  const comments = [
    [1, 2, 'Great intro, really helped me!'],
    [1, 3, 'I had the same issue, this fixed it.'],
    [2, 1, 'FK enforcement is so important.'],
    [2, 4, 'Good explanation of CASCADE.'],
    [3, 2, 'Express v5 changes some of this though.'],
    [3, 5, 'Very clear tutorial.'],
    [4, 3, 'AI is everywhere now, even in DBs!'],
    [4, 1, 'Interesting perspective.'],
    [5, 2, 'Could use more charts.'],
    [7, 3, 'Cloud is definitely the future.'],
    [7, 4, 'Price can be a concern though.'],
    [8, 1, 'UI matters a lot for dashboards.'],
    [8, 2, 'Agreed, clean tables make a difference.'],
    [9, 3, 'Row-level security is underrated.'],
    [9, 4, 'Parameterized queries save lives.'],
    [9, 5, 'Thanks for this!'],
    [1, 4, 'Bookmarked.'],
    [3, 1, 'Solid architecture advice.'],
    [8, 5, 'Great read.'],
    [7, 2, 'Would love a follow-up post.'],
  ];
  for (const [postId, authorId, body] of comments) {
    await db.run(
      `INSERT OR IGNORE INTO comments (post_id, author_id, body) VALUES (?, ?, ?)`,
      [postId, authorId, body]
    );
  }
  console.log(`  ✅ ${comments.length} comments`);

  // Post-tag links
  const postTags = [[1,3],[1,4],[2,3],[3,1],[3,4],[4,5],[5,3],[7,7],[7,8],[8,6],[9,7],[9,3]];
  for (const [postId, tagId] of postTags) {
    await db.run(
      `INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)`,
      [postId, tagId]
    );
  }
  console.log(`  ✅ ${postTags.length} post-tag links`);

  // Products
  const products = [
    ['SSD 1TB',          'SSD-1TB',   89.99,  50, 1, 'Fast NVMe SSD'],
    ['USB-C Hub 7-in-1', 'HUB-7C1',   39.99, 120, 1, 'Multi-port hub'],
    ['Mechanical Keyboard','KB-MEC',  109.99,  35, 1, 'Tactile switches'],
    ['Wireless Mouse',   'MS-WRL',    29.99, 200, 1, 'Ergonomic design'],
    ['4K Monitor 27"',   'MON-27K',  349.99,  15, 1, 'IPS panel'],
    ['Laptop Stand',     'STD-LAP',   24.99,  80, 4, 'Aluminium build'],
    ['Webcam 1080p',     'CAM-1080',  49.99,  60, 1, 'Built-in mic'],
    ['Notebook A5',      'NTB-A5',     5.99, 500, 4, 'Lined pages'],
  ];
  for (const [name, sku, price, stock, categoryId, description] of products) {
    await db.run(
      `INSERT OR IGNORE INTO products (name, sku, price, stock, category_id, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, sku, price, stock, categoryId, description]
    );
  }
  console.log(`  ✅ ${products.length} products`);

  // Orders + order items
  const orders = [
    [2, 'paid'],
    [3, 'shipped'],
    [4, 'pending'],
    [2, 'paid'],
    [5, 'cancelled'],
  ];
  const orderItems = [
    [[1, 2, 89.99],  [2, 1, 39.99]],
    [[3, 1, 109.99], [4, 2, 29.99]],
    [[5, 1, 349.99]],
    [[7, 1, 49.99],  [8, 3, 5.99]],
    [[6, 2, 24.99]],
  ];
  for (let i = 0; i < orders.length; i++) {
    const [userId, status] = orders[i];
    const items = orderItems[i];
    const total = items.reduce((s, [, qty, price]) => s + qty * price, 0);
    const orRes = await db.run(
      `INSERT OR IGNORE INTO orders (user_id, total, status) VALUES (?, ?, ?)`,
      [userId, Math.round(total * 100) / 100, status]
    );
    if (orRes.success && orRes.data?.lastInsertRowid) {
      const oid = orRes.data.lastInsertRowid;
      for (const [productId, qty, unitPrice] of items) {
        await db.run(
          `INSERT OR IGNORE INTO order_items (order_id, product_id, quantity, unit_price)
           VALUES (?, ?, ?, ?)`,
          [oid, productId, qty, unitPrice]
        );
      }
    }
  }
  console.log(`  ✅ ${orders.length} orders with line items`);

  console.log('\n  🎉 Done! Start the server with: npm start\n');
  process.exit(0);
}

run().catch(err => {
  console.error('\n  ❌ Seed failed:', err.message);
  process.exit(1);
});

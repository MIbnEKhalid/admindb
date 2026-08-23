# AdminDB — Test App (`testapp/`)

A fully standalone Express application that imports **AdminDB from the built `../dist/`** — exactly as a real downstream user would consume it.

## Quick Start

```bash
# 1. Build admindb first (from the project root)
cd ..
npm run build

# 2. Install the testapp's own dependencies
cd testapp
npm install

# 3. (Optional) seed the database with realistic test data
node seed-data.js

# 4. Start the server
npm start
# or with auto-restart on file changes:
npm run dev
```

Then open **http://localhost:4000** for the host app, or jump straight to **http://localhost:4000/admin** for AdminDB.

---

## What's Included

| File | Purpose |
|---|---|
| `server.js` | Host Express app — mounts AdminDB via `createRouter()` at `/admin` |
| `seed-data.js` | Creates 8 relational tables and populates them with realistic rows |
| `testapp.db` | SQLite file (auto-created on first run) |

## Test Tables Created by `seed-data.js`

```
users         5 rows   (id, username, email, role, created_at, is_active)
categories    4 rows   (id, name, slug)
posts        10 rows   (FK → users, categories)
comments     20 rows   (FK → posts, users)
tags          8 rows   (id, name)
post_tags    12 rows   (junction: FK → posts, tags)
products      8 rows   (FK → categories)
orders        5 rows   (FK → users)
order_items  ~9 rows   (FK → orders, products)
```

Great for testing:
- **FK constraint enforcement** (delete a user → cascades to posts & comments)
- **Bulk drop / truncate** with and without force mode
- **ER Diagram** — should show a nicely connected graph
- **Seed generator** — chain mode across the FK graph
- **Query editor** — JOINs across multiple tables

## Scenarios

### 1. Normal FK-blocked delete
1. Go to **Home** → select `users` → *Clear Rows* (normal)
2. Should fail with FK error (posts/comments reference users)

### 2. Force clear
1. Same, but use **Force Clear (ignore FK)**
2. Should succeed regardless

### 3. Seed Generator — Single Table
1. Open `products` table → click **Seed**
2. Choose **Single Table**, set rows to 20, click Preview & Execute

### 4. Seed Generator — ER Chain
1. Open `orders` table → click **Seed**
2. Choose **ER Relational Chain**
3. Should auto-discover `users` as a dependency

### 5. ER Diagram
- Navigate to **ER Diagram** — all 9 tables should appear with FK arrows

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port for the test server |

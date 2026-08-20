# AdminDB

[![Version](https://img.shields.io/npm/v/admindb.svg)](https://www.npmjs.com/package/admindb)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Downloads](https://img.shields.io/npm/dm/admindb.svg)](https://www.npmjs.com/package/admindb)
[![Publish](https://github.com/MIbnEKhalid/admindb/actions/workflows/publish.yml/badge.svg?branch=main)](https://github.com/MIbnEKhalid/admindb/actions/workflows/publish.yml)

**A browser-based SQLite administration tool.** Manage a SQLite database
entirely from the browser — browse and edit rows, run SQL, design schemas,
import/export and seed data — with no separate frontend app to build or deploy.

- **No frontend build step.** Handlebars server-rendered UI + vanilla JS +
  Tailwind/DaisyUI; one Express process serves pages, static assets, and the
  JSON API.
- **Standalone or embeddable.** Run it from the CLI against a file or a folder
  of databases, or mount it inside an existing Express app under any path on
  the same port.
- **Safe SQL by construction.** Every identifier is quoted and every literal is
  escaped when SQL is generated, and the "Get query / preview" modes only
  produce SQL strings — they never execute.

![Home dashboard](docs/screenshots/home.png)

> More screenshots in [`docs/screenshots/`](docs/screenshots/): table browser,
> query editor, table designer, insert/edit form, schema editor, and the
> databases landing page.

## 30-Second Start

No install needed:

```bash
npx admindb
# → AdminDB is listening on http://localhost:3000
```

With no arguments the server starts in **manager mode**: a **Databases** landing
page where you can browse the filesystem and open any SQLite database file
(`.db` / `.sqlite` / `.sqlite3`), or create new ones. Or point it straight at a
file:

```bash
npx admindb ./data/app.db          # open one database
npx admindb -d ./dbs               # manage a folder of databases
```

From a clone:

```bash
git clone https://github.com/MIbnEKhalid/admindb.git
cd admindb
npm install
npm run build
npm start                          # serves http://localhost:3000
```

> Requires **Node.js ≥ 20**. Runtime dependencies are `express`,
> `express-handlebars`, and `better-sqlite3`; the rest is the application.

## Why This Exists

AdminDB exists because SQLite deserves a proper web admin UI, and desktop tools
(DBeaver, DB Browser for SQLite) live outside both your browser and your stack.
Web admin tools like phpMyAdmin target MySQL/Postgres, not SQLite. This one is
server-rendered, so there is no frontend build step and nothing extra to deploy
— the same Express process serves pages, assets, and the JSON API. Run it
standalone from the CLI, or mount it under any path of an existing Express app
on the same port.

## Install

### Try it (no install)

```bash
npx admindb -p 8080        # run on port 8080 without installing
npx admindb ./app.db       # open a database file directly
```

### Install as a standalone CLI tool

Requires **Node.js ≥ 20**:

```bash
npm install -g admindb
admindb                    # starts the server → open http://localhost:3000
```

The `admindb` command starts the built-in server and prints the URL to open in
your browser. See the [CLI reference](#cli-reference) for `--port`,
`--open <file>`, `--dir <folder>`, `--readonly`, and more.

### Embed AdminDB in your own app

AdminDB is an Express app you can mount inside your own application, under your
own path, on the same port as the rest of your server.

#### Minimal example

```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

app.get('/', (_req, res) => res.send('My main app'));

// All AdminDB routes live under /admin on the same port.
app.use('/admin', createRouter({ dbPath: '/data/my.db', basePath: '/admin' }));

app.listen(3000);
```

`createRouter(options)` returns a fully wired Express app (pages + JSON API +
static assets + view engine). Mounting it is just `app.use('/path', router)`.

#### Options

| Option     | Type                 | Description                                                    |
| ---------- | -------------------- | -------------------------------------------------------------- |
| `dbPath`   | `string`             | Path to a single SQLite file (single-db mode). Default: `admindb.db` |
| `db`       | `SqliteDatabase`     | An already-open database instance (advanced embedding)         |
| `manager`  | `DbManager`          | Enables multi-database mode (see below)                        |
| `basePath` | `string`             | URL prefix used by templates/assets (e.g. `/admin`). Pass the same prefix you mount at |
| `logger`   | `Logger`             | Custom logger (see `createLogger`)                             |
| `logLevel` | `'debug'\|'info'\|'warn'\|'error'` | Log verbosity (used when no logger is passed)     |
| `allowBrowse` | `boolean`         | Manager mode: show the filesystem file-browser on the databases page. Set `false` to disable it (e.g. when the server was started with specific database files). Default: `true` |
| `browseRoot` | `string`          | Manager mode: restrict the file-browser to this folder (absolute path) — it cannot navigate above it and only databases inside it can be opened |
| `readonly` | `boolean`            | Open the database(s) **read-only**: every write is rejected (403), write controls are disabled in the UI, and a banner is shown. The DB file is opened with `SQLITE_OPEN_READONLY` + `PRAGMA query_only` as a belt-and-suspenders guard. Default: `false` |

Example with a custom logger and prefix:

```ts
import express from 'express';
import { createRouter, createLogger } from 'admindb';

const app = express();
app.use('/tools/db', createRouter({
  dbPath: './data/app.db',
  basePath: '/tools/db',
  logLevel: 'info',
}));
app.listen(3000);
```

#### Multiple databases

Pass a `DbManager` to manage several database files — either from a directory,
from an explicit list of file paths, or both:

```ts
import express from 'express';
import { createRouter, DbManager, createLogger } from 'admindb';

const app = express();
app.use('/admin', createRouter({
  manager: new DbManager(
    {
      dir: './data',                                   // scan a directory
      files: ['/srv/legacy/app.db', './shared.sqlite'], // and/or explicit paths
      readonly: true,                                  // open all databases read-only
    },
    createLogger('info'),
  ),
  basePath: '/admin',
}));
```

In multi-db mode:

- a **"Databases" landing page** lets you open, create, and delete database files,
- every database is scoped under its file name, e.g.
  `/admin/app.db/tables/users` and `/admin/app.db/api/tables`,
- file names that collide across sources are deduped (`name__2.db`).

### CLI reference

The standalone server is a full web app. With no arguments it runs in
**manager mode**: a **Databases** landing page where you can browse the
filesystem and open any SQLite database file (`.db` / `.sqlite` / `.sqlite3`),
or create new ones.

| Flag                 | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `-p, --port <port>`  | Port to listen on (default `3000`)                       |
| `-H, --host <host>`  | Host / interface to bind (default `0.0.0.0`)             |
| `-o, --open <file>`  | Open a single database file directly                     |
| `-d, --dir <dir>`    | Manage a folder of database files                        |
| `--files <list>`     | Comma-separated database file paths to manage            |
| `-b, --base-path <p>`| URL prefix to serve under (default `/`)                  |
| `-r, --readonly`     | Open databases read-only (all writes disabled)           |
| `-l, --log-level <l>`| `debug` \| `info` \| `warn` \| `error` (default `info`)  |
| `-h, --help`         | Show help                                                |
| `-v, --version`      | Show the version                                         |

A positional `path` argument opens a database file directly, or manages a
folder when it is a directory.

Every flag has a matching environment variable; **flags override the
environment**:

| Variable    | Default | Description                          |
| ----------- | ------- | ------------------------------------ |
| `PORT`      | `3000`  | Port to listen on                    |
| `HOST`      | `0.0.0.0` | Host / interface to bind           |
| `DB_PATH`   | —       | Single SQLite database file          |
| `DB_DIR`    | —       | Folder of `.db`/`.sqlite` files      |
| `DB_FILES`  | —       | Comma-separated explicit database file paths |
| `READONLY`  | —       | `1` / `true` / `yes` / `on` opens the database(s) read-only |
| `BASE_PATH` | `''`    | URL prefix (e.g. `/admin`)           |
| `LOG_LEVEL` | `info`  | `debug` \| `info` \| `warn` \| `error` |

Examples:

```bash
admindb                        # manager UI on http://localhost:3000
admindb -p 8080                # same, on port 8080
admindb ./data/app.db          # open a single database file
admindb --open ~/notes.sqlite  # open a file directly
admindb -d ./dbs               # manage a folder of databases
admindb --files a.db,b.db -r   # open two files read-only
```

```powershell
$env:DB_DIR='./db'; npm start   # PowerShell
# bash/zsh:  DB_DIR=./db npm start
```

When the server runs without an explicit single file, the **Databases** landing
page lists the managed databases and includes an **"Open an existing
database"** file browser: navigate folders, pick a database file, and open it.
Opened files are added to the list so you can switch between databases freely.

**File-browser policy:**

- When a **folder** is given (`--dir`, a directory path, or `DB_DIR`), browsing
  is limited to that folder — it cannot navigate above it and only databases
  inside it can be opened.
- When specific **files** are given (`--files`, or `DB_FILES`) without a folder,
  file browsing is **disabled** entirely; only the configured databases are
  listed.
- With no folder or files, browsing is unrestricted.

## Features

### 🔍 Browse & edit rows

- **Table browser** — every table with pagination, sorting (click a column
  header), a sticky header, and per-row actions; composite primary keys are
  supported (values are URL-encoded and comma-joined in the row endpoints).
- **Type-aware filters** — per-column filter controls: foreign-key dropdowns,
  boolean toggles, date and numeric range inputs, plus the exact (`=value`),
  comparison (`>5`, `<=10`), prefix (`pre*`) and substring (plain text)
  operators on text columns. Filters survive sorting and pagination.
- **Inline (spreadsheet-style) editing** — double-click any cell to edit it in
  place with a type-aware control (FK dropdown, boolean toggle, date picker,
  number/text input). Changes are staged and highlighted in the grid, then
  applied all at once in a single transaction, or discarded.
- **Insert and delete rows** (full CRUD). FK columns become dropdowns; insert
  forms pre-fill column defaults from the schema.
- **Bulk row operations** — select rows with checkboxes (or "select all"), then
  **delete** them in one transaction (with a warning listing how many rows in
  other tables reference them) or **export** only the selected rows as CSV/JSON.
- **Related rows** — every table that has a foreign key pointing at a table gets
  its own column at the end of that table's grid; each cell shows how many of its
  rows reference that record. Click it to open a nested table with all of the
  referencing table's columns and data for that specific record.

### ⚡ Query & run SQL

- **Arbitrary SQL runner** — SELECTs render as a table, `COUNT` queries show a
  readable summary, and write statements execute and report affected rows.
- **Saved named queries** — save a query and reload it from a dropdown.
- **"Get query" / preview mode** — generate `CREATE` / `INSERT` / `UPDATE` SQL
  from the UI without executing it. The preview modes only return the SQL
  string; they never touch the database.
- **SQL dump** — export the whole database as a downloadable `CREATE` + `INSERT`
  SQL file.

### 🗂️ Design & manage schema

- **Visual table designer** — create a table with name, type, primary key,
  not-null / unique, default value, and foreign-key references, with a live
  `CREATE TABLE` SQL preview.
- **Schema editor** — rename the table, add / rename / drop columns, and drop
  tables, with relationship-safety checks: drops are refused when the column is
  a primary key, has a UNIQUE constraint, is used by an index, is part of a
  foreign key, or is referenced by another table's foreign key. Tables
  referenced by other tables cannot be dropped. Internal (`_`-prefixed) tables
  cannot be renamed or dropped.
- **Indexes** — create indexes (plain or unique, on one or many columns — pick
  columns in order, with a live `CREATE INDEX` SQL preview) and drop them from
  the schema editor; automatic SQLite (primary-key/unique) indexes are
  protected.

### 🔄 Import, export & seed data

- **Export** — table rows or query results as **CSV or JSON** (a whole table or
  only selected rows).
- **CSV import** — paste or upload CSV into a table; the header must match
  existing columns, and the import runs in a single transaction (a failed row
  rolls everything back).
- **Seed data generator** — fill a table with realistic rows in one go. Each
  column gets an auto-detected strategy (first/last/full name, email, phone,
  city, country, UUID, random integer/decimal/date/datetime/boolean/bytes, a few
  words, a sentence, a fixed value, a random value from a list, or "skip — let
  the DB default apply"); foreign-key columns can sample real values from the
  referenced table. Insert up to 5,000 rows transactionally, or preview the
  generated `INSERT` SQL without executing it.

### 🚀 Deploy

- **Read-only mode** — open the database(s) without write access: the file is
  opened `SQLITE_OPEN_READONLY` + `query_only`, every write route returns `403`,
  and the UI hides/disables all write controls and shows a banner.
- **Standalone CLI / file browser** — `admindb` runs as a full web app; with no
  arguments it opens a **Databases** landing page where you can browse the
  filesystem and open any SQLite database file, or create new ones. Flags set
  the port, open a file, manage a folder, and more (`admindb --help`).
- **Multiple databases** — directory scanning and/or explicit file lists, each
  with its own workspace under `/{db}/…`.

## Authentication & Security

AdminDB includes a built-in native authentication system that is **enabled by default**, while giving developers complete freedom to customize credentials with salted password hashes, disable it, or supply their own authentication layer.

> ⚠️ **Production Security Notice:**
> The built-in native authentication is intended for **basic/lightweight protection** (e.g. local networks, staging environments, internal developer tools). For production deployments with sensitive or public data, **always use your own robust authentication system** (such as OAuth2 / OIDC, enterprise SSO, mTLS, or custom Express middleware) or place AdminDB behind an authenticated reverse proxy or API gateway.

### Default Credentials
- **Default Username:** `admin`
- **Default Password:** `admin` *(stored via a hardcoded salted `scrypt` cryptographic hash)*

> 💡 *When running with the default password, a warning badge is displayed in the navigation bar to remind you to set custom credentials.*

---

### Generating a Secure Password Hash (`npm run generatehash`)

To secure your installation with a custom password, generate a salted cryptographic `scrypt` hash using the built-in generator script:

```bash
npm run generatehash
```

The script will prompt you:
```text
Enter password to hash: [your-strong-password]
```

And outputs a secure hash format:
```text
scrypt:3f8e02d9a1c4b7e8...:cb3032b16f29c8d44f75...
```

You can then **paste this hash in place of your password** across any configuration method:

#### 1. Via Environment Variables (`.env`)
```bash
# Set your custom username and generated password hash
export ADMINDB_USERNAME="ops"
export ADMINDB_PASSWORD="scrypt:3f8e02d9a1c4b7e8...:cb3032b16f29c8d44f75..."

# Run AdminDB
npx admindb
```

#### 2. Via Standalone CLI Options
```bash
# Pass the username and generated password hash directly
admindb -u ops -P "scrypt:3f8e02d9a1c4b7e8...:cb3032b16f29c8d44f75..."
```

#### 3. When Embedding in Express (`createRouter`)
```ts
import { createRouter } from 'admindb';

app.use('/admin', createRouter({
  dbPath: './data/app.db',
  auth: {
    enabled: true,
    username: 'ops',
    password: 'scrypt:3f8e02d9a1c4b7e8...:cb3032b16f29c8d44f75...',
    secret: process.env.SESSION_SECRET,
  },
}));
```

---

### Disabling Native Authentication

If you want no protection (e.g. for local scratchpads) or want to handle authentication entirely with your own custom Express middleware / gateway:

#### 1. Via CLI Flag
```bash
admindb --no-auth
```

#### 2. Via Environment Variables
```bash
ADMINDB_AUTH=false admindb
# or
ADMINDB_NO_AUTH=1 admindb
```

#### 3. Via Express Options
```ts
// Attach your own authentication middleware before AdminDB
app.use('/admin', myCustomAuthMiddleware, createRouter({
  dbPath: './data/app.db',
  auth: false, // Disables built-in auth completely
}));
```

---

### Supported Authentication Methods
1. **Web Browser UI:** Form login at `/login` with constant-time verification, salted scrypt key derivation, and `HMAC-SHA256` signed HTTP-only session cookies.
2. **HTTP Basic Auth:** Send `Authorization: Basic <base64(username:password)>` with API requests.
3. **Bearer Token:** Send `Authorization: Bearer <sessionToken>` in REST API headers.

## Security Warning & Best Practices

> ⚠️ **AdminDB provides full administrative access to your database and filesystem.**
> - Always set a strong, custom `ADMINDB_PASSWORD` or pass custom credentials before deploying to a shared network.
> - If exposing over the internet, place the application behind HTTPS / SSL termination.
> - When authentication is disabled (`--no-auth` / `auth: false`), ensure the port is bound to `127.0.0.1` or protected by your own gateway.

## API

All routes live under `basePath` and return the consistent shape
`{ success, data?, error? }`. In multi-db mode, every route is scoped under the
database, e.g. `/api/app.db/tables`.

```text
GET    /api/tables                          List tables
GET    /api/tables/:table/rows              Paginated rows (filters, sorting)
POST   /api/tables/:table/rows              Insert row
PUT    /api/tables/:table/row/:id           Update row
DELETE /api/tables/:table/row/:id           Delete row
POST   /api/query                           Run arbitrary SQL
POST   /api/tables                          Create table
GET    /api/tables/:table/export            Download all rows as csv|json
POST   /api/tables/:table/seed              Generate and insert seed rows
```

Plus bulk row operations, CSV import, schema and index management, saved
queries, a data generator — and, in manager mode, database-file management and
the filesystem browser.

> **Full reference:** every endpoint (including seed config/generate, bulk
> update/delete/export, and the multi-db manager endpoints) is documented in
> **[`docs/API.md`](docs/API.md)**.

**Behaviour notes:**

- **Empty input = "not set".** Empty form fields are omitted so DB defaults
  apply; `0` is a valid value and is never treated as empty. Insert forms
  pre-fill column defaults from the schema (string/number/boolean literals and
  `CURRENT_TIMESTAMP`-style defaults).
- **Inline editing is staged, not instant.** Double-click a cell to edit it in
  place; edits are buffered locally and highlighted in the grid rather than
  written immediately. Press **Apply** to write every pending change in a single
  transaction (the page then reloads so related-row counts stay accurate), or
  **Discard** to revert. Clearing a text/date/number field stages a `NULL`.
- **Bulk operations** run per page with "select all"; delete first shows an
  FK-impact warning (rows may be cascaded away or orphaned depending on the
  foreign-key action, and the delete can fail if a constraint blocks it). Both
  delete and export are capped at 1000 rows per batch.
- **CSV import** runs in a single transaction — a failed row rolls everything
  back.
- **Identifiers are quoted and string values escaped** everywhere SQL is built,
  so generated SQL is correct and safe; **"Get query" never executes** — it only
  returns the generated SQL string.
- **`COUNT` queries** return a readable summary message instead of a table.
- **Internal table** `_saved_queries` stores saved queries and is kept out of
  user-facing FK pickers. Schema initialization is idempotent and safe to run
  repeatedly.

## Contributing

PRs are welcome. Development workflow (`npm run dev` for live reload, `npm test`
to build and run the unit suite), project layout, and contribution guidelines
live in **[`CONTRIBUTING.md`](CONTRIBUTING.md)**.

## License

[MIT](./LICENSE) — see the [LICENSE](LICENSE) file.

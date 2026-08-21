# AdminDB

[![Version](https://img.shields.io/npm/v/admindb.svg)](https://www.npmjs.com/package/admindb)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Downloads](https://img.shields.io/npm/dm/admindb.svg)](https://www.npmjs.com/package/admindb)
[![Publish](https://github.com/MIbnEKhalid/admindb/actions/workflows/publish.yml/badge.svg?branch=main)](https://github.com/MIbnEKhalid/admindb/actions/workflows/publish.yml)

**A modern, browser-based SQLite and PostgreSQL database administration tool.** Manage SQLite and PostgreSQL databases entirely from your browser — browse and edit rows, run arbitrary SQL queries, design schemas visually, seed realistic test data, inspect complex data types, and import/export CSV/JSON — with zero frontend build step.

- **SQLite & PostgreSQL Multi-Engine:** Seamlessly manage local SQLite files, remote PostgreSQL connections, or multi-database environments with distinct engine badges and credentials protection.
- **Secure JSON Config Files:** Pass database credentials securely in `.json` files (`name.postgres.json`) without exposing secrets on the CLI.
- **Zero frontend build step:** Server-rendered Handlebars UI + vanilla JS + Tailwind/DaisyUI; a single lightweight Express process serves pages, static assets, and the REST API.
- **Standalone CLI or embeddable library:** Run instantly via `npx admindb` or mount it directly into your existing Express application under any subpath.
- **Modern terminal experience:** Clean, colorized startup banner with auto-detected local/network URLs and streamlined runtime logs.
- **Rich Data Types & Calendar Controls:** In-place calendar pickers with presets (`Now`, `Yesterday`, `Tomorrow`, `+7 Days`, `+30 Days`), PostgreSQL Array chip managers, JSON modal inspector, UUID generators, and byte dump inspector.
- **Safe SQL by construction:** Quoted identifiers, escaped literals, parameterized queries, and non-executing SQL preview modes.

---

![Home dashboard](docs/screenshots/home.png)

> 📸 **Visual Tour:** See [`docs/screenshots/`](docs/screenshots/) for screenshots of the Table Browser, Query Editor, Visual Schema Designer, Inline Grid Editor, and Multi-Database Manager.

---

## ⚡ 30-Second Quickstart

No installation required:

```bash
npx admindb
```

By default, AdminDB opens in **Manager Mode** on `http://localhost:45531`, allowing you to browse the filesystem, create new SQLite databases, or open existing `.db` / `.sqlite` / `.sqlite3` files.

### 1. Load database connections securely from a JSON file:

Create `name.postgres.json`:
```json
{
  "prod": "postgresql://postgres:secret@localhost:5432/prod_db",
  "staging": "postgresql://postgres:secret@localhost:5432/staging_db",
  "local": "./data/local.db"
}
```

Run:
```bash
npx admindb name.postgres.json
```

### 2. Point directly to a database file or PostgreSQL URI:

```bash
npx admindb ./data/app.db                                     # Open a single SQLite database directly
npx admindb postgresql://postgres:secret@localhost:5432/mydb  # Open a PostgreSQL database directly
npx admindb -d ./databases                                    # Manage a folder of SQLite databases
npx admindb -p 8080 -r                                        # Run on port 8080 in read-only mode
```

### Install globally:

```bash
npm install -g admindb
admindb
```

---

## 🖥️ Modern Terminal Experience

AdminDB features a clean, colorized CLI startup banner and streamlined, low-noise runtime logging:

```text
  ⚡ AdminDB v2.0.0

  ➜  Local:    http://localhost:45531/
  ➜  Network:  http://192.168.1.15:45531/
  ➜  Mode:     Manager
  ➜  Config:   name.postgres.json (2 connection(s))
     • prod: PostgreSQL postgresql://postgres:****@localhost:5432/prod_db
     • staging: PostgreSQL postgresql://postgres:****@localhost:5432/staging_db
  ➜  Auth:     User: admin (default password)

  ⚠  Default password in use (admin). Generate a secure hash with:
     npm run generatehash and set ADMINDB_PASSWORD or -P <hash>
```

Runtime operations produce crisp, color-coded status logs:

```text
16:38:13 [info] Initialized PostgreSQL pool for postgresql://postgres:****@localhost:5432/prod_db
16:38:15 [info] Executed query in 2.4ms (42 rows returned)
16:38:18 [warn] Failed login attempt for user "unknown"
```

---

## 🌟 Core Features

### 🔍 Browse & Edit Rows
* **Table Browser:** High-density compact grid by default, column-header sorting, sticky headers, and pinned right-aligned action columns. Composite primary keys are fully supported.
* **Spreadsheet-Style Inline Editing & Keyboard Navigation:**
  * **Full Grid Navigation:** Navigate cells with <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> or <kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>.
  * **In-Place Type-Aware Controls:** Double-click or press <kbd>Enter</kbd> to edit in place (FK dropdowns, boolean toggles, date/time pickers with instant calendar triggers, array tags, numeric inputs). Pressing <kbd>Enter</kbd> commits and shifts focus to the cell below. Pressing <kbd>Space</kbd> on boolean cells toggles immediately.
  * **Interactive Date & Time Presets:** Calendar widget with quick shortcuts (`Now / Today`, `Yesterday`, `Tomorrow`, `+7 Days`, `+30 Days`, `Start of Day`, `End of Day`, `Clear`).
  * **PostgreSQL Array Tag Manager:** Interactive chip manager with Enter key chip addition, removal, and `{item1,item2}` array serialization.
  * **Quick Copy Shortcut:** Press <kbd>Ctrl+C</kbd> / <kbd>Cmd+C</kbd> on any focused cell to copy its raw value to the clipboard.
  * **Granular Staging & Single-Cell Revert:** Staged edits are marked with amber indicators (`.cell-dirty`). Hovering reveals an individual undo button (`↺`) to revert a single field without losing the rest of your pending batch.
  * **Staged Changes Diff & Review Drawer:** Floating dock displays pending edit count; click **Review Diff** to inspect a side-by-side comparison of original vs staged values across all modified rows before applying atomically in a single transaction.
* **Universal Data Inspector:** Rich interactive modal for deep data inspection:
  * **JSON / JSONB Viewer & Editor:** Interactive syntax-highlighted tree viewer, expandable nodes, real-time JSON editor, and format **Beautify** & **Minify** tools.
  * **BLOB / BYTEA & Media Previews:** Automatic MIME sniffing (PNG, JPEG, WebP, GIF, SVG, PDF, audio/video), inline image thumbnails, direct binary download, and drag-and-drop file upload. Supports PostgreSQL `\x...` and `0x...` hex strings.
  * **3-Column Hex Dump:** Professional byte offset, hexadecimal, and printable ASCII viewer for raw binary blobs.
  * **Text & Code Inspector:** Full-height editor for lengthy text fields, SQL strings, markdown, UUIDs, and config blobs with copy shortcuts.
* **Row Quick Actions:** 3-dots dropdown menu on each row for *Edit*, *Duplicate Row*, *Copy as JSON*, *Copy SQL INSERT*, and *Delete Row*.
* **Type-Aware Filters:** Filter by exact match, comparison (`>5`, `<=10`), prefix (`pre*`), substring, boolean state, or date/numeric ranges.
* **Bulk Operations:** Select rows to delete in one transaction (with foreign-key impact previews) or export selected rows as CSV/JSON.
* **Related Rows:** Cross-table foreign key indicators show how many child records reference each row, with one-click nested table exploration.

### ⚡ Query Runner & SQL Tools
* **Arbitrary SQL Runner:** Execute queries with results formatted as clean tables; `COUNT` queries display a concise summary, and mutations report affected row counts. Double-click or click inspect on any cell in query results to open the universal inspector.
* **Saved Named Queries:** Save frequently used queries in the database and reload them from a dropdown menu.
* **Safe SQL Preview:** Generate `CREATE`, `INSERT`, or `UPDATE` SQL without executing it.
* **Full Database Dump:** Download the entire database as a standard SQL file (`CREATE TABLE` + `INSERT` statements).

### 🗂️ Visual Schema Designer & Indexes
* **Visual Table Designer:** Create tables interactively with column types (including `UUID`, `JSONB`, `TIMESTAMP`, `TIMESTAMPTZ`, `INTERVAL`, `BYTEA`, `INET`, `SERIAL`, `BIGINT`), primary keys, autoincrement, nullable/unique constraints, default values, and foreign keys.
* **Relationship-Safe Schema Editor:** Rename tables, add columns, modify column types, rename columns, and drop columns/tables with safety checks to protect active foreign keys and unique constraints.
* **Index Manager:** Create single or multi-column indexes (plain or unique) with live SQL previews, and drop existing indexes safely.

### 🔄 Import, Export & Seed Data Generation
* **CSV Import:** Upload or paste CSV files with column matching, executed transactionally.
* **Data Export:** Download table data or arbitrary SQL query results as CSV or JSON.
* **Intelligent Seed Generator:** Populate tables with up to 5,000 realistic rows using intelligent heuristic strategy detection (names, emails, phones, addresses, dates, UUIDs, custom templates, or sampled foreign keys). Includes live table preview before execution.

### 📁 Multi-Database Manager
* Manage directories of SQLite files, explicit file lists, or named JSON connections.
* Dedicated landing page with engine badges (`PostgreSQL` / `SQLite`), table counts, connection paths, and seamless database switching.

### 🛡️ Strict Read-Only & Serverless Mode
* **Serverless Ready:** Auto-detects ephemeral serverless environments (Vercel, AWS Lambda, Cloudflare Pages, Netlify, GCP Cloud Functions).
* **Smart Serverless Editability Rule:**
  * **SQLite** defaults to **read-only** in serverless mode to prevent data loss on ephemeral filesystems.
  * **PostgreSQL** is **fully editable and writable** in serverless mode because it connects to persistent remote database services.
* Includes ready-to-use `createServerlessHandler` and `createLambdaHandler` wrappers.

---

## 🚀 Embed AdminDB in Express

AdminDB can be mounted directly into any existing Express application under any subpath on the same port:

```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

app.get('/', (_req, res) => res.send('Main App'));

// Mount AdminDB for SQLite
app.use('/admin', createRouter({
  dbPath: './data/app.db',
  basePath: '/admin',
}));

// Or mount AdminDB for PostgreSQL
app.use('/admin-pg', createRouter({
  connection: 'postgresql://postgres:secret@localhost:5432/mydb',
  basePath: '/admin-pg',
}));

app.listen(45531, () => {
  console.log('App running on http://localhost:45531 (Admin: http://localhost:45531/admin)');
});
```

> 📖 **Full Options & Advanced Embedding Recipes:**
> See [**`docs/EXAMPLES.md`**](docs/EXAMPLES.md#-part-2-programmatic-code-examples-express--typescript) for the complete `createRouter` options reference, multi-database management (`DbManager`), custom loggers, read-only mode, and custom authentication configurations.

---

## ⚙️ CLI & Environment Variables

Every setting can be configured via **CLI flags**, **Environment Variables**, or **JSON Configuration Files** (CLI flags override JSON config, which overrides environment variables):

| Setting | CLI Flag & Aliases | Environment Variable & Aliases | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Config File** | `-C, --config <file.json>` | `ADMINDB_CONFIG` | — | Path to a JSON configuration file containing database credentials & settings |
| **Port** | `-p, --port <port>` | `PORT`, `ADMINDB_PORT` | `45531` | Port to listen on |
| **Host** | `-H, --host <host>` | `HOST`, `ADMINDB_HOST` | `0.0.0.0` | Host / interface to bind |
| **Connection URI** | `-c, --connection, --pg <uri>` | `DATABASE_URL`, `ADMINDB_CONNECTION`, `PG_CONNECTION` | — | PostgreSQL connection URI or path |
| **Single DB** | `-o, --open, --db-path <file>` | `DB_PATH`, `ADMINDB_DB_PATH`, `ADMINDB_PATH` | — | Open a single database file directly |
| **Database Dir** | `-d, --dir, --db-dir <dir>` | `DB_DIR`, `ADMINDB_DB_DIR`, `ADMINDB_DIR` | — | Folder of database files to manage |
| **Explicit Files** | `--files, --db-files <list>` | `DB_FILES`, `ADMINDB_DB_FILES` | — | Comma-separated database file paths |
| **Base Path** | `-b, --base-path, --base <p>` | `BASE_PATH`, `ADMINDB_BASE_PATH` | `''` (`/`) | URL prefix to serve under (e.g. `/admin`) |
| **Read-Only** | `-r, --readonly, --read-only`| `READONLY`, `ADMINDB_READONLY` | `false` | Open databases read-only (writes disabled) |
| **Serverless**| `--serverless` | `SERVERLESS`, `ADMINDB_SERVERLESS` | `false` *(auto)* | Serverless mode (SQLite read-only, Postgres editable) |
| **Auth** | `--auth` / `--no-auth` | `ADMINDB_AUTH`, `ADMINDB_NO_AUTH` | `true` | Enable or disable built-in authentication |
| **Username** | `-u, --username, --user <user>` | `ADMINDB_USERNAME`, `ADMINDB_USER` | `admin` | Admin username |
| **Password** | `-P, --password, --pass <pass>` | `ADMINDB_PASSWORD`, `ADMINDB_PASS` | `admin` *(hash)* | Admin password or salted `scrypt:...` hash |
| **Session Secret**| `--auth-secret, --secret <sec>` | `ADMINDB_SECRET`, `SESSION_SECRET` | *(auto)* | Secret key for signing session cookies |
| **Log Level** | `-l, --log-level <level>` | `LOG_LEVEL`, `ADMINDB_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| **Help** | `-h, --help` | — | — | Show CLI help |
| **Version** | `-v, --version` | — | — | Show version |

Quick CLI examples:

```bash
admindb name.postgres.json                   # Load credentials from JSON file
admindb postgresql://user:pass@host:5432/db  # Open PostgreSQL database
admindb ./data/app.db                        # Open SQLite database
admindb -d ./databases                       # Manage a folder of databases
admindb -p 8080                              # Run on port 8080
admindb --no-auth                            # Authentication disabled
```

> 📖 **Full Configuration Reference & Deployment Recipes:**
> See [**`docs/EXAMPLES.md`**](docs/EXAMPLES.md) for detailed variable explanations, reasons/use cases, and ready-to-run recipes for Bash, PowerShell, Docker, Docker Compose, and Nginx.

---

## 🔒 Authentication & Security

> [!WARNING]
> **Important Security Notice:**
> AdminDB's built-in native authentication provides **basic single-user access control** for local development and private internal tools.
> For production environments and internet-facing networks, **it is entirely the user's responsibility to protect AdminDB** by placing it behind your own web application's authentication (e.g. NextAuth, Passport, OAuth2/OIDC middleware), an IP-restricted VPN, or a secure reverse proxy with TLS/HTTPS.

### Generate a Secure Password Hash

To configure custom credentials with a salted cryptographic `scrypt` hash:

```bash
npm run generatehash
```

Paste the resulting hash into `ADMINDB_PASSWORD`, CLI `-P`, or your Express configuration:

```bash
ADMINDB_USERNAME="ops" ADMINDB_PASSWORD="scrypt:8011bcda...:85465796..." npx admindb
```

### Wrapping with Your Own Express Authentication (Recommended for Production)

When embedding AdminDB in your Express application, turn off built-in auth (`auth: false`) and protect the route with your existing auth middleware:

```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

app.use('/admin', requireYourAppAuth, createRouter({
  connection: process.env.DATABASE_URL,
  basePath: '/admin',
  auth: false, // Turn off built-in login form; rely on requireYourAppAuth
}));

app.listen(45531);
```

### Disabling Built-in Authentication

When deploying behind an external gateway (Cloudflare Zero Trust, OAuth2 Proxy, Authelia):

```bash
admindb --no-auth
# or
ADMINDB_AUTH=false npx admindb
```

> 📖 **Full Security Guide:** See [**`docs/SECURITY.md`**](docs/SECURITY.md) for the shared security model, filesystem sandboxing, PostgreSQL remote protection, and production deployment checklists.


---

## 📡 REST API

AdminDB exposes a comprehensive REST API under `basePath` returning `{ success, data?, error? }`:

```text
GET    /api/tables                                 List tables
GET    /api/tables/:table/rows                     Paginated rows (with filtering & sorting)
GET    /api/tables/:table/row/:id                  Get a single row
GET    /api/tables/:table/row/:id/blob/:column     Stream raw BLOB / BYTEA binary data
GET    /api/tables/:table/row/:id/blob/:col/meta   BLOB / BYTEA metadata, MIME analysis & hex dump
PUT    /api/tables/:table/row/:id/blob/:column     Upload / update binary content
POST   /api/tables/:table/rows                     Insert row (single or batch)
PUT    /api/tables/:table/row/:id                  Update row
DELETE /api/tables/:table/row/:id                  Delete row
POST   /api/tables/:table/rows/bulk-update         Apply staged inline edits atomically
POST   /api/tables/:table/rows/bulk-delete         Delete selected rows atomically
POST   /api/tables/:table/seed                     Generate & insert realistic seed rows
POST   /api/tables                                 Create a new table
GET    /api/tables/:table/schema                   Inspect table schema & constraints
GET    /api/tables/:table/ddl                      Get table CREATE SQL & indexes
POST   /api/query                                  Execute arbitrary SQL
GET    /api/databases                              List managed database connections & files
```

> 📖 **Full API Reference:** See [**`docs/API.md`**](docs/API.md) for detailed documentation of all 30+ endpoints, query parameters, payload schemas, and TypeScript types.

---

## 📚 Documentation Index

| Document | Description |
| :--- | :--- |
| [**`docs/EXAMPLES.md`**](docs/EXAMPLES.md) | Comprehensive Environment Variables reference, JSON configs, Express code examples, and deployment recipes. |
| [**`docs/SECURITY.md`**](docs/SECURITY.md) | Authentication architecture, password hashing, reverse proxy setup, and security checklist. |
| [**`docs/API.md`**](docs/API.md) | Complete REST API endpoint reference and TypeScript type exports. |
| [**`CONTRIBUTING.md`**](CONTRIBUTING.md) | Development workflow, running tests, project layout, and contribution guidelines. |

---

## 🤝 Contributing

Contributions are welcome! Please check out [**`CONTRIBUTING.md`**](CONTRIBUTING.md) for development setup and testing instructions.

```bash
git clone https://github.com/MIbnEKhalid/admindb.git
cd admindb
npm install
npm run dev        # Live reload development server
npm test           # Run comprehensive unit test suite
```

---

## 📄 License

[MIT](./LICENSE) © MIbnEKhalid

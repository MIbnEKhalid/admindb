# AdminDB

A browser-based SQLite database administration tool. Manage a SQLite database
entirely from the browser: browse tables, full CRUD, a visual table designer, an
arbitrary SQL query runner, saved named queries, SQL-dump export, a
"generate SQL" preview mode that never executes, a schema editor, and
multi-database support.

- **Backend:** Node.js + TypeScript (compiled to plain JS) on Express.
- **Frontend:** Handlebars server-rendered templates, Tailwind CSS + DaisyUI,
  plain JavaScript (no frontend framework).
- **Database:** SQLite via the standard Node driver (`node:sqlite`). Requires
  **Node.js ≥ 22.5**.

> ## ⚠️ Security warning — read first
>
> **This tool exposes full, unauthenticated database access.** Every page and
> API route (browse, edit, delete, run arbitrary SQL, change the schema, export
> the whole database) is available to **anyone who can reach the server**.
>
> - **No authentication or authorization is built in.** The routes are **not
>   protected**.
> - **It is your responsibility to protect access.** Do **not** expose
>   AdminDB to the public internet or to untrusted networks.
> - Recommended ways to protect it:
>   - bind the standalone server to `127.0.0.1` (`HOST=127.0.0.1`) and use it
>     only from your own machine, and/or
>   - run it behind a reverse proxy that requires authentication (Basic auth,
>     OAuth, mTLS, …) or inside a VPN / private network.
>
> Treat AdminDB as if it were a remote `sqlite3` shell with write access.

---

## Install

```bash
npm install admindb
```

Requires **Node.js ≥ 22.5** (for the built-in `node:sqlite` driver).

## Using as an npm package

AdminDB is an Express app you can mount inside your own application, under
your own path, on the same port as the rest of your server.

### Minimal example

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

### Options

| Option     | Type                 | Description                                                    |
| ---------- | -------------------- | -------------------------------------------------------------- |
| `dbPath`   | `string`             | Path to a single SQLite file (single-db mode). Default: `admindb.db` |
| `db`       | `SqliteDatabase`     | An already-open database instance (advanced embedding)         |
| `manager`  | `DbManager`          | Enables multi-database mode (see below)                        |
| `basePath` | `string`             | URL prefix used by templates/assets (e.g. `/admin`). Pass the same prefix you mount at |
| `logger`   | `Logger`             | Custom logger (see `createLogger`)                             |
| `logLevel` | `'debug'\|'info'\|'warn'\|'error'` | Log verbosity (used when no logger is passed)     |
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

### Multiple databases

Pass a `DbManager` to manage several database files — either from a directory,
from an explicit list of file paths, or both:

```ts
import express from 'express';
import { createRouter, DbManager, createLogger } from 'admindb';

const app = express();
app.use('/admin', createRouter({
  manager: new DbManager(
    {
      dir: './data',                                  // scan a directory
      files: ['/srv/legacy/app.db', './shared.sqlite'], // and/or explicit paths
      readonly: true,                                 // open all databases read-only
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

## Features

- Browse every table and its rows (paginated, with primary-key awareness).
- **Filter rows by column** — exact (`=value`), comparison (`>5`, `<=10`), prefix
  (`pre*`) or substring (plain text) matching; filters survive sorting and
  pagination.
- Insert, edit, and delete rows (full CRUD). FK columns become dropdowns.
- **Export** table rows or query results as **CSV or JSON**, and **import a CSV
  file** (or pasted CSV) into a table.
- Create tables visually: name, type, primary key, not-null / unique,
  default value, and foreign-key references.
- Write and run arbitrary SQL — SELECTs render as a table, `COUNT` queries show
  a readable summary, write statements execute and report affected rows.
- Save named queries and reload them from a dropdown.
- Export the whole database as a downloadable SQL dump (`CREATE` + `INSERT`).
- **Get query / preview mode:** generate `CREATE` / `INSERT` / `UPDATE` SQL from
  the UI without executing it.
- **Edit schema:** rename the table, add / rename / drop columns (with
  relationship-safety checks), and drop tables.
- **Indexes:** create indexes (plain or unique, on one or many columns — pick
  columns in order, with a live `CREATE INDEX` SQL preview) and drop them from
  the schema editor; automatic SQLite indexes are protected.
- **Views:** create / drop `CREATE VIEW` definitions, preview the rows they
  return, and inspect their SQL — from a dedicated Views page.
- **Triggers:** create / drop triggers with a structured form (timing, single
  event, optional `WHEN`, body with a live `CREATE TRIGGER` SQL preview) and
  inspect existing trigger SQL — from a dedicated Triggers page.
- **Read-only mode:** open the database(s) without write access — the file is
  opened `SQLITE_OPEN_READONLY` + `query_only`, every write route returns `403`,
  and the UI hides/disables all write controls and shows a banner.
- **Multiple databases:** directory scanning and/or explicit file lists, each
  with its own workspace under `/{db}/…`.

## Screenshots

Home dashboard — stat cards and the table list.

![Home dashboard](docs/screenshots/home.png)

Table browser — sortable columns, sticky header, and per-row actions.

![Table browser](docs/screenshots/table.png)

Query editor — line-numbered editor with a results table.

![Query editor](docs/screenshots/query.png)

Table designer — visual columns with a live SQL preview.

![Table designer](docs/screenshots/designer.png)

Insert / edit form — column defaults are pre-filled.

![Insert form](docs/screenshots/form.png)

Schema editor — rename the table, add / rename / drop columns safely.

![Schema editor](docs/screenshots/schema.png)

Databases landing page (multi-db mode) — manage multiple SQLite files.

![Databases](docs/screenshots/databases.png)

## Run the built-in server

For convenience a standalone server is included. From a clone of the repo:

```bash
npm install
npm run build
npm start        # open http://localhost:3000
```

Configuration via environment variables:

| Variable    | Default            | Description                          |
| ----------- | ------------------ | ------------------------------------ |
| `PORT`      | `3000`             | Port to listen on                    |
| `HOST`      | `0.0.0.0`          | Host / interface to bind             |
| `DB_PATH`   | `admindb.db`   | Single SQLite database file          |
| `DB_DIR`    | —                  | Multi-db source 1: a directory of `.db`/`.sqlite` files |
| `DB_FILES`  | —                  | Multi-db source 2: comma-separated explicit database file paths |
| `READONLY`  | —                  | `1` / `true` / `yes` / `on` opens the database(s) read-only     |
| `BASE_PATH` | `''`               | URL prefix (e.g. `/admin`)           |
| `LOG_LEVEL` | `info`             | `debug` \| `info` \| `warn` \| `error` |

Multi-db mode activates when `DB_DIR` and/or `DB_FILES` is set:

```powershell
$env:DB_DIR='./db'; npm start                 # PowerShell
# bash/zsh:  DB_DIR=./db npm start
```

## The JSON REST API (under `basePath`)

| Method | Path                                     | Purpose                          |
| ------ | ---------------------------------------- | -------------------------------- |
| GET    | `/api/tables`                            | List tables                      |
| GET    | `/api/tables/:table/info`                | Column + FK metadata, PK columns |
| GET    | `/api/tables/:table/fk-options`          | Values for FK dropdowns          |
| GET    | `/api/tables/:table/rows?page&limit&f`   | Paginated rows (`f` = URL-encoded JSON filters, e.g. `{"age":">35"}`) |
| GET    | `/api/tables/:table/row/:id`             | Single row by (encoded) PK       |
| POST   | `/api/tables/:table/rows`                | Insert row                       |
| POST   | `/api/tables/:table/rows/generate`       | Generate INSERT SQL (no execute) |
| POST   | `/api/tables/:table/rows/import`         | Import CSV (`{ csv }`, header row must match columns) |
| GET    | `/api/tables/:table/export?format=`      | Download all rows as `csv` or `json` |
| PUT    | `/api/tables/:table/row/:id`             | Update row                       |
| PUT    | `/api/tables/:table/row/:id/generate`    | Generate UPDATE SQL (no execute) |
| DELETE | `/api/tables/:table/row/:id`             | Delete row                       |
| POST   | `/api/tables`                            | Create table                     |
| POST   | `/api/tables/generate`                   | Generate CREATE SQL (no execute) |
| GET    | `/api/tables/:table/schema`              | Full schema (constraints, indexes, FK refs) |
| POST   | `/api/tables/:table/rename`              | Rename the table                 |
| POST   | `/api/tables/:table/columns`             | Add a column                     |
| PUT    | `/api/tables/:table/columns/:column`     | Rename a column                  |
| DELETE | `/api/tables/:table/columns/:column`     | Drop a column (safety-checked)   |
| DELETE | `/api/tables/:table`                     | Drop the table (safety-checked)  |
| POST   | `/api/tables/:table/indexes`             | Create an index (`{ name?, columns[], unique? }`) |
| DELETE | `/api/tables/:table/indexes/:index`      | Drop an index (auto indexes refused) |
| GET    | `/api/views`                             | List views                       |
| GET    | `/api/views/:name/rows`                  | Preview a view's rows            |
| POST   | `/api/views/generate`                    | Generate CREATE VIEW SQL (no execute) |
| POST   | `/api/views`                             | Create a view (`{ name, sql }`)  |
| DELETE | `/api/views/:name`                       | Drop a view                      |
| GET    | `/api/triggers`                          | List triggers                    |
| POST   | `/api/triggers/generate`                 | Generate CREATE TRIGGER SQL (no execute) |
| POST   | `/api/triggers`                          | Create a trigger (`{ name, table, timing, event, when?, body }`) |
| DELETE | `/api/triggers/:name`                    | Drop a trigger                   |
| POST   | `/api/query`                             | Run arbitrary SQL                |
| POST   | `/api/query/export`                      | Run a SELECT and download as `csv`/`json` |
| GET    | `/api/queries`                           | List saved queries               |
| POST   | `/api/queries`                           | Save a named query               |
| DELETE | `/api/queries/:id`                       | Delete a saved query             |

In multi-db mode, every route is scoped under the database, e.g.
`/api/app.db/tables`. Every API response uses the consistent shape
`{ success, data?, error? }`.

## Behaviour notes

- **Empty input = "not set".** Empty form fields are omitted so DB defaults
  apply; `0` is a valid value and is never treated as empty.
- **Insert forms pre-fill defaults.** On the "new row" form, columns that have
  a schema default are pre-filled (string/number/boolean literals and
  `CURRENT_TIMESTAMP`-style defaults) so you can see and adjust them.
- **Row filters.** Each column's filter supports exact match (`=value`),
  comparison (`>5`, `>=5`, `<5`, `<=5`, `!=value`), prefix (`pre*`) and
  case-insensitive substring (plain text). Filters are carried in the URL and
  survive sorting and pagination.
- **CSV import.** The first row must be a header whose names match existing
  columns (unknown or duplicate names are rejected). Empty cells are treated as
  "not set" so database defaults apply. The whole import runs in a single
  transaction — a failed row rolls everything back.
- **Indexes.** Creating an index takes one or more columns and an optional
  unique flag (the index name is optional too). Only explicitly created indexes
  (`origin = 'c'`) can be dropped from the UI — automatic primary-key/unique
  indexes are protected.
- **Schema editor.** Drops are refused when the column is a primary key, has a
  UNIQUE constraint, is used by an index, is part of a foreign key, or is
  referenced by another table's foreign key. Tables referenced by other tables
  cannot be dropped. Internal (`_`-prefixed) tables cannot be renamed or dropped.
- **Identifiers are quoted and string values escaped** everywhere SQL is built,
  so generated SQL is correct and safe.
- **`COUNT` queries** return a readable summary message instead of a table.
- **"Get query" never executes** — it only returns the generated SQL string.
- **Internal table** `_saved_queries` stores saved queries and is kept out of
  user-facing FK pickers. Schema initialization is idempotent and safe to run
  repeatedly.
- Composite primary keys are supported (values are URL-encoded and comma-joined
  in the row endpoints).

## Development

```bash
npm install
npm run build      # TypeScript → dist + Tailwind CSS
npm run dev        # tsx watch server + Tailwind watch
npm test           # builds and runs the unit tests
```

`npm test` compiles TypeScript to `dist/` and runs the `node:test` suite
covering the SQL generator (INSERT / UPDATE / CREATE output, type mapping,
quoting, rejection of unsupported types), the SQL classifier, and the database
manager.

## Publishing to npm

The package ships the compiled `dist/` (with type declarations), this `README`,
and the `LICENSE`. When you are ready to publish:

```bash
npm run build     # happens automatically via the prepack script
npm login
npm publish
```

Update `name`/`version` in `package.json` to match your intended package name
and add an `author`/`repository` if desired.

## License

[MIT](./LICENSE) — see the [LICENSE](LICENSE) file.

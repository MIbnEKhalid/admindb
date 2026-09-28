# AdminDB REST API

Every route is under `basePath` and returns the consistent shape
`{ success, data?, error? }`. All database-specific routes follow the uniform pattern
`/<page>/<db>` and `/api/<resource>/<db>/...` (e.g. `/api/tables/app.db` or `/api/tables/prod_pg/users`).

AdminDB supports both **SQLite** and **PostgreSQL** database backends seamlessly.

## Tables & rows

| Method | Path                                          | Purpose                          |
| ------ | --------------------------------------------- | -------------------------------- |
| GET    | `/api/tables/:db`                             | List tables                      |
| GET    | `/api/tables/:db/:table/info`                 | Column + FK metadata, PK columns |
| GET    | `/api/tables/:db/:table/fk-options`           | Values for FK dropdowns          |
| GET    | `/api/tables/:db/:table/rows?page&limit&f`    | Paginated rows (`f` = URL-encoded JSON filters — legacy strings like `{"age":">35"}` or structured conditions like `{"balance":{"op":"gte","value":"100"}}`) |
| GET    | `/api/tables/:db/:table/rows/count?f=`        | Filtered row count               |
| GET    | `/api/tables/:db/:table/row/:id`              | Single row by (encoded) PK       |
| GET    | `/api/tables/:db/:table/rows/:id/references`  | Rows in other tables whose foreign keys reference this row |
| GET    | `/api/tables/:db/:table/row/:id/blob/:column` | Stream binary BLOB / BYTEA with MIME detection (add `?download=1` to force download) |
| GET    | `/api/tables/:db/:table/row/:id/blob/:column/meta` | Inspect BLOB / BYTEA metadata, MIME sniffing & 3-column hex dump |
| PUT    | `/api/tables/:db/:table/row/:id/blob/:column` | Update binary value (`{ data: base64/hex, format?: 'base64'|'hex'|'text' }`) |
| POST   | `/api/tables/:db/:table/rows`                 | Insert row (or batch of rows with `{ rows: [...] }`) |
| POST   | `/api/tables/:db/:table/rows/generate`        | Generate INSERT SQL (no execute) |
| POST   | `/api/tables/:db/:table/rows/import`          | Import CSV (`{ csv }`, header row must match columns) |
| GET    | `/api/tables/:db/:table/export?format=`       | Download all rows as `csv` or `json` |
| PUT    | `/api/tables/:db/:table/row/:id`              | Update row (`{ values, nulls? }` — `nulls` explicitly sets columns to NULL) |
| PUT    | `/api/tables/:db/:table/row/:id/generate`     | Generate UPDATE SQL (no execute) |
| DELETE | `/api/tables/:db/:table/row/:id`              | Delete row                       |
| POST   | `/api/tables/:db/:table/rows/bulk-impact`     | FK-impact preview: how many rows in other tables reference the selected rows |
| POST   | `/api/tables/:db/:table/rows/bulk-delete`     | Delete selected rows (`{ ids, confirmImpact }`; transactional) |
| POST   | `/api/tables/:db/:table/rows/bulk-export`     | Export only the selected rows as `csv`/`json` (`{ ids, format }`) |
| POST   | `/api/tables/:db/:table/rows/bulk-update`     | Apply staged inline edits (`{ updates: [{ id, values?, nulls? }] }`; transactional) |
| GET    | `/api/tables/:db/:table/seed/config`          | Per-column generator strategies + detected defaults |
| GET    | `/api/tables/:db/:table/seed/plan`            | Detect intelligent seed plan heuristics |
| POST   | `/api/tables/:db/:table/seed/preview`         | Generate preview sample rows for grid without executing |
| POST   | `/api/tables/:db/:table/seed/generate`        | Generate seed INSERT SQL without executing (`{ count, plan }`) |
| POST   | `/api/tables/:db/:table/seed`                 | Generate and insert seed rows transactionally (`{ count, plan, truncate? }`) |
| GET    | `/api/tables/:db/:table/seed/chain`           | Relational ER chain resolution and topological sort |
| POST   | `/api/tables/:db/:table/seed/chain/generate`  | Generate ER chain seed SQL & preview rows |
| POST   | `/api/tables/:db/:table/seed/chain`           | Execute atomic relational chain seeding |
| POST   | `/api/seed/:db/validate`                      | Validate unified seed plan |
| POST   | `/api/seed/:db/preview`                       | Preview unified multi-table seed rows |
| POST   | `/api/seed/:db/execute`                       | Execute unified multi-table seed plan |

## Schema & indexes

| Method | Path                                      | Purpose                          |
| ------ | ----------------------------------------- | -------------------------------- |
| POST   | `/api/tables/:db`                         | Create table                     |
| POST   | `/api/tables/:db/generate`                | Generate CREATE SQL (no execute) |
| GET    | `/api/tables/:db/:table/schema`           | Full schema (constraints, indexes, FK refs) |
| GET    | `/api/tables/:db/:table/ddl`              | Get formatted `CREATE TABLE` and `INDEX` DDL for a single table |
| GET    | `/api/info/:db/ddl`                       | Get formatted DDL for the entire database schema |
| POST   | `/api/tables/:db/:table/rename`           | Rename the table                 |
| POST   | `/api/tables/:db/:table/columns`          | Add a column                     |
| PUT    | `/api/tables/:db/:table/columns/:column`  | Modify/rename a column           |
| DELETE | `/api/tables/:db/:table/columns/:column`  | Drop a column (safety-checked)   |
| DELETE | `/api/tables/:db/:table`                  | Drop the table (safety-checked)  |
| POST   | `/api/tables/:db/bulk-drop`               | Drop multiple tables at once (`{ tables, force }`) |
| POST   | `/api/tables/:db/bulk-truncate`           | Truncate/empty multiple tables at once (`{ tables, force }`) |
| POST   | `/api/tables/:db/:table/indexes`          | Create an index (`{ name?, columns[], unique? }`) |
| DELETE | `/api/tables/:db/:table/indexes/:index`   | Drop an index (auto indexes refused) |
| GET    | `/api/erd/:db`                            | Full schema graph with columns & FK edges for ER Diagram |

## Queries

| Method | Path                 | Purpose                    |
| ------ | -------------------- | -------------------------- |
| POST   | `/api/query/:db`     | Run arbitrary SQL          |
| POST   | `/api/query/:db/export` | Run a SELECT and download as `csv`/`json` |
| GET    | `/api/queries/:db`   | List saved queries         |
| POST   | `/api/queries/:db`   | Save a named query         |
| DELETE | `/api/queries/:db/:id` | Delete a saved query     |

## Manager mode (databases landing page)

These endpoints manage database files and power the filesystem browser:

| Method | Path                            | Purpose                                     |
| ------ | ------------------------------- | ------------------------------------------- |
| GET    | `/api/databases`                | List managed databases                      |
| POST   | `/api/databases`                | Create a new SQLite database (`{ name }`)   |
| POST   | `/api/databases/connect-postgres` | Connect a PostgreSQL database (`{ name?, connectionString, readonly? }`) |
| POST   | `/api/databases/:id/mode`       | Toggle/set database mode (`{ readonly: boolean }`) |
| DELETE | `/api/databases/:id`            | Delete SQLite database file or disconnect PostgreSQL connection |
| GET    | `/api/fs/list?path=`            | List subfolders + SQLite files under a path (sandboxed file browser) |
| POST   | `/api/databases/open`           | Open/register an existing database file by path (`{ path, readonly? }`) |

## Authentication & Sessions

| Method | Path                  | Purpose                                     |
| ------ | --------------------- | ------------------------------------------- |
| GET    | `/login`              | Web UI login page                           |
| POST   | `/login`              | Authenticate with `{ username, password }` and get session token |
| POST   | `/logout`             | Terminate session and clear cookie          |
| GET    | `/logout`             | Terminate session and redirect to `/login`  |

All API endpoints accept:
- **HTTP Basic Auth**: `Authorization: Basic <base64(username:password)>`
- **Bearer Token**: `Authorization: Bearer <sessionToken>`
- **Session Cookie**: `admindb_session=<sessionToken>`

### Generating Password Hashes
Generate salted `scrypt` password hashes for custom credentials:
```bash
npm run generatehash
# Enter password -> outputs scrypt:<salt>:<hash>
```

Paste the generated hash into `ADMINDB_PASSWORD`, CLI `-P`, or `auth.password` option.

### Disabling Native Authentication & Custom Application Auth
Pass `auth: false`, CLI `--no-auth`, or `ADMINDB_AUTH=false` to turn off built-in authentication when integrating your own security layer.

> [!WARNING]
> **Security & Responsibility Notice**:
> AdminDB's built-in authentication is designed for basic access control during local development. For production environments and internet-facing networks, **it is entirely the user's responsibility to protect AdminDB** by placing it behind your own application authentication (e.g. NextAuth, Passport, JWT, SSO/OAuth middleware), a VPN, an IP-allowlist reverse proxy (Nginx, Cloudflare Access), or HTTPS with rate limiting.


## TypeScript API Types & Helpers

All request and response types, data inspection helpers, and serverless handlers are exported by the package entry point:

```ts
import { createRouter, createServerlessHandler, createLambdaHandler, sniffMimeType, generateHexDump, analyzeBlob, isJsonString, formatJsonSafely, type ApiResponse, type GetRowsResponseData, type BlobMetaResponseData, type TableDdlResponseData } from 'admindb';
import { analyzeSqlError } from 'admindb/dist/sql/error-analyzer.js';

// 1. Sniff MIME type from binary magic bytes
const analysis = sniffMimeType(imageBuffer);
console.log(analysis.mime, analysis.ext, analysis.isImage);

// 2. Generate a 3-column hex dump
const dump = generateHexDump(binaryBuffer, 1024);
dump.lines.forEach((l) => console.log(`${l.offset}  ${l.hex}  |${l.ascii}|`));

// 3. Serverless request handler (Vercel, AWS Lambda, Cloudflare, etc.)
export default createServerlessHandler({ dbPath: './app.db' });
```



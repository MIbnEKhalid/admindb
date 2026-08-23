# AdminDB REST API

Every route is under `basePath` and returns the consistent shape
`{ success, data?, error? }`. In multi-db mode, every route is scoped under the
database identifier, e.g. `/api/app.db/tables` or `/api/prod_pg/tables`.

AdminDB supports both **SQLite** and **PostgreSQL** database backends seamlessly.

## Tables & rows

| Method | Path                                     | Purpose                          |
| ------ | ---------------------------------------- | -------------------------------- |
| GET    | `/api/tables`                            | List tables                      |
| GET    | `/api/tables/:table/info`                | Column + FK metadata, PK columns |
| GET    | `/api/tables/:table/fk-options`          | Values for FK dropdowns          |
| GET    | `/api/tables/:table/rows?page&limit&f`   | Paginated rows (`f` = URL-encoded JSON filters — legacy strings like `{"age":">35"}` or structured conditions like `{"balance":{"op":"gte","value":"100"}}`) |
| GET    | `/api/tables/:table/rows/count?f=`       | Filtered row count               |
| GET    | `/api/tables/:table/row/:id`             | Single row by (encoded) PK       |
| GET    | `/api/tables/:table/rows/:id/references` | Rows in other tables whose foreign keys reference this row |
| GET    | `/api/tables/:table/row/:id/blob/:column` | Stream binary BLOB / BYTEA with MIME detection (add `?download=1` to force download) |
| GET    | `/api/tables/:table/row/:id/blob/:column/meta` | Inspect BLOB / BYTEA metadata, MIME sniffing & 3-column hex dump |
| PUT    | `/api/tables/:table/row/:id/blob/:column` | Update binary value (`{ data: base64/hex, format?: 'base64'|'hex'|'text' }`) |
| POST   | `/api/tables/:table/rows`                | Insert row (or batch of rows with `{ rows: [...] }`) |
| POST   | `/api/tables/:table/rows/generate`       | Generate INSERT SQL (no execute) |
| POST   | `/api/tables/:table/rows/import`         | Import CSV (`{ csv }`, header row must match columns) |
| GET    | `/api/tables/:table/export?format=`      | Download all rows as `csv` or `json` |
| PUT    | `/api/tables/:table/row/:id`             | Update row (`{ values, nulls? }` — `nulls` explicitly sets columns to NULL) |
| PUT    | `/api/tables/:table/row/:id/generate`    | Generate UPDATE SQL (no execute) |
| DELETE | `/api/tables/:table/row/:id`             | Delete row                       |
| POST   | `/api/tables/:table/rows/bulk-impact`    | FK-impact preview: how many rows in other tables reference the selected rows |
| POST   | `/api/tables/:table/rows/bulk-delete`    | Delete selected rows (`{ ids, confirmImpact }`; transactional) |
| POST   | `/api/tables/:table/rows/bulk-export`    | Export only the selected rows as `csv`/`json` (`{ ids, format }`) |
| POST   | `/api/tables/:table/rows/bulk-update`    | Apply staged inline edits (`{ updates: [{ id, values?, nulls? }] }`; transactional) |
| GET    | `/api/tables/:table/seed/config`         | Per-column generator strategies + detected defaults |
| GET    | `/api/tables/:table/seed/plan`           | Detect intelligent seed plan heuristics |
| POST   | `/api/tables/:table/seed/preview`        | Generate preview sample rows for grid without executing |
| POST   | `/api/tables/:table/seed/generate`       | Generate seed INSERT SQL without executing (`{ count, plan }`) |
| POST   | `/api/tables/:table/seed`                | Generate and insert seed rows transactionally (`{ count, plan, truncate? }`) |

## Schema & indexes

| Method | Path                                 | Purpose                          |
| ------ | ------------------------------------ | -------------------------------- |
| POST   | `/api/tables`                        | Create table                     |
| POST   | `/api/tables/generate`               | Generate CREATE SQL (no execute) |
| GET    | `/api/tables/:table/schema`          | Full schema (constraints, indexes, FK refs) |
| GET    | `/api/tables/:table/ddl`             | Get formatted `CREATE TABLE` and `INDEX` DDL |

| POST   | `/api/tables/:table/rename`          | Rename the table                 |
| POST   | `/api/tables/:table/columns`         | Add a column                     |
| PUT    | `/api/tables/:table/columns/:column` | Modify/rename a column           |
| DELETE | `/api/tables/:table/columns/:column` | Drop a column (safety-checked)   |
| DELETE | `/api/tables/:table`                 | Drop the table (safety-checked)  |
| POST   | `/api/tables/bulk-drop`              | Drop multiple tables at once (`{ tables, force }`) |
| POST   | `/api/tables/bulk-truncate`          | Truncate/empty multiple tables at once (`{ tables, force }`) |
| POST   | `/api/tables/:table/indexes`         | Create an index (`{ name?, columns[], unique? }`) |
| DELETE | `/api/tables/:table/indexes/:index`  | Drop an index (auto indexes refused) |
| GET    | `/api/erd`                           | Full schema graph with columns & FK edges for ER Diagram |

## Queries

| Method | Path              | Purpose                    |
| ------ | ----------------- | -------------------------- |
| POST   | `/api/query`      | Run arbitrary SQL          |
| POST   | `/api/query/export` | Run a SELECT and download as `csv`/`json` |
| GET    | `/api/queries`    | List saved queries         |
| POST   | `/api/queries`    | Save a named query         |
| DELETE | `/api/queries/:id`| Delete a saved query       |

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
import {
  createRouter,
  createServerlessHandler,
  createLambdaHandler,
  sniffMimeType,
  generateHexDump,
  analyzeBlob,
  isJsonString,
  formatJsonSafely,
  type ApiResponse,
  type GetRowsResponseData,
  type BlobMetaResponseData,
  type TableDdlResponseData,
} from 'admindb';
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



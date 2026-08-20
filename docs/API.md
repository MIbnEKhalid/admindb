# AdminDB REST API

Every route is under `basePath` and returns the consistent shape
`{ success, data?, error? }`. In multi-db mode, every route is scoped under the
database, e.g. `/api/app.db/tables`.

## Tables & rows

| Method | Path                                     | Purpose                          |
| ------ | ---------------------------------------- | -------------------------------- |
| GET    | `/api/tables`                            | List tables                      |
| GET    | `/api/tables/:table/info`                | Column + FK metadata, PK columns |
| GET    | `/api/tables/:table/fk-options`          | Values for FK dropdowns          |
| GET    | `/api/tables/:table/rows?page&limit&f`   | Paginated rows (`f` = URL-encoded JSON filters — legacy strings like `{"age":">35"}` or structured conditions like `{"balance":{"op":"gte","value":"100"}}`) |
| GET    | `/api/tables/:table/row/:id`             | Single row by (encoded) PK       |
| GET    | `/api/tables/:table/rows/:id/references` | Rows in other tables whose foreign keys reference this row |
| POST   | `/api/tables/:table/rows`                | Insert row                       |
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
| POST   | `/api/tables/:table/seed/generate`       | Generate seed INSERT SQL without executing (`{ count, plan }`) |
| POST   | `/api/tables/:table/seed`                | Generate and insert seed rows transactionally (`{ count, plan }`) |

## Schema & indexes

| Method | Path                                 | Purpose                          |
| ------ | ------------------------------------ | -------------------------------- |
| POST   | `/api/tables`                        | Create table                     |
| POST   | `/api/tables/generate`               | Generate CREATE SQL (no execute) |
| GET    | `/api/tables/:table/schema`          | Full schema (constraints, indexes, FK refs) |
| POST   | `/api/tables/:table/rename`          | Rename the table                 |
| POST   | `/api/tables/:table/columns`         | Add a column                     |
| PUT    | `/api/tables/:table/columns/:column` | Rename a column                  |
| DELETE | `/api/tables/:table/columns/:column` | Drop a column (safety-checked)   |
| DELETE | `/api/tables/:table`                 | Drop the table (safety-checked)  |
| POST   | `/api/tables/:table/indexes`         | Create an index (`{ name?, columns[], unique? }`) |
| DELETE | `/api/tables/:table/indexes/:index`  | Drop an index (auto indexes refused) |

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

| Method | Path                  | Purpose                                     |
| ------ | --------------------- | ------------------------------------------- |
| GET    | `/api/databases`      | List managed databases                      |
| POST   | `/api/databases`      | Create a new database (`{ name }`)          |
| DELETE | `/api/databases/:id`  | Delete a database                           |
| GET    | `/api/fs/list?path=`  | List subfolders + SQLite files under a path (file browser) |
| POST   | `/api/databases/open` | Open/register an existing database file by path (`{ path }`) |

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

### Disabling Native Authentication
Pass `auth: false`, CLI `--no-auth`, or `ADMINDB_AUTH=false` to turn off built-in authentication when integrating your own security layer.

> ⚠️ **Notice**: The native authentication system is designed for basic protection. In production environments, place AdminDB behind an authenticated gateway or use custom authentication middleware.

## TypeScript API Types

All request and response types are exported by the package entry point for client/SDK consumers:

```ts
import type {
  ApiResponse,
  ApiSuccessResponse,
  ApiErrorResponse,
  GetRowsResponse,
  GetRowsResponseData,
  TableInfoResponse,
  TableInfoResponseData,
  ExecuteQueryResponse,
  ExecuteQueryResponseData,
  BulkDeleteResponse,
  BulkUpdateResponse,
  SeedConfigResponse,
  SeedGenerateResponse,
  ListDatabasesResponse,
  ListFsResponse,
} from 'admindb';

async function fetchTableRows(table: string): Promise<GetRowsResponseData> {
  const res = await fetch(`/api/tables/${table}/rows`);
  const json: GetRowsResponse = await res.json();
  if (!json.success) {
    throw new Error(json.error);
  }
  return json.data;
}
```


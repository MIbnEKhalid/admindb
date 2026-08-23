# AdminDB Examples & Configuration Reference

> A comprehensive, organized reference guide for **Environment Variables**, **JSON Configuration Files**, **Programmatic Code Examples (Express & TypeScript)**, and **Deployment Recipes**.

---

## 📑 Table of Contents

- [Overview & Precedence Order](#-overview--precedence-order)
- [Configuration Matrix](#-configuration-matrix)
- [Part 1: Environment Variables Reference](#-part-1-environment-variables-reference)
  - [1. PORT / ADMINDB_PORT](#1-port--admindb_port)
  - [2. HOST / ADMINDB_HOST](#2-host--admindb_host)
  - [3. DATABASE_URL / ADMINDB_CONNECTION / PG_CONNECTION](#3-database_url--admindb_connection--pg_connection)
  - [4. ADMINDB_CONFIG (JSON Configuration Files)](#4-admindb_config-json-configuration-files)
  - [5. DB_PATH / ADMINDB_DB_PATH / ADMINDB_PATH](#5-db_path--admindb_db_path--admindb_path)
  - [6. DB_DIR / ADMINDB_DB_DIR / ADMINDB_DIR](#6-db_dir--admindb_db_dir--admindb_dir)
  - [7. DB_FILES / ADMINDB_DB_FILES](#7-db_files--admindb_db_files)
  - [8. BASE_PATH / ADMINDB_BASE_PATH](#8-base_path--admindb_base_path)
  - [9. READONLY / ADMINDB_READONLY](#9-readonly--admindb_readonly)
  - [10. SERVERLESS / ADMINDB_SERVERLESS](#10-serverless--admindb_serverless)
  - [11. ADMINDB_AUTH / ADMINDB_NO_AUTH / ADMINDB_DISABLE_AUTH](#11-admindb_auth--admindb_no_auth--admindb_disable_auth)
  - [12. ADMINDB_USERNAME / ADMINDB_USER](#12-admindb_username--admindb_user)
  - [13. ADMINDB_PASSWORD / ADMINDB_PASS](#13-admindb_password--admindb_pass)
  - [14. ADMINDB_SECRET / SESSION_SECRET](#14-admindb_secret--session_secret)
  - [15. LOG_LEVEL / ADMINDB_LOG_LEVEL](#15-log_level--admindb_log_level)
- [Part 2: Programmatic Code Examples (Express & TypeScript)](#-part-2-programmatic-code-examples-express--typescript)
  - [`createRouter(options)` Reference](#createrouteroptions-reference)
  - [Example 1: Minimal Single SQLite Database Embedding](#example-1-minimal-single-sqlite-database-embedding)
  - [Example 2: Single PostgreSQL Database Embedding](#example-2-single-postgresql-database-embedding)
  - [Example 3: Multiple PostgreSQL Connections (`DbManager`)](#example-3-multiple-postgresql-connections-dbmanager)
  - [Example 4: Mixed Multi-Database Manager (Postgres & SQLite)](#example-4-mixed-multi-database-manager-postgres--sqlite)
  - [Example 5: Custom Authentication with Salted scrypt Hash](#example-5-custom-authentication-with-salted-scrypt-hash)
  - [Example 6: Disabling Built-in Auth to Use Custom Express Middleware](#example-6-disabling-built-in-auth-to-use-custom-express-middleware)

- [Part 3: Infrastructure & Deployment Recipes](#-part-3-infrastructure--deployment-recipes)
  - [Recipe 1: Secure Credentials JSON File](#recipe-1-secure-credentials-json-file)
  - [Recipe 2: Direct PostgreSQL CLI Connection](#recipe-2-direct-postgresql-cli-connection)
  - [Recipe 3: Multi-Database Folder (Read-Only Auditor)](#recipe-3-multi-database-folder-read-only-auditor)
  - [Recipe 4: Production Docker & Docker Compose Deployment](#recipe-4-production-docker--docker-compose-deployment)
  - [Recipe 5: Nginx Reverse Proxy with Subpath Routing](#recipe-5-nginx-reverse-proxy-with-subpath-routing)
  - [Recipe 6: Serverless Deployment (Vercel & AWS Lambda)](#recipe-6-serverless-deployment-vercel--aws-lambda)

---

## ⚡ Overview & Precedence Order

When starting AdminDB standalone:

```text
CLI Arguments & Flags (Highest) ➔ JSON Configuration File ➔ Environment Variables ➔ Default Values (Lowest)
```

- **CLI flags always override configuration files and environment variables.**
- JSON configuration files (`name.postgres.json`, `--config config.json`) allow storing passwords securely away from shell history.
- Namespaced variables (`ADMINDB_*`) and standard short variables (`PORT`, `HOST`, `DATABASE_URL`, `DB_PATH`, etc.) are both fully supported.

> [!WARNING]
> **Production Security & Protection Notice:**
> AdminDB's native authentication is designed as a basic convenience layer for single-user local development.
> In production environments or public-facing deployments, **it is the user's sole responsibility to fully protect AdminDB** using your application's own authentication (e.g. NextAuth, Passport, JWT, SSO/OAuth middleware with `auth: false`), a VPN, an IP-allowlist reverse proxy (Nginx, Cloudflare Access), and HTTPS encryption.


---

## 📊 Configuration Matrix

| Feature | CLI Flag & Aliases | Environment Variable & Aliases | Type | Default | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Config File** | `-C, --config, --json <file.json>` | `ADMINDB_CONFIG` | `string` | — | Path to a JSON configuration file with database credentials |
| **Port** | `-p, --port <port>` | `PORT`, `ADMINDB_PORT` | `number` | `45531` | HTTP port the server listens on |
| **Host** | `-H, --host <host>` | `HOST`, `ADMINDB_HOST` | `string` | `0.0.0.0` | Network interface to bind |
| **Connection URI** | `-c, --connection, --conn, --pg <uri>` | `DATABASE_URL`, `ADMINDB_CONNECTION`, `PG_CONNECTION` | `string` | — | PostgreSQL connection URI or database target |
| **Single DB File** | `-o, --open, --db-path, --file <file>` | `DB_PATH`, `ADMINDB_DB_PATH`, `ADMINDB_PATH` | `string` | `admindb.db` | Path to a single SQLite database file |
| **Database Directory** | `-d, --dir, --db-dir, --folder <dir>` | `DB_DIR`, `ADMINDB_DB_DIR`, `ADMINDB_DIR` | `string` | — | Folder of `.db`/`.sqlite` files to manage |
| **Explicit DB Files** | `--files, --db-files <list>` | `DB_FILES`, `ADMINDB_DB_FILES` | `string` (CSV) | — | Comma-separated database file paths |
| **Base URL Path** | `-b, --base-path, --base <path>` | `BASE_PATH`, `ADMINDB_BASE_PATH` | `string` | `''` (`/`) | URL prefix to serve under (e.g. `/admin`) |
| **Read-Only Mode** | `-r, --readonly, --read-only` | `READONLY`, `ADMINDB_READONLY` | `boolean` | `false` | Disable all insert, update, delete, and DDL operations |
| **Serverless** | `--serverless` | `SERVERLESS`, `ADMINDB_SERVERLESS` | `boolean` | `false` *(auto)* | Serverless mode (SQLite read-only, Postgres editable) |
| **Authentication** | `--auth` / `--no-auth`, `--disable-auth` | `ADMINDB_AUTH`, `ADMINDB_NO_AUTH`, `ADMINDB_DISABLE_AUTH` | `boolean` | `true` | Enable or disable built-in login authentication |
| **Admin Username** | `-u, --username, --user, --auth-username <user>` | `ADMINDB_USERNAME`, `ADMINDB_USER` | `string` | `admin` | Custom administrator username for web login & basic auth |
| **Admin Password** | `-P, --password, --pass, --auth-password <pass>` | `ADMINDB_PASSWORD`, `ADMINDB_PASS` | `string` | `admin` (hash) | Plain text password or salted `scrypt:...` cryptographic hash |
| **Session Secret** | `--auth-secret, --secret, --session-secret <sec>` | `ADMINDB_SECRET`, `SESSION_SECRET` | `string` | *(auto-generated)* | Secret key used to sign HTTP session cookies |
| **Log Level** | `-l, --log-level <level>` | `LOG_LEVEL`, `ADMINDB_LOG_LEVEL` | `enum` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| **Help** | `-h, --help` | — | `boolean` | `false` | Print CLI help documentation |
| **Version** | `-v, --version` | — | `boolean` | `false` | Print current package version |

---

# 🌐 Part 1: Environment Variables Reference

Detailed reference for every environment variable supported by AdminDB.

---

### 1. `PORT` / `ADMINDB_PORT`
* **Type:** `number`
* **Default:** `45531`
* **Why/When to use it:** Specify the TCP port where the web server should accept connections.
* **Configuration Examples:**
  ```bash
  PORT=8080 npx admindb
  ```

---

### 2. `HOST` / `ADMINDB_HOST`
* **Type:** `string`
* **Default:** `0.0.0.0`
* **Why/When to use it:** Specify which network interface to bind. Use `127.0.0.1` to restrict access strictly to localhost.
* **Configuration Examples:**
  ```bash
  HOST=127.0.0.1 npx admindb
  ```

---

### 3. `DATABASE_URL` / `ADMINDB_CONNECTION` / `PG_CONNECTION`
* **Type:** `string`
* **Default:** —
* **Why/When to use it:** Connect directly to a PostgreSQL database (e.g. Supabase, Neon, AWS RDS, local PostgreSQL).
* **Configuration Examples:**
  ```bash
  DATABASE_URL="postgresql://postgres:secret@localhost:5432/my_database" npx admindb
  ```

---

### 4. `ADMINDB_CONFIG` (JSON Configuration Files)
* **Type:** `string` (Path to a `.json` file)
* **Default:** —
* **Why/When to use it:** Store database connection credentials securely in a JSON file without passing raw passwords on the command line.
* **Format:**
  ```json
  {
    "primary": "postgresql://postgres:secret@localhost:5432/primary_db",
    "analytics": "postgresql://postgres:secret@localhost:5432/analytics_db",
    "local": "./data/local.db"
  }
  ```
* **Configuration Examples:**
  ```bash
  npx admindb name.postgres.json
  # or
  ADMINDB_CONFIG=./connections.json npx admindb
  ```

---

### 5. `DB_PATH` / `ADMINDB_DB_PATH` / `ADMINDB_PATH`
* **Type:** `string`
* **Default:** `admindb.db`
* **Why/When to use it:** Open a single SQLite database file directly.
* **Configuration Examples:**
  ```bash
  DB_PATH="./data/production.sqlite" npx admindb
  ```

---

### 6. `DB_DIR` / `ADMINDB_DB_DIR` / `ADMINDB_DIR`
* **Type:** `string`
* **Default:** —
* **Why/When to use it:** Scan a folder and manage all SQLite files found in it.
* **Configuration Examples:**
  ```bash
  DB_DIR="./databases" npx admindb
  ```

---

### 7. `DB_FILES` / `ADMINDB_DB_FILES`
* **Type:** `string` (Comma-separated paths)
* **Default:** —
* **Why/When to use it:** Specify an explicit list of database files located anywhere on disk.
* **Configuration Examples:**
  ```bash
  DB_FILES="./app.db,/var/data/users.sqlite" npx admindb
  ```

---

### 8. `BASE_PATH` / `ADMINDB_BASE_PATH`
* **Type:** `string`
* **Default:** `''` (`/`)
* **Why/When to use it:** Serve AdminDB under a URL prefix (e.g. `/admin`).
* **Configuration Examples:**
  ```bash
  BASE_PATH="/admin" npx admindb
  ```

---

### 9. `READONLY` / `ADMINDB_READONLY`
* **Type:** `boolean` (`1`, `true`, `yes`, `on`)
* **Default:** `false`
* **Why/When to use it:** Open databases in **Strict Read-Only Mode**. Disables all insert, update, delete, and DDL operations.
* **Configuration Examples:**
  ```bash
  READONLY=true npx admindb
  ```

---

### 10. `SERVERLESS` / `ADMINDB_SERVERLESS`
* **Type:** `boolean` (`1`, `true`, `yes`, `on`)
* **Default:** `false` *(automatically detected on Vercel, AWS Lambda, Cloudflare Pages, Netlify, GCP Cloud Functions)*
* **Why/When to use it:** Enforce read-only safety for local SQLite databases while keeping remote PostgreSQL connections fully writable.
* **Configuration Examples:**
  ```bash
  SERVERLESS=true npx admindb
  ```

---

### 11. `ADMINDB_AUTH` / `ADMINDB_NO_AUTH` / `ADMINDB_DISABLE_AUTH`
* **Type:** `boolean`
* **Default:** `true` (auth enabled)
* **Why/When to use it:** Enable or disable built-in native authentication.
* **Configuration Examples:**
  ```bash
  ADMINDB_AUTH=false npx admindb
  ```

---

### 12. `ADMINDB_USERNAME` / `ADMINDB_USER`
* **Type:** `string`
* **Default:** `admin`
* **Why/When to use it:** Change the administrator username.
* **Configuration Examples:**
  ```bash
  ADMINDB_USERNAME=superadmin npx admindb
  ```

---

### 13. `ADMINDB_PASSWORD` / `ADMINDB_PASS`
* **Type:** `string` (Plain text or salted cryptographic `scrypt` hash)
* **Default:** `admin` *(hash)*
* **Why/When to use it:** Secure your instance with a custom password or scrypt hash.
* **Generating a Hash:**
  ```bash
  npm run generatehash
  ```
* **Configuration Examples:**
  ```bash
  ADMINDB_PASSWORD="scrypt:3f8e02d9a1c4b7e8...:cb3032b16f29c8d44f75..." npx admindb
  ```

---

### 14. `ADMINDB_SECRET` / `SESSION_SECRET`
* **Type:** `string`
* **Default:** Auto-generated randomly per process instance
* **Why/When to use it:** Fixed secret key used to sign HTTP session cookies.
* **Configuration Examples:**
  ```bash
  ADMINDB_SECRET="a7f8e92c4b1d6e3f8a0b5c7d9e1f2a3b4c5d6e7f8" npx admindb
  ```

---

### 15. `LOG_LEVEL` / `ADMINDB_LOG_LEVEL`
* **Type:** `enum`: `debug` | `info` | `warn` | `error`
* **Default:** `info`
* **Why/When to use it:** Control log output verbosity in the terminal.
* **Configuration Examples:**
  ```bash
  LOG_LEVEL=warn npx admindb
  ```

---

# 💻 Part 2: Programmatic Code Examples (Express & TypeScript)

AdminDB can be mounted directly into any existing Express application as a sub-router on the same port.

> **💡 Note on ESM vs CJS:**
> AdminDB natively supports both **ES Modules** (`import { createRouter } from 'admindb'`) and **CommonJS** (`const { createRouter } = require('admindb')`). The examples below use TypeScript/ESM syntax, but they work identically in pure Node.js CommonJS.

---

### `createRouter(options)` Reference

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `connection` | `string` | — | PostgreSQL connection string or database URI. |
| `dbPath` | `string` | `'admindb.db'` | Path to a single SQLite database file. |
| `db` | `IDatabase` | — | An already-opened `SqliteDatabase` or `PostgresDatabase` instance. |
| `manager` | `DbManager` | — | Enables multi-database management across folders, files, and named connections. |
| `basePath` | `string` | `''` | URL prefix used by templates and static assets (e.g. `/admin`). |
| `readonly` | `boolean` | `false` | Open databases in strict read-only mode. |
| `serverless` | `boolean` | `false` | Serverless mode (SQLite read-only, Postgres editable). |
| `auth` | `boolean \| AuthConfig` | `true` | Configure built-in authentication or pass `false` to disable it. |
| `logger` | `Logger` | — | Custom logger instance. |
| `logLevel` | `'debug'\|'info'\|'warn'\|'error'` | `'info'` | Logging verbosity when no custom logger is provided. |

---

### Example 1: Minimal Single SQLite Database Embedding

```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

app.use('/admin', createRouter({
  dbPath: './data/production.db',
  basePath: '/admin',
}));

app.listen(45531, () => {
  console.log('App running on http://localhost:45531 (Admin: http://localhost:45531/admin)');
});
```

---

### Example 2: Single PostgreSQL Database Embedding

```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

app.use('/admin', createRouter({
  connection: process.env.DATABASE_URL || 'postgresql://postgres:secret@localhost:5432/mydb',
  basePath: '/admin',
}));

app.listen(45531, () => {
  console.log('AdminDB running at http://localhost:45531/admin');
});
```

---

### Example 3: Multiple PostgreSQL Connections (`DbManager`)

Manage multiple PostgreSQL databases under a single AdminDB manager interface:

```ts
import express from 'express';
import { createRouter, DbManager } from 'admindb';

const app = express();

// Initialize manager with multiple named PostgreSQL connections
const manager = new DbManager({
  connections: {
    primary_db: process.env.PRIMARY_DB_URL || 'postgresql://postgres:secret@db1.internal:5432/primary_app',
    analytics_db: process.env.ANALYTICS_DB_URL || 'postgresql://postgres:secret@db2.internal:5432/analytics',
    users_shard: 'postgresql://postgres:secret@db3.internal:5432/users_db',
  },
});

// Optionally register another PostgreSQL connection dynamically at runtime
// (e.g. read-only replica)
manager.addConnection('reporting_replica', 'postgresql://postgres:secret@replica.internal:5432/reporting_db', /* readonly */ true);

// Mount AdminDB manager router
app.use('/admin', createRouter({
  manager,
  basePath: '/admin',
}));

app.listen(45531, () => {
  console.log('Multi-PostgreSQL Admin running on http://localhost:45531/admin');
});
```

---

### Example 4: Mixed Multi-Database Manager (Postgres & SQLite)

```ts
import express from 'express';
import { createRouter, DbManager } from 'admindb';

const app = express();

const manager = new DbManager({
  dir: './data/databases',
  connections: {
    prod_pg: 'postgresql://postgres:secret@db.internal:5432/prod_db',
    analytics_pg: 'postgresql://postgres:secret@analytics.internal:5432/warehouse',
  },
  files: ['./legacy/archive.sqlite'],
});

app.use('/admin', createRouter({
  manager,
  basePath: '/admin',
}));

app.listen(45531);
```

---

### Example 5: Custom Authentication with Salted scrypt Hash

```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

app.use('/admin', createRouter({
  dbPath: './data/app.db',
  basePath: '/admin',
  auth: {
    enabled: true,
    username: 'ops_lead',
    password: 'scrypt:8011bcda719a32dd307cbcbad899e963:854657965139a68b14ffb30f6a64a18d8b10197046e720dbf6e2e26fee2c5dcc2b6a8b8aed514c1a2be7d73279481bf780c4cf381b68eea40d4e2a7b58dd24f8',
    secret: 'my-persistent-session-secret-key-12345',
  },
}));

app.listen(45531);
```

---

### Example 6: Disabling Built-in Auth to Use Custom Express Middleware


```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

// Custom organization authentication middleware
function requireCompanySso(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.headers['x-sso-user']) return next();
  res.status(401).send('SSO Authentication Required');
}

app.use('/admin', requireCompanySso, createRouter({
  dbPath: './data/app.db',
  basePath: '/admin',
  auth: false, // Turn off built-in login form
}));

app.listen(45531);
```

---

# 🚀 Part 3: Infrastructure & Deployment Recipes

---

### Recipe 1: Secure Credentials JSON File

Store your database connections in a JSON file without exposing secrets in your terminal:

#### `name.postgres.json`:
```json
{
  "production": "postgresql://postgres:secret@10.0.0.5:5432/prod_db",
  "analytics": "postgresql://postgres:secret@10.0.0.6:5432/analytics_db",
  "local": "./data/local.db"
}
```

Run:
```bash
npx admindb name.postgres.json
```

---

### Recipe 2: Direct PostgreSQL CLI Connection

```bash
npx admindb postgresql://postgres:password@localhost:5432/my_database
```

Or using environment variable:
```bash
DATABASE_URL="postgresql://postgres:password@localhost:5432/my_database" npx admindb
```

---

### Recipe 3: Multi-Database Folder (Read-Only Auditor)

```bash
admindb -d ./company_dbs --readonly -p 8080 -u auditor -P "secure_pass_123"
```

---

### Recipe 4: Production Docker & Docker Compose Deployment

#### `Dockerfile`
```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN npm install -g admindb
EXPOSE 45531
CMD ["admindb"]
```

#### `docker-compose.yml`
```yaml
version: '3.8'

services:
  admindb:
    image: node:20-alpine
    command: npx admindb
    restart: unless-stopped
    ports:
      - "45531:45531"
    environment:
      - HOST=0.0.0.0
      - PORT=45531
      - DATABASE_URL=postgresql://postgres:secret@db:5432/mydb
      - BASE_PATH=/admin
      - ADMINDB_USERNAME=admin_ops
      - ADMINDB_PASSWORD=scrypt:8011bcda719a32dd307cbcbad899e963:854657965139a68b14ffb30f6a64a18d8b10197046e720dbf6e2e26fee2c5dcc2b6a8b8aed514c1a2be7d73279481bf780c4cf381b68eea40d4e2a7b58dd24f8
      - ADMINDB_SECRET=c28f93e481b0a6e7d95c1a3f5b7e9d2a
      - LOG_LEVEL=info
```

---

### Recipe 5: Nginx Reverse Proxy with Subpath Routing

```nginx
server {
    listen 80;
    server_name db.example.com;

    location /admin/ {
        proxy_pass http://127.0.0.1:45531/admin/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Command:
```bash
BASE_PATH=/admin HOST=127.0.0.1 PORT=45531 DB_DIR=/var/databases admindb
```

---

### Recipe 6: Serverless Deployment (Vercel & AWS Lambda)

In serverless mode, local SQLite databases default to read-only safety, while remote PostgreSQL connections are fully editable.

#### 1. Vercel API Route (`api/index.ts`):
```ts
import { createServerlessHandler } from 'admindb';

export default createServerlessHandler({
  connection: process.env.DATABASE_URL,
  basePath: '/admin',
});
```

#### 2. AWS Lambda with API Gateway (`index.ts`):
```ts
import { createLambdaHandler } from 'admindb';

export const handler = createLambdaHandler({
  connection: process.env.DATABASE_URL,
});
```

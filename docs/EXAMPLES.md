# AdminDB Examples & Configuration Reference

> A comprehensive, organized reference guide for **Environment Variables**, **Programmatic Code Examples (Express & TypeScript)**, and **Deployment Recipes**.

---

## 📑 Table of Contents

- [Overview & Precedence Order](#-overview--precedence-order)
- [Configuration Matrix](#-configuration-matrix)
- [Part 1: Environment Variables Reference](#-part-1-environment-variables-reference)
  - [1. PORT / ADMINDB_PORT](#1-port--admindb_port)
  - [2. HOST / ADMINDB_HOST](#2-host--admindb_host)
  - [3. DB_PATH / ADMINDB_DB_PATH / ADMINDB_PATH](#3-db_path--admindb_db_path--admindb_path)
  - [4. DB_DIR / ADMINDB_DB_DIR / ADMINDB_DIR](#4-db_dir--admindb_db_dir--admindb_dir)
  - [5. DB_FILES / ADMINDB_DB_FILES](#5-db_files--admindb_db_files)
  - [6. BASE_PATH / ADMINDB_BASE_PATH](#6-base_path--admindb_base_path)
  - [7. READONLY / ADMINDB_READONLY](#7-readonly--admindb_readonly)
  - [8. ADMINDB_AUTH / ADMINDB_NO_AUTH / ADMINDB_DISABLE_AUTH](#8-admindb_auth--admindb_no_auth--admindb_disable_auth)
  - [9. ADMINDB_USERNAME / ADMINDB_USER](#9-admindb_username--admindb_user)
  - [10. ADMINDB_PASSWORD / ADMINDB_PASS](#10-admindb_password--admindb_pass)
  - [11. ADMINDB_SECRET / SESSION_SECRET](#11-admindb_secret--session_secret)
  - [12. LOG_LEVEL / ADMINDB_LOG_LEVEL](#12-log_level--admindb_log_level)
- [Part 2: Programmatic Code Examples (Express & TypeScript)](#-part-2-programmatic-code-examples-express--typescript)
  - [`createRouter(options)` Reference](#createrouteroptions-reference)
  - [Example 1: Minimal Single-Database Embedding](#example-1-minimal-single-database-embedding)
  - [Example 2: Custom Subpath & Custom Scoped Logger](#example-2-custom-subpath--custom-scoped-logger)
  - [Example 3: Multi-Database Manager (`DbManager`)](#example-3-multi-database-manager-dbmanager)
  - [Example 4: Custom Authentication with Salted scrypt Hash](#example-4-custom-authentication-with-salted-scrypt-hash)
  - [Example 5: Disabling Built-in Auth to Use Custom Express Middleware](#example-5-disabling-built-in-auth-to-use-custom-express-middleware)
- [Part 3: Infrastructure & Deployment Recipes](#-part-3-infrastructure--deployment-recipes)
  - [Recipe 1: Quick Local CLI Database Inspection](#recipe-1-quick-local-cli-database-inspection)
  - [Recipe 2: Multi-Database Folder (Read-Only Auditor)](#recipe-2-multi-database-folder-read-only-auditor)
  - [Recipe 3: Production Docker Deployment](#recipe-3-production-docker-deployment)
  - [Recipe 4: Nginx Reverse Proxy with Subpath Routing](#recipe-4-nginx-reverse-proxy-with-subpath-routing)
  - [Recipe 5: External Auth Proxy (Cloudflare Zero Trust / Authelia)](#recipe-5-external-auth-proxy-cloudflare-zero-trust--authelia)

---

## ⚡ Overview & Precedence Order

When starting AdminDB standalone:

```text
CLI Arguments & Flags (Highest) ➔ Environment Variables ➔ Default Values (Lowest)
```

- **CLI flags always override environment variables.**
- Every setting can be controlled via CLI flags or environment variables.
- Namespaced variables (`ADMINDB_*`) and standard short variables (`PORT`, `HOST`, `DB_PATH`, etc.) are both fully supported.

---

## 📊 Configuration Matrix

| Feature | CLI Flag & Aliases | Environment Variable & Aliases | Type | Default | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Port** | `-p, --port <port>` | `PORT`, `ADMINDB_PORT` | `number` | `3000` | HTTP port the server listens on |
| **Host** | `-H, --host <host>` | `HOST`, `ADMINDB_HOST` | `string` | `0.0.0.0` | Network interface to bind |
| **Single DB** | `-o, --open, --db-path, --file <file>` | `DB_PATH`, `ADMINDB_DB_PATH`, `ADMINDB_PATH` | `string` | `admindb.db` | Path to a single SQLite database file |
| **Database Directory** | `-d, --dir, --db-dir, --folder <dir>` | `DB_DIR`, `ADMINDB_DB_DIR`, `ADMINDB_DIR` | `string` | — | Folder of `.db`/`.sqlite` files to manage |
| **Explicit DB Files** | `--files, --db-files <list>` | `DB_FILES`, `ADMINDB_DB_FILES` | `string` (CSV) | — | Comma-separated database file paths |
| **Base URL Path** | `-b, --base-path, --base <path>` | `BASE_PATH`, `ADMINDB_BASE_PATH` | `string` | `''` (`/`) | URL prefix to serve under (e.g. `/admin`) |
| **Read-Only Mode** | `-r, --readonly, --read-only` | `READONLY`, `ADMINDB_READONLY` | `boolean` | `false` | Disable all insert, update, delete, and DDL operations |
| **Serverless** | `--serverless` | `SERVERLESS`, `ADMINDB_SERVERLESS` | `boolean` | `false` *(auto)* | Enforces read-only safety for serverless platforms |
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
* **Default:** `3000`
* **Why/When to use it:** Specify the TCP port where the web server should accept connections. Useful when port `3000` is already in use by another service or when deploying to container platforms (e.g. Heroku, Railway, Cloud Run) that assign a dynamic `$PORT`.
* **Configuration Examples:**
  ```bash
  # Bash / Linux / macOS
  PORT=8080 npx admindb
  # or
  ADMINDB_PORT=8080 npx admindb
  ```
  ```powershell
  # PowerShell (Windows)
  $env:PORT="8080"; npx admindb
  ```
  ```env
  # .env file
  PORT=8080
  ```

---

### 2. `HOST` / `ADMINDB_HOST`
* **Type:** `string`
* **Default:** `0.0.0.0`
* **Why/When to use it:** Control which network interfaces the server binds to.
  * Use `127.0.0.1` or `localhost` to restrict access strictly to the local machine (safe for local development).
  * Use `0.0.0.0` to allow access from local networks or Docker port forwarding.
* **Configuration Examples:**
  ```bash
  # Restrict to localhost only
  HOST=127.0.0.1 npx admindb
  ```
  ```env
  # .env file
  HOST=127.0.0.1
  ```

---

### 3. `DB_PATH` / `ADMINDB_DB_PATH` / `ADMINDB_PATH`
* **Type:** `string`
* **Default:** `admindb.db` (in single-database mode)
* **Why/When to use it:** Target a specific SQLite database file directly without displaying the multi-database manager landing page.
* **Configuration Examples:**
  ```bash
  # Bash
  DB_PATH=/var/data/production.sqlite npx admindb
  ```
  ```powershell
  # PowerShell
  $env:DB_PATH="C:\Data\app.db"; npx admindb
  ```
  ```dockerfile
  # Dockerfile
  ENV DB_PATH=/data/app.db
  ```

---

### 4. `DB_DIR` / `ADMINDB_DB_DIR` / `ADMINDB_DIR`
* **Type:** `string`
* **Default:** `undefined`
* **Why/When to use it:** Start AdminDB in **Manager Mode** pointing at a folder of databases. All `.db`, `.sqlite`, and `.sqlite3` files in that folder will be automatically scanned, listed, and manageable. The in-browser filesystem browser will be sandboxed to this folder.
* **Configuration Examples:**
  ```bash
  # Bash
  DB_DIR=./databases npx admindb
  ```
  ```powershell
  # PowerShell
  $env:DB_DIR="./databases"; npx admindb
  ```
  ```yaml
  # docker-compose.yml
  environment:
    - DB_DIR=/databases
  volumes:
    - ./my-sqlite-files:/databases
  ```

---

### 5. `DB_FILES` / `ADMINDB_DB_FILES`
* **Type:** `string` (comma-separated file list)
* **Default:** `undefined`
* **Why/When to use it:** Specify an exact, explicit set of database files located anywhere on disk. When `DB_FILES` is provided without `DB_DIR`, file browsing is automatically disabled for security, presenting only the configured files.
* **Configuration Examples:**
  ```bash
  # Bash
  DB_FILES="/var/db/users.db,/var/db/analytics.sqlite,/tmp/cache.db" npx admindb
  ```
  ```env
  # .env file
  DB_FILES=/data/primary.db,/data/secondary.db
  ```

---

### 6. `BASE_PATH` / `ADMINDB_BASE_PATH`
* **Type:** `string`
* **Default:** `''` (`/`)
* **Why/When to use it:** Serve the AdminDB UI and API under a URL subpath prefix (e.g. `http://localhost:3000/admin`). Essential when hosting AdminDB behind a reverse proxy (Nginx, Traefik, Caddy) or mounting it into an existing URL hierarchy.
* **Configuration Examples:**
  ```bash
  # Access UI at http://localhost:3000/admin
  BASE_PATH=/admin npx admindb
  ```
  ```env
  # .env file
  BASE_PATH=/tools/sqlite
  ```

---

### 7. `READONLY` / `ADMINDB_READONLY`
* **Type:** `boolean` (`1`, `true`, `yes`, `on`)
* **Default:** `false`
* **Why/When to use it:** Open databases in **Strict Read-Only Mode**.
  * Disables all write controls in the UI (no insert, update, delete, drop, seed, or create).
  * Executes SQLite statements with `PRAGMA query_only = ON` and opens files with `SQLITE_OPEN_READONLY`.
  * Every mutation API endpoint returns `403 Forbidden`.
  * Ideal for production auditing, reporting, and read-only developer dashboards.
* **Configuration Examples:**
  ```bash
  # Bash
  READONLY=1 npx admindb
  # or
  ADMINDB_READONLY=true npx admindb
  ```
  ```powershell
  # PowerShell
  $env:READONLY="true"; npx admindb
  ```

---

### 8. `ADMINDB_AUTH` / `ADMINDB_NO_AUTH` / `ADMINDB_DISABLE_AUTH`
* **Type:** `boolean`
* **Default:** `true` (auth enabled)
* **Why/When to use it:** Enable or disable built-in native authentication.
  * Set `ADMINDB_AUTH=false` or `ADMINDB_NO_AUTH=1` when you are securing AdminDB with external infrastructure (e.g. Cloudflare Zero Trust, OAuth2 Proxy, Authelia, VPN, basic auth reverse proxy) and want to skip the built-in login screen.
* **Configuration Examples:**
  ```bash
  # Disable authentication
  ADMINDB_AUTH=false npx admindb
  # or
  ADMINDB_NO_AUTH=1 npx admindb
  ```
  ```yaml
  # docker-compose.yml
  environment:
    - ADMINDB_AUTH=false
  ```

---

### 9. `ADMINDB_USERNAME` / `ADMINDB_USER`
* **Type:** `string`
* **Default:** `admin`
* **Why/When to use it:** Change the administrator username required to log into the web interface or make authenticated API requests.
* **Configuration Examples:**
  ```bash
  # Bash
  ADMINDB_USERNAME=superadmin npx admindb
  ```
  ```env
  # .env file
  ADMINDB_USERNAME=ops_team
  ```

---

### 10. `ADMINDB_PASSWORD` / `ADMINDB_PASS`
* **Type:** `string` (Plain text or salted cryptographic `scrypt` hash)
* **Default:** `admin` *(stored as a secure salted hash)*
* **Why/When to use it:** Secure your AdminDB instance with a custom password. You can supply either a plain text password or a cryptographic hash generated by `npm run generatehash`.
* **Generating a Hash:**
  ```bash
  npm run generatehash
  # Output: scrypt:3f8e02d9a1c4b7e8...:cb3032b16f29c8d44f75...
  ```
* **Configuration Examples:**
  ```bash
  # Using generated secure hash (Recommended)
  export ADMINDB_PASSWORD="scrypt:3f8e02d9a1c4b7e8...:cb3032b16f29c8d44f75..."
  npx admindb

  # Or passing plain text
  ADMINDB_PASSWORD="MyStrongSecretPassword!123" npx admindb
  ```

---

### 11. `ADMINDB_SECRET` / `SESSION_SECRET`
* **Type:** `string`
* **Default:** Auto-generated randomly per process instance
* **Why/When to use it:** Fixed secret key used to sign HTTP session cookies (`HMAC-SHA256`). Setting a persistent secret ensures user login sessions survive process restarts and works reliably across load-balanced instances.
* **Configuration Examples:**
  ```bash
  ADMINDB_SECRET="a7f8e92c4b1d6e3f8a0b5c7d9e1f2a3b4c5d6e7f8" npx admindb
  ```
  ```env
  # .env file
  ADMINDB_SECRET=6c4e0b57e7df92a5b6c98114620f48da
  ```

---

### 12. `LOG_LEVEL` / `ADMINDB_LOG_LEVEL`
* **Type:** `enum`: `debug` | `info` | `warn` | `error`
* **Default:** `info`
* **Why/When to use it:** Control log output verbosity in the terminal.
  * `debug`: Verbose diagnostics.
  * `info`: Standard operational logs (server start, database open/close).
  * `warn`: Warnings (default password alerts, skipped missing files).
  * `error`: Only fatal errors and query exceptions.
* **Configuration Examples:**
  ```bash
  LOG_LEVEL=warn npx admindb
  ```
  ```env
  # .env file
  LOG_LEVEL=error
  ```

---

# 💻 Part 2: Programmatic Code Examples (Express & TypeScript)

AdminDB can be mounted directly into any existing Express application as a sub-router on the same port.

---

### `createRouter(options)` Reference

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `dbPath` | `string` | `'admindb.db'` | Path to a single SQLite database file (single-db mode). |
| `db` | `SqliteDatabase` | — | An already-opened `SqliteDatabase` instance (advanced programmatic use). |
| `manager` | `DbManager` | — | Enables multi-database management across folders/files. |
| `basePath` | `string` | `''` | URL prefix used by templates and static assets (e.g. `/admin`). Pass the same path you mount at. |
| `readonly` | `boolean` | `false` | Open databases in strict read-only mode (`SQLITE_OPEN_READONLY` + `PRAGMA query_only`). |
| `auth` | `boolean \| AuthConfig` | `true` | Configure built-in authentication or pass `false` to disable it. |
| `logger` | `Logger` | — | Custom logger instance (see `createLogger`). |
| `logLevel` | `'debug'\|'info'\|'warn'\|'error'` | `'info'` | Logging verbosity when no custom logger is provided. |
| `allowBrowse` | `boolean` | `true` | Manager mode: show the in-browser filesystem browser. |
| `browseRoot` | `string` | — | Manager mode: restrict the file browser strictly to this directory. |

---

### Example 1: Minimal Single-Database Embedding

Mount AdminDB under `/admin` on the same port as your main application:

```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

app.get('/', (_req, res) => res.send('Main App Homepage'));

// Mount AdminDB under /admin
app.use('/admin', createRouter({
  dbPath: './data/app.db',
  basePath: '/admin',
}));

app.listen(3000, () => {
  console.log('App running on http://localhost:3000 (Admin: http://localhost:3000/admin)');
});
```

---

### Example 2: Custom Subpath & Custom Scoped Logger

Configure custom logging and mount under a custom dashboard prefix:

```ts
import express from 'express';
import { createRouter, createLogger } from 'admindb';

const app = express();

const logger = createLogger('debug', 'custom-admin');

app.use('/tools/sqlite', createRouter({
  dbPath: './data/production.db',
  basePath: '/tools/sqlite',
  logger,
  readonly: true, // Read-only dashboard
}));

app.listen(3000);
```

---

### Example 3: Multi-Database Manager (`DbManager`)

Scan a directory of SQLite files and include specific legacy files:

```ts
import express from 'express';
import { createRouter, DbManager, createLogger } from 'admindb';

const app = express();

const manager = new DbManager({
  dir: './data/tenants',                           // Scans folder for .db / .sqlite files
  files: ['/var/legacy/app.db', './shared.sqlite'], // Explicit paths
  readonly: false,
});

app.use('/admin', createRouter({
  manager,
  basePath: '/admin',
  logger: createLogger('info'),
}));

app.listen(3000);
```

---

### Example 4: Custom Authentication with Salted scrypt Hash

Protect your embedded AdminDB instance with a custom salted password hash and session secret:

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
    secret: process.env.SESSION_SECRET || 'strong_production_secret_key_123',
    sessionDurationMs: 1000 * 60 * 60 * 24, // 24 hours
  },
}));

app.listen(3000);
```

---

### Example 5: Disabling Built-in Auth to Use Custom Express Middleware

Attach your own authentication middleware before AdminDB:

```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

// Custom authentication middleware (e.g. Passport, JWT, OAuth2 session)
function requireAdminRole(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).send('Forbidden: Admin access required');
}

app.use('/admin', requireAdminRole, createRouter({
  dbPath: './data/app.db',
  basePath: '/admin',
  auth: false, // Disables built-in login barrier
}));

app.listen(3000);
```

---

# 🚀 Part 3: Infrastructure & Deployment Recipes

Production-ready configuration recipes for containers, proxies, and standalone deployments.

---

### Recipe 1: Quick Local CLI Database Inspection
Inspect and edit a local database without installing anything:

```bash
npx admindb ./data/app.db
```

---

### Recipe 2: Multi-Database Folder (Read-Only Auditor)
Expose a folder of SQLite files for read-only reporting on port `8080`:

```bash
admindb -d ./company_dbs --readonly -p 8080 -u auditor -P "secure_pass_123"
```

Or using environment variables:

```bash
export DB_DIR="./company_dbs"
export READONLY="true"
export PORT="8080"
export ADMINDB_USERNAME="auditor"
export ADMINDB_PASSWORD="secure_pass_123"

npx admindb
```

---

### Recipe 3: Production Docker Deployment
Deploy AdminDB in a Docker container behind an authenticated reverse proxy:

#### `Dockerfile`
```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN npm install -g admindb
EXPOSE 3000
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
      - "3000:3000"
    environment:
      - HOST=0.0.0.0
      - PORT=3000
      - DB_DIR=/data
      - BASE_PATH=/admin
      - ADMINDB_USERNAME=admin_ops
      - ADMINDB_PASSWORD=scrypt:8011bcda719a32dd307cbcbad899e963:854657965139a68b14ffb30f6a64a18d8b10197046e720dbf6e2e26fee2c5dcc2b6a8b8aed514c1a2be7d73279481bf780c4cf381b68eea40d4e2a7b58dd24f8
      - ADMINDB_SECRET=c28f93e481b0a6e7d95c1a3f5b7e9d2a
      - LOG_LEVEL=info
    volumes:
      - ./sqlite-data:/data
```

---

### Recipe 4: Nginx Reverse Proxy with Subpath Routing

#### Nginx Configuration:
```nginx
server {
    listen 80;
    server_name db.example.com;

    location /admin/ {
        proxy_pass http://127.0.0.1:3000/admin/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

#### AdminDB Command:
```bash
BASE_PATH=/admin HOST=127.0.0.1 PORT=3000 DB_DIR=/var/databases admindb
```

---

### Recipe 5: External Auth Proxy (Cloudflare Zero Trust / Authelia)
When using an external authentication proxy:

```bash
admindb -d ./databases --no-auth -H 127.0.0.1 -p 3000
```

Or via environment variables:

```bash
ADMINDB_AUTH=false HOST=127.0.0.1 DB_DIR=./databases npx admindb
```

---

### Recipe 6: Serverless Deployment (Vercel, AWS Lambda & Cloud Functions)

When deploying to ephemeral, read-only serverless environments, AdminDB automatically activates **Serverless Read-Only Mode**, protecting bundled SQLite database files from corrupted or dropped writes.

#### 1. Vercel API Route (`api/index.ts`):
```ts
import { createServerlessHandler } from 'admindb';

export default createServerlessHandler({
  dbPath: './data/production.db',
  basePath: '/admin',
});
```

#### 2. AWS Lambda with API Gateway (`index.ts`):
```ts
import { createLambdaHandler } from 'admindb';

export const handler = createLambdaHandler({
  dbPath: './data/production.db',
  auth: {
    username: process.env.ADMINDB_USERNAME || 'admin',
    password: process.env.ADMINDB_PASSWORD,
    secret: process.env.ADMINDB_SECRET,
  },
});
```

#### 3. CLI Serverless Flag:
```bash
admindb ./data/app.db --serverless
```

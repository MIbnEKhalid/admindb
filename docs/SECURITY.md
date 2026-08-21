# AdminDB Security & Authentication Guide

> Detailed guide to AdminDB's security architecture, native authentication system, cryptographic password hashing, production deployment best practices, and SQL execution safeguards.

---

## 📑 Table of Contents

- [Security Overview](#security-overview)
- [Native Authentication System](#native-authentication-system)
  - [Default Credentials](#default-credentials)
  - [Password Hashing with `npm run generatehash`](#password-hashing-with-npm-run-generatehash)
  - [Setting Credentials](#setting-credentials)
  - [Session Tokens & Cookie Security](#session-tokens--cookie-security)
- [Disabling Native Authentication](#disabling-native-authentication)
- [Supported Authentication Methods](#supported-authentication-methods)
- [Production Security Checklist & Best Practices](#production-security-checklist--best-practices)
- [SQL Safety & Injection Protections](#sql-safety--injection-protections)
- [Read-Only Mode Safeguards](#read-only-mode-safeguards)
- [Universal Destructive Action Safeguards](#universal-destructive-action-safeguards)

---

## Security Overview

AdminDB provides direct administrative access to your SQLite databases and underlying filesystem. Because administrative tools possess powerful query and modification capabilities, robust access controls are essential.

AdminDB provides:
1. **Built-in Native Authentication:** Enabled by default with constant-time verification, salted cryptographic `scrypt` hashing, and `HMAC-SHA256` signed HTTP-only session cookies.
2. **External Gateway Flexibility:** Can be completely disabled (`auth: false` / `--no-auth` / `ADMINDB_AUTH=false`) when deployed behind corporate SSO, reverse proxy gateways, or custom Express middleware.
3. **Strict Read-Only Enforcement:** Deep database engine guards (`SQLITE_OPEN_READONLY` + `PRAGMA query_only = ON`) that guarantee no write operations can occur.
4. **SQL Safety by Construction:** Comprehensive identifier quoting and literal value escaping across all schema and query generators.

---

## Native Authentication System

### Default Credentials

Out of the box, AdminDB includes default credentials to ensure the service is never accidentally started unprotected:

* **Default Username:** `admin`
* **Default Password:** `admin` *(stored internally via a salted `scrypt` hash)*

> ⚠️ **Default Password Notice:**
> When running with default credentials, AdminDB displays a warning in the terminal on startup and an alert badge in the web navigation bar reminding you to configure custom credentials.

---

### Password Hashing with `npm run generatehash`

AdminDB uses Node.js's built-in cryptographic `scrypt` algorithm with a unique 16-byte random salt per hash. To generate a secure hash for your custom password:

```bash
npm run generatehash
```

The interactive script prompts:
```text
Enter password to hash: [your-strong-password]
```

And outputs a formatted hash:
```text
⚡ AdminDB Password Hash Generated

➜  Hash: scrypt:8011bcda719a32dd307cbcbad899e963:854657965139a68b14ffb30f6a64a18d8b10197046e720dbf6e2e26fee2c5dcc2b6a8b8aed514c1a2be7d73279481bf780c4cf381b68eea40d4e2a7b58dd24f8
```

You can also pass the password as a command-line argument:
```bash
node scripts/generate-hash.mjs "my_strong_password_123"
```

---

### Setting Credentials

You can supply the generated hash (or a plain-text password) through any of the following methods:

#### 1. Environment Variables (`.env`)
```bash
export ADMINDB_USERNAME="ops_admin"
export ADMINDB_PASSWORD="scrypt:8011bcda719a32dd307cbcbad899e963:854657965139a68b14ffb30f6a64a18d8b10197046e720dbf6e2e26fee2c5dcc2b6a8b8aed514c1a2be7d73279481bf780c4cf381b68eea40d4e2a7b58dd24f8"
export ADMINDB_SECRET="a7f8e92c4b1d6e3f8a0b5c7d9e1f2a3b4c5d6e7f8"

npx admindb
```

#### 2. CLI Flags
```bash
admindb -u ops_admin -P "scrypt:8011bcda719a32dd307cbcbad899e963:854657965139a68b14ffb30f6a64a18d8b10197046e720dbf6e2e26fee2c5dcc2b6a8b8aed514c1a2be7d73279481bf780c4cf381b68eea40d4e2a7b58dd24f8"
```

#### 3. Express Embedding (`createRouter`)
```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

app.use('/admin', createRouter({
  dbPath: './data/app.db',
  basePath: '/admin',
  auth: {
    enabled: true,
    username: 'ops_admin',
    password: 'scrypt:8011bcda719a32dd307cbcbad899e963:854657965139a68b14ffb30f6a64a18d8b10197046e720dbf6e2e26fee2c5dcc2b6a8b8aed514c1a2be7d73279481bf780c4cf381b68eea40d4e2a7b58dd24f8',
    secret: process.env.ADMINDB_SECRET || 'your_secret_key_here',
    sessionDurationMs: 1000 * 60 * 60 * 24, // 24 hours
  },
}));

app.listen(3000);
```

---

### Session Tokens & Cookie Security

When a user logs in through the web UI:
1. **Token Generation:** A cryptographic timestamped token is created and signed using `HMAC-SHA256` with your configured `ADMINDB_SECRET`.
2. **Cookie Flags:** The session cookie (`admindb_session`) is set with:
   - `HttpOnly: true` (prevents JavaScript access & XSS token theft)
   - `SameSite: Lax` (protects against Cross-Site Request Forgery)
   - `Path: /` (or your configured `basePath`)
3. **Constant-Time Verification:** Password matching and token signature verification use constant-time comparisons (`crypto.timingSafeEqual`) to protect against timing attacks.

---

## Disabling Native Authentication

If you are placing AdminDB behind an external authentication layer (e.g. Cloudflare Access, Authelia, OAuth2 Proxy, Keycloak, or custom Express middleware), disable the native login screen:

#### 1. CLI Flag
```bash
admindb --no-auth
```

#### 2. Environment Variables
```bash
ADMINDB_AUTH=false npx admindb
# or
ADMINDB_NO_AUTH=1 npx admindb
```

#### 3. Express Options
```ts
app.use('/admin', myAuthMiddleware, createRouter({
  dbPath: './data/app.db',
  auth: false, // Disables built-in auth completely
}));
```

---

## Supported Authentication Methods

All AdminDB API endpoints and UI pages accept:

| Method | Header / Cookie Syntax | Use Case |
| :--- | :--- | :--- |
| **Session Cookie** | `Cookie: admindb_session=<token>` | Standard browser UI sessions |
| **HTTP Basic Auth** | `Authorization: Basic <base64(username:password)>` | Scripts, CI/CD pipelines, curl commands |
| **Bearer Token** | `Authorization: Bearer <sessionToken>` | Single-Page Apps, API integrations |

Example using `curl` with HTTP Basic Auth:
```bash
curl -u "admin:admin" http://localhost:3000/api/tables
```

---

## Production Security Checklist & Best Practices

When deploying AdminDB to production or shared networks:

- [ ] **Change the Default Password:** Never run with default `admin/admin` credentials in production.
- [ ] **Set a Fixed `ADMINDB_SECRET`:** Configure a persistent secret so user sessions remain valid across container restarts.
- [ ] **Bind to Localhost or Private Interface:** Set `HOST=127.0.0.1` unless external network access is explicitly intended.
- [ ] **Use HTTPS / TLS Termination:** Place AdminDB behind an SSL-terminating reverse proxy (Nginx, Caddy, Cloudflare, Traefik).
- [ ] **Apply Read-Only Mode for Audits:** Use `--readonly` (`READONLY=true`) for reporting dashboards or developer access to prevent accidental mutations.
- [ ] **Restrict Directory Browsing:** In manager mode, pass `-d /path/to/folder` to constrain file browsing strictly to that folder (`browseRoot`), preventing parent directory traversal.

---

## SQL Safety & Injection Protections

AdminDB enforces SQL safety through several architectural safeguards:

1. **Quoting and Escaping:** Every identifier (table names, column names, index names) is quoted with standard double quotes (`"identifier"`), and every user string literal is escaped properly.
2. **Parameterized Bindings:** Core CRUD query endpoints (`getRows`, `insertRows`, `updateRows`, `deleteRows`) use SQLite parameter bindings (`?`), never raw string interpolation.
3. **Safe Preview Modes:** "Get query" and preview endpoints only generate and return SQL strings for the user to review — they never touch the database engine.
4. **Internal Table Protection:** Internal state tables (such as `_saved_queries`) are protected from being dropped, renamed, or exposed in foreign-key pickers.

---

## Read-Only Mode Safeguards

When read-only mode is active (`--readonly` / `READONLY=true` / `readonly: true`):

* The underlying SQLite file is opened with `SQLITE_OPEN_READONLY`.
* SQLite engine execution runs `PRAGMA query_only = ON`.
* Every mutation REST API endpoint (`POST`, `PUT`, `DELETE`) immediately returns `403 Forbidden`.
* The web interface disables and hides all write buttons, insert forms, delete triggers, schema alter forms, seed generators, and CSV import tools.
* A prominent warning banner is displayed across the interface alerting users that writes are disabled.

---

## Universal Destructive Action Safeguards

AdminDB strictly enforces a **zero-unprompted-destruction** policy across the web interface to prevent accidental data loss:

1. **Interactive Confirmation Barriers (`UI.confirm`):**
   - **Single Row Deletions:** Always prompts with row primary key preview and impact warnings.
   - **Bulk Row Purges:** Performs a pre-flight foreign key check via `/api/tables/:table/rows/bulk-impact` and displays a breakdown of child records referencing the target rows before confirmation.
   - **Discarding Staged Edits:** Warns user of the exact count of pending cell modifications before reverting.
   - **Schema Alterations:** Dropping columns or indexes prompts with confirmation of affected fields.
2. **Type-to-Confirm Input Verification:**
   - **Dropping Tables:** Requires typing the exact table name into an input field before the destructive action button enables.
   - **Deleting Databases (Manager Mode):** Requires typing the exact database identifier before disk deletion is authorized.
3. **Transactional Isolation:**
   - All batch operations (bulk updates, bulk deletions, CSV imports, and seed data generation) run inside dedicated atomic database transactions (`BEGIN IMMEDIATE ... COMMIT/ROLLBACK`). If any record fails or violates constraints, the entire batch automatically rolls back with zero partial corruption.

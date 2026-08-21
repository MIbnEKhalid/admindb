# AdminDB Security, Authentication & Protection Guide

> Comprehensive guide to AdminDB's security architecture, shared responsibility model, native authentication system, filesystem browsing sandboxing, remote PostgreSQL protection, and production deployment safeguards.

---

## 📑 Table of Contents

- [🛡️ Security Responsibility Model (Crucial)](#️-security-responsibility-model-crucial)
- [Native Authentication System](#native-authentication-system)
  - [Default Credentials & Alerts](#default-credentials--alerts)
  - [Cryptographic Password Hashing (`npm run generatehash`)](#cryptographic-password-hashing-npm-run-generatehash)
  - [Configuring Credentials](#configuring-credentials)
  - [Session Tokens & Cookie Security](#session-tokens--cookie-security)
- [Protecting AdminDB with Your Own Application Auth](#protecting-admindb-with-your-own-application-auth)
  - [Custom Express Middleware (Recommended for Production)](#custom-express-middleware-recommended-for-production)
  - [Reverse Proxy & Gateway Protection (Nginx, Caddy, Cloudflare Zero Trust)](#reverse-proxy--gateway-protection-nginx-caddy-cloudflare-zero-trust)
- [Manager Mode & Filesystem Browsing Security](#manager-mode--filesystem-browsing-security)
  - [Path Sandboxing (`browseRoot`) & Traversal Prevention](#path-sandboxing-browseroot--traversal-prevention)
  - [Blocked Files & Secret Exclusion](#blocked-files--secret-exclusion)
  - [Disabling File Browsing Completely](#disabling-file-browsing-completely)
- [Remote PostgreSQL Security](#remote-postgresql-security)
  - [Credential Masking & Memory Sanitation](#credential-masking--memory-sanitation)
  - [Secure JSON Configuration Files (`name.postgres.json`)](#secure-json-configuration-files-namepostgresjson)
  - [Per-Database Read-Only Enforcements](#per-database-read-only-enforcements)
- [Production Security Checklist](#production-security-checklist)
- [SQL Safety & Injection Protections](#sql-safety--injection-protections)
- [Universal Destructive Action Safeguards](#universal-destructive-action-safeguards)

---

## 🛡️ Security Responsibility Model (Crucial)

> [!WARNING]
> **IMPORTANT: Native Authentication is Basic Security.**
> AdminDB's built-in single-user login screen and HTTP basic authentication are intended as **convenience access controls** for local development, trusted private intranets, or single-operator setups.
> 
> **It is the user's sole responsibility to fully protect AdminDB** when exposing it to untrusted networks, shared environments, or the public internet.

For production or team usage, you should **always**:
1. **Wrap AdminDB with your application's own authentication**: If embedding via Express/Node.js (`createRouter`), apply your organization's robust authentication middleware (e.g. NextAuth, Passport.js, OAuth2/OIDC, JWT verification, or session guards) before the AdminDB router, and disable native auth (`auth: false`).
2. **Place behind a secure reverse proxy or VPN**: Terminate TLS/HTTPS and enforce IP allowlisting, Cloudflare Zero Trust / Cloudflare Access, AWS Cognito, or Tailscale/WireGuard.
3. **Use granular database credentials**: Create dedicated database users with least-privilege permissions instead of root `postgres` superuser accounts.

---

## Native Authentication System

### Default Credentials & Alerts

Out of the box, AdminDB includes default credentials to ensure a newly launched server is never exposed completely open:

* **Default Username:** `admin`
* **Default Password:** `admin` *(stored internally via a salted `scrypt` hash)*

> [!CAUTION]
> When running with default credentials, AdminDB displays a prominent warning in your terminal on startup and an alert badge in the web UI. Always generate a custom password for anything beyond local testing.

---

### Cryptographic Password Hashing (`npm run generatehash`)

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

### Configuring Credentials

You can supply the generated hash (or plain-text password) through any of the following methods:

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

#### 3. JSON Configuration File (`name.postgres.json`)
```json
{
  "production": "postgresql://postgres:secret@localhost:5432/mydb",
  "auth": {
    "username": "ops_admin",
    "password": "scrypt:8011bcda719a32dd307cbcbad899e963:854657965139a68b14ffb30f6a64a18d8b10197046e720dbf6e2e26fee2c5dcc2b6a8b8aed514c1a2be7d73279481bf780c4cf381b68eea40d4e2a7b58dd24f8"
  }
}
```

---

### Session Tokens & Cookie Security

When a user logs in through the web UI:
1. **Token Generation:** A cryptographic timestamped token is created and signed using `HMAC-SHA256` with your configured `ADMINDB_SECRET`.
2. **Cookie Security Flags:** The session cookie (`admindb_session`) is set with:
   - `HttpOnly: true` (prevents client JavaScript access & XSS token theft)
   - `SameSite: Lax` (protects against Cross-Site Request Forgery)
   - `Path: /` (or your configured `basePath`)
3. **Constant-Time Verification:** Password matching and token signature verification use constant-time comparisons (`crypto.timingSafeEqual`) to protect against timing attacks.

---

## Protecting AdminDB with Your Own Application Auth

### Custom Express Middleware (Recommended for Production)

When embedding AdminDB in an existing Express / Next.js backend, turn off built-in auth (`auth: false`) and apply your existing session or JWT middleware:

```ts
import express from 'express';
import { createRouter } from 'admindb';

const app = express();

// Your enterprise authentication middleware
function requireAdminRole(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.user && req.user.role === 'SUPERADMIN') {
    return next();
  }
  res.status(403).send('Forbidden: AdminDB requires SUPERADMIN privileges');
}

app.use('/admin', requireAdminRole, createRouter({
  connection: process.env.DATABASE_URL,
  basePath: '/admin',
  auth: false, // Turn off built-in login form; rely on requireAdminRole
}));

app.listen(45531);
```

---

### Reverse Proxy & Gateway Protection (Nginx, Caddy, Cloudflare Zero Trust)

If running AdminDB standalone (`npx admindb`), bind to localhost (`HOST=127.0.0.1`) and put a reverse proxy in front:

```nginx
# Nginx reverse proxy with IP allowlist and HTTPS termination
server {
    listen 443 ssl http2;
    server_name db.yourcompany.internal;

    ssl_certificate /etc/ssl/certs/app.crt;
    ssl_certificate_key /etc/ssl/certs/app.key;

    # Restrict to VPN / Office IP range
    allow 10.0.0.0/8;
    allow 192.168.1.0/24;
    deny all;

    location / {
        proxy_pass http://127.0.0.1:45531;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Manager Mode & Filesystem Browsing Security

In Manager Mode, AdminDB provides an interactive filesystem browser to locate and open SQLite databases on the host. Several defensive measures protect host integrity:

### Path Sandboxing (`browseRoot`) & Traversal Prevention
- **Sandboxed Root (`browseRoot` / `-d <folder>`):** When started with a specific directory or `--browse-root`, browsing is strictly jailed to that folder. Any attempt to navigate upward returns `403 Forbidden`.
- **Symlink Escape Protection:** All path validations resolve real filesystem symlinks (`realpathSync`), preventing symlink-based jailbreaks.
- **Null-Byte Injection Blocking:** All inputs containing `\0` null-bytes are rejected immediately.

### Blocked Files & Secret Exclusion
The file browser automatically ignores and conceals sensitive system folders and secrets:
- Directories: `node_modules`, `.git`, `.svn`, `.hg`, `.aws`, `.ssh`, `System Volume Information`, `$RECYCLE.BIN`.
- Secret Files: Hidden dotfiles (`.*`), `.env`, `.env.local`, `.env.production`.
- File Filter: Only recognized database files (`.db`, `.sqlite`, `.sqlite3`) are displayed for opening.

### Disabling File Browsing Completely
When AdminDB is started with explicit database files (`--files`, `name.postgres.json`) or in serverless environments, **filesystem browsing is automatically disabled** (`allowBrowse: false`), eliminating any directory traversal attack surface.

---

## Remote PostgreSQL Security

### Credential Masking & Memory Sanitation
- When PostgreSQL connection URIs (`postgresql://user:password@host:5432/db`) are registered, credentials are sanitised across the UI, responses, and log messages (`postgresql://user:****@host:5432/db`).
- Passwords are encrypted in-memory and are never leaked to client browsers.

### Secure JSON Configuration Files (`name.postgres.json`)
To avoid leaking passwords in shell history or process tables (`ps aux`), store database connections in a restricted JSON file:

```json
{
  "production": "postgresql://postgres:secret@prod.internal:5432/prod_db",
  "analytics": "postgresql://postgres:secret@analytics.internal:5432/dw_db"
}
```

And start AdminDB using the file:
```bash
npx admindb name.postgres.json
```

### Per-Database Read-Only Enforcements
- AdminDB allows marking any PostgreSQL or SQLite database as **Read-only** directly from the UI or configuration (`[ ] Open as Read-only`).
- In read-only mode, all write statements (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`) and data-mutating APIs are blocked at the engine layer.

---

## Production Security Checklist

- [ ] **Custom Credentials:** Replaced default `admin/admin` with a salted `scrypt` hash (`npm run generatehash`).
- [ ] **Fixed Session Secret:** Configured `ADMINDB_SECRET` to prevent session invalidation on restart.
- [ ] **Private Interface:** Bound to `HOST=127.0.0.1` or private subnet.
- [ ] **HTTPS / TLS:** Terminated SSL via reverse proxy or load balancer.
- [ ] **Custom Auth Wrapper:** Placed behind application auth middleware when embedded in Express.
- [ ] **Least Privilege DB Users:** Connected PostgreSQL using dedicated user roles with appropriate table grants.
- [ ] **Read-Only Where Applicable:** Enabled `--readonly` for auditing and data-viewer personas.
- [ ] **Jailed Browsing:** Specified `-d /path/to/dbs` or disabled browsing with explicit files.

---

## SQL Safety & Injection Protections

1. **Identifier Quoting:** Identifiers (table names, columns, indexes) are safely double-quoted (`"table_name"`).
2. **Parameterized Queries:** Queries use native driver parameter placeholders (`?` for SQLite, `$1, $2, ...` for PostgreSQL).
3. **Safe Preview Modes:** Preview endpoints return raw generated SQL strings for visual inspection without executing against the database.
4. **Internal Table Protection:** Internal AdminDB state tables (`_saved_queries`) are protected from being dropped, renamed, or mutated.

---

## Universal Destructive Action Safeguards

1. **Interactive Confirmation Barriers (`UI.confirm`):** Prompts with primary key details and impact assessments before single/bulk deletions.
2. **Type-to-Confirm Input Verification:** Dropping tables and deleting database files requires typing the exact name of the item.
3. **Transactional Isolation:** Bulk operations and CSV imports run in atomic transactions (`BEGIN ... COMMIT/ROLLBACK`), ensuring zero partial corruption on errors.

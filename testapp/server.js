/**
 * testapp/server.js
 *
 * Real-world integration test for admindb.
 * Imports from the BUILT package (../dist/index.js) — not source.
 *
 * Usage:
 *   cd testapp
 *   npm install
 *   node seed-data.js   # (optional) populate test data
 *   npm start           # or: npm run dev   (auto-restarts on file change)
 *
 * Then open: http://localhost:4000/admin
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Import admindb ────────────────────────────────────────────────────────────
import { createRouter, createLogger } from '../dist/index.js';

// ESM replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config ───────────────────────────────────────────────────────────────────
const PORT      = process.env.PORT || 4000;
const BASE_PATH = '/admin';
const DB_FILE   = path.join(__dirname, 'testapp.db');

// ── Logger (optional — admindb will create one internally if omitted) ─────────
const logger = createLogger({ level: 'info', prefix: 'testapp' });

// ── Create the host Express app ───────────────────────────────────────────────
const app = express();

// Example: a simple landing page at the root so you can see the host app
app.get('/', (_req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/\{\{BASE_PATH\}\}/g, BASE_PATH);
  html = html.replace(/\{\{DB_FILE\}\}/g, DB_FILE);
  html = html.replace(/\{\{PORT\}\}/g, PORT);
  res.send(html);
});

// ── Mount admindb ─────────────────────────────────────────────────────────────
const adminRouter = createRouter({
  // --- REQUIRED OR COMMON OPTIONS ---
  dbPath:   DB_FILE,         // Path to SQLite file (if using SQLite)
  basePath: BASE_PATH,       // Prefix for all routes/assets (e.g. '/admin')
  
  // --- AUTHENTICATION ---
  // auth: true,             // Enable default authentication (requires env vars)
  // auth: { username: 'admin', password: 'password', secret: 'xyz' },
  auth: false,               // Disable auth entirely for dev mode
  
  // --- POSTGRESQL ALTERNATIVE ---
  // connection: 'postgresql://user:pass@localhost:5432/mydb', // PG connection string
  // pgOptions: { ssl: false },                                // Additional PG config

  // --- LOGGING ---
  logger,                    // Custom logger instance (or omit to use default console)
  // logLevel: 'info',       // 'debug' | 'info' | 'warn' | 'error' | 'silent'
  
  // --- MULTI-TENANCY / DIRECTORY BROWSING ---
  // manager: new DbManager({ directory: './dbs' }), // Serve multiple DBs from a folder
  // allowBrowse: true,      // Show file browser on landing page (multi-db mode only)
  // browseRoot: __dirname,  // Restrict directory traversal to this folder
  
  // --- BEHAVIOR CONTROLS ---
  // readonly: false,        // If true, disables all writes/mutations returning 403
  // serverless: false,      // Strict read-only mode, disables schema/mutations
  
  // --- INTERNAL PRE-INITIALIZED INSTANCES ---
  // db: myExistingDatabaseInstance, // Inject an already open Database adapter instance
});

app.use(BASE_PATH, adminRouter);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅ AdminDB testapp running');
  console.log(`     Host app : http://localhost:${PORT}`);
  console.log(`     AdminDB  : http://localhost:${PORT}${BASE_PATH}`);
  console.log(`     DB file  : ${DB_FILE}`);
  console.log('');
  console.log('  Tip: run `node seed-data.js` first to populate test tables.');
  console.log('');
});

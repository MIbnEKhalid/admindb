import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import Database from 'better-sqlite3';
import { createRouter } from '../dist/app.js';
import { SqliteDatabase } from '../dist/db/database.js';
import { DbManager } from '../dist/db/manager.js';
import { createLogger } from '../dist/utils/logger.js';

// Locate Chrome or Microsoft Edge browser executable across platforms
function findBrowserExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = [
    // Windows Chrome & Edge paths
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),

    // macOS paths
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',

    // Linux paths
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ];

  for (const p of candidates) {
    if (p && existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    'No Chrome or Microsoft Edge executable found. Set PUPPETEER_EXECUTABLE_PATH or CHROME_PATH environment variable.',
  );
}

function seedDatabase(dbPath) {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT DEFAULT 'member',
      is_verified BOOLEAN DEFAULT 1,
      spend_total REAL DEFAULT 0.00,
      created_at DATETIME DEFAULT (datetime('now', '-15 days'))
    );

    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER DEFAULT 0,
      sku TEXT UNIQUE,
      is_active BOOLEAN DEFAULT 1,
      metadata TEXT
    );

    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id),
      product_id INTEGER REFERENCES products(id),
      order_number TEXT NOT NULL UNIQUE,
      quantity INTEGER NOT NULL DEFAULT 1,
      total_amount REAL NOT NULL,
      status TEXT DEFAULT 'completed',
      shipping_address TEXT,
      created_at DATETIME DEFAULT (datetime('now', '-2 days'))
    );

    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      ip_address TEXT,
      details TEXT,
      created_at DATETIME DEFAULT (datetime('now', '-1 hour'))
    );

    CREATE TABLE _saved_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sql TEXT NOT NULL,
      created_at DATETIME DEFAULT (datetime('now', '-5 days'))
    );

    INSERT INTO customers (name, email, role, is_verified, spend_total, created_at) VALUES
      ('Alice Johnson', 'alice.j@example.com', 'admin', 1, 1420.50, '2026-08-01 10:15:00'),
      ('Marcus Chen', 'marcus.chen@techcorp.io', 'member', 1, 890.00, '2026-08-03 14:22:00'),
      ('Sophia Martinez', 'sophia.m@designstudio.co', 'member', 1, 2340.75, '2026-08-05 09:40:00'),
      ('Liam O''Connor', 'liam.oc@ventures.org', 'member', 1, 450.20, '2026-08-08 16:05:00'),
      ('Emma Watson', 'emma.w@creative.net', 'member', 1, 120.00, '2026-08-10 11:30:00'),
      ('Daniel Kim', 'daniel.kim@enterprise.io', 'member', 1, 3100.00, '2026-08-12 18:45:00'),
      ('Olivia Taylor', 'olivia.t@cloudservice.com', 'member', 1, 560.80, '2026-08-14 08:20:00'),
      ('Ethan Wright', 'ethan.w@developer.dev', 'member', 0, 980.40, '2026-08-16 13:10:00');

    INSERT INTO products (title, category, price, stock, sku, is_active, metadata) VALUES
      ('Ergonomic Mechanical Keyboard', 'Hardware', 149.99, 45, 'KB-MECH-01', 1, '{"switch": "tactile", "backlight": "RGB", "layout": "ANSI"}'),
      ('Ultra-Wide 4K Gaming Monitor 34"', 'Displays', 599.99, 18, 'MON-34-4K', 1, '{"refresh_rate": "144Hz", "panel": "IPS", "hdr": true}'),
      ('Wireless Noise-Cancelling Headphones', 'Audio', 249.50, 32, 'AUD-NC-500', 1, '{"battery_hours": 30, "bluetooth": "5.3", "anc": "active"}'),
      ('USB-C Multi-Port Hub (10-in-1)', 'Accessories', 69.00, 120, 'HUB-10IN1', 1, '{"power_delivery_watts": 100, "hdmi": "4K60Hz"}'),
      ('Precision Wireless Mouse', 'Hardware', 89.95, 64, 'MOU-PRO-02', 1, '{"dpi": 16000, "weight_grams": 63, "sensor": "optical"}'),
      ('Height-Adjustable Standing Desk', 'Furniture', 420.00, 12, 'DSK-ADJ-99', 1, '{"motor": "dual", "preset_slots": 4, "max_load_kg": 120}');

    INSERT INTO orders (customer_id, product_id, order_number, quantity, total_amount, status, shipping_address, created_at) VALUES
      (1, 1, 'ORD-2026-8901', 2, 299.98, 'completed', '742 Evergreen Terr, Springfield, OR', '2026-08-18 10:12:00'),
      (2, 2, 'ORD-2026-8902', 1, 599.99, 'completed', '100 Main Street, Suite 400, Austin, TX', '2026-08-18 11:45:00'),
      (3, 3, 'ORD-2026-8903', 1, 249.50, 'processing', '452 Broadway Ave, New York, NY', '2026-08-19 09:30:00'),
      (4, 4, 'ORD-2026-8904', 3, 207.00, 'shipped', '88 Market St, San Francisco, CA', '2026-08-19 14:15:00'),
      (5, 5, 'ORD-2026-8905', 1, 89.95, 'completed', '12 Pine Road, Seattle, WA', '2026-08-20 08:20:00'),
      (6, 6, 'ORD-2026-8906', 1, 420.00, 'processing', '330 Innovation Way, Boston, MA', '2026-08-20 15:50:00'),
      (7, 1, 'ORD-2026-8907', 1, 149.99, 'completed', '512 Elm St, Denver, CO', '2026-08-21 12:05:00'),
      (8, 3, 'ORD-2026-8908', 2, 499.00, 'pending', '900 Michigan Ave, Chicago, IL', '2026-08-21 16:30:00');

    INSERT INTO audit_logs (action, actor, ip_address, details, created_at) VALUES
      ('TABLE_CREATE', 'system', '127.0.0.1', 'Created tables and indexes', '2026-08-01 00:00:00'),
      ('USER_LOGIN', 'alice.j@example.com', '192.168.1.10', 'Successful admin authentication', '2026-08-21 08:00:00'),
      ('DATA_EXPORT', 'alice.j@example.com', '192.168.1.10', 'Exported orders table to CSV', '2026-08-21 09:14:00');

    INSERT INTO _saved_queries (name, sql, created_at) VALUES
      ('Recent High-Value Orders', 'SELECT o.order_number, c.name AS customer, p.title AS product, o.quantity, o.total_amount, o.status FROM orders o JOIN customers c ON o.customer_id = c.id JOIN products p ON o.product_id = p.id ORDER BY o.total_amount DESC LIMIT 10;', '2026-08-15 10:00:00'),
      ('Product Stock & Revenue Summary', 'SELECT p.title, p.category, p.stock, p.price, COALESCE(SUM(o.quantity), 0) AS total_sold, COALESCE(SUM(o.total_amount), 0) AS total_revenue FROM products p LEFT JOIN orders o ON p.id = o.product_id GROUP BY p.id ORDER BY total_revenue DESC;', '2026-08-16 12:00:00');
  `);

  db.close();
}

function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
    server.on('error', reject);
  });
}

async function capture() {
  console.log('🚀 Starting AdminDB Comprehensive Screenshot Capture...');

  const executablePath = findBrowserExecutable();
  console.log(`🌐 Using browser binary: ${executablePath}`);

  const outputDir = path.resolve('docs', 'screenshots');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Create isolated temp workspace
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-screenshots-'));
  const singleDbPath = path.join(tmpDir, 'ecommerce.db');
  seedDatabase(singleDbPath);

  // Setup manager directory with multiple databases
  const mgrDir = path.join(tmpDir, 'manager');
  mkdirSync(mgrDir, { recursive: true });
  const db1 = path.join(mgrDir, 'ecommerce.db');
  const db2 = path.join(mgrDir, 'analytics.db');
  const db3 = path.join(mgrDir, 'staging.db');
  seedDatabase(db1);
  seedDatabase(db2);
  seedDatabase(db3);

  const logger = createLogger('error');

  // 1. Single DB instance (writable)
  const singleDb = new SqliteDatabase(singleDbPath, logger);
  const singleApp = createRouter({ db: singleDb, auth: false });
  const singleServer = await startServer(singleApp);
  console.log(`📡 Single DB server running at: ${singleServer.url}`);

  // 2. Read-only DB instance
  const roDb = new SqliteDatabase(singleDbPath, logger, { readonly: true });
  const roApp = createRouter({ db: roDb, readonly: true, auth: false });
  const roServer = await startServer(roApp);
  console.log(`📡 Read-only DB server running at: ${roServer.url}`);

  // 3. Manager DB instance
  const manager = new DbManager({ dir: mgrDir }, logger);
  manager.addConnection('prod_postgres', 'postgresql://app_user:••••••••@aws-rds.internal:5432/production');
  const mgrApp = createRouter({ manager, auth: false });
  const mgrServer = await startServer(mgrApp);
  console.log(`📡 Manager server running at: ${mgrServer.url}`);

  // Launch browser with high-DPI
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=max',
      '--enable-font-antialiasing',
      '--disable-gpu',
      '--hide-scrollbars',
    ],
    defaultViewport: {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
    },
  });

  const page = await browser.newPage();

  async function takeScreenshot(url, filename, setupFn) {
    console.log(`📸 Capturing: ${filename} from ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle0' });

    if (setupFn) {
      await setupFn(page);
    }

    await new Promise((r) => setTimeout(r, 450));

    const dest = path.join(outputDir, filename);
    await page.screenshot({ path: dest, type: 'png' });
    console.log(`  ✓ Saved: ${dest}`);
  }

  try {
    // 1. Home Dashboard Overview
    await takeScreenshot(`${singleServer.url}/`, 'home.png');

    // 2. Table Browser (Clean state)
    await takeScreenshot(`${singleServer.url}/tables/orders`, 'table.png');

    // 3. Inline Row Editing & Staged Changes Bar
    await takeScreenshot(`${singleServer.url}/tables/orders`, 'inline-editing.png', async (p) => {
      await p.evaluate(() => {
        const rows = document.querySelectorAll('#main-table tbody tr');
        if (rows[0]) {
          // Double-click status cell in 1st row to open active inline editor
          const statusCell = rows[0].querySelector('td[data-col="status"]');
          if (statusCell) {
            statusCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          }
        }

        if (rows[1]) {
          // Stage an edit in 2nd row (quantity 1 -> 4)
          const qtyCell = rows[1].querySelector('td[data-col="quantity"]');
          if (qtyCell) {
            qtyCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const inp = qtyCell.querySelector('input');
            if (inp) {
              inp.value = '4';
              inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            }
          }
        }
      });
      await new Promise((r) => setTimeout(r, 400));
    });

    // 4. Read-Only Mode (Top banner + locked state)
    await takeScreenshot(`${roServer.url}/tables/orders`, 'readonly.png');

    // 5. Bulk Row Operations (Multi-select toolbar)
    await takeScreenshot(`${singleServer.url}/tables/orders`, 'bulk-actions.png', async (p) => {
      await p.evaluate(() => {
        const checkboxes = document.querySelectorAll('.row-checkbox');
        if (checkboxes[0]) {
          checkboxes[0].checked = true;
          checkboxes[0].dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (checkboxes[2]) {
          checkboxes[2].checked = true;
          checkboxes[2].dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (checkboxes[3]) {
          checkboxes[3].checked = true;
          checkboxes[3].dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 300));
    });

    // 6. JSON / Universal Data Inspector Modal
    await takeScreenshot(`${singleServer.url}/tables/products`, 'inspector.png', async (p) => {
      await p.evaluate(() => {
        if (window.Inspector && window.Inspector.open) {
          window.Inspector.open({
            table: 'products',
            column: 'metadata',
            pk: '1',
            value: '{"switch": "tactile", "backlight": "RGB", "layout": "ANSI", "wireless": true, "keycaps": "PBT double-shot"}',
            type: 'JSON',
            readonly: false,
          });
        }
      });
      await new Promise((r) => setTimeout(r, 450));
    });

    // 7. Schema Inspector
    await takeScreenshot(`${singleServer.url}/tables/orders/schema`, 'schema.png');

    // 8. Visual Schema Designer
    await takeScreenshot(`${singleServer.url}/designer`, 'designer.png', async (p) => {
      await p.evaluate(() => {
        const tableNameInput = document.getElementById('table-name');
        if (tableNameInput) {
          tableNameInput.value = 'inventory';
          tableNameInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const rows = document.querySelectorAll('#columns > div');
        if (rows[0]) {
          const nameInput = rows[0].querySelector('.col-name');
          const typeSelect = rows[0].querySelector('.col-type');
          const pkCheckbox = rows[0].querySelector('.col-pk');
          if (nameInput) {
            nameInput.value = 'id';
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (typeSelect) {
            typeSelect.value = 'INTEGER';
            typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (pkCheckbox) {
            pkCheckbox.checked = true;
            pkCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        if (rows[1]) {
          const nameInput = rows[1].querySelector('.col-name');
          const typeSelect = rows[1].querySelector('.col-type');
          const notNullCheckbox = rows[1].querySelector('.col-notnull');
          const uniqueCheckbox = rows[1].querySelector('.col-unique');
          if (nameInput) {
            nameInput.value = 'sku';
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (typeSelect) {
            typeSelect.value = 'TEXT';
            typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (notNullCheckbox) {
            notNullCheckbox.checked = true;
            notNullCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (uniqueCheckbox) {
            uniqueCheckbox.checked = true;
            uniqueCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        const addBtn = document.getElementById('add-column');
        if (addBtn) {
          addBtn.click();
          setTimeout(() => {
            const currentRows = document.querySelectorAll('#columns > div');
            if (currentRows[2]) {
              const nameInput = currentRows[2].querySelector('.col-name');
              const typeSelect = currentRows[2].querySelector('.col-type');
              const defaultInput = currentRows[2].querySelector('.col-default');
              if (nameInput) {
                nameInput.value = 'quantity';
                nameInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
              if (typeSelect) {
                typeSelect.value = 'INTEGER';
                typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
              }
              if (defaultInput) {
                defaultInput.value = '0';
                defaultInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
          }, 50);
        }
      });
      await new Promise((r) => setTimeout(r, 400));
    });

    // 9. Query Editor with Execution Results
    await takeScreenshot(`${singleServer.url}/query`, 'query.png', async (p) => {
      await p.evaluate(async () => {
        const queryText = `SELECT 
  o.order_number,
  c.name AS customer_name,
  p.title AS product_title,
  o.quantity,
  o.total_amount,
  o.status,
  o.created_at
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p ON o.product_id = p.id
ORDER BY o.total_amount DESC;`;

        const textarea = document.getElementById('query-sql');
        if (textarea) {
          textarea.value = queryText;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const runBtn = document.getElementById('run-query');
        if (runBtn) {
          runBtn.click();
        }
      });
      await new Promise((r) => setTimeout(r, 600));
    });

    // 10. Form / Edit Row
    await takeScreenshot(`${singleServer.url}/tables/customers/rows/1/edit`, 'form.png');

    // 11. Mock Data Seeder with Live Preview
    await takeScreenshot(`${singleServer.url}/seed/customers`, 'seed.png', async (p) => {
      await p.evaluate(() => {
        const previewBtn = document.getElementById('seed-preview');
        if (previewBtn) {
          previewBtn.click();
        }
        window.scrollTo(0, 0);
      });
      await new Promise((r) => setTimeout(r, 600));
    });

    // 12. Multi-Database Manager
    await takeScreenshot(`${mgrServer.url}/`, 'databases.png');

    console.log('\n✨ All comprehensive screenshots captured successfully!');
  } finally {
    await browser.close();
    await singleServer.close();
    await roServer.close();
    await mgrServer.close();
    singleDb.close();
    roDb.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

capture().catch((err) => {
  console.error('❌ Screenshot capture failed:', err);
  process.exit(1);
});

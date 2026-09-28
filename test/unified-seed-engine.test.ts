import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../src/db/database';
import { createLogger } from '../src/utils/logger';
import { createPrng, evaluateTemplate, extractTemplateDependencies, orderColumnDependencies, isJunctionTable, validateGenerationPlan, SeedEngine, type GenerationPlan } from '../src/data/index';

function openDb(schemaSql?: string): { db: SqliteDatabase; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'admindb-unified-test-'));
  const db = new SqliteDatabase(path.join(root, 'test.db'), createLogger('error'));
  if (schemaSql) db.execResult(schemaSql);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('PRNG: Deterministic Mulberry32 produces identical output given the same seed', () => {
  const prngA1 = createPrng(42);
  const prngA2 = createPrng(42);

  const numsA1 = [prngA1.int(1, 1000), prngA1.int(1, 1000), prngA1.float(0, 1), prngA1.pick(['a', 'b', 'c'])];
  const numsA2 = [prngA2.int(1, 1000), prngA2.int(1, 1000), prngA2.float(0, 1), prngA2.pick(['a', 'b', 'c'])];

  assert.deepEqual(numsA1, numsA2);

  // Different seed produces different sequence
  const prngB = createPrng(999);
  const numsB = [prngB.int(1, 1000), prngB.int(1, 1000), prngB.float(0, 1), prngB.pick(['a', 'b', 'c'])];
  assert.notDeepEqual(numsA1, numsB);
});

test('Templates: Token dependency extraction and evaluation', () => {
  const tpl = '{{first_name}}.{{last_name}}@{{domain}} - year: {{year}} seq: {{sequence:10:5}}';
  const deps = extractTemplateDependencies(tpl);
  assert.deepEqual(deps, ['first_name', 'last_name', 'domain']);

  const rowValues = {
    first_name: 'John',
    last_name: 'Smith',
    domain: 'example.com',
  };
  const prng = createPrng(123);
  const evaluated = evaluateTemplate(tpl, rowValues, prng, 2);

  assert.ok(evaluated.startsWith('john.smith@example.com - year: '));
  assert.ok(evaluated.includes('seq: 20'));
});

test('Templates: Intra-row column topological dependency ordering', () => {
  const cols = ['email', 'fullname', 'first_name', 'last_name'];
  const plans = {
    first_name: { strategy: 'first' as const },
    last_name: { strategy: 'last' as const },
    fullname: { strategy: 'template' as const, template: '{{first_name}} {{last_name}}' },
    email: { strategy: 'template' as const, template: '{{fullname}}@domain.com' },
  };

  const { orderedColumns, hasCycle } = orderColumnDependencies(cols, plans);
  assert.equal(hasCycle, false);

  const idxFirst = orderedColumns.indexOf('first_name');
  const idxLast = orderedColumns.indexOf('last_name');
  const idxFull = orderedColumns.indexOf('fullname');
  const idxEmail = orderedColumns.indexOf('email');

  assert.ok(idxFirst < idxFull);
  assert.ok(idxLast < idxFull);
  assert.ok(idxFull < idxEmail);
});

test('Schema Graph: Junction table (Many-to-Many) detection', () => {
  const userRolesInfo = {
    table: 'user_roles',
    columns: [
      { cid: 0, name: 'user_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: 'role_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 2 },
      { cid: 2, name: 'assigned_at', type: 'DATETIME', notnull: 0, dflt_value: null, pk: 0 },
    ],
    primaryKey: ['user_id', 'role_id'],
    foreignKeys: [
      { id: 0, seq: 0, table: 'users', from: 'user_id', to: 'id', on_update: 'CASCADE', on_delete: 'CASCADE', match: 'NONE' },
      { id: 1, seq: 0, table: 'roles', from: 'role_id', to: 'id', on_update: 'CASCADE', on_delete: 'CASCADE', match: 'NONE' },
    ],
    indexes: [],
    strict: false,
    withoutRowid: false,
    view: false,
    virtual: false,
    autoIncrement: false,
  };

  assert.equal(isJunctionTable(userRolesInfo), true);
});

test('Single Table: Template-based row generation with dependent columns', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      fullname TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      age INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    const plan: GenerationPlan = {
      rootTable: 'employees',
      scope: 'single',
      tables: {
        employees: {
          mode: 'generate',
          rows: 5,
          columns: {
            id: { strategy: 'skip' },
            first_name: { strategy: 'first' },
            last_name: { strategy: 'last' },
            fullname: { strategy: 'template', template: '{{first_name}} {{last_name}}' },
            email: { strategy: 'template', template: '{{first_name}}.{{last_name}}.{{sequence:1:1}}@company.org' },
            age: { strategy: 'int', min: 25, max: 65 },
          },
        },
      },
      options: { seed: 100 },
    };

    const res = await SeedEngine.executePlan(db, plan);
    assert.equal(res.tableResults['employees'].rows.length, 5);

    for (const preview of res.tableResults['employees'].previewRows) {
      const email = String(preview['email']);
      assert.ok(!email.includes(' '));
      assert.ok(email.endsWith('@company.org'));
      assert.ok(Number(preview['age']) >= 25 && Number(preview['age']) <= 65);
    }
  } finally {
    cleanup();
  }
});

test('Single Table: Full name with {{full_name}}@gmail.com and implicit email strategy derivation', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE customers (
      customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    const plan: GenerationPlan = {
      rootTable: 'customers',
      scope: 'single',
      tables: {
        customers: {
          mode: 'generate',
          rows: 5,
          columns: {
            customer_id: { strategy: 'skip' },
            full_name: { strategy: 'fullname' },
            email: { strategy: 'template', template: '{{full_name}}@gmail.com' },
          },
        },
      },
      options: { seed: 42 },
    };

    const res = await SeedEngine.executePlan(db, plan);
    assert.equal(res.tableResults['customers'].rows.length, 5);

    for (const preview of res.tableResults['customers'].previewRows) {
      const name = String(preview['full_name']);
      const email = String(preview['email']);
      // Email should be sanitized (no spaces, lowercased, ending in @gmail.com)
      assert.ok(!email.includes(' '), `Email "${email}" should not contain spaces`);
      assert.ok(email.endsWith('@gmail.com'), `Email "${email}" should end with @gmail.com`);
      const nameParts = name.toLowerCase().split(' ');
      assert.ok(email.startsWith(nameParts[0]), `Email "${email}" should start with "${nameParts[0]}"`);
    }

    // Also test implicit email strategy (strategy: 'email')
    const planImplicit: GenerationPlan = {
      rootTable: 'customers',
      scope: 'single',
      tables: {
        customers: {
          mode: 'generate',
          rows: 3,
          columns: {
            customer_id: { strategy: 'skip' },
            full_name: { strategy: 'fullname' },
            email: { strategy: 'email' },
          },
        },
      },
      options: { seed: 99 },
    };

    const resImplicit = await SeedEngine.executePlan(db, planImplicit);
    for (const preview of resImplicit.tableResults['customers'].previewRows) {
      const name = String(preview['full_name']);
      const email = String(preview['email']);
      assert.ok(!email.includes(' '));
      const nameParts = name.toLowerCase().split(' ');
      assert.ok(email.startsWith(nameParts[0]), `Implicit email "${email}" should derive from name "${nameParts[0]}"`);
    }
  } finally {
    cleanup();
  }
});

test('Relational: Multi-table generation with foreign keys, junction tables, and table modes', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE countries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );

    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country_id INTEGER NOT NULL REFERENCES countries(id),
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE
    );

    CREATE TABLE groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE account_groups (
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      group_id INTEGER NOT NULL REFERENCES groups(id),
      PRIMARY KEY (account_id, group_id)
    );

    INSERT INTO countries (code, name) VALUES ('US', 'United States'), ('DE', 'Germany'), ('JP', 'Japan');
  `);

  try {
    // Plan: countries uses existing rows; accounts and groups generate new rows; account_groups generates unique pairs
    const plan: GenerationPlan = {
      rootTable: 'accounts',
      scope: 'all',
      tables: {
        countries: {
          mode: 'use_existing',
          columns: {},
        },
        accounts: {
          mode: 'generate',
          rows: 6,
          columns: {
            country_id: { strategy: 'fk', refTable: 'countries', refColumn: 'id' },
            username: { strategy: 'username' },
            email: { strategy: 'email' },
          },
        },
        groups: {
          mode: 'generate',
          rows: 3,
          columns: {
            group_name: { strategy: 'words', minLen: 1, maxLen: 2 },
          },
        },
        account_groups: {
          mode: 'generate',
          rows: 8,
          columns: {
            account_id: { strategy: 'fk', refTable: 'accounts', refColumn: 'id' },
            group_id: { strategy: 'fk', refTable: 'groups', refColumn: 'id' },
          },
        },
      },
      options: { seed: 555 },
    };

    const res = await SeedEngine.executePlan(db, plan);

    assert.equal(res.tableResults['countries'].rows.length, 0); // use_existing
    assert.equal(res.tableResults['accounts'].rows.length, 6);
    assert.equal(res.tableResults['groups'].rows.length, 3);
    assert.ok(res.tableResults['account_groups'].rows.length > 0);

    // Verify account country_id foreign keys are drawn from existing countries table (1, 2, or 3)
    for (const preview of res.tableResults['accounts'].previewRows) {
      assert.ok([1, 2, 3].includes(Number(preview['country_id'])));
    }
  } finally {
    cleanup();
  }
});

test('Self-referencing: Hierarchical tree structure generation', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE org_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES org_units(id),
      unit_name TEXT NOT NULL
    );
  `);

  try {
    const plan: GenerationPlan = {
      rootTable: 'org_units',
      scope: 'single',
      tables: {
        org_units: {
          mode: 'generate',
          rows: 10,
          columns: {
            parent_id: { strategy: 'fk' },
            unit_name: { strategy: 'company' },
          },
        },
      },
      options: { seed: 777 },
    };

    const res = await SeedEngine.executePlan(db, plan);
    const rows = res.tableResults['org_units'].previewRows;
    assert.equal(rows.length, 10);

    // First node must be a root node (parent_id is null)
    assert.equal(rows[0]['parent_id'], null);
  } finally {
    cleanup();
  }
});

test('Pre-flight Validation: Detects non-existent tables and circular templates', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      col_a TEXT,
      col_b TEXT
    );
  `);

  try {
    // 1. Invalid plan with circular templates
    const invalidPlan: GenerationPlan = {
      rootTable: 'items',
      tables: {
        items: {
          mode: 'generate',
          rows: 5,
          columns: {
            col_a: { strategy: 'template', template: '{{col_b}}' },
            col_b: { strategy: 'template', template: '{{col_a}}' },
          },
        },
        ghost_table: {
          mode: 'generate',
          rows: 5,
          columns: {},
        },
      },
    };

    const report = await validateGenerationPlan(db, invalidPlan);
    assert.equal(report.valid, false);
    assert.ok(report.issues.some((i) => i.code === 'TABLE_NOT_FOUND'));
    assert.ok(report.issues.some((i) => i.code === 'TEMPLATE_CYCLE'));
  } finally {
    cleanup();
  }
});


test('Relational Chain: Automatically resolves missing upstream reference tables and self-referencing hierarchy', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES categories(id),
      name TEXT NOT NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES categories(id),
      name TEXT NOT NULL,
      price REAL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id),
      product_id INTEGER REFERENCES products(id),
      quantity INTEGER NOT NULL
    );
  `);

  try {
    // Single child table target in chain mode: should auto-discover and generate categories, products, orders first
    const plan: GenerationPlan = {
      rootTable: 'order_items',
      scope: 'chain',
      tables: {
        order_items: {
          mode: 'generate',
          rows: 8,
          columns: {
            order_id: { strategy: 'fk' },
            product_id: { strategy: 'fk' },
            quantity: { strategy: 'int', min: 1, max: 10 },
          },
        },
      },
      options: { seed: 12345 },
    };

    const res = await SeedEngine.executePlan(db, plan);

    // Should generate all upstream tables in topological order
    assert.ok(res.tableResults['categories']);
    assert.ok(res.tableResults['products']);
    assert.ok(res.tableResults['orders']);
    assert.ok(res.tableResults['order_items']);

    assert.ok(res.tableResults['categories'].rows.length > 0);
    assert.ok(res.tableResults['products'].rows.length > 0);
    assert.ok(res.tableResults['orders'].rows.length > 0);
    assert.equal(res.tableResults['order_items'].rows.length, 8);

    // Verify self-referencing categories has NO false "has no rows; NULL will be used" warning
    const catWarnings = res.tableResults['categories'].warnings;
    assert.equal(catWarnings.filter((w) => w.includes('has no rows; NULL will be used')).length, 0);

    // Verify execution order
    const catIdx = res.executionOrder.indexOf('categories');
    const prodIdx = res.executionOrder.indexOf('products');
    const ordIdx = res.executionOrder.indexOf('orders');
    const itemIdx = res.executionOrder.indexOf('order_items');
    assert.ok(catIdx < prodIdx);
    assert.ok(prodIdx < itemIdx);
    assert.ok(ordIdx < itemIdx);
  } finally {
    cleanup();
  }
});


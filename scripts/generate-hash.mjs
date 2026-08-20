#!/usr/bin/env node

/**
 * AdminDB Password Hash Generator
 *
 * Prompts for a password and outputs a salted cryptographic scrypt hash
 * formatted as `scrypt:<salt>:<hash>` for use in:
 * - `ADMINDB_PASSWORD` environment variable
 * - `admindb -P "<hash>"` CLI flag
 * - `createRouter({ auth: { password: '<hash>' } })` options
 */

import { randomBytes, scryptSync } from 'node:crypto';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

function hashPassword(password) {
  const saltHex = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, saltHex, 64).toString('hex');
  return `scrypt:${saltHex}:${derivedKey}`;
}

async function main() {
  let password = process.argv[2];

  if (!password) {
    const rl = readline.createInterface({ input, output });
    try {
      password = await rl.question('Enter password to hash: ');
    } finally {
      rl.close();
    }
  }

  if (!password || !password.trim()) {
    console.error('Error: Password cannot be empty.');
    process.exit(1);
  }

  const trimmedPassword = password.trim();
  const hash = hashPassword(trimmedPassword);

  console.log('\n===============================================================');
  console.log('  AdminDB Native Password Hash Generated');
  console.log('===============================================================');
  console.log('\nGenerated Hash:\n');
  console.log(hash);
  console.log('\n---------------------------------------------------------------');
  console.log('How to use this hash:');
  console.log('---------------------------------------------------------------');
  console.log('1. Environment Variable:');
  console.log(`   export ADMINDB_PASSWORD="${hash}"`);
  console.log('\n2. Standalone CLI:');
  console.log(`   npx admindb -P "${hash}"`);
  console.log('\n3. Express createRouter():');
  console.log(`   createRouter({`);
  console.log(`     auth: {`);
  console.log(`       username: 'admin',`);
  console.log(`       password: '${hash}',`);
  console.log(`     }`);
  console.log(`   });`);
  console.log('===============================================================\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

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
      password = await rl.question(cyan('Enter password to hash: '));
    } finally {
      rl.close();
    }
  }

  if (!password || !password.trim()) {
    console.error(red('Error: Password cannot be empty.'));
    process.exit(1);
  }

  const trimmedPassword = password.trim();
  const hash = hashPassword(trimmedPassword);

  console.log();
  console.log(`  ${cyan(bold('⚡ AdminDB Password Hash Generated'))}`);
  console.log();
  console.log(`  ${green('➜')}  ${bold('Hash:')} ${cyan(hash)}`);
  console.log();
  console.log(`  ${dim('How to use this hash:')}`);
  console.log(`  ${dim('1. Environment Variable:')}`);
  console.log(`     export ADMINDB_PASSWORD="${hash}"`);
  console.log(`  ${dim('2. Standalone CLI:')}`);
  console.log(`     npx admindb -P "${hash}"`);
  console.log(`  ${dim('3. Express createRouter():')}`);
  console.log(`     createRouter({ auth: { username: 'admin', password: '${hash}' } });`);
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

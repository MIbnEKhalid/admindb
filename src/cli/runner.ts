import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../app';
import { loadConfig } from './config';
import { createLogger } from '../utils/logger';
import { DbManager } from '../db/manager';
import { parseArgs, helpText, versionText, getPackageVersion } from './args';
import { DEFAULT_PASSWORD_HASH } from '../auth';
import { c } from '../utils/colors';

export function runCli(): void {
  const env = loadConfig();
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(c.red(c.bold(`Error: ${parsed.error}`)));
    console.error();
    console.error(helpText());
    process.exit(1);
  }
  const args = parsed.args;
  if (args.help) {
    console.log(helpText());
    process.exit(0);
  }
  if (args.version) {
    console.log(versionText());
    process.exit(0);
  }

  // Merge CLI flags over environment variables.
  const authEnabled = args.auth !== undefined ? args.auth : env.auth;
  const authUsername = args.authUsername ?? env.authUsername ?? 'admin';
  const authPassword = args.authPassword ?? env.authPassword;
  const authSecret = args.authSecret ?? env.authSecret;
  const serverless = args.serverless !== undefined ? args.serverless : env.serverless;
  const readonly = serverless || args.readonly || env.readonly;

  const config = {
    host: args.host ?? env.host,
    port: args.port ?? env.port,
    dbPath: args.dbPath ?? env.dbPath,
    dbDir: args.dbDir ?? env.dbDir,
    dbFiles: args.dbFiles ?? env.dbFiles,
    basePath: (args.basePath ?? env.basePath).replace(/\/+$/, ''),
    logLevel: args.logLevel ?? env.logLevel,
    readonly,
    serverless,
    auth: authEnabled
      ? {
          enabled: true,
          username: authUsername,
          password: authPassword,
          secret: authSecret,
        }
      : false,
  };

  const logger = createLogger(config.logLevel, 'admindb');
  const app = express();
  app.disable('x-powered-by');

  // Mode selection:
  //  - A specific single file was requested (`--open`, a file path argument, or
  //    DB_PATH) and no folder/files were configured → single-database mode.
  //  - Otherwise → manager mode with a landing page where you can browse the
  //    filesystem and open database files, or create new ones.
  const hasDir = Boolean(config.dbDir);
  const hasFiles = Boolean(config.dbFiles && config.dbFiles.length > 0);
  const explicitFile =
    args.dbPath ??
    (process.env.ADMINDB_DB_PATH || process.env.ADMINDB_PATH || process.env.DB_PATH ? config.dbPath : undefined);
  const singleFileOnly = Boolean(explicitFile) && !hasDir && !hasFiles;
  const useManager = !singleFileOnly;

  const managerFiles = [...(config.dbFiles ?? [])];
  if (useManager && explicitFile) managerFiles.push(explicitFile);

  // File-browser policy for manager mode:
  //  - a folder was requested → browsing is allowed but limited to that folder;
  //  - specific files were requested (no folder) → browsing is disabled entirely;
  //  - nothing requested → browsing is allowed (free); the folder defaults to the
  //    current directory so new/created databases land there.
  const managerDir = hasDir ? config.dbDir : hasFiles || explicitFile ? undefined : process.cwd();
  const allowBrowse = useManager && (hasDir || (!hasFiles && !explicitFile));
  const browseRoot = hasDir ? path.resolve(config.dbDir!) : undefined;

  const router = useManager
    ? createRouter({
        manager: new DbManager(
          { dir: managerDir, files: managerFiles, readonly: config.readonly },
          logger,
        ),
        basePath: config.basePath,
        logger,
        readonly: config.readonly,
        serverless: config.serverless,
        allowBrowse,
        browseRoot,
        auth: config.auth,
      })
    : createRouter({
        dbPath: explicitFile,
        basePath: config.basePath,
        logger,
        readonly: config.readonly,
        serverless: config.serverless,
        auth: config.auth,
      });
  app.use(config.basePath || '/', router);

  function getNetworkIp(): string | undefined {
    try {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
          if (net.family === 'IPv4' && !net.internal) {
            return net.address;
          }
        }
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  const server = app.listen(config.port, config.host, () => {
    const v = getPackageVersion();
    const versionStr = v ? ` v${v}` : '';

    const isAnyHost = config.host === '0.0.0.0' || config.host === '::' || config.host === '';
    const localHost = isAnyHost ? 'localhost' : config.host;
    const localUrl = `http://${localHost}:${config.port}${config.basePath}/`;

    console.log();
    console.log(`  ${c.cyan(c.bold('⚡ AdminDB'))}${c.dim(versionStr)}`);
    console.log();
    console.log(`  ${c.green('➜')}  ${c.bold('Local:')}    ${c.cyan(localUrl)}`);

    if (isAnyHost) {
      const netIp = getNetworkIp();
      if (netIp) {
        const netUrl = `http://${netIp}:${config.port}${config.basePath}/`;
        console.log(`  ${c.green('➜')}  ${c.bold('Network:')}  ${c.cyan(netUrl)}`);
      }
    }

    // Mode & Target Info
    if (useManager) {
      const modeDesc = config.serverless
        ? 'Manager [Serverless Read-Only]'
        : config.readonly
        ? 'Manager [Read-Only]'
        : 'Manager';
      const target = managerDir ? managerDir : managerFiles.length ? `[${managerFiles.join(', ')}]` : '';
      console.log(`  ${c.green('➜')}  ${c.bold('Mode:')}     ${modeDesc}${target ? c.dim(` (${target})`) : ''}`);
      if (!allowBrowse) {
        console.log(`  ${c.green('➜')}  ${c.bold('Browse:')}   ${c.dim('Disabled (configured files only)')}`);
      } else if (browseRoot) {
        console.log(`  ${c.green('➜')}  ${c.bold('Browse:')}   ${c.dim(`Limited to ${browseRoot}`)}`);
      }
    } else {
      const modeDesc = config.serverless
        ? 'Single DB [Serverless Read-Only]'
        : config.readonly
        ? 'Single DB [Read-Only]'
        : 'Single DB';
      console.log(`  ${c.green('➜')}  ${c.bold('Mode:')}     ${modeDesc}`);
      console.log(`  ${c.green('➜')}  ${c.bold('Database:')} ${explicitFile}`);
    }

    // Auth Status
    if (authEnabled) {
      const isDefaultPass =
        authUsername === 'admin' &&
        (!authPassword || authPassword === 'admin' || authPassword === DEFAULT_PASSWORD_HASH);
      if (isDefaultPass) {
        console.log(`  ${c.green('➜')}  ${c.bold('Auth:')}     User: ${c.bold(authUsername)} ${c.yellow('(default password)')}`);
        console.log();
        console.log(`  ${c.yellow('⚠')}  ${c.yellow('Default password in use (admin).')} Generate a secure hash with:`);
        console.log(`     ${c.dim('npm run generatehash')} and set ${c.cyan('ADMINDB_PASSWORD')} or ${c.cyan('-P <hash>')}`);
      } else {
        console.log(`  ${c.green('➜')}  ${c.bold('Auth:')}     User: ${c.bold(authUsername)}`);
      }
    } else {
      console.log(`  ${c.yellow('➜')}  ${c.bold('Auth:')}     ${c.yellow('Disabled (--no-auth)')}`);
      console.log(`     ${c.dim('Warning: Anyone with network access can view and modify databases.')}`);
    }

    console.log();
  });

  const shutdown = (signal: string): void => {
    console.log(`\n  ${c.dim(`Received ${signal}, shutting down…`)}`);
    server.close(() => {
      console.log(`  ${c.green('✓')} ${c.dim('AdminDB stopped.')}\n`);
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

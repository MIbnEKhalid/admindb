import { c } from './colors';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function formatTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const BADGES: Record<LogLevel, string> = {
  debug: c.magenta('[debug]'),
  info: c.cyan('[info]'),
  warn: c.yellow('[warn]'),
  error: c.red(c.bold('[error]')),
};

/** Minimal, color-enhanced console logger with level filtering and scoped children. */
export function createLogger(level: LogLevel = 'info', scope = 'admindb'): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info;

  // Clean scope name (e.g. "admindb:db:users.db" -> "db:users.db")
  const cleanScope = scope === 'admindb' || scope === 'app' ? '' : scope.replace(/^admindb:/, '');
  const scopeTag = cleanScope ? c.dim(c.cyan(`[${cleanScope}]`)) : '';

  const write = (lv: LogLevel, args: unknown[]): void => {
    if (LEVELS[lv] < threshold) return;
    const time = c.gray(formatTime());
    const badge = BADGES[lv];
    const prefix = [time, badge, scopeTag].filter(Boolean).join(' ');
    // eslint-disable-next-line no-console
    console.log(prefix, ...args);
  };

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    child: (s) => createLogger(level, cleanScope ? `${cleanScope}:${s}` : s),
  };
}

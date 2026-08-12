export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function timestamp(): string {
  return new Date().toISOString();
}

/** Minimal console logger with level filtering and scoped children. */
export function createLogger(level: LogLevel = 'info', scope = 'app'): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (lv: LogLevel, args: unknown[]): void => {
    if (LEVELS[lv] < threshold) return;
    // eslint-disable-next-line no-console
    console.log(`[${timestamp()}] [${lv.toUpperCase()}] [${scope}]`, ...args);
  };

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    child: (s) => createLogger(level, `${scope}:${s}`),
  };
}

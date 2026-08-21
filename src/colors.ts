/**
 * Lightweight ANSI color utility with zero runtime dependencies.
 *
 * Supports detection of terminal color capabilities via `process.stdout.isTTY`,
 * `FORCE_COLOR`, `NO_COLOR`, and CI environments.
 */

export function supportsColor(): boolean {
  if (process.env.NO_COLOR || process.env.NODE_DISABLE_COLORS) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  if (process.env.CI) return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

const wrap = (open: string, close: string) => (str: unknown): string => {
  const text = String(str ?? '');
  if (!supportsColor() || !text) return text;
  return `${open}${text}${close}`;
};

export const c = {
  reset: wrap('\x1b[0m', '\x1b[0m'),
  bold: wrap('\x1b[1m', '\x1b[22m'),
  dim: wrap('\x1b[2m', '\x1b[22m'),
  italic: wrap('\x1b[3m', '\x1b[23m'),
  underline: wrap('\x1b[4m', '\x1b[24m'),
  inverse: wrap('\x1b[7m', '\x1b[27m'),

  // Foreground colors
  black: wrap('\x1b[30m', '\x1b[39m'),
  red: wrap('\x1b[31m', '\x1b[39m'),
  green: wrap('\x1b[32m', '\x1b[39m'),
  yellow: wrap('\x1b[33m', '\x1b[39m'),
  blue: wrap('\x1b[34m', '\x1b[39m'),
  magenta: wrap('\x1b[35m', '\x1b[39m'),
  cyan: wrap('\x1b[36m', '\x1b[39m'),
  white: wrap('\x1b[37m', '\x1b[39m'),
  gray: wrap('\x1b[90m', '\x1b[39m'),

  // Bright foregrounds
  brightRed: wrap('\x1b[91m', '\x1b[39m'),
  brightGreen: wrap('\x1b[92m', '\x1b[39m'),
  brightYellow: wrap('\x1b[93m', '\x1b[39m'),
  brightBlue: wrap('\x1b[94m', '\x1b[39m'),
  brightMagenta: wrap('\x1b[95m', '\x1b[39m'),
  brightCyan: wrap('\x1b[96m', '\x1b[39m'),
  brightWhite: wrap('\x1b[97m', '\x1b[39m'),

  // Background colors
  bgBlack: wrap('\x1b[40m', '\x1b[49m'),
  bgRed: wrap('\x1b[41m', '\x1b[49m'),
  bgGreen: wrap('\x1b[42m', '\x1b[49m'),
  bgYellow: wrap('\x1b[43m', '\x1b[49m'),
  bgBlue: wrap('\x1b[44m', '\x1b[49m'),
  bgMagenta: wrap('\x1b[45m', '\x1b[49m'),
  bgCyan: wrap('\x1b[46m', '\x1b[49m'),
  bgWhite: wrap('\x1b[47m', '\x1b[49m'),
  bgGray: wrap('\x1b[100m', '\x1b[49m'),
};

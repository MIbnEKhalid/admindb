/**
 * Minimal RFC 4180-style CSV serialization and parsing, used for table and
 * query export/import. Pure functions with no I/O so they are easy to test.
 */

/** Escape a single CSV field (quote when it contains comma, quote or newline). */
export function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize rows to CSV with an explicit column order. */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(csvEscape).join(',');
  const body = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(','));
  return [header, ...body].join('\r\n');
}

/** Serialize rows to JSON (values are expected to be already normalized). */
export function toJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * Parse CSV text into rows of string fields. Handles quoted fields containing
 * commas, quotes and embedded newlines. Blank lines are skipped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else if (ch === '\r') {
      // Ignore — part of CRLF line endings.
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

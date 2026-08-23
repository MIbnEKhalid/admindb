/**
 * SQL Error Analyzer & Explainer
 *
 * Parses raw error messages from SQLite (better-sqlite3) and PostgreSQL (pg),
 * pinpoints exact line/column offsets in the user's SQL text, formats visual
 * error snippets with pointers, and generates actionable "Possible Cause" and
 * "Suggested Fix" explanations.
 */
import type { IDatabase } from '../db/types';

export interface SqlErrorDetails {
  message: string;
  line?: number;
  column?: number;
  token?: string;
  snippet?: string;
  cause?: string;
  suggestion?: string;
  raw?: string;
}

// ---------------------------------------------------------------------------
// Levenshtein distance for fuzzy table/column typo detection
// ---------------------------------------------------------------------------

function levenshteinDistance(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix: number[][] = [];
  for (let i = 0; i <= bn; i++) matrix[i] = [i];
  for (let j = 0; j <= an; j++) matrix[0][j] = j;

  for (let i = 1; i <= bn; i++) {
    for (let j = 1; j <= an; j++) {
      if (b.charAt(i - 1).toLowerCase() === a.charAt(j - 1).toLowerCase()) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1,     // deletion
        );
      }
    }
  }
  return matrix[bn][an];
}

function findClosestMatch(target: string, candidates: string[], maxDist = 3): string | null {
  if (!candidates.length || !target) return null;
  let best: string | null = null;
  let bestDist = maxDist + 1;
  for (const c of candidates) {
    if (c.toLowerCase() === target.toLowerCase()) continue;
    const dist = levenshteinDistance(target, c);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return bestDist <= maxDist ? best : null;
}

// ---------------------------------------------------------------------------
// Position & Visual Snippet Helper
// ---------------------------------------------------------------------------

/** Given 1-based line & col in sql, builds a 3-line contextual snippet with a `^` pointer. */
export function buildErrorSnippet(sql: string, line: number, column: number): string {
  const lines = sql.split(/\r?\n/);
  const targetLineIdx = Math.max(0, Math.min(lines.length - 1, line - 1));
  const startIdx = Math.max(0, targetLineIdx - 1);
  const endIdx = Math.min(lines.length - 1, targetLineIdx + 1);

  const maxLineNumLen = Math.max(2, String(endIdx + 1).length);
  const out: string[] = [];

  for (let i = startIdx; i <= endIdx; i++) {
    const lineNum = String(i + 1).padStart(maxLineNumLen, ' ');
    const isError = i === targetLineIdx;
    const prefix = isError ? `> ${lineNum} | ` : `  ${lineNum} | `;
    out.push(`${prefix}${lines[i]}`);

    if (isError) {
      const colPad = Math.max(0, column - 1);
      const indent = ' '.repeat(maxLineNumLen + 5 + colPad);
      out.push(`${indent}^`);
    }
  }

  return out.join('\n');
}

/** Given a 1-based character position in string, returns 1-based line and column. */
export function offsetToLineCol(sql: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  const target = Math.max(1, Math.min(sql.length, offset));

  for (let i = 0; i < target - 1; i++) {
    if (sql[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

/** Masks comments and string literals in SQL with whitespace, preserving line/col numbers. */
export function maskCommentsAndStrings(sql: string): string {
  let out = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        i++;
      } else if (ch === '\n') {
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }

    if (inSingleQuote) {
      if (ch === "'") {
        if (next === "'") {
          out += '  ';
          i++;
        } else {
          inSingleQuote = false;
          out += ' ';
        }
      } else if (ch === '\n') {
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '"') {
        if (next === '"') {
          out += '  ';
          i++;
        } else {
          inDoubleQuote = false;
          out += ' ';
        }
      } else if (ch === '\n') {
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }

    // Start of line comment
    if (ch === '-' && next === '-') {
      inLineComment = true;
      out += '  ';
      i++;
      continue;
    }

    // Start of block comment
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i++;
      continue;
    }

    // Start of quotes
    if (ch === "'") {
      inSingleQuote = true;
      out += ' ';
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      out += ' ';
      continue;
    }

    out += ch;
  }
  return out;
}

/** Finds the most probable occurrence of a syntax error token in SQL (ignoring comments & strings). */
export function findTokenPosition(sql: string, token: string): { line: number; column: number } | null {
  if (!token) return null;
  const masked = maskCommentsAndStrings(sql);
  const maskedLines = masked.split(/\r?\n/);
  const originalLines = sql.split(/\r?\n/);

  const isWordToken = /^[A-Za-z0-9_$]+$/.test(token);

  // 1. If searching for '(', check for suspect patterns first (e.g. unparenthesized DEFAULT function or unaliased subquery)
  if (token === '(') {
    for (let l = 0; l < maskedLines.length; l++) {
      const lineText = maskedLines[l];
      const dfMatch = lineText.match(/DEFAULT\s+[a-zA-Z0-9_]+\s*(\()/i);
      if (dfMatch && dfMatch.index != null) {
        const parenCol = lineText.indexOf('(', dfMatch.index + 7);
        if (parenCol !== -1) return { line: l + 1, column: parenCol + 1 };
      }
    }
    for (let l = 0; l < maskedLines.length; l++) {
      const lineText = maskedLines[l];
      if (/\bFROM\s+\(/i.test(lineText) || /,\s*\(/i.test(lineText)) {
        const parenCol = lineText.indexOf('(');
        if (parenCol !== -1) return { line: l + 1, column: parenCol + 1 };
      }
    }
  }

  // 2. Exact word boundary search in active (masked) SQL code
  if (isWordToken) {
    const wordRegex = new RegExp(`\\b${token}\\b`, 'i');
    for (let l = 0; l < maskedLines.length; l++) {
      const m = maskedLines[l].match(wordRegex);
      if (m && m.index != null) {
        return { line: l + 1, column: m.index + 1 };
      }
    }
  }

  // 3. Substring search in active (masked) SQL code
  for (let l = 0; l < maskedLines.length; l++) {
    const colIdx = maskedLines[l].toLowerCase().indexOf(token.toLowerCase());
    if (colIdx !== -1) {
      return { line: l + 1, column: colIdx + 1 };
    }
  }

  // 4. Fallback to raw lines if not found in active code (e.g. string syntax error)
  for (let l = 0; l < originalLines.length; l++) {
    const colIdx = originalLines[l].toLowerCase().indexOf(token.toLowerCase());
    if (colIdx !== -1) {
      return { line: l + 1, column: colIdx + 1 };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main Analysis Logic
// ---------------------------------------------------------------------------

export async function analyzeSqlError(
  sql: string,
  rawError: unknown,
  db?: IDatabase,
): Promise<SqlErrorDetails> {
  const rawMsg = rawError instanceof Error ? rawError.message : String(rawError ?? 'Unknown error');
  const details: SqlErrorDetails = {
    message: rawMsg,
    raw: rawMsg,
  };

  const cleanSql = sql.trim();
  const lines = sql.split(/\r?\n/);

  // Check for PostgreSQL position property (e.g. pg driver error)
  const pgPos = (rawError as { position?: string | number })?.position;
  if (pgPos != null) {
    const numPos = Number(pgPos);
    if (Number.isFinite(numPos) && numPos > 0) {
      const pos = offsetToLineCol(sql, numPos);
      details.line = pos.line;
      details.column = pos.column;
    }
  }

  // ── 1. Check for mismatched parentheses / quotes ────────────────────────
  let openParens = 0;
  let closeParens = 0;
  let singleQuotes = 0;
  let doubleQuotes = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '-' && next === '-') {
        // Line comment
        while (i < sql.length && sql[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        // Block comment
        i += 2;
        while (i < sql.length - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i++;
        continue;
      }
      if (ch === '(') openParens++;
      if (ch === ')') closeParens++;
    }
    if (ch === "'" && !inDoubleQuote) {
      singleQuotes++;
      inSingleQuote = !inSingleQuote;
    }
    if (ch === '"' && !inSingleQuote) {
      doubleQuotes++;
      inDoubleQuote = !inDoubleQuote;
    }
  }

  // ── 2. Parse SQLite "near <token>": syntax error ─────────────────────────
  const nearMatch = rawMsg.match(/near\s+"([^"]+)":\s*syntax error/i) || rawMsg.match(/syntax error at or near\s+"?([^"\s]+)"?/i);
  if (nearMatch) {
    const token = nearMatch[1];
    details.token = token;

    if (!details.line) {
      const pos = findTokenPosition(sql, token);
      if (pos) {
        details.line = pos.line;
        details.column = pos.column;
      }
    }

    if (token === '(') {
      // Check context around '('
      const defaultFnMatch = sql.match(/DEFAULT\s+([a-zA-Z0-9_]+)\s*\(/i);
      if (defaultFnMatch) {
        const fnName = defaultFnMatch[1];
        if (fnName.toLowerCase() === 'gen_random_uuid') {
          details.cause = `In SQLite, default expressions calling functions must be enclosed in parentheses "DEFAULT (expr)". Additionally, "gen_random_uuid()" is a PostgreSQL function not built into SQLite.`;
          details.suggestion = `For SQLite, use "DEFAULT (lower(hex(randomblob(16))))" or assign UUIDs in your application. Also replace "NOW()" with "CURRENT_TIMESTAMP".`;
        } else if (fnName.toLowerCase() === 'now') {
          details.cause = `In SQLite, "NOW()" is not a built-in function (PostgreSQL only), and function default expressions must be enclosed in parentheses.`;
          details.suggestion = `Replace "DEFAULT NOW()" with "DEFAULT CURRENT_TIMESTAMP" or "DEFAULT (datetime('now'))".`;
        } else {
          details.cause = `In SQLite, function calls and expressions in a DEFAULT constraint must be enclosed in parentheses, e.g. "DEFAULT (${fnName}(...))" instead of "DEFAULT ${fnName}(...)".`;
          details.suggestion = `Wrap the default function expression in parentheses: DEFAULT (${fnName}(...))`;
        }
      } else if (/\bfrom\s+\(/i.test(sql) && !/\bfrom\s+\([^)]+\)\s+as\s+[a-z0-9_]+/i.test(sql) && !/\bfrom\s+\([^)]+\)\s+[a-z0-9_]+/i.test(sql)) {
        details.cause = 'Subqueries in the FROM clause require a table alias.';
        details.suggestion = 'Add a subquery alias after the closing parenthesis, e.g. FROM (SELECT ...) AS sub_table';
      } else if (openParens !== closeParens) {
        details.cause = `Mismatched parentheses: Found ${openParens} opening '(' and ${closeParens} closing ')'.`;
        details.suggestion = openParens > closeParens
          ? `Add ${openParens - closeParens} closing ')' to balance the expression.`
          : `Remove ${closeParens - openParens} extra closing ')' from the query.`;
      } else if (/,\s*\(/i.test(sql) && !/\bvalues\s*\(/i.test(sql)) {
        details.cause = 'Unexpected parenthesis following a comma in the expression list.';
        details.suggestion = 'Check for extra commas or ensure the parenthesized expression is part of a valid function or subquery.';
      } else {
        details.cause = 'An unexpected opening parenthesis "(" was found where an identifier or expression was expected.';
        details.suggestion = 'Check for missing column/table names before "(", or verify subquery syntax.';
      }
    } else if (token === ')') {
      if (openParens !== closeParens) {
        details.cause = `Mismatched parentheses: Found ${openParens} opening '(' and ${closeParens} closing ')'.`;
        details.suggestion = `Remove the extra closing parenthesis ')' or add a matching opening '('.`;
      } else if (/,\s*\)/i.test(sql)) {
        details.cause = 'Trailing comma detected before the closing parenthesis ")".';
        details.suggestion = 'Remove the trailing comma before ")", e.g. (col1, col2) instead of (col1, col2,).';
      } else {
        details.cause = 'An unexpected closing parenthesis ")" was encountered.';
        details.suggestion = 'Verify that every opening parenthesis has a corresponding closing parenthesis and valid enclosed expressions.';
      }
    } else if (token === ',') {
      details.cause = 'Unexpected comma in SQL statement.';
      details.suggestion = 'Remove duplicate or misplaced commas (e.g. trailing commas before FROM, WHERE, or clauses).';
    } else if (token === ';') {
      details.cause = 'Premature semicolon or empty statement.';
      details.suggestion = 'Check if a clause before the semicolon is incomplete, or remove extra semicolons.';
    } else if (token.toUpperCase() === 'FROM' && /,\s*FROM/i.test(sql)) {
      details.cause = 'Trailing comma before the FROM keyword.';
      details.suggestion = 'Remove the trailing comma right before FROM in your SELECT column list.';
    } else if (token.toUpperCase() === 'WHERE' && /,\s*WHERE/i.test(sql)) {
      details.cause = 'Trailing comma before the WHERE keyword.';
      details.suggestion = 'Remove the trailing comma before WHERE (e.g. in UPDATE ... SET col = val, WHERE).';
    } else {
      details.cause = `Syntax error near keyword or identifier "${token}".`;
      details.suggestion = `Check the syntax immediately preceding "${token}" for missing keywords, operators, or commas.`;
    }
  }

  // ── 3. Check for "no such table: <name>" ─────────────────────────────────
  const noTableMatch = rawMsg.match(/no such table:\s*([^\s:]+)/i) || rawMsg.match(/relation "([^"]+)" does not exist/i);
  if (noTableMatch) {
    const tableName = noTableMatch[1].replace(/["']/g, '');
    details.token = tableName;
    if (!details.line) {
      const pos = findTokenPosition(sql, tableName);
      if (pos) { details.line = pos.line; details.column = pos.column; }
    }
    details.cause = `Table "${tableName}" does not exist in the database.`;

    let suggestion = `Verify the table name spelling or create the table first.`;
    if (db) {
      try {
        const tablesResult = await db.listTables();
        if (tablesResult.success && tablesResult.data) {
          const knownTables = tablesResult.data.map((t) => t.name);
          const match = findClosestMatch(tableName, knownTables);
          if (match) {
            suggestion = `Did you mean table "${match}"?`;
          }
        }
      } catch { /* ignore */ }
    }
    details.suggestion = suggestion;
  }

  // ── 3b. Check for "table X already exists" / "index X already exists" ───
  const tableExistsMatch = rawMsg.match(/table\s+([^\s:]+)\s+already exists/i) || rawMsg.match(/relation "([^"]+)" already exists/i);
  if (tableExistsMatch) {
    const tableName = tableExistsMatch[1].replace(/["']/g, '');
    details.token = tableName;
    // Find CREATE TABLE line for this table
    for (let l = 0; l < lines.length; l++) {
      const lineText = lines[l];
      const reg = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`]?${tableName}["'\`]?`, 'i');
      if (reg.test(lineText)) {
        details.line = l + 1;
        details.column = lineText.toLowerCase().indexOf(tableName.toLowerCase()) + 1;
        break;
      }
    }
    if (!details.line) {
      const pos = findTokenPosition(sql, tableName);
      if (pos) { details.line = pos.line; details.column = pos.column; }
    }
    details.cause = `A table named "${tableName}" already exists in this database.`;
    details.suggestion = `Use "CREATE TABLE IF NOT EXISTS ${tableName} ..." or drop the existing table first using "DROP TABLE IF EXISTS ${tableName};".`;
  }

  const indexExistsMatch = rawMsg.match(/index\s+([^\s:]+)\s+already exists/i);
  if (indexExistsMatch) {
    const indexName = indexExistsMatch[1].replace(/["']/g, '');
    details.token = indexName;
    const pos = findTokenPosition(sql, indexName);
    if (pos) { details.line = pos.line; details.column = pos.column; }
    details.cause = `An index named "${indexName}" already exists in the database.`;
    details.suggestion = `Use "CREATE INDEX IF NOT EXISTS ${indexName} ..." or drop the existing index with "DROP INDEX IF EXISTS ${indexName};".`;
  }

  // ── 3c. Non-deterministic functions in generated columns ───────────────────
  if (/non-deterministic functions prohibited in generated columns/i.test(rawMsg)) {
    for (let l = 0; l < lines.length; l++) {
      const lineText = lines[l];
      if (/GENERATED\s+ALWAYS\s+AS/i.test(lineText) && /CURRENT_DATE|CURRENT_TIMESTAMP|datetime|random|now/i.test(lineText)) {
        details.line = l + 1;
        details.column = lineText.search(/CURRENT_DATE|CURRENT_TIMESTAMP|datetime|random|now/i) + 1;
        break;
      }
    }
    details.cause = `SQLite does not permit non-deterministic expressions (like CURRENT_DATE, CURRENT_TIMESTAMP, or datetime('now')) in GENERATED (computed) column definitions because their output varies over time.`;
    details.suggestion = `Remove CURRENT_DATE from the GENERATED ALWAYS AS clause, or evaluate active status dynamically in queries (e.g. SELECT (end_date IS NULL OR end_date > CURRENT_DATE) AS is_active).`;
  }

  // ── 4. Check for "no such column: <name>" ────────────────────────────────
  const noColMatch = rawMsg.match(/no such column:\s*([^\s:]+)/i) || rawMsg.match(/column "([^"]+)" does not exist/i);
  if (noColMatch) {
    const colName = noColMatch[1].replace(/["']/g, '');
    details.token = colName;
    if (!details.line) {
      const pos = findTokenPosition(sql, colName);
      if (pos) { details.line = pos.line; details.column = pos.column; }
    }
    details.cause = `Column "${colName}" was not found in the referenced tables.`;
    details.suggestion = `Check for typos in column name "${colName}", or use single quotes '${colName}' if this was intended as a text string.`;
  }

  // ── 5. Check for "table X has no column named Y" ─────────────────────────
  const tableHasNoColMatch = rawMsg.match(/table\s+([^\s]+)\s+has no column named\s+([^\s:]+)/i);
  if (tableHasNoColMatch) {
    const targetTable = tableHasNoColMatch[1];
    const targetCol = tableHasNoColMatch[2];
    details.token = targetCol;
    if (!details.line) {
      const pos = findTokenPosition(sql, targetCol);
      if (pos) { details.line = pos.line; details.column = pos.column; }
    }
    details.cause = `Table "${targetTable}" has no column named "${targetCol}".`;
    details.suggestion = `Check the column names defined on "${targetTable}" or alter the table to add "${targetCol}".`;
  }

  // ── 6. Incomplete input ──────────────────────────────────────────────────
  if (/incomplete input/i.test(rawMsg)) {
    details.line = lines.length;
    details.column = lines[lines.length - 1].length + 1;
    if (inSingleQuote) {
      details.cause = 'Unclosed single quote string literal.';
      details.suggestion = 'Add a closing single quote (\') to terminate the string literal.';
    } else if (openParens > closeParens) {
      details.cause = `Unclosed parenthesis: Found ${openParens} opening '(' but only ${closeParens} closing ')'.`;
      details.suggestion = `Add ${openParens - closeParens} closing ')' at the end of the statement.`;
    } else {
      details.cause = 'The SQL statement is incomplete and ended prematurely.';
      details.suggestion = 'Complete the statement by providing the required clause arguments or closing brackets/quotes.';
    }
  }

  // ── 7. Constraint violations ─────────────────────────────────────────────
  const uniqueMatch = rawMsg.match(/UNIQUE constraint failed:\s*(.+)/i) || rawMsg.match(/duplicate key value violates unique constraint\s*"?([^"\s]+)?"?/i);
  if (uniqueMatch) {
    const rawTarget = (uniqueMatch[1] || '').trim();
    const parts = rawTarget.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const firstPart = parts[0] || '';
    const colName = firstPart.includes('.') ? firstPart.split('.').pop()! : firstPart;
    const tableName = firstPart.includes('.') ? firstPart.split('.')[0] : '';

    if (colName && !details.line) {
      const pos = findTokenPosition(sql, colName);
      if (pos) {
        details.line = pos.line;
        details.column = pos.column;
        details.token = colName;
      }
    }

    if (tableName && colName) {
      details.cause = `A UNIQUE constraint on column "${colName}" in table "${tableName}" was violated because one of the rows you are inserting has an email/value that already exists in the database (or is duplicated in your batch).`;
    } else {
      details.cause = `A unique constraint was violated (${rawTarget || 'duplicate key'}). A row with these values already exists in the database.`;
    }

    details.suggestion = `• To skip duplicate rows and insert only new records, use "INSERT OR IGNORE INTO ${tableName || 'table'} ..."\n• To overwrite existing records, use "INSERT OR REPLACE INTO ${tableName || 'table'} ..."\n• Or use DELETE FROM ${tableName || 'table'}; to clear previous data before re-inserting.`;
  }

  const fkMatch = rawMsg.match(/FOREIGN KEY constraint failed/i) || rawMsg.match(/violates foreign key constraint/i);
  if (fkMatch) {
    details.cause = 'Foreign key constraint violation: A foreign key column references a parent ID that does not exist in the referenced table.';
    details.suggestion = '• Ensure referenced parent records exist before inserting child records.\n• If you deleted and re-inserted rows in SQLite, AUTOINCREMENT assigns new IDs (e.g. 17+ instead of 1). Either supply explicit IDs in your INSERTs (e.g. INSERT INTO users (id, ...)), or reset sequence counters with "DELETE FROM sqlite_sequence;" before re-seeding.';
  }

  const notNullMatch = rawMsg.match(/NOT NULL constraint failed:\s*(.+)/i) || rawMsg.match(/null value in column "([^"]+)" violates not-null constraint/i);
  if (notNullMatch) {
    const col = notNullMatch[1];
    details.cause = `Column "${col}" has a NOT NULL constraint and cannot be NULL.`;
    details.suggestion = `Provide a non-NULL value for "${col}" or define a DEFAULT value on the column.`;
  }

  const checkMatch = rawMsg.match(/CHECK constraint failed:\s*(.+)/i) || rawMsg.match(/violates check constraint/i);
  if (checkMatch) {
    details.cause = `CHECK constraint condition failed (${checkMatch[1] || 'condition not satisfied'}).`;
    details.suggestion = 'Ensure the inserted/updated values satisfy all CHECK constraint expressions on the table.';
  }

  // ── 8. Ambiguous column name ─────────────────────────────────────────────
  const ambigMatch = rawMsg.match(/ambiguous column name:\s*(.+)/i);
  if (ambigMatch) {
    const col = ambigMatch[1];
    details.token = col;
    if (!details.line) {
      const pos = findTokenPosition(sql, col);
      if (pos) { details.line = pos.line; details.column = pos.column; }
    }
    details.cause = `Column name "${col}" is ambiguous because it exists in multiple joined tables.`;
    details.suggestion = `Qualify the column with its table or alias name (e.g. "table_name.${col}").`;
  }

  // ── Fallback line/column & snippet ───────────────────────────────────────
  if (!details.line) {
    // If no line was determined, default to line 1 or last line
    details.line = 1;
    details.column = 1;
  }

  if (details.line && details.column) {
    details.snippet = buildErrorSnippet(sql, details.line, details.column);
  }

  if (!details.cause) {
    details.cause = 'SQL execution error.';
    details.suggestion = 'Review the SQL syntax and ensure all table names, column names, and clauses are valid.';
  }

  return details;
}

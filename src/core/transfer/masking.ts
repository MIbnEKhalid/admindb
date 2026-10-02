export interface MaskingRule {
  columnPattern: string; // regex or exact column name like 'email', 'password', 'phone'
  strategy: 'email' | 'password' | 'phone' | 'name' | 'redact' | 'hash';
  customValue?: string;
}

export const DEFAULT_MASKING_RULES: MaskingRule[] = [
  { columnPattern: 'email|e_mail|mail', strategy: 'email' },
  { columnPattern: 'pass|password|passwd|pwd|secret|token|api_key|auth', strategy: 'password' },
  { columnPattern: 'phone|mobile|cell|telephone', strategy: 'phone' },
  { columnPattern: 'first_name|last_name|full_name|username|user_name', strategy: 'name' },
];

/**
 * Applies anonymization/masking on a single row based on column names.
 */
export function maskRowData(
  row: Record<string, unknown>,
  rules: MaskingRule[] = DEFAULT_MASKING_RULES,
  rowIndex = 1,
): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...row };

  for (const [colName, val] of Object.entries(row)) {
    if (val === null || val === undefined) continue;

    for (const rule of rules) {
      const regex = new RegExp(rule.columnPattern, 'i');
      if (regex.test(colName)) {
        switch (rule.strategy) {
          case 'email':
            masked[colName] = `user${rowIndex}@masked.test`;
            break;
          case 'password':
            if (/token|secret|key|auth/i.test(colName) && !/pass|pwd/i.test(colName)) {
              masked[colName] = `masked_${rowIndex}_${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;
            } else {
              // Standard test bcrypt/hash with unique suffix per row to satisfy UNIQUE constraints
              masked[colName] = `$2b$10$maskedpwdhash${String(rowIndex).padStart(6, '0')}${Math.random().toString(36).substring(2, 14)}`;
            }
            break;
          case 'phone':
            masked[colName] = `+1555000${String(rowIndex).padStart(4, '0')}`;
            break;
          case 'name':
            masked[colName] = `Test User ${rowIndex}`;
            break;
          case 'redact':
            masked[colName] = `[REDACTED_${rowIndex}]`;
            break;
          case 'hash':
            masked[colName] = `hash_${rowIndex}_${Math.random().toString(36).substring(2, 8)}`;
            break;
        }
        break; // Match first rule
      }
    }
  }

  return masked;
}

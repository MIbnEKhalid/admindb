import { Transform, Readable, type TransformCallback } from 'node:stream';
import { csvEscape } from './csv';

/**
 * Creates a Transform stream that receives row objects and emits formatted JSON array chunks.
 */
export function createJsonStream(): Transform {
  let isFirst = true;
  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(chunk: Record<string, unknown>, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        const str = JSON.stringify(chunk, null, 2);
        if (isFirst) {
          isFirst = false;
          this.push(`[\n  ${str.replace(/\n/g, '\n  ')}`);
        } else {
          this.push(`,\n  ${str.replace(/\n/g, '\n  ')}`);
        }
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      if (isFirst) {
        this.push('[]');
      } else {
        this.push('\n]');
      }
      callback();
    },
  });
}

/**
 * Creates a Transform stream that receives row objects and emits RFC 4180 CSV chunks.
 */
export function createCsvStream(columns: string[]): Transform {
  let headerSent = false;
  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(chunk: Record<string, unknown>, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        if (!headerSent) {
          headerSent = true;
          const header = columns.map(csvEscape).join(',');
          this.push(`${header}\r\n`);
        }
        const line = columns.map((c) => csvEscape(chunk[c])).join(',');
        this.push(`${line}\r\n`);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      if (!headerSent) {
        this.push(`${columns.map(csvEscape).join(',')}\r\n`);
      }
      callback();
    },
  });
}

/**
 * Parses an async iterable stream of text chunks into batched CSV lines.
 */
export async function parseCsvStreamBatched(
  stream: AsyncIterable<string | Buffer>,
  onBatch: (rows: string[][]) => Promise<void>,
  batchSize = 500,
): Promise<number> {
  let buffer = '';
  let inQuotes = false;
  let row: string[] = [];
  let field = '';
  let totalRows = 0;
  let batch: string[][] = [];

  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    buffer += text;

    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (inQuotes) {
        if (ch === '"') {
          if (buffer[i + 1] === '"') {
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
        if (row.length > 1 || (row[0] !== undefined && row[0] !== '')) {
          batch.push(row);
          totalRows++;
          if (batch.length >= batchSize) {
            await onBatch(batch);
            batch = [];
          }
        }
        row = [];
      } else if (ch !== '\r') {
        field += ch;
      }
    }
    buffer = '';
  }

  if (field || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row[0] !== undefined && row[0] !== '')) {
      batch.push(row);
      totalRows++;
    }
  }

  if (batch.length > 0) {
    await onBatch(batch);
  }

  return totalRows;
}

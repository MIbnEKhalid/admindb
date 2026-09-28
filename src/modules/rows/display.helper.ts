import type { TableInfoData } from '../../db/index';
import { encodePk, normalizeCell, formatBytes } from '../../utils/common';
import { isJsonString } from '../../utils/datatype';
import { resolveBlobBuffer, sniffBlobMime } from './blob.helper';

export interface DisplayCell {
  name: string;
  value: unknown;
  isNull: boolean;
  display: string;
  type?: string;
  isBlob?: boolean;
  isJson?: boolean;
  isImage?: boolean;
  isUrl?: boolean;
  isColor?: boolean;
  blobSize?: string;
  blobMime?: string;
  blobExt?: string;
  blobUrl?: string;
}

export interface DisplayRow {
  cells: DisplayCell[];
  pkEncoded: string | null;
  refs?: { table: string; from: string; to: string; value: string; count: number }[];
}

export function buildDisplayRows(
  rawRows: Record<string, unknown>[],
  info: TableInfoData,
  dbId?: string,
  table?: string,
  basePath = '',
): DisplayRow[] {
  const pkCols = info.primaryKey.length ? info.primaryKey : ['_rowid_'];
  return rawRows.map((row) => {
    const pkEncoded = encodePk(pkCols.map((c) => row[c]));
    return {
      cells: info.columns.map((c) => {
        const raw = row[c.name];
        const v = normalizeCell(raw);
        const isNull = v == null;
        const typeUpper = (c.type || '').toUpperCase();
        const isBlob =
          typeUpper.includes('BLOB') ||
          typeUpper.includes('BYTEA') ||
          Buffer.isBuffer(raw) ||
          raw instanceof Uint8Array ||
          (typeof v === 'string' && (/^0x[0-9a-f]{8,}$/i.test(v) || /^\\x[0-9a-f]{8,}$/i.test(v)));
        let isJson = false;
        let isImage = false;
        let isUrl = false;
        let isColor = false;
        let blobSize = '';
        let blobMime = '';
        let blobExt = '';
        let blobUrl = '';

        if (!isNull) {
          const str = String(v);
          if (isBlob) {
            const buf = resolveBlobBuffer(raw ?? v);
            const mimeInfo = sniffBlobMime(buf);
            blobSize = formatBytes(buf.length);
            blobMime = mimeInfo.mime;
            blobExt = mimeInfo.ext;
            isImage = mimeInfo.isImage;
            if (table && pkEncoded && dbId) {
              blobUrl = `${basePath}/api/tables/${encodeURIComponent(dbId)}/${encodeURIComponent(table)}/row/${encodeURIComponent(pkEncoded)}/blob/${encodeURIComponent(c.name)}`;
            }
          } else if (isJsonString(v) || typeUpper.includes('JSON')) {
            isJson = isJsonString(v);
          } else {
            if (/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(str)) isUrl = true;
            else if (/^#(?:[0-9a-fA-F]{3}){1,2}$|^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/i.test(str)) isColor = true;
          }
        }

        return {
          name: c.name,
          value: v,
          isNull,
          display: isNull ? '' : String(v),
          type: c.type,
          isBlob,
          isJson,
          isImage,
          isUrl,
          isColor,
          blobSize,
          blobMime,
          blobExt,
          blobUrl,
        };
      }),
      pkEncoded,
    };
  });
}

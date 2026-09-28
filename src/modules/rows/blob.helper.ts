import { sniffMimeType, analyzeBlob, type MimeAnalysis, type BlobMetadata } from '../../utils/datatype';

export function resolveBlobBuffer(rawVal: unknown): Buffer {
  if (Buffer.isBuffer(rawVal) || rawVal instanceof Uint8Array) {
    return Buffer.isBuffer(rawVal) ? rawVal : Buffer.from(rawVal);
  }
  if (typeof rawVal === 'string' && /^0x[0-9a-f]*$/i.test(rawVal)) {
    return Buffer.from(rawVal.slice(2), 'hex');
  }
  return Buffer.from(String(rawVal ?? ''), 'utf8');
}

export function parseBlobPayload(data: unknown, format = 'base64'): Buffer {
  if (data === undefined || data === null) {
    throw new Error('Payload data is required.');
  }
  if (format === 'base64') {
    const base64Str = String(data).replace(/^data:[^;]+;base64,/, '');
    return Buffer.from(base64Str, 'base64');
  }
  if (format === 'hex') {
    const hexStr = String(data).replace(/^0x/i, '');
    return Buffer.from(hexStr, 'hex');
  }
  return Buffer.from(String(data), 'utf8');
}

export function getBlobMetadata(rawVal: unknown): { isNull: boolean } & (Partial<BlobMetadata>) {
  if (rawVal === null || rawVal === undefined) {
    return { isNull: true, size: 0, sizeFormatted: '0 B' };
  }
  const meta = analyzeBlob(rawVal as Uint8Array | Buffer | string);
  return { isNull: false, ...meta };
}

export function sniffBlobMime(buf: Buffer): MimeAnalysis {
  return sniffMimeType(buf);
}

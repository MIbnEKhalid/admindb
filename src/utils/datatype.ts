import { formatBytes } from './common.js';

export interface MimeAnalysis {
  mime: string;
  ext: string;
  isImage: boolean;
  isText: boolean;
  isPdf: boolean;
  isAudio: boolean;
  isVideo: boolean;
}

export interface HexDumpLine {
  offset: string;
  hex: string;
  ascii: string;
}

export interface HexDumpResult {
  lines: HexDumpLine[];
  totalBytes: number;
  truncated: boolean;
}

export interface BlobMetadata extends MimeAnalysis {
  size: number;
  sizeFormatted: string;
  hexDump?: HexDumpResult;
  textPreview?: string | null;
}

const mimeResult = (
  mime: string,
  ext: string,
  flags: Partial<Omit<MimeAnalysis, 'mime' | 'ext'>> = {},
): MimeAnalysis => ({
  mime,
  ext,
  isImage: false,
  isText: false,
  isPdf: false,
  isAudio: false,
  isVideo: false,
  ...flags,
});

/**
 * Sniff MIME type and file extension from magic bytes of a buffer.
 */
export function sniffMimeType(buf: Uint8Array | Buffer): MimeAnalysis {
  const len = buf.length;
  if (len === 0) return mimeResult('application/octet-stream', 'bin');

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (len >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return mimeResult('image/png', 'png', { isImage: true });
  }

  // JPEG: FF D8 FF
  if (len >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return mimeResult('image/jpeg', 'jpg', { isImage: true });
  }

  // GIF: GIF87a or GIF89a
  if (len >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return mimeResult('image/gif', 'gif', { isImage: true });
  }

  // WebP: RIFF....WEBP
  if (len >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return mimeResult('image/webp', 'webp', { isImage: true });
  }

  // BMP: 42 4D
  if (len >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return mimeResult('image/bmp', 'bmp', { isImage: true });
  }

  // ICO: 00 00 01 00
  if (len >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return mimeResult('image/x-icon', 'ico', { isImage: true });
  }

  // PDF: %PDF
  if (len >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return mimeResult('application/pdf', 'pdf', { isPdf: true });
  }

  // MP3: ID3 or sync byte
  if ((len >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (len >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    return mimeResult('audio/mpeg', 'mp3', { isAudio: true });
  }

  // WAV: RIFF....WAVE
  if (len >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) {
    return mimeResult('audio/wav', 'wav', { isAudio: true });
  }

  // OGG: OggS
  if (len >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return mimeResult('audio/ogg', 'ogg', { isAudio: true });
  }

  // MP4 video: ....ftyp
  if (len >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return mimeResult('video/mp4', 'mp4', { isVideo: true });
  }

  // WebM: 1A 45 DF A3
  if (len >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return mimeResult('video/webm', 'webm', { isVideo: true });
  }

  // Check for UTF-8 Text / SVG / JSON
  const sampleLen = Math.min(len, 1024);
  const sample = Buffer.from(buf.subarray(0, sampleLen)).toString('utf8');
  const trimmed = sample.trim();

  if (trimmed.startsWith('<svg') || (trimmed.startsWith('<?xml') && trimmed.includes('<svg'))) {
    return mimeResult('image/svg+xml', 'svg', { isImage: true, isText: true });
  }

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(sample);
      return mimeResult('application/json', 'json', { isText: true });
    } catch {
      /* not valid json */
    }
  }

  // Check if buffer contains mostly printable ASCII / UTF-8
  let nonPrintable = 0;
  for (let i = 0; i < sampleLen; i++) {
    const byte = buf[i];
    if (byte === 0 || (byte < 7 && byte !== 9 && byte !== 10 && byte !== 13)) {
      nonPrintable++;
    }
  }

  if (nonPrintable === 0) {
    return mimeResult('text/plain; charset=utf-8', 'txt', { isText: true });
  }

  return mimeResult('application/octet-stream', 'bin');
}

/**
 * Generate formatted 3-column Hex Dump (Offset | Hex Bytes | ASCII).
 */
export function generateHexDump(buf: Uint8Array | Buffer, maxBytes = 4096, bytesPerLine = 16): HexDumpResult {
  const totalBytes = buf.length;
  const limit = Math.min(totalBytes, maxBytes);
  const truncated = totalBytes > maxBytes;
  const lines: HexDumpLine[] = [];
  const mid = Math.floor(bytesPerLine / 2);

  for (let i = 0; i < limit; i += bytesPerLine) {
    const offset = i.toString(16).padStart(8, '0');
    const chunk = buf.subarray(i, Math.min(i + bytesPerLine, limit));
    const hexParts: string[] = [];
    let asciiPart = '';

    for (let j = 0; j < bytesPerLine; j++) {
      if (j < chunk.length) {
        const byte = chunk[j];
        hexParts.push(byte.toString(16).padStart(2, '0'));
        asciiPart += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
      } else {
        hexParts.push('  ');
        asciiPart += ' ';
      }
    }

    lines.push({
      offset,
      hex: `${hexParts.slice(0, mid).join(' ')}  ${hexParts.slice(mid).join(' ')}`,
      ascii: asciiPart,
    });
  }

  return { lines, totalBytes, truncated };
}

/**
 * Get comprehensive metadata for a binary buffer or hex string.
 */
export function analyzeBlob(data: Uint8Array | Buffer | string): BlobMetadata {
  let buf: Buffer;
  if (typeof data === 'string') {
    buf = /^0x/i.test(data) ? Buffer.from(data.slice(2), 'hex') : Buffer.from(data, 'utf8');
  } else {
    buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  const analysis = sniffMimeType(buf);
  let textPreview: string | null = null;
  if (analysis.isText || buf.length < 2048) {
    try {
      const txt = buf.toString('utf8');
      if (!/[\x00-\x08\x0E-\x1F]/.test(txt.slice(0, 512))) {
        textPreview = txt.slice(0, 4000);
      }
    } catch {
      /* ignore */
    }
  }

  return {
    ...analysis,
    size: buf.length,
    sizeFormatted: formatBytes(buf.length),
    hexDump: generateHexDump(buf),
    textPreview,
  };
}

/**
 * Detect whether a value is a valid JSON string (Object or Array).
 */
export function isJsonString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse and pretty format JSON string. Returns null if invalid.
 */
export function formatJsonSafely(value: unknown, indent = 2): string | null {
  if (value == null) return null;
  try {
    const obj = typeof value === 'string' ? JSON.parse(value) : value;
    return typeof obj === 'object' && obj !== null ? JSON.stringify(obj, null, indent) : null;
  } catch {
    return null;
  }
}

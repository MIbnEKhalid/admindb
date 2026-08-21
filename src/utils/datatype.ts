/**
 * Utilities for rich data type detection, MIME sniffing, hex dump generation,
 * and JSON inspection in AdminDB.
 */

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

/**
 * Sniff MIME type and file extension from magic bytes of a buffer.
 */
export function sniffMimeType(buf: Uint8Array | Buffer): MimeAnalysis {
  const len = buf.length;
  if (len === 0) {
    return { mime: 'application/octet-stream', ext: 'bin', isImage: false, isText: false, isPdf: false, isAudio: false, isVideo: false };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (len >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return { mime: 'image/png', ext: 'png', isImage: true, isText: false, isPdf: false, isAudio: false, isVideo: false };
  }

  // JPEG: FF D8 FF
  if (len >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', isImage: true, isText: false, isPdf: false, isAudio: false, isVideo: false };
  }

  // GIF: GIF87a or GIF89a (47 49 46 38 37/39 61)
  if (len >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return { mime: 'image/gif', ext: 'gif', isImage: true, isText: false, isPdf: false, isAudio: false, isVideo: false };
  }

  // WebP: RIFF....WEBP (52 49 46 46 ... 57 45 42 50)
  if (len >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { mime: 'image/webp', ext: 'webp', isImage: true, isText: false, isPdf: false, isAudio: false, isVideo: false };
  }

  // BMP: 42 4D
  if (len >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { mime: 'image/bmp', ext: 'bmp', isImage: true, isText: false, isPdf: false, isAudio: false, isVideo: false };
  }

  // ICO: 00 00 01 00
  if (len >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return { mime: 'image/x-icon', ext: 'ico', isImage: true, isText: false, isPdf: false, isAudio: false, isVideo: false };
  }

  // PDF: %PDF (25 50 44 46)
  if (len >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return { mime: 'application/pdf', ext: 'pdf', isImage: false, isText: false, isPdf: true, isAudio: false, isVideo: false };
  }

  // MP3: ID3 (49 44 33) or Sync 0xFF 0xFB/0xF3/0xF2
  if (len >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return { mime: 'audio/mpeg', ext: 'mp3', isImage: false, isText: false, isPdf: false, isAudio: true, isVideo: false };
  }
  if (len >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return { mime: 'audio/mpeg', ext: 'mp3', isImage: false, isText: false, isPdf: false, isAudio: true, isVideo: false };
  }

  // WAV: RIFF....WAVE
  if (len >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) {
    return { mime: 'audio/wav', ext: 'wav', isImage: false, isText: false, isPdf: false, isAudio: true, isVideo: false };
  }

  // OGG: OggS (4F 67 67 53)
  if (len >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return { mime: 'audio/ogg', ext: 'ogg', isImage: false, isText: false, isPdf: false, isAudio: true, isVideo: false };
  }

  // MP4 video: ....ftyp (66 74 79 70)
  if (len >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return { mime: 'video/mp4', ext: 'mp4', isImage: false, isText: false, isPdf: false, isAudio: false, isVideo: true };
  }

  // WebM: 1A 45 DF A3
  if (len >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { mime: 'video/webm', ext: 'webm', isImage: false, isText: false, isPdf: false, isAudio: false, isVideo: true };
  }

  // Check for UTF-8 Text / SVG / JSON
  const sampleLen = Math.min(len, 1024);
  const sample = Buffer.from(buf.subarray(0, sampleLen)).toString('utf8');
  const trimmed = sample.trim();

  // SVG: starts with <?xml or <svg
  if (trimmed.startsWith('<svg') || (trimmed.startsWith('<?xml') && trimmed.includes('<svg'))) {
    return { mime: 'image/svg+xml', ext: 'svg', isImage: true, isText: true, isPdf: false, isAudio: false, isVideo: false };
  }

  // JSON
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(sample);
      return { mime: 'application/json', ext: 'json', isImage: false, isText: true, isPdf: false, isAudio: false, isVideo: false };
    } catch {
      /* not valid json in sample */
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
    return { mime: 'text/plain; charset=utf-8', ext: 'txt', isImage: false, isText: true, isPdf: false, isAudio: false, isVideo: false };
  }

  return { mime: 'application/octet-stream', ext: 'bin', isImage: false, isText: false, isPdf: false, isAudio: false, isVideo: false };
}

/**
 * Generate formatted 3-column Hex Dump (Offset | Hex Bytes | ASCII).
 */
export function generateHexDump(buf: Uint8Array | Buffer, maxBytes = 4096, bytesPerLine = 16): HexDumpResult {
  const totalBytes = buf.length;
  const limit = Math.min(totalBytes, maxBytes);
  const truncated = totalBytes > maxBytes;
  const lines: HexDumpLine[] = [];

  for (let i = 0; i < limit; i += bytesPerLine) {
    const offset = i.toString(16).padStart(8, '0');
    const chunk = buf.subarray(i, Math.min(i + bytesPerLine, limit));
    
    const hexParts: string[] = [];
    let asciiPart = '';

    for (let j = 0; j < bytesPerLine; j++) {
      if (j < chunk.length) {
        const byte = chunk[j];
        hexParts.push(byte.toString(16).padStart(2, '0'));
        // Printable ASCII between 32 (space) and 126 (~)
        asciiPart += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.';
      } else {
        hexParts.push('  ');
        asciiPart += ' ';
      }
    }

    // Insert extra space in the middle for readability (e.g. after 8 bytes)
    const mid = Math.floor(bytesPerLine / 2);
    const hexFormatted = hexParts.slice(0, mid).join(' ') + '  ' + hexParts.slice(mid).join(' ');

    lines.push({
      offset,
      hex: hexFormatted,
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
    if (data.startsWith('0x') || data.startsWith('0X')) {
      buf = Buffer.from(data.slice(2), 'hex');
    } else {
      buf = Buffer.from(data, 'utf8');
    }
  } else {
    buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  const analysis = sniffMimeType(buf);
  let textPreview: string | null = null;
  if (analysis.isText || buf.length < 2048) {
    try {
      const txt = buf.toString('utf8');
      // If it looks like valid text
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
  if (!trimmed) return false;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Parse and pretty format JSON string. Returns null if invalid.
 */
export function formatJsonSafely(value: unknown, indent = 2): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, indent);
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, indent);
    } catch {
      return null;
    }
  }
  return null;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffMimeType, generateHexDump, analyzeBlob, isJsonString, formatJsonSafely } from '../src/utils/datatype';

test('sniffMimeType detects PNG, JPEG, GIF, WebP, SVG, PDF, and text', () => {
  // PNG magic bytes
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const pngResult = sniffMimeType(pngHeader);
  assert.equal(pngResult.mime, 'image/png');
  assert.equal(pngResult.ext, 'png');
  assert.equal(pngResult.isImage, true);

  // JPEG magic bytes
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const jpegResult = sniffMimeType(jpegHeader);
  assert.equal(jpegResult.mime, 'image/jpeg');
  assert.equal(jpegResult.ext, 'jpg');
  assert.equal(jpegResult.isImage, true);

  // GIF magic bytes
  const gifHeader = Buffer.from('GIF89a...');
  const gifResult = sniffMimeType(gifHeader);
  assert.equal(gifResult.mime, 'image/gif');
  assert.equal(gifResult.isImage, true);

  // PDF magic bytes
  const pdfHeader = Buffer.from('%PDF-1.4\n...');
  const pdfResult = sniffMimeType(pdfHeader);
  assert.equal(pdfResult.mime, 'application/pdf');
  assert.equal(pdfResult.isPdf, true);

  // Plain Text
  const textHeader = Buffer.from('Hello world, this is a plain text note.');
  const textResult = sniffMimeType(textHeader);
  assert.equal(textResult.mime, 'text/plain; charset=utf-8');
  assert.equal(textResult.isText, true);

  // SVG
  const svgHeader = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  const svgResult = sniffMimeType(svgHeader);
  assert.equal(svgResult.mime, 'image/svg+xml');
  assert.equal(svgResult.isImage, true);
});

test('generateHexDump generates standard 3-column hex dump', () => {
  const buf = Buffer.from('Hello, AdminDB! 1234567890');
  const dump = generateHexDump(buf, 4096, 16);
  assert.ok(dump.lines.length >= 2);
  assert.equal(dump.lines[0].offset, '00000000');
  assert.ok(dump.lines[0].hex.length > 10);
  assert.ok(dump.lines[0].ascii.includes('Hello, AdminDB!'));
  assert.equal(dump.totalBytes, buf.length);
  assert.equal(dump.truncated, false);
});

test('analyzeBlob extracts metadata, hex dump, and text preview', () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const meta = analyzeBlob(pngHeader);
  assert.equal(meta.mime, 'image/png');
  assert.equal(meta.isImage, true);
  assert.equal(meta.size, 8);
  assert.equal(meta.sizeFormatted, '8 B');
  assert.ok(meta.hexDump);
  assert.equal(meta.hexDump.lines.length, 1);
});

test('isJsonString and formatJsonSafely detect and format JSON safely', () => {
  assert.equal(isJsonString('{"name": "AdminDB", "version": 1}'), true);
  assert.equal(isJsonString('[1, 2, 3]'), true);
  assert.equal(isJsonString('not json'), false);
  assert.equal(isJsonString(123), false);

  const formatted = formatJsonSafely('{"a":1,"b":2}', 2);
  assert.equal(formatted, '{\n  "a": 1,\n  "b": 2\n}');
});

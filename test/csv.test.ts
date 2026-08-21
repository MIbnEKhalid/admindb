import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, toJson, parseCsv, csvEscape } from '../src/utils/csv';

test('csvEscape quotes fields with commas, quotes or newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(0), '0');
  assert.equal(csvEscape(false), 'false');
});

test('toCsv writes a header and quotes tricky cells', () => {
  const csv = toCsv(
    [
      { id: 1, name: 'Ada', note: 'a, b "c"' },
      { id: 2, name: null, note: 'x' },
    ],
    ['id', 'name', 'note'],
  );
  assert.equal(csv, 'id,name,note\r\n1,Ada,"a, b ""c"""\r\n2,,x');
});

test('toJson pretty-prints an array of objects', () => {
  const json = toJson([{ a: 1, b: null }]);
  assert.equal(json, '[\n  {\n    "a": 1,\n    "b": null\n  }\n]');
});

test('parseCsv handles quoted fields, embedded commas and newlines', () => {
  const rows = parseCsv('a,b,c\r\n1,"two, words","line1\nline2"\r\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'two, words', 'line1\nline2'],
  ]);
});

test('parseCsv handles escaped quotes and skips blank lines', () => {
  const rows = parseCsv('x,y\n"say ""hi""",2\n\n3,4\n');
  assert.deepEqual(rows, [
    ['x', 'y'],
    ['say "hi"', '2'],
    ['3', '4'],
  ]);
});

test('parseCsv handles a file without a trailing newline', () => {
  const rows = parseCsv('a,b\n1,2');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('toCsv → parseCsv round-trips typical data', () => {
  const rows = [
    { name: 'O\'Reilly, John', age: 42, note: 'line1\nline2' },
    { name: 'x', age: null, note: 'plain' },
  ];
  const columns = ['name', 'age', 'note'];
  const parsed = parseCsv(toCsv(rows, columns));
  assert.deepEqual(parsed, [
    ['name', 'age', 'note'],
    ["O'Reilly, John", '42', 'line1\nline2'],
    ['x', '', 'plain'],
  ]);
});

#!/usr/bin/env node
/**
 * file_doc.cjs
 *
 * Generates documentation/file.md with:
 *   1. A file-tree in the exact format of Windows `tree /F` (UTF-8 box-drawing chars)
 *      rendered identically across Windows, Linux, and macOS.
 *   2. A lines-of-code summary sorted by extension and by file.
 *
 * Usage:
 *   node scripts/file_doc.cjs           # writes documentation/file.md
 *   node scripts/file_doc.cjs --stdout  # prints to stdout instead
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(__dirname, '..');
const TARGET   = path.join(ROOT_DIR, 'docs', 'FilesStats.md');

/** Dirs skipped in the tree */
const TREE_SKIP = new Set(['node_modules', '.git', '.claude', 'dist', '/db/']);

/** Dirs skipped when counting lines of code */
const CODE_SKIP = new Set(['node_modules', '.git', 'data', '.claude', 'dist', 'db']);

/** Exact filenames never counted */
const FILE_SKIP = new Set(['package-lock.json', '.gitignore']);

/** File extensions never counted */
const EXT_SKIP = new Set([
  'jpg','jpeg','png','gif','svg','webp','ico','bmp',
  'mp4','mov','mkv','webm','avi','exe', 'db', 'shm', 'wal' ,'sqlite', 'db-shm', 'db-wal'
]);

/** Public asset directory (relative to ROOT_DIR, forward slashes) */
const PUBLIC_DIR = 'public';

/** Case-insensitive locale compare options (reused) */
const CI = { sensitivity: 'base' };

// ── Helpers ───────────────────────────────────────────────────────────────────

const isBackendJs = (rel) =>
  rel.endsWith('.js') && !rel.replace(/\\/g, '/').startsWith(PUBLIC_DIR + '/');

const isAssetJs = (rel) => {
  const norm = rel.replace(/\\/g, '/');
  return norm.endsWith('.js') && norm.startsWith(PUBLIC_DIR + '/');
};

/**
 * Derive the "bucket" label used for the per-extension summary.
 *  - .js outside public/  → "backend-js"
 *  - .js inside  public/  → "asset-js"
 *  - everything else      → lowercased extension (or "noext")
 */
function bucketOf(rel) {
  const norm = rel.replace(/\\/g, '/');
  const dot  = norm.lastIndexOf('.');
  const ext  = dot === -1 ? 'noext' : norm.slice(dot + 1).toLowerCase();

  if (ext === 'js') {
    return norm.startsWith(PUBLIC_DIR + '/') ? 'asset-js' : 'backend-js';
  }
  return ext;
}

// ── Tree builder (exact tree /F box drawing style) ────────────────────────────

function readDir(dir, skip) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const subdirs = [];
  const files   = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!skip.has(e.name)) subdirs.push(e.name);
    } else if (e.isFile()) {
      files.push(e.name);
    }
  }
  subdirs.sort((a, b) => a.localeCompare(b, undefined, CI));
  files.sort((a, b)   => a.localeCompare(b, undefined, CI));
  return { subdirs, files };
}

/**
 * Build the directory tree in the format produced by `tree /F`.
 *
 * Returns { lines: string[], totalDirs: number, totalFiles: number }
 */
function buildTree(rootDir) {
  const lines      = ['Repo'];
  let   totalDirs  = 0;
  let   totalFiles = 0;

  const { subdirs: rootDirs, files: rootFiles } = readDir(rootDir, TREE_SKIP);
  totalFiles += rootFiles.length;

  for (const f of rootFiles) lines.push('│   ' + f);
  if (rootFiles.length > 0 && rootDirs.length > 0) lines.push('│   ');

  function walk(dirPath, prefix) {
    totalDirs++;
    const { subdirs, files } = readDir(dirPath, TREE_SKIP);
    totalFiles += files.length;

    if (subdirs.length > 0) {
      for (const f of files) lines.push(prefix + '│   ' + f);
      if (files.length > 0) lines.push(prefix + '│');

      for (let i = 0; i < subdirs.length; i++) {
        const isLast = i === subdirs.length - 1;
        const branch = isLast ? '└───' : '├───';
        lines.push(prefix + branch + subdirs[i]);
        walk(path.join(dirPath, subdirs[i]), prefix + (isLast ? '    ' : '│   '));
        if (!isLast) lines.push(prefix + '│');
      }
    } else {
      for (const f of files) lines.push(prefix + '    ' + f);
    }
  }

  for (let i = 0; i < rootDirs.length; i++) {
    const isLast = i === rootDirs.length - 1;
    const branch = isLast ? '└───' : '├───';
    lines.push(branch + rootDirs[i]);
    walk(path.join(rootDir, rootDirs[i]), isLast ? '    ' : '│   ');
    if (!isLast) lines.push('│');
  }

  return { lines, totalDirs, totalFiles };
}

// ── Line counter ──────────────────────────────────────────────────────────────

function countLines(filePath) {
  return new Promise((resolve, reject) => {
    let lines   = 0;
    let hadData = false;

    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk) => {
      hadData = true;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) lines++;
      }
    });
    rs.on('end', () => {
      if (!hadData) return resolve(0);
      fs.promises.stat(filePath).then((st) => {
        if (st.size > 0) {
          // Count final line if file doesn't end with a newline
          const fd  = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(1);
          fs.readSync(fd, buf, 0, 1, st.size - 1);
          fs.closeSync(fd);
          if (buf[0] !== 10) lines++;
        }
        resolve(lines);
      }).catch(reject);
    });
    rs.on('error', reject);
  });
}

async function* walkCodeFiles(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!CODE_SKIP.has(ent.name)) yield* walkCodeFiles(full);
    } else if (ent.isFile()) {
      if (FILE_SKIP.has(ent.name)) continue;
      const dot = ent.name.lastIndexOf('.');
      const ext = dot === -1 ? '' : ent.name.slice(dot + 1).toLowerCase();
      if (!EXT_SKIP.has(ext)) yield full;
    }
  }
}

// ── Markdown generator ────────────────────────────────────────────────────────

function buildMarkdown(treeLines, totalDirs, totalFiles, results) {
  const total = results.reduce((s, r) => s + r.lines, 0);

  // Aggregate by bucket (backend-js / asset-js / other ext)
  const byBucket = {};
  for (const r of results) {
    const key = bucketOf(r.file);
    byBucket[key] = (byBucket[key] || 0) + r.lines;
  }
  const bucketLines = Object.entries(byBucket)
    .sort((a, b) => b[1] - a[1])
    .map(([key, c]) => key.padEnd(12, ' ') + ' ' + c);

  // Top files, sorted by descending line count (already sorted upstream)
  const topFiles = results.map(
    r => r.lines.toString().padStart(8, ' ') + ' ' + r.file.replace(/\//g, '\\')
  );

  return [
    '',
    '## File & Folder Structure',
    '',
    '[Back To Main](../README.md)',
    '',
    '',
    `${totalDirs} directories, ${totalFiles} files`,
    '',
    '### Files',
    '```',
    ...treeLines,
    '```',
    '',
    '### Lines of code',
    'node count_lines.cjs',
    "exlcuding node_modules,docs,documenatation,data,package-lock.json,gitignore,git,'jpg',",
    "'jpeg','png','gif','svg','webp','ico','bmp','mp4','mov','mkv','webm','avi',",
    '',
    '```',
    `TOTAL_LINES ${total}`,
    '',
    ...bucketLines,
    '--- Top files by lines ---',
    ...topFiles,
    '```',
    '',
  ].join('\r\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const selfPath = path.resolve(__filename);

  // Collect all code files
  const results = [];
  for await (const fullPath of walkCodeFiles(ROOT_DIR)) {
    if (path.resolve(fullPath) === selfPath) continue;
    const rel = path.relative(ROOT_DIR, fullPath);
    try {
      const lines = await countLines(fullPath);
      results.push({ file: rel, lines });
    } catch (err) {
      process.stderr.write('skip ' + rel + ': ' + err.message + '\n');
    }
  }
  results.sort((a, b) => b.lines - a.lines);

  // Build tree
  const { lines: treeLines, totalDirs, totalFiles } = buildTree(ROOT_DIR);

  // First pass
  let md = buildMarkdown(treeLines, totalDirs, totalFiles, results);

  // Self-convergence: update TARGET's own line count and regenerate
  const targetRel = path.relative(ROOT_DIR, TARGET).replace(/\//g, '\\');
  const entry     = results.find(r => r.file.replace(/\//g, '\\') === targetRel);
  if (entry) {
    entry.lines = md.split(/\r?\n/).length - 1;
    results.sort((a, b) => b.lines - a.lines);
    md = buildMarkdown(treeLines, totalDirs, totalFiles, results);
  }

  if (process.argv.includes('--stdout')) {
    process.stdout.write(md);
    return;
  }

  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, md, 'utf8');

  const total = results.reduce((s, r) => s + r.lines, 0);
  console.log(`Generated ${path.relative(process.cwd(), TARGET)}`);
  console.log(`Directories: ${totalDirs}, Files: ${totalFiles}, Total Lines: ${total}`);
}

main().catch(err => { console.error(err); process.exit(1); });
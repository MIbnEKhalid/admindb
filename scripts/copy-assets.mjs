// Copies non-compiled assets (Handlebars views + static files) into dist/
// and minifies all JavaScript and templates to ensure comment-free, minimal footprint.
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { minify } from 'terser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const viewsDir = path.join(distDir, 'views');
const publicDir = path.join(distDir, 'public');

mkdirSync(distDir, { recursive: true });
cpSync(path.join(root, 'src', 'views'), viewsDir, { recursive: true });
cpSync(path.join(root, 'src', 'public'), publicDir, { recursive: true });

// 1. Remove unnecessary input.css from dist
const inputCssPath = path.join(publicDir, 'css', 'input.css');
if (existsSync(inputCssPath)) {
  try {
    unlinkSync(inputCssPath);
  } catch {}
}

// 2. Clean and strip comments from Handlebars templates
function processHbsFiles(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      processHbsFiles(fullPath);
    } else if (entry.endsWith('.hbs')) {
      let content = readFileSync(fullPath, 'utf8');
      // Strip {{!-- ... --}} comments, {{! ... }} comments, and <!-- ... --> comments
      content = content.replace(/\{\{!--[\s\S]*?--\}\}/g, '');
      content = content.replace(/\{\{![\s\S]*?\}\}/g, '');
      content = content.replace(/<!--[\s\S]*?-->/g, '');
      // Trim empty lines
      content = content.replace(/^\s*[\r\n]/gm, '');
      writeFileSync(fullPath, content.trim() + '\n', 'utf8');
    }
  }
}
processHbsFiles(viewsDir);

// 3. Minify all JavaScript files in dist (client + server)
async function processJsFiles(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      await processJsFiles(fullPath);
    } else if (entry.endsWith('.js')) {
      const code = readFileSync(fullPath, 'utf8');
      const isClient = fullPath.includes(path.join('dist', 'public'));
      try {
        const minified = await minify(code, {
          module: !isClient,
          compress: isClient ? true : { defaults: true },
          mangle: isClient ? true : false,
          format: {
            comments: false,
            beautify: false,
          },
        });
        if (minified.code) {
          writeFileSync(fullPath, minified.code, 'utf8');
        }
      } catch (err) {
        console.warn(`[minify-warning] Skipping ${fullPath}: ${err.message}`);
      }
    }
  }
}

// 4. Minify all TypeScript declaration files (.d.ts) in dist
function minifyDts(code) {
  // 1. Remove comments
  let stripped = '';
  let inString = null;
  let inComment = null;

  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const next = code[i + 1];

    if (inComment === 'line') {
      if (char === '\n' || char === '\r') {
        inComment = null;
        stripped += char;
      }
      continue;
    }

    if (inComment === 'block') {
      if (char === '*' && next === '/') {
        inComment = null;
        i++;
      }
      continue;
    }

    if (inString) {
      stripped += char;
      if (char === '\\') {
        if (next) {
          stripped += next;
          i++;
        }
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inComment = 'line';
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inComment = 'block';
      i++;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      inString = char;
      stripped += char;
      continue;
    }

    stripped += char;
  }

  // 2. Separate string literals and minify TypeScript types/signatures
  const stringRegex = /('([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`)/g;
  let lastIdx = 0;
  let match;
  let result = '';

  while ((match = stringRegex.exec(stripped)) !== null) {
    const nonString = stripped.slice(lastIdx, match.index);
    result += minifyDtsNonString(nonString);
    result += match[0];
    lastIdx = match.index + match[0].length;
  }
  result += minifyDtsNonString(stripped.slice(lastIdx));

  return result.trim();
}

function minifyDtsNonString(str) {
  return str
    .replace(/\s+/g, ' ')
    // Remove space around punctuation
    .replace(/\s*([;:,{}[\]()|&?=<>]|\.\.\.)\s*/g, '$1')
    // Keep single space between identifiers / keywords
    .replace(/([A-Za-z0-9_$])\s+([A-Za-z0-9_$])/g, '$1 $2')
    .replace(/\bimport\s+type\b/g, 'import type ')
    .replace(/\bexport\s+declare\b/g, 'export declare ')
    .replace(/\bexport\s+type\b/g, 'export type ')
    .replace(/\bexport\s+interface\b/g, 'export interface ')
    .replace(/\bexport\s+const\b/g, 'export const ')
    .replace(/\bexport\s+class\b/g, 'export class ')
    .replace(/\bexport\s+default\b/g, 'export default ')
    .replace(/\bexport\s+abstract\b/g, 'export abstract ')
    .replace(/\bdeclare\s+class\b/g, 'declare class ')
    .replace(/\bdeclare\s+function\b/g, 'declare function ')
    .replace(/\bdeclare\s+const\b/g, 'declare const ')
    .replace(/\bdeclare\s+type\b/g, 'declare type ')
    .replace(/\bdeclare\s+interface\b/g, 'declare interface ')
    .replace(/\bdeclare\s+abstract\b/g, 'declare abstract ')
    .replace(/\bdeclare\s+namespace\b/g, 'declare namespace ')
    .replace(/\bdeclare\s+module\b/g, 'declare module ')
    .replace(/\bextends\b/g, ' extends ')
    .replace(/\bimplements\b/g, ' implements ')
    .replace(/\bkeyof\b/g, ' keyof ')
    .replace(/\btypeof\b/g, ' typeof ')
    .replace(/\breadonly\b/g, 'readonly ')
    .replace(/\bprivate\b/g, 'private ')
    .replace(/\bprotected\b/g, 'protected ')
    .replace(/\bpublic\b/g, 'public ')
    .replace(/\bstatic\b/g, 'static ')
    .replace(/\bas\s+const\b/g, 'as const')
    .replace(/\bfrom\b/g, ' from ')
    .replace(/\s+/g, ' ');
}

function processDtsFiles(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      processDtsFiles(fullPath);
    } else if (entry.endsWith('.d.ts')) {
      const code = readFileSync(fullPath, 'utf8');
      const minified = minifyDts(code);
      writeFileSync(fullPath, minified + '\n', 'utf8');
    }
  }
}

await processJsFiles(distDir);
processDtsFiles(distDir);

console.log('[copy-assets] Processed views, minified JS, and minified .d.ts into dist/ (comment-free, minimalist format).');



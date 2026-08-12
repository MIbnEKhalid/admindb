// Copies non-compiled assets (Handlebars views + static files) into dist/.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

mkdirSync(path.join(root, 'dist'), { recursive: true });
cpSync(path.join(root, 'src', 'views'), path.join(root, 'dist', 'views'), { recursive: true });
cpSync(path.join(root, 'src', 'public'), path.join(root, 'dist', 'public'), { recursive: true });

console.log('[copy-assets] Copied views and public assets into dist/.');

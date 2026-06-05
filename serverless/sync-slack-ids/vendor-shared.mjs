/** Copy ../shared vào node_modules khi dev local (`npm install` trong thư mục lambda). SAM dùng Makefile. */
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const dest = join(root, 'node_modules', '@slack-dishes', 'shared');
const src = join(root, '..', 'shared');

if (!existsSync(src)) {
  console.log('vendor-shared: skip (../shared not found — SAM Makefile sẽ copy khi build)');
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(root, 'node_modules', '@slack-dishes'), { recursive: true });
cpSync(src, dest, { recursive: true });

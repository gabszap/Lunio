// `npm run clean` portável (o antigo `rm -rf` não existe no Windows).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const target of ['dist', 'server.js']) {
  fs.rmSync(path.join(root, target), { recursive: true, force: true });
}
console.log('Limpo: dist/ e server.js');

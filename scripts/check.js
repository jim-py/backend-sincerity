import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let count = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory() && entry.name !== 'generated') await check(url);
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', fileURLToPath(url)], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(1);
      count++;
    }
  }
}
for (const dir of ['src', 'scripts', 'requests', 'test']) await check(new URL(`../${dir}/`, import.meta.url));
console.info(`Syntax OK: ${count} JavaScript files; no application modules executed.`);

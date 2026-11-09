import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';

try {
  const path = new URL('../.env', import.meta.url);
  let content;
  let exists = true;
  try { content = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; content = ''; exists = false; }
  const matches = [...content.matchAll(/^(?:export\s+)?AI_SERVICE_KEY\s*=\s*([^\r\n]*)/gm)];
  if (matches.length > 1) throw new Error('duplicate');
  const value = matches[0]?.[1].trim().replace(/^(['"])(.*)\1$/, '$2') ?? '';
  if (value && !value.startsWith('REPLACE_')) {
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(value)) throw new Error('invalid');
    console.info('[ai-key] existing_key_preserved_value_not_printed');
  } else {
    const line = `AI_SERVICE_KEY=${randomBytes(32).toString('hex')}`;
    content = matches.length ? content.replace(matches[0][0], line) : `${content}${content.endsWith('\n') || !content ? '' : '\n'}${line}\n`;
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: exists ? 'w' : 'wx' });
    if (process.platform !== 'win32') await chmod(path, 0o600);
    console.info('[ai-key] generated_in_local_env_value_not_printed');
  }
} catch {
  console.error('[ai-key] could_not_update_env_check_permissions_and_duplicate_or_invalid_entries');
  process.exitCode = 1;
}

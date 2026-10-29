// Optional fixture generator for the user's manual checks. Does not import/run the API.
import { mkdir, writeFile } from 'node:fs/promises';

const directory = new URL('./generated/', import.meta.url);
await mkdir(directory, { recursive: true });
const cases = {
  '299': { content: 'я'.repeat(299) },
  '300': { content: 'я'.repeat(300) },
  '10000': { content: 'я'.repeat(10_000) },
  '10001': { content: 'я'.repeat(10_001) },
  whitespace: { content: ' \t\n\u00a0\u2003 ' },
  emoji: { content: '🌿'.repeat(300) },
  formatting: { content: ` \n${'я'.repeat(300)}  \n\n  конец\n ` },
  nul: { content: `${'я'.repeat(300)}\0` },
  surrogate: { content: `${'я'.repeat(300)}\ud800` },
  'wrong-type': { content: 123 },
  missing: {},
  unknown: { content: 'я'.repeat(300), extra: true },
  array: [{ content: 'я'.repeat(300) }],
  oversized: { content: ' '.repeat(128 * 1024) },
};
for (const [name, document] of Object.entries(cases)) {
  await writeFile(new URL(`${name}.json`, directory), JSON.stringify(document), 'utf8');
}
await writeFile(new URL('invalid-json.json', directory), '{"content":', 'utf8');
// 10 000 supplementary-plane code points even in fully escaped JSON fit under 128 KiB.
await writeFile(new URL('escaped-emoji-10000.json', directory), `{"content":"${'\\ud83c\\udf3f'.repeat(10_000)}"}`, 'utf8');
console.info('Manual request fixtures written to requests/generated/. No API requests made.');

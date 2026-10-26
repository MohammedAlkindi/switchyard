import { readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const page = new URL('public/index.html', root);
const html = await readFile(page, 'utf8');
const marker = /(<span class="version-chip" id="version-chip">)[^<]*(<\/span>)/;
if (!marker.test(html)) throw new Error('Website version marker is missing');
await writeFile(page, html.replace(marker, `$1v${version}$2`));

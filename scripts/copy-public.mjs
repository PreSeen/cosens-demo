// Copies the files the pages load from the site root (logos, favicon) and sends / to the demo hub.
import {cp, mkdir, writeFile} from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
await mkdir(dist, {recursive: true});
await cp(new URL('../public/', import.meta.url), dist, {recursive: true});
await writeFile(new URL('_redirects', dist), '/ /demo/ 302\n');

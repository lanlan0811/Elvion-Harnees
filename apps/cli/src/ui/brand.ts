import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrandAssets } from './types.js';

/** Keep the source bytes as UTF-8 text; the grid only ignores empty boundary rows. */
export async function loadBrandAssets(directory: string): Promise<BrandAssets> {
  const [largeFox, smallFox, wordmark] = await Promise.all(
    ['elvion-fox-large.txt', 'elvion-fox-small.txt', 'elvion-wordmark.txt'].map(name => readFile(join(directory, name), 'utf8')),
  );
  if (largeFox === undefined || smallFox === undefined || wordmark === undefined) throw new Error('Brand assets are incomplete.');
  return { largeFox, smallFox, wordmark };
}

export function brandLines(source: string): string[] {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

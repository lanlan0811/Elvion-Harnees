import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/assets', { recursive: true });
await cp('assets/brand', 'dist/assets/brand', { recursive: true });
await cp('prompts', 'dist/prompts', { recursive: true });

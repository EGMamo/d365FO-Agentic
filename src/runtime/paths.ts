import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const defaultRepoRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '../..');

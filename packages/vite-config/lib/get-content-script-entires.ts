import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const getContentScriptEntries = (matchesDir: string) => {
  const entryPoints: Record<string, string> = {};
  const entries = readdirSync(matchesDir);

  entries.forEach((folder: string) => {
    const filePath = resolve(matchesDir, folder);
    const isFolder = statSync(filePath).isDirectory();
    const haveIndexTsFile = readdirSync(filePath).includes('index.ts');
    const haveIndexTsxFile = readdirSync(filePath).includes('index.tsx');

    if (isFolder && !(haveIndexTsFile || haveIndexTsxFile)) {
      throw new Error(`${folder} in \`matches\` doesn't have index.ts or index.tsx file`);
    } else {
      entryPoints[folder] = resolve(filePath, haveIndexTsFile ? 'index.ts' : 'index.tsx');
    }
  });

  return entryPoints;
};

export const getMainWorldEntries = (matchesDir: string) => {
  const entryPoints: Record<string, string> = {};
  const entries = readdirSync(matchesDir);

  entries.forEach((folder: string) => {
    const filePath = resolve(matchesDir, folder);
    if (!statSync(filePath).isDirectory()) return;
    const files = readdirSync(filePath);
    if (files.includes('main.ts')) {
      entryPoints[`${folder}_main`] = resolve(filePath, 'main.ts');
    }
  });

  return entryPoints;
};

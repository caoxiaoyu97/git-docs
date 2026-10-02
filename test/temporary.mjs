import { after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';

const directories = [];
const root = path.resolve('dist/test');

export async function temporary(prefix = 'case-') {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, prefix));
  directories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of directories) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

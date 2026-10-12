import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Arquivo JSON gravado de forma atômica (arquivo temporário + rename), com as
// gravações enfileiradas para não se sobreporem.
export function createJsonStore(filePath, { fallback, logger = console } = {}) {
  let queue = Promise.resolve();
  return {
    async read() {
      try {
        return JSON.parse(await readFile(filePath, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') logger.error(`Não foi possível ler ${filePath}: ${error.message}`);
        return structuredClone(fallback);
      }
    },
    write(value) {
      queue = queue
        .then(async () => {
          const temporary = `${filePath}.${process.pid}.tmp`;
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(temporary, JSON.stringify(value), 'utf8');
          await rename(temporary, filePath);
        })
        .catch((error) => logger.error(`Não foi possível gravar ${filePath}: ${error.message}`));
      return queue;
    },
  };
}

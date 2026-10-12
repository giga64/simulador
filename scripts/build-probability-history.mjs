// Reconstrói as chances de cada clube ao fim de cada rodada já disputada e grava
// em data/probability-history-2026.json. Rode depois de atualizar o snapshot.
// Uso: npm run build:history
import { readFile, writeFile } from 'node:fs/promises';
import { mergeVerifiedResults } from '../src/history-integrity.js';
import { DEFAULT_SETTINGS } from '../src/model/season-model.js';
import { reconstructRoundHistory } from '../src/model/probability-history.js';

const readJson = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const [season, backfill] = await Promise.all([
  readJson('../data/season-2026.json'),
  readJson('../data/historical-backfill-2026.json'),
]);
const reconciled = mergeVerifiedResults(season, backfill);
const started = Date.now();
const entries = reconstructRoundHistory(reconciled);
await writeFile(
  new URL('../data/probability-history-2026.json', import.meta.url),
  `${JSON.stringify({ version: 1, season: season.season, settings: DEFAULT_SETTINGS, iterations: 10_000, entries })}\n`,
);
console.log(`${entries.length} rodadas reconstruídas em ${((Date.now() - started) / 1000).toFixed(1)} s.`);

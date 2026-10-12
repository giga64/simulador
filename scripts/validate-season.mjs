import { readFile } from 'node:fs/promises';
import { mergeVerifiedResults } from '../src/history-integrity.js';
import { validateSeasonData } from '../src/season-data.js';

const readJson = async (relativePath) => JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
const [season, logos, backfill] = await Promise.all([
  readJson('../data/season-2026.json'),
  readJson('../assets/logos.json'),
  readJson('../data/historical-backfill-2026.json'),
]);
let reconciledSeason, errors, warnings;
try {
  reconciledSeason = mergeVerifiedResults(season, backfill);
  ({ errors, warnings } = validateSeasonData(reconciledSeason, logos));
} catch (error) {
  errors = [error.message || String(error)];
  warnings = [];
}

if (errors.length) {
  console.error('Falha na validação dos dados:');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(
    `Dados da temporada ${season.season} válidos: ${reconciledSeason.results.length} resultados (${backfill.results.length} correções verificadas); ${season.fixtures.length} partidas.`,
  );
}
warnings.forEach((warning) => console.warn(`Aviso: ${warning}`));

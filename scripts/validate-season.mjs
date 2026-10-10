import { readFile } from 'node:fs/promises';
import { validateSeasonData } from '../src/season-data.js';

const readJson = async (relativePath) => JSON.parse(
  await readFile(new URL(relativePath, import.meta.url), 'utf8'),
);
const [season, logos] = await Promise.all([
  readJson('../data/season-2026.json'),
  readJson('../assets/logos.json'),
]);
const { errors, warnings } = validateSeasonData(season, logos);

if (errors.length) {
  console.error('Falha na validação dos dados:');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`Dados da temporada ${season.season} válidos: ${season.results.length} resultados; ${season.fixtures.length} partidas.`);
}
warnings.forEach((warning) => console.warn(`Aviso: ${warning}`));

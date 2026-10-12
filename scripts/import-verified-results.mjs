import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeVerifiedResults } from '../src/history-integrity.js';
import { validateSeasonData } from '../src/season-data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [csvPath, sourceUrl, sourceName] = process.argv.slice(2);
if (!csvPath || !sourceUrl) {
  console.error('Uso: node scripts/import-verified-results.mjs <resultados.csv> <fonte-https> [nome-da-fonte]');
  process.exitCode = 1;
} else {
  await runImport(csvPath, sourceUrl, sourceName);
}

async function runImport(inputPath, sourceUrlValue, sourceNameValue) {
  try {
    const sourceUrl = new URL(sourceUrlValue);
    if (sourceUrl.protocol !== 'https:') throw new Error('A fonte informada precisa usar HTTPS.');

    const [season, logos, csv] = await Promise.all([
      readJson(path.join(root, 'data', 'season-2026.json')),
      readJson(path.join(root, 'assets', 'logos.json')),
      readFile(path.resolve(inputPath), 'utf8'),
    ]);
    const validation = validateSeasonData(season, logos);
    if (validation.errors.length) throw new Error(validation.errors.join(' '));

    const backfillPath = path.join(root, 'data', 'historical-backfill-2026.json');
    const backfill = await readJson(backfillPath);
    const existing = new Map(
      backfill.results.map((result) => [`${result.round}:${result.home}:${result.away}`, result]),
    );
    const knownResults = new Map(
      season.results.map((result) => [`${result.round}:${result.home}:${result.away}`, result]),
    );
    const source = {
      name: sourceNameValue?.trim() || sourceUrl.hostname,
      url: sourceUrl.toString(),
      verifiedAt: new Date().toISOString(),
    };
    const additions = [];
    const lines = csv
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/);
    if (lines.shift()?.trim() !== 'round,home,away,homeGoals,awayGoals') {
      throw new Error('Cabeçalho CSV esperado: round,home,away,homeGoals,awayGoals.');
    }

    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const cells = line.split(',').map((value) => value.trim());
      if (cells.length !== 5) throw new Error(`Linha ${index + 2}: são esperadas exatamente 5 colunas.`);
      const [roundValue, home, away, homeGoalsValue, awayGoalsValue] = cells;
      if (![roundValue, homeGoalsValue, awayGoalsValue].every((value) => /^\d+$/.test(value))) {
        throw new Error(`Linha ${index + 2}: rodada e placares precisam ser números inteiros explícitos.`);
      }
      const result = {
        round: Number(roundValue),
        home,
        away,
        homeGoals: Number(homeGoalsValue),
        awayGoals: Number(awayGoalsValue),
      };
      const key = `${result.round}:${result.home}:${result.away}`;
      if (!Object.hasOwn(season.teams, home) || !Object.hasOwn(season.teams, away)) {
        throw new Error(`Linha ${index + 2}: use as siglas de clubes conhecidas no snapshot.`);
      }
      if (knownResults.has(key)) {
        const known = knownResults.get(key);
        if (known.homeGoals !== result.homeGoals || known.awayGoals !== result.awayGoals) {
          throw new Error(`Linha ${index + 2}: o placar diverge do snapshot existente (${key}).`);
        }
        continue;
      }
      if (existing.has(key)) {
        const known = existing.get(key);
        if (known.homeGoals !== result.homeGoals || known.awayGoals !== result.awayGoals) {
          throw new Error(`Linha ${index + 2}: o placar diverge da correção já importada (${key}).`);
        }
        continue;
      }
      additions.push({ ...result, source });
    }

    const next = {
      schemaVersion: 1,
      season: 2026,
      updatedAt: new Date().toISOString(),
      results: [...backfill.results, ...additions],
    };
    mergeVerifiedResults(season, next);
    if (!additions.length) {
      console.log('Nenhum resultado novo: os placares informados já constam nos dados locais.');
      return;
    }

    const temporaryPath = `${backfillPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, backfillPath);
    console.log(`${additions.length} resultado(s) verificado(s) importado(s) em data/historical-backfill-2026.json.`);
    console.log(`Fonte registrada: ${source.name} (${source.url}). Confira e publique esse arquivo junto com o site.`);
  } catch (error) {
    console.error(`Importação cancelada: ${error.message || String(error)}`);
    process.exitCode = 1;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

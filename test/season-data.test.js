import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateSeasonData } from '../src/season-data.js';

const loadJson = async (relativePath) => JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
const [season, logos] = await Promise.all([loadJson('../data/season-2026.json'), loadJson('../assets/logos.json')]);

test('the season snapshot has a complete and consistent 380-match calendar', () => {
  const result = validateSeasonData(season, logos);
  assert.deepEqual(result.errors, []);
  assert.equal(season.teams && Object.keys(season.teams).length, 20);
  assert.equal(season.fixtures.length, 380);
  assert.equal(season.results.length, 289);
  assert.equal(season.fixtures.filter((fixture) => fixture.status !== 'played').length, 91);
});

test('duplicate fixtures and unmatched scores fail validation', () => {
  const corrupt = structuredClone(season);
  corrupt.fixtures[1].id = corrupt.fixtures[0].id;
  corrupt.results[0].homeGoals = 21;

  const { errors } = validateSeasonData(corrupt, logos);
  assert.ok(errors.some((error) => error.includes('identificadores')));
  assert.ok(errors.some((error) => error.includes('placar inválido')));
});

test('a scheduled match without a kickoff is rejected', () => {
  const corrupt = structuredClone(season);
  const fixture = corrupt.fixtures.find((match) => match.status === 'scheduled');
  fixture.kickoff = null;

  assert.ok(validateSeasonData(corrupt, logos).errors.some((error) => error.includes('horário')));
});

test('overlapping qualification and relegation ranges fail validation', () => {
  const corrupt = structuredClone(season);
  corrupt.qualificationModel.sudamericanaLeagueEnd = 17;

  assert.ok(validateSeasonData(corrupt, logos).errors.some((error) => error.includes('faixas')));
});

test('partially played rounds are reported without rejecting valid snapshots', () => {
  const inProgress = structuredClone(season);
  const fixture = inProgress.fixtures.find((match) => match.round === 30);
  fixture.status = 'played';
  inProgress.results.push({
    round: fixture.round,
    home: fixture.home,
    away: fixture.away,
    homeGoals: 1,
    awayGoals: 0,
  });

  const result = validateSeasonData(inProgress, logos);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((warning) => warning.includes('Rodada 30 incompleta')));
});

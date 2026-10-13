import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeEspnCompetition } from '../src/competitions/adapters/espn.js';
import { parseFootballTxt } from '../src/competitions/adapters/openfootball.js';
import { expectedGoals, expectedScore, goalFactor, updateElo } from '../src/competitions/elo.js';
import { COMPETITIONS } from '../src/competitions/formats.js';
import { libertadoresSlots } from '../src/competitions/qualification.js';
import { validateCompetition } from '../src/competitions/schema.js';
import { createStrength, simulateKnockout } from '../src/competitions/simulate.js';
import { createCompetitionService } from '../src/server/competitions.js';

const fixture = async (name) => readFile(new URL(`./fixtures/competitions/${name}`, import.meta.url), 'utf8');
const loadEspn = async (id) => {
  const slug = COMPETITIONS[id].espnSlug;
  return normalizeEspnCompetition(id, {
    scoreboard: JSON.parse(await fixture(`espn-${slug}-2026.json`)),
    standings: JSON.parse(await fixture(`espn-${slug}-standings.json`)),
  });
};
const ratings = JSON.parse(await readFile(new URL('../data/club-ratings-2026.json', import.meta.url), 'utf8'));

test('ESPN: Libertadores vira grupos, mata-mata com ida e volta e final indefinida', async () => {
  const cup = await loadEspn('libertadores');
  assert.deepEqual(validateCompetition(cup), []);
  assert.equal(cup.groups.length, 8);
  assert.ok(cup.groups.every((group) => group.table.length === 4));
  assert.equal(cup.currentStage, 'semifinals');
  const quarterfinals = cup.stages.find((stage) => stage.id === 'quarterfinals');
  assert.equal(quarterfinals.ties.length, 4);
  for (const tie of quarterfinals.ties) {
    assert.equal(tie.legs.length, 2);
    assert.ok(tie.winner && tie.teams.includes(tie.winner));
    assert.equal(tie.aggregate.length, 2);
  }
  const final = cup.stages.find((stage) => stage.id === 'final');
  assert.deepEqual(final.ties[0].teams, [null, null], 'final com clubes "a definir"');
});

test('ESPN: confronto decidido nos pênaltis guarda o placar da disputa', async () => {
  const cup = await loadEspn('copaDoBrasil');
  const byPenalties = cup.stages.flatMap((stage) => stage.ties).filter((tie) => tie.decidedBy === 'penalties');
  assert.ok(byPenalties.length > 10);
  const lastLeg = byPenalties[0].legs.at(-1);
  assert.ok(Number.isInteger(lastLeg.penalties.home) && Number.isInteger(lastLeg.penalties.away));
  assert.equal(cup.groups.length, 0, 'Copa do Brasil não tem grupos');
});

test('ESPN: textos da fonte são limpos e logos só do CDN da ESPN', () => {
  const competition = normalizeEspnCompetition('libertadores', {
    scoreboard: {
      leagues: [{ season: { year: 2026 } }],
      events: [
        {
          id: '1',
          date: '2026-10-01T00:00Z',
          season: { slug: 'final' },
          competitions: [
            {
              status: { type: { state: 'pre' } },
              venue: { fullName: '<script>x</script>Centenario' },
              competitors: [
                { homeAway: 'home', team: { id: '1', displayName: 'A<b>', logo: 'https://evil.example/x.png' } },
                { homeAway: 'away', team: { id: '2', displayName: 'B' } },
              ],
            },
          ],
        },
      ],
    },
    standings: null,
  });
  assert.equal(competition.teams['1'].name, 'Ab');
  assert.equal(competition.teams['1'].logo, null);
  assert.equal(competition.stages.at(-1).ties[0].legs[0].venue, 'scriptx/scriptCentenario');
});

test('openfootball: placar de 90 min, prorrogação e pênaltis', async () => {
  const matches = parseFootballTxt(await fixture('openfootball-2022_copal.txt'), { competition: 'libertadores' });
  assert.equal(matches.length, 155);
  const shootout = matches.find((match) => match.home === 'Guaraní' && match.penalties);
  assert.deepEqual([shootout.homeGoals, shootout.awayGoals, ...shootout.penalties], [2, 3, 4, 5]);
  assert.equal(matches.at(-1).stage, 'Final');
  const cup = parseFootballTxt(await fixture('openfootball-2025_brcup.txt'), { competition: 'copaDoBrasil' });
  const extra = cup.find((match) => match.extraTime);
  assert.deepEqual([extra.homeGoals, extra.awayGoals], [1, 1]);
});

test('Elo: favorito ganha menos pontos, goleada pesa mais', () => {
  assert.equal(goalFactor(1), 1);
  assert.equal(goalFactor(2), 1.5);
  assert.equal(goalFactor(4), 15 / 8);
  assert.ok(Math.abs(expectedScore(1600, 1600) - 0.5) < 1e-12);
  const ratings = new Map([
    ['strong', 1800],
    ['weak', 1400],
  ]);
  updateElo(ratings, { home: 'strong', away: 'weak', homeGoals: 1, awayGoals: 0 }, { k: 30, homeAdvantage: 0 });
  assert.ok(ratings.get('strong') - 1800 < 5);
  assert.equal(ratings.get('strong') + ratings.get('weak'), 3200, 'soma constante');
  const [lambdaA, lambdaB] = expectedGoals(1700, 1500, { base: 0.2, home: 0.2, slope: 0.9 });
  assert.ok(lambdaA > lambdaB);
});

test('simulação do mata-mata: probabilidades coerentes e reproduzíveis', async () => {
  const cup = await loadEspn('libertadores');
  const strength = createStrength({ ratings });
  const first = simulateKnockout(cup, strength, { iterations: 4000, seed: 7 });
  const second = simulateKnockout(cup, strength, { iterations: 4000, seed: 7 });
  assert.deepEqual(first.probabilities, second.probabilities);
  const champions = Object.values(first.probabilities).reduce((sum, value) => sum + (value.champion || 0), 0);
  assert.ok(Math.abs(champions - 100) < 1e-9, 'exatamente um campeão por simulação');
  const finalists = Object.values(first.probabilities).reduce((sum, value) => sum + (value.final || 0), 0);
  assert.ok(Math.abs(finalists - 200) < 1e-9, 'dois finalistas');
  for (const value of Object.values(first.probabilities)) {
    assert.ok(value.semifinals >= (value.final || 0) && (value.final || 0) >= (value.champion || 0));
  }
});

test('simulação: ajuste manual de força muda as chances', async () => {
  const cup = await loadEspn('copaDoBrasil');
  const base = simulateKnockout(cup, createStrength({ ratings }), { iterations: 3000 });
  const boosted = simulateKnockout(cup, createStrength({ ratings, overrides: { 6273: 300 } }), { iterations: 3000 });
  assert.ok(boosted.probabilities['6273'].champion > base.probabilities['6273'].champion + 10, 'Grêmio +300');
});

test('confronto já decidido não é sorteado de novo', async () => {
  const cup = await loadEspn('libertadores');
  const decided = structuredClone(cup);
  const semifinal = decided.stages.find((stage) => stage.id === 'semifinals');
  semifinal.ties[0].winner = semifinal.ties[0].teams[0];
  const result = simulateKnockout(decided, createStrength({ ratings }), { iterations: 2000 });
  assert.equal(result.probabilities[semifinal.ties[0].teams[0]].final, 100);
  assert.equal(result.probabilities[semifinal.ties[0].teams[1]].final ?? 0, 0);
});

test('vagas na Libertadores: copa e campeões continentais empurram a linha de corte', () => {
  const order = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const toAppCode = (id) => ({ 1: 'A', 2: 'F', 3: 'H', 4: 'B' })[id] || null;
  const result = libertadoresSlots({
    leagueOrders: [order, order],
    cups: {
      libertadores: { champions: ['1', null] },
      sudamericana: { champions: [null, null] },
      copaDoBrasil: { champions: ['2', '4'], runnersUp: ['3', '9999'] },
    },
    toAppCode,
  });
  // Simulação 1: 8 vagas (7 + campeão da Libertadores, que é A). F e H pela Copa.
  // Faltam 5 vagas pela tabela: A (já está), B, C, D, E, G -> vai até G (7º).
  assert.equal(result.chance.G, 50);
  // Simulação 2: 7 vagas; B campeão (já G5) e um vice fora da Série A: liga vai até o 6º.
  assert.equal(result.chance.F, 100);
  assert.equal(result.cutoff['7'], 50);
  assert.equal(result.cutoff['6'], 50);
});

test('serviço de copas: cache curto com jogo ao vivo e versão antiga se a fonte cair', async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const scoreboard = JSON.parse(await fixture('espn-bra.copa_do_brazil-2026.json'));
  const service = createCompetitionService({
    clock: () => now,
    logger: { error() {} },
    fetchImpl: async () => {
      calls++;
      if (fail) return { ok: false, status: 500 };
      return { ok: true, json: async () => scoreboard };
    },
  });
  await service.read('copaDoBrasil');
  await service.read('copaDoBrasil');
  assert.equal(calls, 1, 'dentro de 2 min usa o cache');
  now = 121_000;
  fail = true;
  const stale = await service.read('copaDoBrasil');
  assert.equal(stale.stale, true);
  await assert.rejects(() => service.read('nada'), /desconhecida/);
});

// Simulação do mata-mata das copas a partir do estado atual (esquema único).
// Para cada confronto ainda aberto: sorteia os jogos que faltam (Poisson com
// gols esperados pelo Elo), soma o agregado, aplica prorrogação só onde o
// regulamento manda e decide nos pênaltis. Os vencedores se cruzam na fase
// seguinte na ordem dos confrontos.
import { createSeededRandom } from '../random.js';
import { remainingFraction } from '../model/live-matches.js';
import { COMPETITIONS } from './formats.js';
import { expectedGoals } from './elo.js';

function poissonSample(lambda, random) {
  // Knuth: suficiente para λ pequeno (gols de futebol).
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = random();
  while (p > limit) {
    k++;
    p *= random();
  }
  return k;
}

// Força efetiva: Elo + ajuste manual + diferença de mando em relação à referência.
export function createStrength({ ratings, overrides = {}, defaultElo = 1450 }) {
  const { teams, model } = ratings;
  const reference = model.referenceHomeAdvantage ?? 70;
  const leagueHome = (id) => {
    const league = teams[id]?.league;
    return model.cupHomeAdvantageByLeague?.[league]?.elo ?? model.homeAdvantageByLeague?.[league] ?? reference;
  };
  return {
    elo: (id) => (teams[id]?.elo ?? defaultElo) + (Number(overrides[id]) || 0),
    known: (id) => Boolean(teams[id]),
    homeExtra: (id, { national = false } = {}) =>
      national
        ? (model.homeAdvantageByLeague?.[teams[id]?.league] ?? reference) - reference
        : leagueHome(id) - reference,
    model,
  };
}

function minuteFromClock(clock) {
  const minute = Number(/^(\d+)/.exec(clock || '')?.[1]);
  return Number.isFinite(minute) ? Math.min(90, minute) : 45;
}

// Gols de um jogo ainda não terminado (ou do tempo restante de um jogo ao vivo).
function sampleLeg(leg, strength, { neutral, national }, random) {
  const extraHome = neutral ? 0 : strength.homeExtra(leg.home, { national });
  const [lambdaHome, lambdaAway] = expectedGoals(
    strength.elo(leg.home) + extraHome,
    strength.elo(leg.away),
    strength.model,
    {
      neutral,
    },
  );
  if (leg.state === 'in') {
    const fraction = remainingFraction(minuteFromClock(leg.clock));
    return [
      leg.homeGoals + poissonSample(lambdaHome * fraction, random),
      leg.awayGoals + poissonSample(lambdaAway * fraction, random),
    ];
  }
  return [poissonSample(lambdaHome, random), poissonSample(lambdaAway, random)];
}

function resolveTie(tie, stageFormat, strength, context, random) {
  const [a, b] = tie.teams;
  let goalsA = 0;
  let goalsB = 0;
  let lastLeg = null;
  for (const leg of tie.legs) {
    const neutral = Boolean(stageFormat.neutral);
    const [homeGoals, awayGoals] =
      leg.state === 'post' ? [leg.homeGoals, leg.awayGoals] : sampleLeg(leg, strength, { ...context, neutral }, random);
    goalsA += leg.home === a ? homeGoals : awayGoals;
    goalsB += leg.home === a ? awayGoals : homeGoals;
    lastLeg = leg;
  }
  if (goalsA !== goalsB) return goalsA > goalsB ? a : b;
  // Prorrogação (30 min = 1/3 do jogo) só onde o regulamento manda.
  if (stageFormat.extraTime) {
    const [lambdaA, lambdaB] = expectedGoals(strength.elo(a), strength.elo(b), strength.model, { neutral: true });
    const extraA = poissonSample(lambdaA / 3, random);
    const extraB = poissonSample(lambdaB / 3, random);
    if (extraA !== extraB) return extraA > extraB ? a : b;
  }
  // Pênaltis: no histórico 2012–2025 (openfootball) o mandante venceu 50%.
  void lastLeg;
  return random() < 0.5 ? a : b;
}

// Confrontos de uma fase com os clubes já sabidos ou vindos da fase anterior.
function tiesForStage(stage, previousWinners) {
  if (!stage.ties.length) return [];
  return stage.ties.map((tie, index) => {
    if (tie.teams[0] && tie.teams[1]) return tie;
    const a = previousWinners?.[index * 2] ?? null;
    const b = previousWinners?.[index * 2 + 1] ?? null;
    const legs =
      stage.legs === 1 || !tie.legs.length
        ? [{ id: `${tie.id}:sim`, home: a, away: b, state: 'pre' }]
        : tie.legs.map((leg, legIndex) => ({ ...leg, home: legIndex % 2 ? b : a, away: legIndex % 2 ? a : b }));
    return { ...tie, teams: [a, b], legs };
  });
}

// Resultado: chance de cada clube alcançar cada fase restante e ser campeão,
// mais o campeão e o vice de cada simulação (para o cálculo de vagas).
export function simulateKnockout(competition, strength, { iterations = 10_000, seed = 20261010 } = {}) {
  const format = COMPETITIONS[competition.id];
  const national = competition.id === 'copaDoBrasil';
  const random = createSeededRandom(seed ^ 0x9e3779b9);
  const stages = competition.stages.filter((stage) => stage.type === 'knockout');
  const startIndex = stages.findIndex((stage) => stage.ties.some((tie) => !tie.winner));
  const remaining = startIndex >= 0 ? stages.slice(startIndex) : [];
  const reach = {};
  const bump = (team, stageId) => {
    if (!team) return;
    reach[team] ??= {};
    reach[team][stageId] = (reach[team][stageId] || 0) + 1;
  };
  const champions = new Array(iterations);
  const runnersUp = new Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let winners = null;
    let lastTie = null;
    for (const stage of remaining) {
      const stageFormat = format.stages.find((item) => item.id === stage.id) || {};
      const ties = tiesForStage(stage, winners);
      winners = ties.map((tie) => {
        for (const team of tie.teams) bump(team, stage.id);
        lastTie = tie;
        return (
          tie.winner ||
          (tie.teams[0] && tie.teams[1]
            ? resolveTie(tie, stageFormat, strength, { national }, random)
            : tie.teams[0] || tie.teams[1])
        );
      });
    }
    const champion = remaining.length ? winners?.[0] : competition.champion;
    champions[iteration] = champion || null;
    runnersUp[iteration] = lastTie ? lastTie.teams.find((team) => team && team !== champion) || null : null;
    bump(champion, 'champion');
  }
  const probabilities = Object.fromEntries(
    Object.entries(reach).map(([team, counts]) => [
      team,
      Object.fromEntries(Object.entries(counts).map(([stageId, count]) => [stageId, (count / iterations) * 100])),
    ]),
  );
  return {
    iterations,
    stages: [...remaining.map((stage) => stage.id), 'champion'],
    probabilities,
    champions,
    runnersUp,
  };
}

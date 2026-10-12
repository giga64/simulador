import { createSeededRandom } from '../random.js';
import { applyPairwiseTieBreak } from './standings.js';
import { sampleIndex } from './poisson.js';

export const DEFAULT_ITERATIONS = 10_000;
const MAX_POINTS = 130;

// Simula o restante do campeonato `iterations` vezes.
//
// Os clubes são índices 0..teamCount-1. points/wins/goalDifference/goalsFor são
// os números atuais (jogos definidos já incluídos). Cada item de `fixtures` é um
// jogo ainda incerto: `cumulative` é a distribuição acumulada de placares
// (achatada, size x size) e baseHome/baseAway somam um placar já existente —
// usado para jogos ao vivo, em que se sorteia apenas o restante da partida.
// `track` >= 0 guarda o resultado (0 casa, 1 empate, 2 fora) daquela partida em
// cada simulação, para medir quais jogos mais mexem nas chances de um clube.
export function runMonteCarlo({
  teamCount,
  points,
  wins,
  goalDifference,
  goalsFor,
  headToHead,
  fixtures,
  cutPositions,
  relegationPlaces,
  iterations = DEFAULT_ITERATIONS,
  seed,
  trackedCount = 0,
}) {
  const random = createSeededRandom(seed);
  const positionCounts = Array.from({ length: teamCount }, () => new Array(teamCount).fill(0));
  const pointsHistogram = Array.from({ length: teamCount }, () => new Array(MAX_POINTS + 1).fill(0));
  const cutHistogram = cutPositions.map(() => new Array(MAX_POINTS + 1).fill(0));
  const relegatedByPoints = new Array(MAX_POINTS + 1).fill(0);
  const teamsByPoints = new Array(MAX_POINTS + 1).fill(0);
  const finalPositions = new Uint8Array(iterations * teamCount);
  const trackedOutcomes = new Uint8Array(iterations * trackedCount);
  const order = Array.from({ length: teamCount }, (_, index) => index);
  const P = new Int32Array(teamCount);
  const V = new Int32Array(teamCount);
  const D = new Int32Array(teamCount);
  const G = new Int32Array(teamCount);
  const h2h = headToHead.map((row) => Int32Array.from(row));

  for (let iteration = 0; iteration < iterations; iteration++) {
    P.set(points);
    V.set(wins);
    D.set(goalDifference);
    G.set(goalsFor);
    for (let team = 0; team < teamCount; team++) h2h[team].set(headToHead[team]);

    for (const fixture of fixtures) {
      const index = sampleIndex(fixture.cumulative, random());
      const x = (fixture.baseHome || 0) + Math.floor(index / fixture.size);
      const y = (fixture.baseAway || 0) + (index % fixture.size);
      const { home, away } = fixture;
      D[home] += x - y;
      D[away] += y - x;
      G[home] += x;
      G[away] += y;
      let outcome;
      if (x > y) {
        P[home] += 3;
        V[home]++;
        h2h[home][away] += 3;
        outcome = 0;
      } else if (x < y) {
        P[away] += 3;
        V[away]++;
        h2h[away][home] += 3;
        outcome = 2;
      } else {
        P[home]++;
        P[away]++;
        h2h[home][away]++;
        h2h[away][home]++;
        outcome = 1;
      }
      if (fixture.track >= 0) trackedOutcomes[iteration * trackedCount + fixture.track] = outcome;
    }

    order.sort((a, b) => P[b] - P[a] || V[b] - V[a] || D[b] - D[a] || G[b] - G[a]);
    applyPairwiseTieBreak(
      order,
      (a, b) => P[a] === P[b] && V[a] === V[b] && D[a] === D[b] && G[a] === G[b],
      (a, b) => h2h[b][a] - h2h[a][b],
    );
    for (let position = 0; position < teamCount; position++) {
      const team = order[position];
      const teamPoints = Math.min(P[team], MAX_POINTS);
      positionCounts[team][position]++;
      pointsHistogram[team][teamPoints]++;
      teamsByPoints[teamPoints]++;
      if (position >= teamCount - relegationPlaces) relegatedByPoints[teamPoints]++;
      finalPositions[iteration * teamCount + team] = position;
    }
    cutPositions.forEach((position, cut) => {
      cutHistogram[cut][Math.min(P[order[position]], MAX_POINTS)]++;
    });
  }

  return {
    N: iterations,
    PC: positionCounts,
    PH: pointsHistogram,
    CP: cutHistogram,
    RL: relegatedByPoints,
    RN: teamsByPoints,
    finalPositions,
    trackedOutcomes,
    trackedCount,
  };
}

// Menor pontuação p tal que a frequência acumulada alcança q (0..1).
export function histogramQuantile(histogram, iterations, q) {
  let accumulated = 0;
  for (let points = 0; points < histogram.length; points++) {
    accumulated += histogram[points];
    if (accumulated >= q * iterations) return points;
  }
  return 0;
}

// Para um clube e uma faixa de posições finais (0-based, inclusiva), calcula a
// chance de terminar na faixa condicionada a cada resultado dos jogos
// acompanhados. Retorna [{ track, home, draw, away, swing }].
export function conditionalChances(result, team, teamCount, firstPosition, lastPosition) {
  const { N, finalPositions, trackedOutcomes, trackedCount } = result;
  const hits = Array.from({ length: trackedCount }, () => [0, 0, 0]);
  const totals = Array.from({ length: trackedCount }, () => [0, 0, 0]);
  for (let iteration = 0; iteration < N; iteration++) {
    const position = finalPositions[iteration * teamCount + team];
    const hit = position >= firstPosition && position <= lastPosition ? 1 : 0;
    for (let track = 0; track < trackedCount; track++) {
      const outcome = trackedOutcomes[iteration * trackedCount + track];
      totals[track][outcome]++;
      hits[track][outcome] += hit;
    }
  }
  return hits.map((counts, track) => {
    const chance = (outcome) => (totals[track][outcome] ? counts[outcome] / totals[track][outcome] : null);
    const values = [chance(0), chance(1), chance(2)];
    const known = values.filter((value) => value != null);
    return {
      track,
      home: values[0],
      draw: values[1],
      away: values[2],
      swing: known.length > 1 ? Math.max(...known) - Math.min(...known) : 0,
    };
  });
}

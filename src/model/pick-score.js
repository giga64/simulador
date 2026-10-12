import { createSeededRandom, hashKey } from '../random.js';

// Escolhe um placar para preencher automaticamente um jogo, segundo o método.
export function pickScore(method, grid, { seed, key = '' } = {}) {
  const size = grid.n;
  if (method === 'home') return [1, 0];
  if (method === 'draw') return [1, 1];
  if (method === 'sample') {
    const random = createSeededRandom(seed ^ hashKey(key));
    let r = random();
    let index = 0;
    for (; index < grid.g.length - 1; index++) {
      r -= grid.g[index];
      if (r <= 0) break;
    }
    return [Math.floor(index / size), index % size];
  }
  const outcome =
    method === 'fav'
      ? grid.H >= grid.A
        ? 'H'
        : 'A'
      : grid.H >= grid.D && grid.H >= grid.A
        ? 'H'
        : grid.A >= grid.D
          ? 'A'
          : 'D';
  let bestIndex = 0;
  let bestProbability = -1;
  grid.g.forEach((probability, index) => {
    const x = Math.floor(index / size);
    const y = index % size;
    const scoreOutcome = x > y ? 'H' : x < y ? 'A' : 'D';
    if (scoreOutcome === outcome && probability > bestProbability) {
      bestProbability = probability;
      bestIndex = index;
    }
  });
  return [Math.floor(bestIndex / size), bestIndex % size];
}

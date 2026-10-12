// Distribuição de placares de uma partida: Poisson independente para cada lado,
// com a correção de Dixon-Coles (1997) para os placares baixos (0x0, 1x0, 0x1, 1x1).

export const MAX_GOALS_PER_SIDE = 9;

export function poissonPmf(lambda, size) {
  const probabilities = [Math.exp(-lambda)];
  for (let goals = 1; goals < size; goals++) probabilities.push((probabilities[goals - 1] * lambda) / goals);
  return probabilities;
}

function dixonColesFactor(homeGoals, awayGoals, lambdaHome, lambdaAway, rho) {
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaHome * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaAway * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

// Retorna a matriz de placares achatada (índice = mandante * size + visitante),
// já normalizada, e as probabilidades de vitória do mandante, empate e visitante.
export function scoreGrid(lambdaHome, lambdaAway, rho = 0, size = MAX_GOALS_PER_SIDE) {
  const home = poissonPmf(lambdaHome, size);
  const away = poissonPmf(lambdaAway, size);
  const grid = [];
  let total = 0;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const probability = home[x] * away[y] * Math.max(dixonColesFactor(x, y, lambdaHome, lambdaAway, rho), 0);
      grid.push(probability);
      total += probability;
    }
  }
  let H = 0;
  let D = 0;
  let A = 0;
  for (let index = 0; index < grid.length; index++) {
    grid[index] /= total;
    const x = Math.floor(index / size);
    const y = index % size;
    if (x > y) H += grid[index];
    else if (x < y) A += grid[index];
    else D += grid[index];
  }
  return { g: grid, n: size, lh: lambdaHome, la: lambdaAway, H, D, A };
}

export function cumulative(probabilities) {
  const result = new Float64Array(probabilities.length);
  let sum = 0;
  for (let index = 0; index < probabilities.length; index++) {
    sum += probabilities[index];
    result[index] = sum;
  }
  return result;
}

// Primeiro índice cujo acumulado alcança r (busca binária; o último índice
// absorve erros de arredondamento).
export function sampleIndex(cumulativeProbabilities, r) {
  let low = 0;
  let high = cumulativeProbabilities.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cumulativeProbabilities[middle] < r) low = middle + 1;
    else high = middle;
  }
  return low;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClubNeeds, percentileFromHistogram } from '../src/club-needs.js';

// 100 simulações: o corte terminou com 60 pts em 10, 70 pts em 80 e 80 pts em 10.
const histogram = Array(131).fill(0);
histogram[60] = 10;
histogram[70] = 80;
histogram[80] = 10;

test('percentil de histograma', () => {
  assert.equal(percentileFromHistogram(histogram, 100, 0.1), 60);
  assert.equal(percentileFromHistogram(histogram, 100, 0.5), 70);
  assert.equal(percentileFromHistogram(histogram, 100, 0.9), 70);
  assert.equal(percentileFromHistogram(histogram, 100, 0.95), 80);
});

test('quanto falta, vitórias equivalentes e parcela necessária', () => {
  const [title] = buildClubNeeds({
    points: 55,
    played: 30,
    totalGames: 38,
    targets: [{ key: 'title', label: 'Título', cutHistogram: histogram, simulations: 100, chance: 12 }],
  });
  assert.equal(title.cut, 70);
  assert.equal(title.needed, 15);
  assert.equal(title.winsEquivalent, 5);
  assert.equal(title.remaining, 8);
  assert.equal(title.maxPoints, 79);
  assert.ok(Math.abs(title.requiredShare - (15 / 24) * 100) < 1e-9);
  assert.equal(title.reached, false);
  assert.equal(title.reachable, true);
  assert.equal(title.outOfReach, false);
  assert.equal(title.chance, 12);
});

test('meta já alcançada e fora de alcance', () => {
  const [done, far] = buildClubNeeds({
    points: 72,
    played: 36,
    targets: [
      { key: 'a', label: 'A', cutHistogram: histogram, simulations: 100 },
      { key: 'b', label: 'B', cutHistogram: histogram, simulations: 100, extra: 20 },
    ],
  });
  assert.equal(done.reached, true);
  assert.equal(done.needed, 0);
  assert.equal(done.requiredShare, 0);
  assert.equal(far.outOfReach, true); // máximo 72 + 2×3 = 78 < corte mais baixo 60 + 20 = 80
});

test('sem jogos restantes e abaixo do corte, a parcela é indefinida e o objetivo fica fora de alcance', () => {
  const [row] = buildClubNeeds({
    points: 50,
    played: 38,
    targets: [{ key: 'a', label: 'A', cutHistogram: histogram, simulations: 100 }],
  });
  assert.equal(row.requiredShare, null);
  assert.equal(row.outOfReach, true);
  assert.equal(row.reachable, false);
});

test('extra soma ao corte (ficar acima do primeiro rebaixado)', () => {
  const [row] = buildClubNeeds({
    points: 40,
    played: 30,
    targets: [{ key: 'z', label: 'Evitar', cutHistogram: histogram, simulations: 100, extra: 1 }],
  });
  assert.equal(row.cut, 71);
  assert.equal(row.needed, 31);
});

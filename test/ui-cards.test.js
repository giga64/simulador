import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClubNeeds } from '../src/club-needs.js';
import { renderClubNeedsCard } from '../src/ui/club-needs-card.js';
import { renderPositionMap } from '../src/ui/position-map.js';
import { renderSplitsCard } from '../src/ui/splits-card.js';

const histogram = Array(131).fill(0);
histogram[70] = 100;
const make = (points, played, extra) =>
  buildClubNeeds({
    points,
    played,
    targets: [{ key: 'a', label: 'Objetivo', cutHistogram: histogram, simulations: 100, extra, chance: 50 }],
  });
const render = (rows) =>
  renderClubNeedsCard({ clubName: 'Clube', rows, simulations: 1200, formatPercent: (v) => `${v}%` });

test('cartão de metas: singular, meta atingida e fora de alcance', () => {
  assert.match(render(make(69, 30)), /<b>1 pt<\/b>/);
  assert.match(render(make(60, 30)), /<b>10 pts<\/b>/);
  assert.match(render(make(70, 30)), /Já atingiu o corte/);
  assert.match(render(make(40, 36)), /Fora de alcance/);
  assert.match(render(make(40, 36)), /&gt;100%/);
  assert.equal(render([]), '');
});

test('mapa de posições: textos das células e linhas sem dados', () => {
  const html = renderPositionMap({
    order: ['AAA', 'BBB'],
    positions: 3,
    positionsOf: (code) => (code === 'AAA' ? [62.4, 0.7, 0.1] : null),
    zoneOf: (i) => (i === 0 ? 'g' : i === 2 ? 'r' : 'n'),
    renderTeam: (code) => `<b>${code}</b>`,
    nameOf: (code) => code,
    highlight: 'AAA',
  });
  assert.match(html, />62</);
  assert.match(html, />&lt;1</);
  assert.match(html, /title="AAA: 62,4% de terminar em 1º"/);
  assert.equal((html.match(/<tr/g) || []).length, 2); // cabeçalho + AAA; BBB (sem dados) não aparece
  assert.match(html, /class="hl"/);
  // 0,1% fica vazia
  assert.match(html, /<td class="cell zr" style="--a:0.00"[^>]*><\/td>/);
});

test('cartão de recortes: seleciona o modo atual e mostra aproveitamento', () => {
  const rows = [{ position: 1, code: 'AAA', P: 7, J: 3, V: 2, E: 1, D: 0, GP: 4, GC: 1, SG: 3, rate: 77.7 }];
  const html = renderSplitsCard({
    rows,
    mode: 'home',
    modes: [
      ['all', 'Geral'],
      ['home', 'Mandante'],
    ],
    renderTeam: (code) => code,
    formatSigned: (n) => `+${n}`,
    note: 'nota',
  });
  assert.match(html, /<option value="home" selected>/);
  assert.match(html, /78%/);
  assert.match(html, /\+3/);
});

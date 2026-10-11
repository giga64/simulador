import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { renderLandingPreview } from '../src/ui/landing.js';

const bootSource = readFileSync(new URL('../boot.js', import.meta.url), 'utf8');

function runBoot({ search = '', seen = false, storageBroken = false } = {}) {
  let attribute = null;
  const sandbox = {
    location: { search },
    localStorage: {
      getItem: () => {
        if (storageBroken) throw new Error('bloqueado');
        return seen ? '1' : null;
      },
    },
    document: { documentElement: { setAttribute: (name, value) => (attribute = [name, value]) } },
  };
  vm.runInNewContext(bootSource, sandbox);
  return attribute;
}

test('primeira visita mostra a apresentação', () => {
  assert.deepEqual(runBoot(), ['data-landing', '1']);
});

test('quem já viu vai direto ao painel', () => {
  assert.deepEqual(runBoot({ seen: true }), ['data-landing', '0']);
});

test('link de cenário compartilhado vai direto ao painel, mesmo na primeira visita', () => {
  assert.deepEqual(runBoot({ search: '?scenario=abc' }), ['data-landing', '0']);
});

test('?landing=1 força a apresentação', () => {
  assert.deepEqual(runBoot({ search: '?landing=1', seen: true }), ['data-landing', '1']);
  assert.deepEqual(runBoot({ search: '?x=1&landing=1', seen: true }), ['data-landing', '1']);
});

test('armazenamento bloqueado nunca esconde o painel', () => {
  assert.deepEqual(runBoot({ storageBroken: true }), ['data-landing', '0']);
});

test('prévia da landing: linhas, próximo jogo e escape de HTML', () => {
  const html = renderLandingPreview({
    rows: [
      { code: 'FLA', position: 1, points: 61 },
      { code: 'PAL', position: 2, points: 60 },
    ],
    nextMatch: { title: 'A <b> x B', when: '11/10, 19:30' },
    dataLabel: 'atualizado agora',
    logo: (code) => `<i class="lg ${code}"></i>`,
    nameOf: (code) => ({ FLA: 'Flamengo', PAL: 'Palmeiras' })[code],
    escape: (text) => String(text).replace(/</g, '&lt;'),
  });
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.match(html, /<b>61<\/b>/);
  assert.match(html, /A &lt;b> x B/);
  assert.doesNotMatch(
    renderLandingPreview({
      rows: [],
      nextMatch: null,
      dataLabel: '',
      logo: () => '',
      nameOf: () => '',
      escape: String,
    }),
    /Próximo jogo/,
  );
});

test('landing declara todos os destinos válidos', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const valid = new Set([
    'home',
    'live',
    'sim',
    'est',
    'clubs',
    'history',
    'perf',
    'cor',
    'search',
    'guide',
    'account',
    'src',
  ]);
  const targets = [...html.matchAll(/data-landing-go="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 8);
  for (const target of targets) assert.ok(valid.has(target), `destino inválido: ${target}`);
});

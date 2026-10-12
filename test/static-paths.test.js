import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicPath } from '../src/static-paths.js';

test('isPublicPath libera os arquivos do site', () => {
  for (const file of [
    'index.html',
    'app.js',
    'styles.css',
    'sw.js',
    'manifest.webmanifest',
    'assets/escudos/FLA.webp',
    'data/season-2026.json',
    'src/model/poisson.js',
    'src/random.js',
  ]) {
    assert.ok(isPublicPath(file), file);
  }
});

test('isPublicPath bloqueia código do servidor, dotfiles e dependências', () => {
  for (const file of [
    '.git/config',
    '.env',
    '.runtime/live-results-2026.json',
    'node_modules/x/index.js',
    'package.json',
    'scripts/serve.mjs',
    'src/live-history.js',
    'supabase/migrations/a.sql',
    'test/model.test.js',
    'assets/.hidden',
    'data/../package.json',
    'src\\..\\.git\\config',
  ]) {
    assert.ok(!isPublicPath(file), file);
  }
});

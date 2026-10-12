import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.runtime/'] },
  js.configs.recommended,
  {
    files: ['app.js', 'sw.js', 'src/client/**/*.js', 'src/model/**/*.js', 'src/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['sw.js', 'src/model/*.worker.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.worker } },
  },
  {
    files: [
      'scripts/**/*.mjs',
      'src/live-feed.js',
      'src/live-history.js',
      'src/live-sources/**/*.js',
      'src/static-paths.js',
      'src/server/**/*.js',
      'src/supabase-config.js',
      'test/**/*.js',
      'eslint.config.js',
    ],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-unused-expressions': 'off',
    },
  },
];

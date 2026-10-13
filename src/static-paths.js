// Arquivos que o servidor pode entregar ao navegador. Tudo o que não estiver
// aqui (código do servidor, testes, migrações, .git, node_modules...) responde 404.
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest', 'theme.js']);
const PUBLIC_DIRECTORIES = ['assets/', 'data/', 'src/client/', 'src/model/', 'src/competitions/'];
const CLIENT_MODULES = new Set([
  'src/history-integrity.js',
  'src/live-season.js',
  'src/prediction-performance.js',
  'src/random.js',
  'src/scenario.js',
  'src/season-data.js',
]);

export function isPublicPath(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment.startsWith('.') || segment === '')) return false;
  return (
    PUBLIC_FILES.has(normalized) ||
    CLIENT_MODULES.has(normalized) ||
    PUBLIC_DIRECTORIES.some((directory) => normalized.startsWith(directory))
  );
}

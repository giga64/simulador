import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompetition } from 'campeonato-brasileiro-api';
import { createLiveFeedCache, normalizeLiveCompetition } from '../src/live-feed.js';
import { createLiveHistoryStore } from '../src/live-history.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const addToHistory = createLiveHistoryStore(
  process.env.LIVE_HISTORY_PATH || path.join(root, '.runtime', 'live-results-2026.json'),
);
const readLiveFeed = createLiveFeedCache(async () => {
  const competition = await getCompetition('a', { signal: AbortSignal.timeout(12_000) });
  const feed = normalizeLiveCompetition(competition);
  return { ...feed, ...await addToHistory(feed) };
});
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method || '')) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }

  let pathname, forceRefresh;
  try {
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    pathname = decodeURIComponent(requestUrl.pathname);
    forceRefresh = requestUrl.searchParams.get('refresh') === '1';
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/api/live-season') {
    if (request.method === 'HEAD') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    try {
      const liveFeed = await readLiveFeed({ forceRefresh });
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      }).end(JSON.stringify(liveFeed));
    } catch (error) {
      response.writeHead(502, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      }).end(JSON.stringify({
        error: 'Não foi possível consultar a fonte GE neste momento.',
        details: error instanceof Error ? error.message : 'Erro externo desconhecido.',
      }));
    }
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  if (relative.split(/[\\/]/).includes('.runtime')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    if (!statSync(filePath).isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`Preview server running at http://${host}:${port}`);
});

const refreshTimer = setInterval(() => {
  readLiveFeed({ forceRefresh: true }).catch((error) => {
    console.error(`Atualização periódica do GE falhou: ${error.message||String(error)}`);
  });
}, 120_000);
refreshTimer.unref();
readLiveFeed().catch((error) => {
  console.error(`Consulta inicial do GE falhou: ${error.message||String(error)}`);
});

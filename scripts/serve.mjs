import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { getCompetition } from 'campeonato-brasileiro-api';
import { createLiveFeedCache, normalizeLiveCompetition } from '../src/live-feed.js';
import { createLiveHistoryStore } from '../src/live-history.js';
import { getPublicSupabaseConfig, isSupabaseServiceRoleKey } from '../src/supabase-config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supabaseSdkPath = path.join(root, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
const supabaseConfig = getPublicSupabaseConfig(process.env);
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const addToHistory = createLiveHistoryStore(
  process.env.LIVE_HISTORY_PATH || path.join(root, '.runtime', 'live-results-2026.json'),
);
const readLiveFeed = createLiveFeedCache(async () => {
  const competition = await getCompetition('a', { signal: AbortSignal.timeout(12_000) });
  const feed = normalizeLiveCompetition(competition);
  return { ...feed, ...(await addToHistory(feed)) };
});
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'],
]);

// Somente o que o navegador precisa é publicado. Antes, qualquer arquivo da pasta
// do projeto (incluindo .git/, package.json e scripts/) era entregue.
const publicFiles = new Set(['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'sw.js']);
const publicDirectories = ['assets/', 'data/', 'src/'];
const isPublicPath = (relative) => {
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '' || part.startsWith('.'))) return false;
  return publicFiles.has(normalized) || publicDirectories.some((directory) => normalized.startsWith(directory));
};

// URL pública do site (ex.: https://simulabr.com.br), usada nas tags de
// compartilhamento (og:image exige URL absoluta). Sem SITE_URL, ficam caminhos relativos.
const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD', 'DELETE'].includes(request.method || '')) {
    response.writeHead(405, { Allow: 'GET, HEAD, DELETE' }).end('Method not allowed');
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

  if (pathname === '/api/account') {
    if (request.method !== 'DELETE') {
      response.writeHead(405, { Allow: 'DELETE' }).end('Method not allowed');
      return;
    }
    if (!supabaseConfig.authConfigured || !isSupabaseServiceRoleKey(supabaseServiceRoleKey)) {
      response
        .writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'Exclusão de conta não está configurada no servidor.' }));
      return;
    }
    const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(request.headers.authorization || '')?.[1];
    if (!token) {
      response
        .writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'Sessão inválida. Entre novamente para excluir a conta.' }));
      return;
    }
    try {
      const authClient = createClient(supabaseConfig.supabaseUrl, supabaseConfig.supabaseKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error: authError } = await authClient.auth.getUser(token);
      if (authError || !data.user) {
        response
          .writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ error: 'Sessão inválida ou expirada. Entre novamente.' }));
        return;
      }
      const adminClient = createClient(supabaseConfig.supabaseUrl, supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await adminClient.auth.admin.deleteUser(data.user.id);
      if (error) throw error;
      response
        .writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
        .end(JSON.stringify({ deleted: true }));
    } catch (error) {
      console.error('Supabase account deletion failed:', error instanceof Error ? error.message : error);
      response
        .writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'O provedor não conseguiu excluir a conta. Tente novamente.' }));
    }
    return;
  }

  if (request.method === 'DELETE') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }

  if (pathname === '/api/live-season') {
    if (request.method === 'HEAD') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    try {
      const liveFeed = await readLiveFeed({ forceRefresh });
      response
        .writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
        .end(JSON.stringify(liveFeed));
    } catch (error) {
      response
        .writeHead(502, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
        .end(
          JSON.stringify({
            error: 'Não foi possível consultar a fonte GE neste momento.',
            details: error instanceof Error ? error.message : 'Erro externo desconhecido.',
          }),
        );
    }
    return;
  }

  if (pathname === '/api/config') {
    response
      .writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      })
      .end(JSON.stringify(supabaseConfig));
    return;
  }

  if (pathname === '/vendor/supabase.js') {
    try {
      if (!statSync(supabaseSdkPath).isFile()) throw new Error('SDK unavailable');
      response.writeHead(200, {
        'Cache-Control': 'public, max-age=3600',
        'Content-Type': 'text/javascript; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(supabaseSdkPath).pipe(response);
    } catch {
      response
        .writeHead(503, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        })
        .end('Supabase client SDK unavailable');
    }
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  if (!isPublicPath(relative)) {
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
    if (relative === 'index.html') {
      const raw = readFileSync(filePath, 'utf8');
      const html = siteUrl
        ? raw.replaceAll('content="assets/og-image.png"', `content="${siteUrl}/assets/og-image.png"`)
        : raw;
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': mimeTypes.get('.html'),
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : html);
      return;
    }
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
    console.error(`Atualização periódica do GE falhou: ${error.message || String(error)}`);
  });
}, 120_000);
refreshTimer.unref();
readLiveFeed().catch((error) => {
  console.error(`Consulta inicial do GE falhou: ${error.message || String(error)}`);
});

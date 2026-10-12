// Utilitários HTTP do servidor: cabeçalhos de segurança, respostas JSON,
// leitura de corpo com limite e limitação de requisições por IP.

export function contentSecurityPolicy({ production = false } = {}) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Os templates usam style="" para larguras de barras e cores dinâmicas.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function securityHeaders({ production = false, html = false, crossOriginResource = false } = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Imagens de compartilhamento precisam ser lidas por outros sites (prévia de links).
    'Cross-Origin-Resource-Policy': crossOriginResource ? 'cross-origin' : 'same-origin',
    ...(html ? { 'Content-Security-Policy': contentSecurityPolicy({ production }), 'X-Frame-Options': 'DENY' } : {}),
    ...(production ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

export function sendJson(response, status, body, headers = {}) {
  response
    .writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    })
    .end(JSON.stringify(body));
}

export function sendText(response, status, text, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }).end(text);
}

// Com TRUST_PROXY=1 (Render, Fly, etc.) o IP real vem do último salto do proxy.
export function clientIp(request, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return request.socket?.remoteAddress || 'unknown';
}

export async function readJsonBody(request, { limit = 4096 } = {}) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
    throw Object.assign(new Error('Envie JSON.'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Corpo da requisição grande demais.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON inválido.'), { status: 400 });
  }
}

// Janela fixa por chave (normalmente o IP). Limpa as chaves antigas sozinho.
export function createRateLimiter({ windowMs, max, clock = Date.now }) {
  const hits = new Map();
  return function check(key) {
    const now = clock();
    if (hits.size > 10_000) {
      for (const [entryKey, entry] of hits) if (now >= entry.resetAt) hits.delete(entryKey);
    }
    let entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    return { allowed: entry.count <= max, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  };
}

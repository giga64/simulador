// Endereços do site (usados pelo navegador e pelo servidor).
//   /                       Início            /clube/flamengo      perfil do clube
//   /ao-vivo                rodada atual      /rodada/31           resultados da rodada
//   /simular                simulador         /copas/libertadores  copa
//   /chances[/mapa|/evolucao|/vagas|/modelo]
//   /estatisticas[/recortes]  /palpites  /fontes  /ajuda  /buscar  /conta

export const CUP_SLUGS = {
  libertadores: 'libertadores',
  sudamericana: 'sul-americana',
  copaDoBrasil: 'copa-do-brasil',
};
const CUP_BY_SLUG = Object.fromEntries(Object.entries(CUP_SLUGS).map(([id, slug]) => [slug, id]));
const CHANCES_SUBS = { race: '', map: 'mapa', trend: 'evolucao', vagas: 'vagas', model: 'modelo' };
const CHANCES_BY_SLUG = Object.fromEntries(Object.entries(CHANCES_SUBS).map(([id, slug]) => [slug, id]));
const SIMPLE = {
  home: '/',
  live: '/ao-vivo',
  sim: '/simular',
  perf: '/palpites',
  src: '/fontes',
  guide: '/ajuda',
  search: '/buscar',
  account: '/conta',
};
const SIMPLE_BY_PATH = Object.fromEntries(Object.entries(SIMPLE).map(([view, path]) => [path, view]));

export function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function clubSlugs(teams) {
  return Object.fromEntries(Object.entries(teams).map(([code, name]) => [code, slugify(name)]));
}

// teams: { FLA: 'Flamengo', ... }. Retorna null para endereços desconhecidos.
export function routeFromPath(pathname, teams, { rounds = 38 } = {}) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (SIMPLE_BY_PATH[path]) return { view: SIMPLE_BY_PATH[path] };
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'chances' && parts.length <= 2) {
    const sub = CHANCES_BY_SLUG[parts[1] || ''];
    return sub ? { view: 'cor', sub } : null;
  }
  if (parts[0] === 'copas' && parts.length <= 2) {
    if (!parts[1]) return { view: 'copas' };
    return CUP_BY_SLUG[parts[1]] ? { view: 'copas', cup: CUP_BY_SLUG[parts[1]] } : null;
  }
  if (parts[0] === 'estatisticas' && parts.length <= 2) {
    if (!parts[1]) return { view: 'est', sub: 'season' };
    return parts[1] === 'recortes' ? { view: 'est', sub: 'splits' } : null;
  }
  if (parts[0] === 'clubes' && parts.length === 1) return { view: 'clubs' };
  if (parts[0] === 'clube' && parts.length === 2) {
    const code = Object.entries(clubSlugs(teams)).find(([, slug]) => slug === parts[1])?.[0];
    return code ? { view: 'clubs', team: code } : null;
  }
  if (parts[0] === 'rodada' && parts.length === 2 && /^\d{1,2}$/.test(parts[1])) {
    const round = Number(parts[1]);
    return round >= 1 && round <= rounds ? { view: 'est', sub: 'rounds', round } : null;
  }
  return null;
}

export function pathFor({ view, sub, team, round, cup }, teams) {
  if (view === 'cor') return `/chances${CHANCES_SUBS[sub] ? `/${CHANCES_SUBS[sub]}` : ''}`;
  if (view === 'copas') return `/copas${cup && CUP_SLUGS[cup] ? `/${CUP_SLUGS[cup]}` : ''}`;
  if (view === 'clubs') return team && teams[team] ? `/clube/${slugify(teams[team])}` : '/clubes';
  if (view === 'est') {
    if (sub === 'rounds' && round) return `/rodada/${round}`;
    return sub === 'splits' ? '/estatisticas/recortes' : '/estatisticas';
  }
  return SIMPLE[view] || '/';
}

// Todos os endereços públicos, para o sitemap.
export function allPaths(teams, { rounds = 38 } = {}) {
  return [
    ...Object.values(SIMPLE).filter((path) => !['/conta', '/buscar'].includes(path)),
    ...Object.values(CHANCES_SUBS).map((slug) => `/chances${slug ? `/${slug}` : ''}`),
    '/copas',
    ...Object.values(CUP_SLUGS).map((slug) => `/copas/${slug}`),
    '/estatisticas',
    '/estatisticas/recortes',
    '/clubes',
    ...Object.values(clubSlugs(teams)).map((slug) => `/clube/${slug}`),
    ...Array.from({ length: rounds }, (_, index) => `/rodada/${index + 1}`),
  ];
}

// Título e descrição de cada endereço, com os números atuais (para o Google e
// para a prévia de links). Usa o estado da temporada e a última foto das chances.
import { COMPETITIONS } from '../competitions/formats.js';

const pct = (value) => (value == null ? null : value < 1 ? 'menos de 1%' : `${Math.round(value)}%`);

export function describeRoute(route, { teams, chances, round }) {
  const site = 'SimulaBR';
  const roundText = round ? `${round}ª rodada` : 'temporada';
  if (!route || route.view === 'home') {
    return {
      title: `${site} · Brasileirão 2026: tabela ao vivo, chances e simulador`,
      description: `Classificação ao vivo, chances de título, Libertadores e rebaixamento de cada clube e simulador da ${roundText} do Brasileirão 2026.`,
    };
  }
  if (route.view === 'clubs' && route.team) {
    const name = teams[route.team];
    const value = chances?.[route.team];
    const facts = value
      ? `${name} tem ${pct(value.title)} de chance de título, ${pct(value.libertadores)} de terminar no G5 e ${pct(value.relegation)} de rebaixamento`
      : `Chances de ${name}`;
    return {
      title: `${name}: chances no Brasileirão 2026 · ${site}`,
      description: `${facts} no Brasileirão 2026, segundo 10.000 simulações. Veja jogos, contas matemáticas e a evolução das chances.`,
    };
  }
  if (route.view === 'cor') {
    const leader = chances ? Object.entries(chances).sort((a, b) => b[1].title - a[1].title)[0] : null;
    const sub = {
      map: 'Mapa de posições finais',
      trend: 'Evolução das chances rodada a rodada',
      vagas: 'Vagas na Libertadores 2027',
      model: 'Qualidade do modelo',
    }[route.sub];
    return {
      title: `${sub || 'Chances de título, G5 e rebaixamento'} · Brasileirão 2026 · ${site}`,
      description: leader
        ? `${teams[leader[0]]} lidera com ${pct(leader[1].title)} de chance de título. Chances de todos os clubes no Brasileirão 2026, em 10.000 simulações.`
        : 'Chances de título, vaga e rebaixamento de todos os clubes no Brasileirão 2026.',
    };
  }
  if (route.view === 'copas') {
    const cup = route.cup ? COMPETITIONS[route.cup] : null;
    return {
      title: `${cup ? cup.fullName : 'Libertadores, Sul-Americana e Copa do Brasil 2026'}: chaveamento e chances · ${site}`,
      description: `${cup ? `Chaveamento, ${cup.id === 'copaDoBrasil' ? '' : 'grupos, '}jogos e chance de título de cada clube na ${cup.fullName}` : 'Chaveamento, grupos e chance de título na Libertadores, na Sul-Americana e na Copa do Brasil 2026'}.`,
    };
  }
  if (route.view === 'est' && route.sub === 'rounds' && route.round) {
    return {
      title: `${route.round}ª rodada do Brasileirão 2026: resultados e classificação · ${site}`,
      description: `Resultados e classificação após a ${route.round}ª rodada do Brasileirão 2026.`,
    };
  }
  const simple = {
    live: [
      'Jogos ao vivo do Brasileirão 2026',
      `Placares ao vivo da ${roundText} e como cada gol muda as chances dos clubes.`,
    ],
    sim: [
      'Simulador do Brasileirão 2026',
      'Defina os placares que faltam e veja a classificação e as chances mudarem na hora.',
    ],
    est: ['Estatísticas do Brasileirão 2026', 'Gols, empates, mandantes, classificação por recorte e rodada a rodada.'],
    clubs: ['Clubes do Brasileirão 2026', 'Perfil, jogos e chances de cada clube da Série A.'],
    perf: ['Seus palpites', 'Compare seus palpites com os resultados e veja a calibração das probabilidades.'],
    src: ['Fontes e método', 'De onde vêm os dados do SimulaBR e como o modelo calcula as chances.'],
    guide: ['Ajuda', 'Como usar o SimulaBR, privacidade e termos de uso.'],
  }[route.view];
  return simple
    ? { title: `${simple[0]} · ${site}`, description: simple[1] }
    : { title: site, description: 'Brasileirão 2026: tabela, chances e simulador.' };
}

export const escapeAttribute = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

// Aplica título, descrição, canonical e og:* ao index.html.
export function applyMeta(html, { title, description, url, image }) {
  const t = escapeAttribute(title);
  const d = escapeAttribute(description);
  let out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta\s+property="og:description"\s+content=")[^"]*(")/, `$1${d}$2`);
  if (image) out = out.replaceAll('content="/assets/og-image.png"', `content="${escapeAttribute(image)}"`);
  if (url) {
    const u = escapeAttribute(url);
    out = out.replace(
      '</head>',
      `    <link rel="canonical" href="${u}" />\n    <meta property="og:url" content="${u}" />\n  </head>`,
    );
  }
  return out;
}

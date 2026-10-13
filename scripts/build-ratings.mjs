// Gera data/club-ratings-2026.json: Elo de todos os clubes que aparecem nas copas
// e nas ligas sul-americanas, mais os parâmetros do modelo de gols.
//
// Fontes:
// - openfootball/south-america (CC0): Libertadores e Sul-Americana 2012–2025 e
//   Copa do Brasil 2025, usados só para os parâmetros médios (gols e mando).
// - ESPN (API pública não oficial): resultados de 2021–2026 das três copas e de
//   2025–2026 das ligas nacionais, usados para o Elo. Só as notas derivadas
//   ficam no repositório.
// Uso: npm run build:ratings
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseFootballTxt } from '../src/competitions/adapters/openfootball.js';
import { DEFAULT_ELO, expectedGoals, expectedScore, poissonLogLikelihood, updateElo } from '../src/competitions/elo.js';

const CACHE = new URL('../.runtime/sources/', import.meta.url);
const CUPS = ['conmebol.libertadores', 'conmebol.sudamericana', 'bra.copa_do_brazil'];
const LEAGUES = ['bra.1', 'arg.1', 'col.1', 'chi.1', 'uru.1', 'ecu.1', 'per.1', 'par.1', 'bol.1', 'ven.1'];
const CUP_YEARS = [2021, 2022, 2023, 2024, 2025, 2026];
const LEAGUE_YEARS = [2025, 2026];
const OPENFOOTBALL = 'https://raw.githubusercontent.com/openfootball/south-america/master';
const PARAMS = { kLeague: 20, kCup: 30, homeAdvantage: 70, seasonShrink: 0.2 };

async function cached(name, url) {
  const file = new URL(name, CACHE);
  try {
    return await readFile(file, 'utf8');
  } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'Accept-Encoding': 'gzip' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`);
    const text = await response.text();
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, text);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return text;
  }
}

// ---- Parâmetros médios das copas (openfootball) ----
const historical = [];
for (let year = 2012; year <= 2025; year++) {
  for (const [file, competition] of [
    [`copa-libertadores/${year}_copal.txt`, 'libertadores'],
    [`copa-libertadores/${year}_copas.txt`, 'sudamericana'],
  ]) {
    try {
      const text = await cached(`of-${year}-${competition}.txt`, `${OPENFOOTBALL}/${file}`);
      historical.push(...parseFootballTxt(text, { competition, season: year }));
    } catch (error) {
      console.warn(`openfootball: ${file} indisponível (${error.message})`);
    }
  }
}
historical.push(
  ...parseFootballTxt(await cached('of-2025-brcup.txt', `${OPENFOOTBALL}/brazil/2025_brcup.txt`), {
    competition: 'copaDoBrasil',
    season: 2025,
  }),
);
const finals = historical.filter((match) => /^final$/i.test(match.stage || ''));
const nonNeutral = historical.filter((match) => !/^final$/i.test(match.stage || ''));
const meanHome = nonNeutral.reduce((sum, match) => sum + match.homeGoals, 0) / nonNeutral.length;
const meanAway = nonNeutral.reduce((sum, match) => sum + match.awayGoals, 0) / nonNeutral.length;
const shootouts = historical.filter((match) => match.penalties);
const shootoutHomeWins = shootouts.filter((match) => match.penalties[0] > match.penalties[1]).length;
const prior = {
  matches: historical.length,
  seasons: '2012–2025',
  meanHomeGoals: meanHome,
  meanAwayGoals: meanAway,
  drawRate: historical.filter((match) => match.homeGoals === match.awayGoals).length / historical.length,
  shootouts: shootouts.length,
  // Nos pênaltis, "home" é o mandante do jogo decisivo.
  shootoutHomeWinRate: shootouts.length ? shootoutHomeWins / shootouts.length : 0.5,
  finals: finals.length,
};
// λ médios do jogo "entre iguais": base = log da média geométrica; home = metade do log da razão.
const base = Math.log(Math.sqrt(meanHome * meanAway));
const home = Math.log(meanHome / meanAway) / 2;

// ---- Resultados recentes (ESPN) para o Elo ----
const matches = [];
const teams = new Map();
async function espnSeason(slug, year, kind) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${year}&limit=1000`;
  let data;
  try {
    data = JSON.parse(await cached(`espn-${slug}-${year}.json`, url));
  } catch (error) {
    console.warn(`ESPN ${slug} ${year}: ${error.message}`);
    return;
  }
  for (const event of data.events || []) {
    const competition = event.competitions?.[0];
    if (!competition?.status?.type?.completed) continue;
    const homeTeam = competition.competitors.find((item) => item.homeAway === 'home');
    const awayTeam = competition.competitors.find((item) => item.homeAway === 'away');
    const homeGoals = Number(homeTeam?.score);
    const awayGoals = Number(awayTeam?.score);
    if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) continue;
    for (const team of [homeTeam.team, awayTeam.team]) {
      const entry = teams.get(team.id) || { name: team.displayName, leagues: new Set(), games: 0 };
      entry.name = team.displayName;
      if (kind === 'league') entry.leagues.add(slug);
      entry.games++;
      teams.set(team.id, entry);
    }
    matches.push({
      date: event.date,
      season: year,
      slug,
      kind,
      stage: event.season?.slug,
      home: homeTeam.team.id,
      away: awayTeam.team.id,
      homeGoals,
      awayGoals,
      neutral: event.season?.slug === 'final',
    });
  }
}
for (const year of CUP_YEARS) for (const slug of CUPS) await espnSeason(slug, year, 'cup');
for (const year of LEAGUE_YEARS) for (const slug of LEAGUES) await espnSeason(slug, year, 'league');
matches.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

// Vantagem de mando por liga, medida nos dados: altitude (Bolívia, Quito) e
// viagens longas pesam muito mais em alguns países. Em pontos de Elo:
// 400 * log10(p / (1 - p)), com p = aproveitamento do mandante.
const homeAdvantageByLeague = {};
for (const slug of LEAGUES) {
  const games = matches.filter((match) => match.slug === slug);
  if (games.length < 100) continue;
  const p =
    games.reduce(
      (sum, match) => sum + (match.homeGoals > match.awayGoals ? 1 : match.homeGoals === match.awayGoals ? 0.5 : 0),
      0,
    ) / games.length;
  homeAdvantageByLeague[slug] = Math.round(400 * Math.log10(p / (1 - p)));
}
const leagueOf = (id) => [...(teams.get(id)?.leagues || [])][0] || null;
const isInternational = (match) =>
  match.kind === 'cup' && leagueOf(match.home) && leagueOf(match.away) && leagueOf(match.home) !== leagueOf(match.away);
// Nas copas, contra estrangeiros, o mando pesa diferente (altitude, viagens).
// Ajustado por país do mandante depois da 2ª passada (ver abaixo).
let cupHomeAdvantage = {};
const homeAdvantageFor = (match) =>
  (isInternational(match) ? cupHomeAdvantage[leagueOf(match.home)] : undefined) ??
  homeAdvantageByLeague[leagueOf(match.home)] ??
  PARAMS.homeAdvantage;

function runElo(initial) {
  const ratings = new Map(initial);
  let season = null;
  const predictions = [];
  for (const match of matches) {
    if (match.season !== season) {
      season = match.season;
      for (const [id, rating] of ratings) ratings.set(id, rating - PARAMS.seasonShrink * (rating - DEFAULT_ELO));
    }
    const before = [ratings.get(match.home) ?? DEFAULT_ELO, ratings.get(match.away) ?? DEFAULT_ELO];
    updateElo(ratings, match, {
      k: match.kind === 'cup' ? PARAMS.kCup : PARAMS.kLeague,
      homeAdvantage: homeAdvantageFor(match),
      neutral: match.neutral,
    });
    predictions.push({ match, before });
  }
  return { ratings, predictions };
}

// Mando em copa por país: o valor h que faz o resultado esperado pelo Elo
// (com as notas de antes do jogo) bater com o resultado real, em média.
// Isso separa o efeito do mando da diferença de força entre os clubes.
function fitCupHomeAdvantage(predictions) {
  const fitted = {};
  for (const slug of LEAGUES) {
    const games = predictions.filter(
      ({ match }) => !match.neutral && isInternational(match) && leagueOf(match.home) === slug,
    );
    if (games.length < 60) continue;
    const balance = (h) =>
      games.reduce(
        ({ sum }, { match, before }) => {
          const outcome = match.homeGoals > match.awayGoals ? 1 : match.homeGoals === match.awayGoals ? 0.5 : 0;
          return { sum: sum + outcome - expectedScore(before[0], before[1], h) };
        },
        { sum: 0 },
      ).sum;
    let low = -300;
    let high = 600;
    for (let step = 0; step < 40; step++) {
      const middle = (low + high) / 2;
      if (balance(middle) > 0) low = middle;
      else high = middle;
    }
    fitted[slug] = { elo: Math.round((low + high) / 2), games: games.length };
  }
  return fitted;
}

// Três passadas: a 2ª começa das notas da 1ª (encolhidas pela metade para a
// média), para os estrangeiros convergirem com poucos jogos; a 3ª usa o mando
// de copa ajustado.
const firstPass = runElo(new Map());
const seed = new Map([...firstPass.ratings].map(([id, rating]) => [id, DEFAULT_ELO + (rating - DEFAULT_ELO) / 2]));
const fittedCup = fitCupHomeAdvantage(runElo(seed).predictions);
cupHomeAdvantage = Object.fromEntries(Object.entries(fittedCup).map(([slug, value]) => [slug, value.elo]));
const { ratings, predictions } = runElo(seed);

// Inclinação (slope) do modelo de gols: máxima verossimilhança nos jogos de copa
// de 2024–2026, com as notas de antes de cada jogo.
const sample = predictions.filter(({ match }) => match.kind === 'cup' && match.season >= 2024);
let best = { slope: 0, logLikelihood: -Infinity };
for (let slope = 0; slope <= 2.5; slope += 0.02) {
  let total = 0;
  for (const { match, before } of sample) {
    // Mando acima da média da amostra entra como diferença de força.
    const extra = match.neutral ? 0 : homeAdvantageFor(match) - PARAMS.homeAdvantage;
    const [lambdaHome, lambdaAway] = expectedGoals(
      before[0] + extra,
      before[1],
      { base, home, slope },
      { neutral: match.neutral },
    );
    total += poissonLogLikelihood(match.homeGoals, lambdaHome) + poissonLogLikelihood(match.awayGoals, lambdaAway);
  }
  if (total > best.logLikelihood) best = { slope: Math.round(slope * 100) / 100, logLikelihood: total };
}

const output = {
  version: 1,
  generatedAt: new Date().toISOString(),
  method:
    'Elo (K 30 em copas, 20 em ligas, mando medido por liga e, nas copas contra estrangeiros, por país, 20% de regressão à média por temporada, duas passadas) com resultados ESPN; gols por Poisson com base e mando do histórico openfootball (CC0) e inclinação ajustada nos jogos de copa de 2024–2026.',
  sources: {
    elo: `ESPN: copas ${CUP_YEARS[0]}–${CUP_YEARS.at(-1)} e ligas ${LEAGUE_YEARS.join(', ')} (${matches.length} jogos)`,
    prior: 'openfootball/south-america, licença CC0 1.0 (domínio público)',
  },
  model: {
    base,
    home,
    slope: best.slope,
    sampleMatches: sample.length,
    referenceHomeAdvantage: PARAMS.homeAdvantage,
    homeAdvantageByLeague,
    cupHomeAdvantageByLeague: fittedCup,
  },
  prior,
  teams: Object.fromEntries(
    [...ratings]
      .filter(([id]) => teams.has(id))
      .sort((a, b) => b[1] - a[1])
      .map(([id, rating]) => [
        id,
        { name: teams.get(id).name, elo: Math.round(rating), games: teams.get(id).games, league: leagueOf(id) },
      ]),
  ),
};
await writeFile(new URL('../data/club-ratings-2026.json', import.meta.url), `${JSON.stringify(output, null, 1)}\n`);
console.log(
  `${Object.keys(output.teams).length} clubes · ${matches.length} jogos ESPN · ${historical.length} jogos openfootball`,
);
console.log('Modelo de gols:', output.model);
console.log('Histórico:', prior);
console.log(
  'Top 15:',
  Object.values(output.teams)
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 15)
    .map((team) => `${team.name} ${team.elo}`)
    .join(' · '),
);

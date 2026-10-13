// Baixa escudos dos clubes das copas e logos das competições para
// assets/crests/ (o site nunca carrega imagem de terceiros) e grava
// assets/crests/map.json: id da fonte -> arquivo e sigla do app.
//
// Fontes: ESPN (logo do clube, versão reduzida pelo próprio CDN) e, quando a
// ESPN não tem, TheSportsDB (chave pública de teste "3", versão /tiny).
// Uso: npm run crests            (só baixa o que falta)
//      npm run crests -- --force (baixa tudo de novo)
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { COMPETITIONS } from '../src/competitions/formats.js';
import { createTeamCodeResolver } from '../src/live-season.js';

const force = process.argv.includes('--force');
const root = new URL('../', import.meta.url);
const outDir = new URL('assets/crests/', root);
const SEASON = 2026;
const SIZE = 72;
// Na Copa do Brasil só os clubes a partir da 5ª fase (as fases iniciais têm 100+ clubes).
const FIRST_STAGE_WITH_CRESTS = { copaDoBrasil: 'fifth-round' };
const LEAGUE_IDS = { libertadores: '4501', sudamericana: '4724', copaDoBrasil: '4725' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`);
  return response.json();
}
async function exists(file) {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}
async function download(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!type.startsWith('image/png')) throw new Error(`tipo inesperado ${type}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 200 || bytes.length > 200_000) throw new Error(`tamanho inesperado ${bytes.length}`);
  await writeFile(file, bytes);
  await sleep(120);
}
const espnSmall = (logo) =>
  `https://a.espncdn.com/combiner/i?img=${encodeURIComponent(new URL(logo).pathname)}&w=${SIZE}&h=${SIZE}`;

const season = JSON.parse(await readFile(new URL('data/season-2026.json', root), 'utf8'));
const resolveApp = createTeamCodeResolver(season.teams);
let previous = { clubs: {}, competitions: {} };
try {
  previous = JSON.parse(await readFile(new URL('map.json', outDir), 'utf8'));
} catch {
  // primeira execução
}
await mkdir(new URL('clubs/', outDir), { recursive: true });
await mkdir(new URL('competitions/', outDir), { recursive: true });

// Sigla do app só para clubes da Série A (lista da própria ESPN), para não
// confundir homônimos (ex.: "Vasco AC" do Acre não é o Vasco da Gama).
const serieA = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams`);
const appCodeById = {};
for (const { team } of serieA.sports[0].leagues[0].teams) {
  const code = resolveApp({ name: team.displayName });
  if (code) appCodeById[team.id] = code;
}

const clubs = {};
for (const [competitionId, format] of Object.entries(COMPETITIONS)) {
  const data = await getJson(
    `https://site.api.espn.com/apis/site/v2/sports/soccer/${format.espnSlug}/scoreboard?dates=${SEASON}&limit=1000`,
  );
  const stages = format.stages.map((stage) => stage.id);
  const firstStage = stages.indexOf(FIRST_STAGE_WITH_CRESTS[competitionId] ?? stages[0]);
  for (const event of data.events || []) {
    if (stages.indexOf(event.season?.slug) < firstStage) continue;
    for (const { team } of event.competitions[0].competitors) {
      if (/^TBD/i.test(team.displayName)) continue;
      clubs[team.id] ??= { name: team.displayName, logo: team.logo || null, competitions: new Set() };
      clubs[team.id].competitions.add(competitionId);
    }
  }
}

const map = { generatedAt: new Date().toISOString(), size: SIZE, clubs: {}, competitions: {} };
let downloaded = 0;
const missing = [];
for (const [id, club] of Object.entries(clubs)) {
  const relative = `assets/crests/clubs/${id}.png`;
  const file = new URL(`clubs/${id}.png`, outDir);
  let source = previous.clubs?.[id]?.source || null;
  if (force || !(await exists(file))) {
    source = null;
    if (club.logo?.startsWith('https://a.espncdn.com/')) {
      try {
        await download(espnSmall(club.logo), file);
        source = 'ESPN';
      } catch (error) {
        console.warn(`ESPN sem escudo para ${club.name}: ${error.message}`);
      }
    }
    if (!source) {
      try {
        const search = await getJson(
          `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(club.name)}`,
        );
        const badge = search.teams?.find((team) => team.strSport === 'Soccer' && team.strBadge)?.strBadge;
        if (badge) {
          await download(`${badge}/tiny`, file);
          source = 'TheSportsDB';
        }
      } catch (error) {
        console.warn(`TheSportsDB sem escudo para ${club.name}: ${error.message}`);
      }
    }
    if (source) downloaded++;
  }
  if (!source) missing.push(club.name);
  map.clubs[id] = {
    name: club.name,
    file: source ? relative : null,
    source,
    appCode: appCodeById[id] || null,
    competitions: [...club.competitions].sort(),
  };
}

for (const [competitionId, leagueId] of Object.entries(LEAGUE_IDS)) {
  const relative = `assets/crests/competitions/${competitionId}.png`;
  const file = new URL(`competitions/${competitionId}.png`, outDir);
  if (force || !(await exists(file))) {
    const league = (await getJson(`https://www.thesportsdb.com/api/v1/json/3/lookupleague.php?id=${leagueId}`))
      .leagues?.[0];
    if (league?.strBadge) await download(`${league.strBadge}/tiny`, file);
  }
  map.competitions[competitionId] = { file: (await exists(file)) ? relative : null, source: 'TheSportsDB' };
}

await writeFile(new URL('map.json', outDir), `${JSON.stringify(map, null, 1)}\n`);
console.log(
  `${Object.keys(map.clubs).length} clubes (${downloaded} baixados agora) · sem escudo: ${missing.length ? missing.join(', ') : 'nenhum'}`,
);
console.log(`Siglas do app associadas: ${Object.values(map.clubs).filter((club) => club.appCode).length}`);

// Imagem de compartilhamento (1200x630) com a classificação de um cenário.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { addHeadToHeadResult, emptyHeadToHead, rankTeams } from '../model/standings.js';
import { baseStatsFrom, openFixturesFrom } from '../model/season-model.js';

const escapeXml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char],
  );

// Classificação do cenário: tabela atual + placares ao vivo + palpites.
export function projectScenarioTable({ seasonData, standings, live, currentRound, scores }) {
  const teams = Object.keys(seasonData.teams);
  const stats = baseStatsFrom(teams, seasonData.results, standings);
  const headToHead = emptyHeadToHead(teams);
  for (const result of seasonData.results)
    addHeadToHeadResult(headToHead, result.home, result.away, result.homeGoals, result.awayGoals);
  let defined = 0;
  for (const fixture of openFixturesFrom(seasonData.fixtures, currentRound)) {
    const liveMatch = live.get(fixture.id);
    const score = liveMatch ? [liveMatch.homeGoals, liveMatch.awayGoals] : scores.get(fixture.id);
    if (!score) continue;
    if (!liveMatch) defined++;
    const [x, y] = score;
    const home = stats[fixture.home];
    const away = stats[fixture.away];
    home.J++;
    away.J++;
    home.GP += x;
    home.GC += y;
    away.GP += y;
    away.GC += x;
    if (x > y) {
      home.P += 3;
      home.V++;
    } else if (x < y) {
      away.P += 3;
      away.V++;
    } else {
      home.P++;
      away.P++;
    }
    addHeadToHeadResult(headToHead, fixture.home, fixture.away, x, y);
  }
  const order = rankTeams(stats, teams, { officialStandings: defined ? null : standings, headToHead });
  return {
    defined,
    rows: order.map((code, index) => ({ code, position: index + 1, points: stats[code].P, played: stats[code].J })),
  };
}

export function createOgRenderer({ root }) {
  const fontFiles = ['Inter_400Regular.ttf', 'Inter_700Bold.ttf', 'Inter_800ExtraBold.ttf'].map((file) =>
    path.join(root, 'server-assets', 'fonts', file),
  );
  const crestCache = new Map();
  const crest = (code) => {
    if (!crestCache.has(code)) {
      crestCache.set(code, readFileSync(path.join(root, 'server-assets', 'escudos', `${code}.png`)).toString('base64'));
    }
    return `data:image/png;base64,${crestCache.get(code)}`;
  };

  return function renderScenarioImage({ rows, teamNames, qualification, defined }) {
    const zone = (position) =>
      position <= qualification.libertadoresLeaguePositions
        ? '#3DD68C'
        : position >= qualification.sudamericanaLeagueStart && position <= qualification.sudamericanaLeagueEnd
          ? '#6AA8F0'
          : position > rows.length - qualification.relegationPlaces
            ? '#F07360'
            : '#3A4A42';
    const shown = [...rows.slice(0, 6), null, ...rows.slice(-4)];
    let y = 92;
    const lines = shown
      .map((row) => {
        if (!row) {
          y += 14;
          return `<text x="640" y="${y}" fill="#5E7268" font-size="20" font-family="Inter">···</text>`;
        }
        const line = `<g transform="translate(600 ${y})">
          <rect x="0" y="-30" width="540" height="44" rx="10" fill="#111B17"/>
          <rect x="0" y="-30" width="5" height="44" rx="2" fill="${zone(row.position)}"/>
          <text x="26" y="0" fill="#9FB3A9" font-size="20" font-weight="700" font-family="Inter">${row.position}</text>
          <image href="${crest(row.code)}" x="64" y="-24" width="32" height="32"/>
          <text x="110" y="0" fill="#ECF3EF" font-size="21" font-weight="700" font-family="Inter">${escapeXml(teamNames[row.code])}</text>
          <text x="520" y="0" fill="#E3C46B" font-size="22" font-weight="800" font-family="Inter" text-anchor="end">${row.points}</text>
        </g>`;
        y += 48;
        return line;
      })
      .join('');
    const champion = rows[0];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0E1A15"/><stop offset="1" stop-color="#070B09"/></linearGradient></defs>
      <rect width="1200" height="630" fill="url(#bg)"/>
      <text x="64" y="96" fill="#E3C46B" font-size="22" font-weight="800" font-family="Inter" letter-spacing="3">SIMULABR · BRASILEIRÃO 2026</text>
      <text x="64" y="160" fill="#ECF3EF" font-size="52" font-weight="800" font-family="Inter">Meu cenário</text>
      <text x="64" y="206" fill="#9FB3A9" font-size="24" font-family="Inter">${defined} ${defined === 1 ? 'jogo definido' : 'jogos definidos'} por mim</text>
      <rect x="64" y="262" width="470" height="250" rx="24" fill="#111B17" stroke="#24352D"/>
      <text x="96" y="312" fill="#9FB3A9" font-size="20" font-weight="700" font-family="Inter" letter-spacing="2">CAMPEÃO</text>
      <image href="${crest(champion.code)}" x="96" y="336" width="112" height="112"/>
      <text x="232" y="392" fill="#ECF3EF" font-size="34" font-weight="800" font-family="Inter">${escapeXml(teamNames[champion.code])}</text>
      <text x="232" y="432" fill="#E3C46B" font-size="26" font-weight="700" font-family="Inter">${champion.points} pontos</text>
      <text x="64" y="574" fill="#5E7268" font-size="20" font-family="Inter">Simulação do usuário · não é previsão oficial</text>
      ${lines}
    </svg>`;
    return new Resvg(svg, {
      font: { loadSystemFonts: false, fontFiles, defaultFontFamily: 'Inter' },
      fitTo: { mode: 'width', value: 1200 },
    })
      .render()
      .asPng();
  };
}

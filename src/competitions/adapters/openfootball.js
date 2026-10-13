// Leitor do formato Football.TXT do openfootball (domínio público, CC0):
// https://github.com/openfootball/south-america
//
// Linhas de jogo, por exemplo:
//   21:30  Millonarios (COL) v Fluminense RJ (BRA)      1-2 (1-1)
//          Guaraní (PAR)     v América MG (BRA)        4-5 pen. (2-3, 2-0)
//          São Raimundo RR   v Grêmio Porto Alegre     1-4 pen. 1-4 a.e.t. (1-1, 0-0)
// O placar de 90 minutos é o primeiro par entre parênteses quando houve
// prorrogação ou pênaltis; senão, é o primeiro placar da linha.

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function parseScore(text) {
  const penalties = /(\d+)-(\d+)\s*pen\./.exec(text);
  const extraTime = /(\d+)-(\d+)\s*a\.e\.t\./.exec(text);
  const parens = /\((\d+)-(\d+)(?:,\s*(\d+)-(\d+))?\)/.exec(text);
  const leading = /^(\d+)-(\d+)/.exec(text.trim());
  if (!leading) return null;
  const pair = (match, offset = 1) => [Number(match[offset]), Number(match[offset + 1])];
  const fullTime = penalties || extraTime ? (parens ? pair(parens) : null) : pair(leading);
  if (!fullTime) return null;
  return {
    fullTime,
    extraTime: extraTime ? pair(extraTime) : null,
    penalties: penalties ? pair(penalties) : null,
  };
}

function splitTeam(text) {
  const match = /^(.*?)\s*\(([A-Z]{3})\)$/.exec(text.trim());
  return match ? { name: match[1].trim(), country: match[2] } : { name: text.trim(), country: null };
}

export function parseFootballTxt(text, { competition, season } = {}) {
  const matches = [];
  let stage = null;
  let year = season ?? null;
  let date = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    const header = /^=\s*(.+?)\s+(\d{4})(?:\/\d{2,4})?\s*$/.exec(line);
    if (header) {
      year = year ?? Number(header[2]);
      continue;
    }
    const stageLine = /^▪\s*(.+)$/.exec(line.trim());
    if (stageLine) {
      stage = stageLine[1].trim();
      continue;
    }
    const dateLine = /^\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Z][a-z]{2})\s+(\d{1,2})(?:\s+(\d{4}))?\s*$/.exec(line);
    if (dateLine) {
      if (dateLine[3]) year = Number(dateLine[3]);
      date = new Date(Date.UTC(year, MONTHS[dateLine[1]], Number(dateLine[2]))).toISOString().slice(0, 10);
      continue;
    }
    const matchLine = /^\s*(?:\d{1,2}:\d{2}\s+)?(.+?)\s+v\s+(.+)$/.exec(line);
    if (!matchLine || line.trim().startsWith('#')) continue;
    const awayAndScore = /^(.+?)\s+(\d+-\d+.*)$/.exec(matchLine[2]);
    if (!awayAndScore) continue;
    const score = parseScore(awayAndScore[2]);
    if (!score) continue;
    const home = splitTeam(matchLine[1]);
    const away = splitTeam(awayAndScore[1]);
    matches.push({
      competition,
      season: year,
      stage,
      date,
      home: home.name,
      homeCountry: home.country,
      away: away.name,
      awayCountry: away.country,
      homeGoals: score.fullTime[0],
      awayGoals: score.fullTime[1],
      extraTime: score.extraTime,
      penalties: score.penalties,
    });
  }
  return matches;
}

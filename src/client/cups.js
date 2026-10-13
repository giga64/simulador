// Aba Copas: chaveamento, grupos e chances por fase (Libertadores,
// Sul-Americana e Copa do Brasil). Funções puras de HTML.
import { COMPETITIONS } from '../competitions/formats.js';
import { escapeHtml, meter, percent } from './ui.js';

const STAGE_SHORT = {
  'round-of-16': 'Oitavas',
  quarterfinals: 'Quartas',
  semifinals: 'Semi',
  final: 'Final',
  champion: 'Campeão',
};

const formatDate = (iso) =>
  new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(iso));

export function crest(teamId, crestMap, size = 22) {
  const file = crestMap?.clubs?.[teamId]?.file;
  return file
    ? `<img class="crest" src="${escapeHtml(file)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`
    : `<span class="crest crest-empty" style="width:${size}px;height:${size}px" aria-hidden="true"></span>`;
}

function teamLabel(competition, teamId, crestMap) {
  if (!teamId) return '<span class="mu">A definir</span>';
  const team = competition.teams[teamId];
  return `${crest(teamId, crestMap)}<span class="cup-team-name">${escapeHtml(team?.shortName || team?.name || '?')}</span>`;
}

function legScore(leg) {
  if (leg.state === 'pre') return `<span class="mu xs">${leg.date ? formatDate(leg.date) : 'a definir'}</span>`;
  const live =
    leg.state === 'in'
      ? `<span class="live-indicator"><i aria-hidden="true"></i>${escapeHtml(leg.clock || 'AO VIVO')}</span> `
      : '';
  const penalties = leg.penalties
    ? ` <span class="mu xs">(${leg.penalties.home}–${leg.penalties.away} pên.)</span>`
    : '';
  return `${live}<b>${leg.homeGoals}–${leg.awayGoals}</b>${penalties}`;
}

function tieCard(competition, tie, crestMap, labelFor) {
  const [a, b] = tie.teams;
  const live = tie.legs.some((leg) => leg.state === 'in');
  const row = (teamId, index) => {
    const goals = tie.aggregate ? tie.aggregate[index] : '';
    const won = tie.winner && tie.winner === teamId;
    const lost = tie.winner && teamId && tie.winner !== teamId;
    return `<div class="tie-row${won ? ' won' : ''}${lost ? ' lost' : ''}">${teamId ? teamLabel(competition, teamId, crestMap) : `<span class="mu">${escapeHtml(labelFor(index))}</span>`}<b class="tie-agg">${goals}</b></div>`;
  };
  const legs = tie.legs
    .filter((leg) => leg.home || leg.away)
    .map(
      (leg, index) =>
        `<li><span class="mu">${tie.legs.length > 1 ? (index ? 'Volta' : 'Ida') : 'Jogo'}</span><span>${legScore(leg)}</span></li>`,
    )
    .join('');
  const decided =
    tie.decidedBy === 'penalties'
      ? '<span class="tag">nos pênaltis</span>'
      : tie.winner
        ? ''
        : live
          ? '<span class="tag live-tag">ao vivo</span>'
          : '';
  return `<article class="tie${live ? ' is-live' : ''}${tie.winner ? ' done' : ''}">${row(a, 0)}${row(b, 1)}${legs ? `<ul class="tie-legs">${legs}</ul>` : ''}${decided ? `<div class="tie-foot">${decided}</div>` : ''}</article>`;
}

export function bracket(competition, crestMap) {
  const knockout = competition.stages.filter((stage) => stage.type === 'knockout' && stage.ties.length);
  const current = knockout.findIndex((stage) => stage.id === competition.currentStage);
  const from = Math.max(0, (current >= 0 ? current : knockout.length - 1) - 2);
  const shown = knockout.slice(from);
  const columns = shown.map((stage, stageIndex) => {
    const previous = shown[stageIndex - 1];
    const labelFor = (tieIndex) => (teamIndex) =>
      previous ? `Vencedor ${STAGE_SHORT[previous.id] || previous.name} ${tieIndex * 2 + teamIndex + 1}` : 'A definir';
    return `<section class="bracket-col" aria-label="${escapeHtml(stage.name)}"><h3>${escapeHtml(stage.name)}</h3><div class="bracket-ties">${stage.ties
      .map((tie, tieIndex) => tieCard(competition, tie, crestMap, labelFor(tieIndex)))
      .join('')}</div></section>`;
  });
  return `<div class="bracket" style="--cols:${shown.length}">${columns.join('')}</div>`;
}

export function groupTables(competition, crestMap) {
  if (!competition.groups.length) return '';
  const advance = COMPETITIONS[competition.id].stages.find((stage) => stage.type === 'groups')?.advance || 2;
  return `<div class="group-grid">${competition.groups
    .map(
      (group) =>
        `<section class="group-card"><h3>${escapeHtml(group.name)}</h3><table class="mini-table"><thead><tr><th class="l">Clube</th><th>P</th><th>J</th><th>SG</th></tr></thead><tbody>${group.table
          .map(
            (row, index) =>
              `<tr class="${index < advance ? 'qualified' : index === advance && competition.id === 'libertadores' ? 'to-sud' : ''}"><td class="l"><span class="cup-team">${crest(row.teamId, crestMap, 18)}${escapeHtml(competition.teams[row.teamId]?.shortName || '?')}</span></td><td class="n">${row.points}</td><td>${row.played}</td><td>${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}</td></tr>`,
          )
          .join('')}</tbody></table></section>`,
    )
    .join(
      '',
    )}</div><p class="mu xs footnote">Destaque: classificados ao mata-mata${competition.id === 'libertadores' ? '; o 3º de cada grupo foi para os playoffs da Sul-Americana' : ''}.</p>`;
}

export function chanceTable(competition, simulation, strength, adjustments, crestMap) {
  if (!simulation) return '<p class="empty">Calculando…</p>';
  const stages = simulation.stages.slice(1);
  const rows = Object.entries(simulation.probabilities).sort(
    (a, b) => (b[1].champion || 0) - (a[1].champion || 0) || (b[1][stages[0]] || 0) - (a[1][stages[0]] || 0),
  );
  if (!rows.length) return '<p class="empty">A competição já terminou.</p>';
  return `<div class="sc"><table><thead><tr><th class="l">Clube</th><th title="Nota de força (Elo) com o seu ajuste">Força</th>${stages
    .map((stage) => `<th>${STAGE_SHORT[stage] || stage}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map(([teamId, chances]) => {
      const adjustment = Number(adjustments[teamId]) || 0;
      return `<tr><td class="l"><span class="cup-team">${crest(teamId, crestMap)}${escapeHtml(competition.teams[teamId]?.name || '?')}</span></td><td><span class="elo-edit"><button type="button" class="ic sm-btn" data-act="cup-adjust" data-team="${teamId}" data-delta="-25" aria-label="Diminuir a força de ${escapeHtml(competition.teams[teamId]?.name || '')}">−</button><b title="${adjustment ? `Elo calculado ${strength.elo(teamId) - adjustment}, ajuste ${adjustment > 0 ? '+' : ''}${adjustment}` : 'Elo calculado'}">${strength.elo(teamId)}</b><button type="button" class="ic sm-btn" data-act="cup-adjust" data-team="${teamId}" data-delta="25" aria-label="Aumentar a força de ${escapeHtml(competition.teams[teamId]?.name || '')}">+</button></span>${adjustment ? `<span class="delta ${adjustment > 0 ? 'up' : 'dn'}">${adjustment > 0 ? '+' : ''}${adjustment}</span>` : ''}</td>${stages
        .map(
          (stage) =>
            `<td><b>${percent(chances[stage] || 0)}</b>${meter(chances[stage] || 0, stage === 'champion' ? 'accent' : 'b')}</td>`,
        )
        .join('')}</tr>`;
    })
    .join('')}</tbody></table></div>`;
}

export function rulesList(competitionId) {
  const rules = COMPETITIONS[competitionId].rules;
  const label = {
    awayGoals: 'Gol fora de casa',
    extraTimeBeforePenalties: 'Prorrogação',
    groupTiebreak: 'Desempate nos grupos',
    thirdPlace: '3º colocado do grupo',
    finalVenue: 'Final',
  };
  const value = (key, rule) => {
    if (key === 'awayGoals') return rule.value ? 'vale' : 'não vale';
    if (key === 'extraTimeBeforePenalties')
      return (
        {
          'final-only': 'só na final; nas outras fases, empate vai aos pênaltis',
          never: 'não; empate vai direto aos pênaltis',
        }[rule.value] || rule.value
      );
    if (key === 'groupTiebreak') return 'pontos, confronto direto, saldo, gols pró';
    if (key === 'thirdPlace') return 'vai aos playoffs da Sul-Americana';
    return rule.value;
  };
  return `<ul class="rules">${Object.entries(rules)
    .map(
      ([key, rule]) =>
        `<li><b>${label[key] || key}:</b> ${escapeHtml(value(key, rule))}${rule.confirmed ? '' : ' <span class="tag">a confirmar no regulamento</span>'}${rule.note ? `<br><span class="mu xs">${escapeHtml(rule.note)}</span>` : ''}</li>`,
    )
    .join('')}</ul>`;
}

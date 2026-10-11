const METHODS = new Set(['ml', 'sample', 'fav', 'home', 'draw']);
const SCORE_PATTERN = /^(?:0|[1-9]\d?)$/;

export function validateScenarioPayload(payload, matchIds, teamCodes) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!payload || payload.version !== 1 || typeof payload !== 'object') {
    return { errors: ['Versão do cenário inválida.'] };
  }

  const allowedMatches = new Set(matchIds);
  const allowedTeams = new Set(teamCodes);
  const scores = payload.scores;
  const settings = payload.settings;
  const options = payload.options;

  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    fail('Os placares do cenário são inválidos.');
  } else {
    for (const [id, value] of Object.entries(scores)) {
      if (!allowedMatches.has(id)) {
        fail(`O cenário contém uma partida desconhecida (${id}).`);
        continue;
      }
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        !value
          .slice(0, 2)
          .every(
            (score) => score === '' || (typeof score === 'string' && SCORE_PATTERN.test(score) && Number(score) <= 20),
          ) ||
        value.slice(0, 2).every((score) => score === '') ||
        !['a', 'u'].includes(value[2])
      ) {
        fail(`O placar da partida ${id} é inválido.`);
      }
    }
  }

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    fail('Os ajustes do modelo são inválidos.');
  } else {
    if (!Number.isInteger(settings.k) || settings.k < 1 || settings.k > 20) {
      fail('O ajuste k precisa estar entre 1 e 20.');
    }
    if (!Number.isFinite(settings.ha) || settings.ha < 0.8 || settings.ha > 1.25) {
      fail('A força do mando precisa estar entre 0,80 e 1,25.');
    }
    if (!Number.isFinite(settings.rho) || settings.rho < -0.25 || settings.rho > 0) {
      fail('A correção de empates precisa estar entre -0,25 e 0.');
    }
    if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 0xffffffff) {
      fail('A semente precisa ser um inteiro entre 0 e 4.294.967.295.');
    }
    if (!settings.adjustments || typeof settings.adjustments !== 'object' || Array.isArray(settings.adjustments)) {
      fail('Os ajustes por clube são inválidos.');
    } else {
      for (const [club, adjustment] of Object.entries(settings.adjustments)) {
        if (!allowedTeams.has(club) || !Number.isFinite(adjustment) || adjustment < -30 || adjustment > 30) {
          fail(`Ajuste inválido para o clube ${club}.`);
        }
      }
    }
  }

  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.full !== 'boolean' ||
    typeof options.odds !== 'boolean' ||
    !METHODS.has(options.method)
  ) {
    fail('As opções de exibição ou o método de simulação são inválidos.');
  }

  return { errors };
}

export function encodeScenarioPayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeScenarioPayload(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('O código do cenário contém caracteres inválidos.');
  }
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function makeBackup(payload, createdAt = new Date().toISOString()) {
  return {
    format: 'brasileirao-simulator-backup',
    version: 1,
    createdAt,
    ...payload,
  };
}

export function pruneCompletedScenarioScores(scores, fixtures, currentRound, activeMatchIds) {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    return { scores, removed: 0 };
  }

  const active = new Set(activeMatchIds);
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const keptScores = {};
  let removed = 0;

  for (const [matchId, score] of Object.entries(scores)) {
    const fixture = byId.get(matchId);
    const completed =
      fixture &&
      !active.has(matchId) &&
      (fixture.status === 'played' || (currentRound && fixture.round < currentRound && fixture.status !== 'postponed'));
    if (completed) removed++;
    else keptScores[matchId] = score;
  }

  return { scores: keptScores, removed };
}

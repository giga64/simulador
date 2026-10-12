const SCORE_PATTERN = /^(?:0|[1-9]|1\d|20)$/;

function validSourceUrl(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function outcome(home, away) {
  if (home > away) return 'H';
  if (home < away) return 'A';
  return 'D';
}

const SNAPSHOT_OUTCOMES = ['home', 'draw', 'away'];

export function createModelSnapshot({
  probabilities,
  settings,
  teams,
  dataRevision,
  method,
  recordedAt = new Date().toISOString(),
}) {
  if (
    !probabilities ||
    !SNAPSHOT_OUTCOMES.every(
      (key) => Number.isFinite(probabilities[key]) && probabilities[key] >= 0 && probabilities[key] <= 1,
    ) ||
    Math.abs(SNAPSHOT_OUTCOMES.reduce((sum, key) => sum + probabilities[key], 0) - 1) > 0.002
  ) {
    throw new Error('As probabilidades do modelo precisam ser válidas e somar 100%.');
  }
  if (
    !settings ||
    !Number.isInteger(settings.seed) ||
    settings.seed < 0 ||
    settings.seed > 0xffffffff ||
    !Number.isInteger(settings.k) ||
    !Number.isFinite(settings.ha) ||
    !Number.isFinite(settings.rho) ||
    !teams ||
    typeof teams.home !== 'string' ||
    typeof teams.away !== 'string'
  ) {
    throw new Error('As configurações do modelo para o snapshot são inválidas.');
  }
  return {
    version: 1,
    recordedAt,
    dataRevision: String(dataRevision || 'snapshot-local'),
    method: String(method || 'manual'),
    teams,
    settings: {
      seed: settings.seed,
      k: settings.k,
      ha: settings.ha,
      rho: settings.rho,
      adjustments: {
        home: Number(settings.adjustments?.[teams.home] || 0),
        away: Number(settings.adjustments?.[teams.away] || 0),
      },
    },
    probabilities: Object.fromEntries(SNAPSHOT_OUTCOMES.map((key) => [key, probabilities[key]])),
  };
}

export function upsertPredictionSnapshot(history, fixture, score, modelSnapshot) {
  if (
    !fixture ||
    !['a', 'u'].includes(score?.[2]) ||
    !SCORE_PATTERN.test(String(score?.[0])) ||
    !SCORE_PATTERN.test(String(score?.[1]))
  ) {
    throw new Error('O palpite precisa conter dois placares válidos.');
  }
  const existing = history.find((entry) => entry.fixtureId === fixture.id);
  const entry = {
    ...(existing || {}),
    fixtureId: fixture.id,
    round: fixture.round,
    home: fixture.home,
    away: fixture.away,
    prediction: { home: Number(score[0]), away: Number(score[1]), type: score[2] },
    modelSnapshot,
    recordedAt: modelSnapshot.recordedAt,
  };
  return [...history.filter((item) => item.fixtureId !== fixture.id), entry].sort(
    (a, b) => a.round - b.round || a.fixtureId.localeCompare(b.fixtureId),
  );
}

export function archiveCompletedPredictions(
  history,
  scores,
  fixtures,
  results,
  recordedAt = new Date().toISOString(),
  snapshotSource = null,
) {
  const existing = new Map(history.map((entry) => [entry.fixtureId, entry]));
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const resultsByKey = new Map(results.map((result) => [`${result.round}:${result.home}:${result.away}`, result]));
  const archived = [];
  let updated = 0;

  for (const [fixtureId, entry] of existing) {
    if (entry.actual) continue;
    const fixture = fixturesById.get(fixtureId);
    const result = fixture && resultsByKey.get(`${fixture.round}:${fixture.home}:${fixture.away}`);
    if (!result) continue;
    const resultSource =
      result.source ||
      (snapshotSource
        ? { ...snapshotSource, type: 'snapshot' }
        : { name: 'Fonte local não especificada', url: null, type: 'snapshot' });
    existing.set(fixtureId, {
      ...entry,
      actual: { home: result.homeGoals, away: result.awayGoals },
      resultSource,
    });
    updated++;
  }

  for (const [fixtureId, score] of Object.entries(scores || {})) {
    if (
      !Array.isArray(score) ||
      score.length < 3 ||
      !SCORE_PATTERN.test(score[0]) ||
      !SCORE_PATTERN.test(score[1]) ||
      !['a', 'u'].includes(score[2])
    )
      continue;
    const fixture = fixturesById.get(fixtureId);
    if (!fixture || fixture.status !== 'played') continue;
    const result = resultsByKey.get(`${fixture.round}:${fixture.home}:${fixture.away}`);
    if (!result) continue;
    const resultSource =
      result.source ||
      (snapshotSource
        ? { ...snapshotSource, type: 'snapshot' }
        : { name: 'Fonte local não especificada', url: null, type: 'snapshot' });
    const existingEntry = existing.get(fixtureId);
    if (existingEntry) {
      if (
        existingEntry.actual.home !== result.homeGoals ||
        existingEntry.actual.away !== result.awayGoals ||
        JSON.stringify(existingEntry.resultSource) !== JSON.stringify(resultSource)
      ) {
        existing.set(fixtureId, {
          ...existingEntry,
          actual: { home: result.homeGoals, away: result.awayGoals },
          resultSource,
        });
        updated++;
      }
      continue;
    }
    const entry = {
      fixtureId,
      round: fixture.round,
      home: fixture.home,
      away: fixture.away,
      prediction: { home: Number(score[0]), away: Number(score[1]), type: score[2] },
      actual: { home: result.homeGoals, away: result.awayGoals },
      resultSource,
      recordedAt,
    };
    existing.set(fixtureId, entry);
    archived.push(entry);
  }

  return {
    history: [...existing.values()].sort((a, b) => a.round - b.round || a.fixtureId.localeCompare(b.fixtureId)),
    added: archived.length,
    updated,
  };
}

export function validatePredictionHistory(history, fixtures, teams) {
  if (!Array.isArray(history)) throw new Error('O histórico de palpites precisa ser uma lista.');
  const allowed = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const seen = new Set();
  for (const entry of history) {
    const fixture = allowed.get(entry?.fixtureId);
    if (
      !fixture ||
      seen.has(entry.fixtureId) ||
      fixture.round !== entry.round ||
      fixture.home !== entry.home ||
      fixture.away !== entry.away ||
      !teams.includes(entry.home) ||
      !teams.includes(entry.away) ||
      !['a', 'u'].includes(entry.prediction?.type) ||
      ![entry.prediction?.home, entry.prediction?.away].every(
        (score) => Number.isInteger(score) && score >= 0 && score <= 20,
      ) ||
      (entry.actual != null &&
        ![entry.actual?.home, entry.actual?.away].every(
          (score) => Number.isInteger(score) && score >= 0 && score <= 20,
        )) ||
      !Number.isFinite(Date.parse(entry.recordedAt)) ||
      (entry.actual != null &&
        (!entry.resultSource ||
          typeof entry.resultSource.name !== 'string' ||
          !validSourceUrl(entry.resultSource.url) ||
          (entry.resultSource.type != null &&
            !['snapshot', 'feed-observed', 'verified-backfill'].includes(entry.resultSource.type)) ||
          (entry.resultSource.observedAt != null && !Number.isFinite(Date.parse(entry.resultSource.observedAt))) ||
          !Number.isFinite(
            Date.parse(entry.resultSource.verifiedAt || entry.resultSource.observedAt || entry.recordedAt),
          ))) ||
      (entry.modelSnapshot != null &&
        (!entry.modelSnapshot.probabilities ||
          !SNAPSHOT_OUTCOMES.every(
            (key) =>
              Number.isFinite(entry.modelSnapshot.probabilities[key]) &&
              entry.modelSnapshot.probabilities[key] >= 0 &&
              entry.modelSnapshot.probabilities[key] <= 1,
          ) ||
          Math.abs(SNAPSHOT_OUTCOMES.reduce((sum, key) => sum + entry.modelSnapshot.probabilities[key], 0) - 1) >
            0.002 ||
          !Number.isInteger(entry.modelSnapshot.settings?.seed) ||
          !Number.isFinite(Date.parse(entry.modelSnapshot.recordedAt))))
    ) {
      throw new Error('O histórico de palpites contém um registro inválido.');
    }
    seen.add(entry.fixtureId);
  }
  return history;
}

export function summarizePredictionPerformance(history, teamCodes) {
  const clubs = Object.fromEntries(
    teamCodes.map((code) => [
      code,
      {
        predictedPoints: 0,
        actualPoints: 0,
        matches: 0,
      },
    ]),
  );
  let exactScoreHits = 0;
  let correctOutcomeHits = 0;
  let predictedGoals = 0;
  let actualGoals = 0;

  for (const entry of history) {
    if (!entry.actual) continue;
    const predicted = entry.prediction;
    const actual = entry.actual;
    if (predicted.home === actual.home && predicted.away === actual.away) exactScoreHits++;
    if (outcome(predicted.home, predicted.away) === outcome(actual.home, actual.away)) {
      correctOutcomeHits++;
    }
    predictedGoals += predicted.home + predicted.away;
    actualGoals += actual.home + actual.away;
    const home = clubs[entry.home];
    const away = clubs[entry.away];
    if (!home || !away) continue;
    home.matches++;
    away.matches++;
    if (predicted.home > predicted.away) home.predictedPoints += 3;
    else if (predicted.home < predicted.away) away.predictedPoints += 3;
    else {
      home.predictedPoints++;
      away.predictedPoints++;
    }
    if (actual.home > actual.away) home.actualPoints += 3;
    else if (actual.home < actual.away) away.actualPoints += 3;
    else {
      home.actualPoints++;
      away.actualPoints++;
    }
  }

  const matches = history.filter((entry) => entry.actual).length;
  return {
    matches,
    exactScoreHits,
    correctOutcomeHits,
    exactScoreRate: matches ? exactScoreHits / matches : null,
    outcomeRate: matches ? correctOutcomeHits / matches : null,
    predictedGoals,
    actualGoals,
    clubs: Object.entries(clubs)
      .filter(([, club]) => club.matches)
      .map(([code, club]) => ({
        code,
        ...club,
        pointsDifference: club.predictedPoints - club.actualPoints,
      }))
      .sort((a, b) => b.matches - a.matches || a.code.localeCompare(b.code)),
  };
}

export function summarizePredictionCalibration(history) {
  const evaluated = history.filter((entry) => entry.actual && entry.modelSnapshot?.probabilities);
  if (!evaluated.length) return { matches: 0, brierScore: null, bins: [] };
  let brierTotal = 0;
  const bins = Array.from({ length: 5 }, (_, index) => ({
    min: index * 0.2,
    max: (index + 1) * 0.2,
    matches: 0,
    confidenceTotal: 0,
    correct: 0,
  }));
  for (const entry of evaluated) {
    const probabilities = entry.modelSnapshot.probabilities;
    const actual = outcome(entry.actual.home, entry.actual.away);
    const actualKey = actual === 'H' ? 'home' : actual === 'D' ? 'draw' : 'away';
    brierTotal += SNAPSHOT_OUTCOMES.reduce(
      (sum, key) => sum + (probabilities[key] - Number(key === actualKey)) ** 2,
      0,
    );
    const predictedKey = SNAPSHOT_OUTCOMES.reduce(
      (best, key) => (probabilities[key] > probabilities[best] ? key : best),
      SNAPSHOT_OUTCOMES[0],
    );
    const confidence = probabilities[predictedKey];
    const binIndex = Math.min(4, Math.floor(confidence / 0.2));
    const bin = bins[binIndex];
    bin.matches++;
    bin.confidenceTotal += confidence;
    if (predictedKey === actualKey) bin.correct++;
  }
  return {
    matches: evaluated.length,
    brierScore: brierTotal / evaluated.length,
    bins: bins
      .filter((bin) => bin.matches)
      .map((bin) => ({
        min: bin.min,
        max: bin.max,
        matches: bin.matches,
        meanConfidence: bin.confidenceTotal / bin.matches,
        observedAccuracy: bin.correct / bin.matches,
      })),
  };
}

export function summarizeCalibrationByRound(history) {
  const rounds = [
    ...new Set(
      history.filter((entry) => entry.actual && entry.modelSnapshot?.probabilities).map((entry) => entry.round),
    ),
  ].sort((a, b) => a - b);
  return rounds.map((round) => {
    const matches = history.filter(
      (entry) => entry.round === round && entry.actual && entry.modelSnapshot?.probabilities,
    );
    return {
      round,
      matches: matches.length,
      brierScore: summarizePredictionCalibration(matches).brierScore,
    };
  });
}

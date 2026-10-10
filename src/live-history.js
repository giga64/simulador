import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function isValidMatch(match) {
  return match && match.status === 'finished'
    && Number.isInteger(match.round) && match.round >= 1 && match.round <= 38
    && typeof match.homeTeam?.shortName === 'string'
    && typeof match.homeTeam?.name === 'string'
    && typeof match.awayTeam?.shortName === 'string'
    && typeof match.awayTeam?.name === 'string'
    && Number.isInteger(match.score?.home) && match.score.home >= 0 && match.score.home <= 20
    && Number.isInteger(match.score?.away) && match.score.away >= 0 && match.score.away <= 20
    && (match.observedAt == null || Number.isFinite(Date.parse(match.observedAt)))
    && (match.source == null || (typeof match.source.name === 'string'
      && typeof match.source.url === 'string'
      && (() => {
        try {
          return new URL(match.source.url).protocol === 'https:';
        } catch {
          return false;
        }
      })()));
}

function matchKey(match) {
  return `${match.round}:${match.homeTeam.shortName}:${match.awayTeam.shortName}`;
}

export function createLiveHistoryStore(filePath, logger = console) {
  const matches = new Map();
  let initialization;
  let warning = '';
  let persistent = true;
  let writeQueue = Promise.resolve();

  async function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      try {
        const stored = JSON.parse(await readFile(filePath, 'utf8'));
        if (stored.version !== 1 || stored.season !== 2026 || !Array.isArray(stored.matches)
          || stored.matches.some((match) => !isValidMatch(match))) {
          throw new Error('Formato do histórico persistido de resultados é inválido.');
        }
        for (const match of stored.matches) matches.set(matchKey(match), match);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          persistent = false;
          warning = `Histórico salvo não pôde ser carregado: ${error.message||String(error)}`;
          logger.error(warning);
        }
      }
    })();
    return initialization;
  }

  async function persist() {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify({
      version: 1,
      season: 2026,
      matches: [...matches.values()],
    }), 'utf8');
    await rename(temporaryPath, filePath);
  }

  return async function addFinishedMatches(feed) {
    await initialize();
    let changed = false;
    for (const match of feed.matches) {
      if (!isValidMatch(match)) continue;
      const key = matchKey(match);
      const previous = matches.get(key);
      const scoreChanged = previous && JSON.stringify(previous.score) !== JSON.stringify(match.score);
      const needsProvenance = !previous?.observedAt && typeof feed.fetchedAt === 'string';
      if (!previous || scoreChanged || needsProvenance) {
        matches.set(key, {
          ...match,
          ...(typeof feed.fetchedAt === 'string' ? { observedAt: feed.fetchedAt } : {}),
          ...(feed.source ? { source: feed.source } : {}),
        });
        changed = true;
      }
    }

    if (changed && persistent) {
      writeQueue = writeQueue.then(persist);
      try {
        await writeQueue;
        warning = '';
      } catch (error) {
        persistent = false;
        warning = `Histórico permanece apenas nesta instância: não foi possível persistir os resultados (${error.message||String(error)}).`;
        logger.error(warning);
      }
    }

    return {
      history: [...matches.values()],
      historyPersistent: persistent,
      historyWarning: warning,
    };
  };
}

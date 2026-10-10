import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLiveHistoryStore } from '../src/live-history.js';

test('finished matches persist and survive a store restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brasileirao-live-history-'));
  const filePath = path.join(directory, 'history.json');
  const feed = {
    matches: [{
      round: 30,
      status: 'finished',
      homeTeam: { shortName: 'FLA', name: 'Flamengo' },
      awayTeam: { shortName: 'PAL', name: 'Palmeiras' },
      score: { home: 2, away: 1 },
    }],
  };
  try {
    const addMatches = createLiveHistoryStore(filePath);
    const first = await addMatches(feed);
    assert.equal(first.history.length, 1);
    assert.equal(first.historyPersistent, true);

    const second = await createLiveHistoryStore(filePath)({ matches: [] });
    assert.equal(second.history.length, 1);
    assert.equal(second.history[0].score.home, 2);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).matches, feed.matches);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

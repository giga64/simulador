// Comparação do modelo com o mercado: guarda, antes de cada jogo, as
// probabilidades implícitas nas odds (sem a margem das casas) e as do modelo.
// Depois do jogo, compara as duas pelo Brier score. Opcional: precisa de
// ODDS_API_KEY (the-odds-api.com). A consulta é feita poucas vezes por dia.

const ODDS_URL = 'https://api.the-odds-api.com/v4/sports/soccer_brazil_campeonato/odds';

// Converte odds decimais em probabilidades e remove a margem (normalização).
export function impliedProbabilities(prices) {
  const inverse = prices.map((price) => 1 / price);
  const total = inverse.reduce((sum, value) => sum + value, 0);
  return inverse.map((value) => value / total);
}

// Média das casas para um evento da API. Retorna [casa, empate, fora] ou null.
export function marketFromEvent(event) {
  const samples = [];
  for (const bookmaker of event.bookmakers || []) {
    const market = bookmaker.markets?.find((item) => item.key === 'h2h');
    const price = (name) => market?.outcomes?.find((outcome) => outcome.name === name)?.price;
    const prices = [price(event.home_team), price('Draw'), price(event.away_team)];
    if (prices.every((value) => Number.isFinite(value) && value > 1)) samples.push(impliedProbabilities(prices));
  }
  if (!samples.length) return null;
  return [0, 1, 2].map((index) => samples.reduce((sum, sample) => sum + sample[index], 0) / samples.length);
}

export function brier(probabilities, outcome) {
  return probabilities.reduce((sum, p, index) => sum + (p - (index === outcome ? 1 : 0)) ** 2, 0);
}

export function compareWithMarket(records, results) {
  const rows = [];
  for (const record of records) {
    const result = results.find(
      (item) => item.round === record.round && item.home === record.home && item.away === record.away,
    );
    if (!result) continue;
    const outcome = result.homeGoals > result.awayGoals ? 0 : result.homeGoals === result.awayGoals ? 1 : 2;
    rows.push({
      ...record,
      result: [result.homeGoals, result.awayGoals],
      modelBrier: brier(record.model, outcome),
      marketBrier: brier(record.market, outcome),
    });
  }
  const mean = (key) => (rows.length ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : null);
  return {
    matches: rows.length,
    modelBrier: mean('modelBrier'),
    marketBrier: mean('marketBrier'),
    rows: rows.slice(-40).reverse(),
  };
}

export function createOddsTracker({ apiKey, store, resolveTeam, fetchImpl = fetch, now = Date.now }) {
  const enabled = typeof apiKey === 'string' && /^[A-Za-z0-9]{16,64}$/.test(apiKey);
  let records = null;
  const load = async () => {
    if (!records) records = ((await store.read()).records || []).filter((record) => record && record.fixtureId);
    return records;
  };

  return {
    enabled,
    // openFixtures: jogos sem resultado; matchModel: modelo atual (season-model).
    async refresh({ openFixtures, matchModel }) {
      if (!enabled) return;
      const url = new URL(ODDS_URL);
      url.search = new URLSearchParams({ apiKey, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal' }).toString();
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Odds: HTTP ${response.status}`);
      const events = await response.json();
      const list = await load();
      for (const event of Array.isArray(events) ? events : []) {
        if (Date.parse(event.commence_time) <= now()) continue; // só antes do início
        const home = resolveTeam({ name: event.home_team });
        const away = resolveTeam({ name: event.away_team });
        const fixture = openFixtures.find((item) => item.home === home && item.away === away);
        const market = fixture && marketFromEvent(event);
        if (!market) continue;
        const grid = matchModel.grid(home, away);
        const record = {
          fixtureId: fixture.id,
          round: fixture.round,
          home,
          away,
          market,
          model: [grid.H, grid.D, grid.A],
          recordedAt: new Date(now()).toISOString(),
        };
        const index = list.findIndex((item) => item.fixtureId === fixture.id);
        if (index >= 0) list[index] = record;
        else list.push(record);
      }
      await store.write({ version: 1, records: list });
    },
    async comparison(results) {
      return { configured: enabled, ...compareWithMarket(await load(), results) };
    },
  };
}

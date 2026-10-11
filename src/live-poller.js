// Atualização automática do feed ao vivo.
// - intervalo curto quando há jogo em andamento, longo nos demais momentos;
// - só consulta com a aba visível;
// - poke() consulta na hora quando o usuário volta para a aba, a rede volta etc.,
//   respeitando um intervalo mínimo para não consultar em excesso.
export function createLivePoller({
  refresh,
  isLive,
  isVisible,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  liveMs = 30_000,
  idleMs = 120_000,
  minGapMs = 20_000,
}) {
  let timer = null;
  let stopped = true;
  let inFlight = false;
  let lastRun = 0;

  const schedule = () => {
    clearTimer(timer);
    if (!stopped) timer = setTimer(tick, isLive() ? liveMs : idleMs);
  };

  async function run() {
    if (inFlight) return;
    inFlight = true;
    lastRun = now();
    try {
      await refresh();
    } catch {
      // refresh trata e mostra seus próprios erros
    } finally {
      inFlight = false;
    }
  }

  async function tick() {
    if (isVisible()) await run();
    schedule();
  }

  return {
    start() {
      stopped = false;
      lastRun = now();
      schedule();
    },
    stop() {
      stopped = true;
      clearTimer(timer);
    },
    async poke() {
      if (stopped || !isVisible() || inFlight || now() - lastRun < minGapMs) return false;
      await run();
      schedule();
      return true;
    },
  };
}

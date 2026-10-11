import assert from 'node:assert/strict';
import test from 'node:test';
import { createLivePoller } from '../src/live-poller.js';
import { createReloadScheduler } from '../src/reload-scheduler.js';

// relógio e temporizadores falsos
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: time + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        await due[1].fn();
      }
      time = target;
    },
    pending: () => timers.size,
  };
}

test('consulta a cada 2 min sem jogo e a cada 30 s com jogo ao vivo', async () => {
  const clock = fakeClock();
  let live = false;
  let calls = 0;
  const poller = createLivePoller({
    ...clock,
    refresh: async () => void calls++,
    isLive: () => live,
    isVisible: () => true,
  });
  poller.start();
  await clock.advance(119_000);
  assert.equal(calls, 0);
  await clock.advance(1_000);
  assert.equal(calls, 1);
  live = true;
  await clock.advance(120_000); // próximo ciclo ainda é o de 2 min, já agendado
  assert.equal(calls, 2);
  await clock.advance(90_000); // a partir daí, 30 s: 3 ciclos
  assert.equal(calls, 5);
});

test('aba oculta não consulta, mas continua agendando', async () => {
  const clock = fakeClock();
  let visible = false;
  let calls = 0;
  const poller = createLivePoller({
    ...clock,
    refresh: async () => void calls++,
    isLive: () => false,
    isVisible: () => visible,
  });
  poller.start();
  await clock.advance(300_000);
  assert.equal(calls, 0);
  visible = true;
  await clock.advance(120_000);
  assert.equal(calls, 1);
});

test('poke consulta ao voltar para a aba, respeitando o intervalo mínimo', async () => {
  const clock = fakeClock();
  let calls = 0;
  const poller = createLivePoller({
    ...clock,
    refresh: async () => void calls++,
    isLive: () => false,
    isVisible: () => true,
  });
  poller.start();
  assert.equal(await poller.poke(), false); // acabou de abrir
  await clock.advance(60_000);
  assert.equal(await poller.poke(), true);
  assert.equal(calls, 1);
  assert.equal(await poller.poke(), false); // logo em seguida: ignora
  await clock.advance(25_000);
  assert.equal(await poller.poke(), true);
  assert.equal(calls, 2);
});

test('poke não faz nada com a aba oculta, parado ou com consulta em andamento', async () => {
  const clock = fakeClock();
  let visible = false;
  let release;
  let calls = 0;
  const poller = createLivePoller({
    ...clock,
    refresh: () => new Promise((resolve) => ((release = resolve), calls++)),
    isLive: () => false,
    isVisible: () => visible,
  });
  assert.equal(await poller.poke(), false); // não iniciado
  poller.start();
  await clock.advance(60_000);
  assert.equal(await poller.poke(), false); // oculta
  visible = true;
  const first = poller.poke();
  assert.equal(await poller.poke(), false); // já em andamento
  release();
  await first;
  assert.equal(calls, 1);
  poller.stop();
  await clock.advance(10 * 60_000);
  assert.equal(calls, 1);
});

test('erro na consulta não derruba o agendamento', async () => {
  const clock = fakeClock();
  let calls = 0;
  const poller = createLivePoller({
    ...clock,
    refresh: async () => {
      calls++;
      throw new Error('falhou');
    },
    isLive: () => false,
    isVisible: () => true,
  });
  poller.start();
  await clock.advance(240_000);
  assert.equal(calls, 2);
});

test('recarga: imediata quando livre, adiada quando ocupado e forçada depois de 3 tentativas', async () => {
  const clock = fakeClock();
  const events = [];
  let busy = false;
  const request = createReloadScheduler({
    isBusy: () => busy,
    reload: () => events.push('reload'),
    announce: () => events.push('aviso'),
    setTimer: clock.setTimer,
  });
  assert.equal(request(), true);
  assert.equal(request(), false); // já pendente
  await clock.advance(1_500);
  assert.deepEqual(events, ['aviso', 'reload']);

  events.length = 0;
  busy = true;
  const second = createReloadScheduler({
    isBusy: () => busy,
    reload: () => events.push('reload'),
    announce: () => events.push('aviso'),
    setTimer: clock.setTimer,
  });
  second();
  await clock.advance(8_000 * 2);
  assert.deepEqual(events, []);
  await clock.advance(8_000 + 1_500);
  assert.deepEqual(events, ['aviso', 'reload']);
});

test('recarga espera o usuário terminar de digitar', async () => {
  const clock = fakeClock();
  const events = [];
  let busy = true;
  const request = createReloadScheduler({
    isBusy: () => busy,
    reload: () => events.push('reload'),
    announce: () => events.push('aviso'),
    setTimer: clock.setTimer,
  });
  request();
  await clock.advance(8_000);
  busy = false;
  await clock.advance(8_000);
  assert.deepEqual(events, ['aviso']);
  await clock.advance(1_500);
  assert.deepEqual(events, ['aviso', 'reload']);
});

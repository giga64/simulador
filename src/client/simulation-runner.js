import { runMonteCarlo } from '../model/monte-carlo.js';

// Envia simulações para um Web Worker. Só o pedido mais recente é entregue:
// se o usuário mudar um placar enquanto uma simulação roda, a antiga é descartada.
// Sem suporte a workers de módulo, roda na thread principal.
export function createSimulationRunner(workerUrl) {
  let worker = null;
  try {
    worker = new Worker(workerUrl, { type: 'module' });
  } catch (error) {
    console.warn('Simulações rodarão na thread principal:', error);
  }
  let latestId = 0;
  const pending = new Map();

  worker?.addEventListener('message', ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  });
  worker?.addEventListener('error', (event) => {
    console.error('Falha no worker de simulação; usando a thread principal.', event.message);
    worker.terminate();
    worker = null;
    for (const [id, request] of pending) {
      pending.delete(id);
      try {
        request.resolve(runMonteCarlo(request.input));
      } catch (error) {
        request.reject(error);
      }
    }
  });

  return function run(input) {
    const id = ++latestId;
    for (const [pendingId, request] of pending) {
      pending.delete(pendingId);
      request.resolve(null);
    }
    if (!worker) {
      return new Promise((resolve) => setTimeout(() => resolve(id === latestId ? runMonteCarlo(input) : null), 0));
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, input });
      worker.postMessage({ id, input });
    });
  };
}

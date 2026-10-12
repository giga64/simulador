import { runMonteCarlo } from './monte-carlo.js';

// Roda as simulações fora da thread principal para não travar a interface.
self.addEventListener('message', ({ data }) => {
  try {
    const result = runMonteCarlo(data.input);
    self.postMessage({ id: data.id, result }, [result.finalPositions.buffer, result.trackedOutcomes.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
});

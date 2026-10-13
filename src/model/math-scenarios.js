// Contas matemáticas sem simulação: quantos pontos garantem cada meta.
//
// "Garante" usa a hipótese mais dura: todos os rivais vencem todos os jogos
// que faltam. É uma condição suficiente (sempre verdadeira); quando os rivais
// ainda se enfrentam entre si, o número exato pode ser menor. Pontos iguais
// dependem do desempate, então a conta pede 1 ponto a mais que o rival.
// "Impossível" é exato: nem vencendo tudo o clube alcança a meta.

const TOTAL_ROUNDS = 38;

const remaining = (entry) => Math.max(0, TOTAL_ROUNDS - entry.J);
const maxPoints = (entry) => entry.P + 3 * remaining(entry);

// Pontos necessários para ficar à frente de `rivalsToPass` rivais no pior caso.
function pointsToFinishAbove(stats, code, positionsAbove) {
  const others = Object.keys(stats)
    .filter((other) => other !== code)
    .map((other) => maxPoints(stats[other]))
    .sort((a, b) => b - a);
  // Para terminar entre os `positionsAbove + 1` primeiros, basta superar o
  // máximo do (positionsAbove + 1)-ésimo rival mais perigoso.
  const threshold = others[positionsAbove];
  return threshold === undefined ? 0 : threshold + 1;
}

// Meta "terminar entre os N primeiros" (N = 1 para título).
export function clinchTopN(stats, code, n) {
  const entry = stats[code];
  const target = pointsToFinishAbove(stats, code, n - 1);
  const needed = Math.max(0, target - entry.P);
  const possible = 3 * remaining(entry);
  // Impossível: mais de n - 1 rivais já têm mais pontos do que o máximo do clube.
  const alreadyAbove = Object.keys(stats).filter((other) => other !== code && stats[other].P > maxPoints(entry)).length;
  return {
    needed,
    possible,
    remaining: remaining(entry),
    clinched: needed === 0,
    impossible: alreadyAbove >= n,
    reachableAlone: needed <= possible,
    winsNeeded: Math.ceil(needed / 3),
  };
}

// Meta "não terminar entre os últimos `places`" (fugir do rebaixamento).
export function clinchSafety(stats, code, places) {
  const teamCount = Object.keys(stats).length;
  return clinchTopN(stats, code, teamCount - places);
}

// Frases prontas para a interface. goal = { verb: 'ser campeão', noun: 'o título' }.
export function describeGoal(result, { teamName, verb, noun }) {
  if (result.clinched) return `${teamName} já garantiu ${noun}.`;
  if (result.impossible) return `${teamName} não pode mais ${verb}.`;
  if (!result.reachableAlone) {
    return `${teamName} ainda pode ${verb}, mas depende de tropeços dos rivais: mesmo vencendo os ${result.remaining} jogos que faltam, não garante sozinho.`;
  }
  const wins = result.winsNeeded === 1 ? '1 vitória' : `${result.winsNeeded} vitórias`;
  return `${teamName} garante ${noun} se somar ${result.needed} ${result.needed === 1 ? 'ponto' : 'pontos'} nos ${result.remaining} jogos que faltam (o equivalente a ${wins}).`;
}

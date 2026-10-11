// Recarrega a página quando chegam resultados novos, sem atrapalhar quem está digitando:
// se o usuário está ocupado (campo em edição, janela aberta), espera um pouco e tenta de novo.
// Depois de algumas tentativas recarrega mesmo assim, para a página não ficar desatualizada.
export function createReloadScheduler({
  isBusy,
  reload,
  announce,
  setTimer = setTimeout,
  announceDelayMs = 1500,
  retryMs = 8000,
  maxDeferrals = 3,
}) {
  let pending = false;
  return function requestReload() {
    if (pending) return false;
    pending = true;
    let deferrals = 0;
    const attempt = () => {
      if (isBusy() && deferrals < maxDeferrals) {
        deferrals++;
        setTimer(attempt, retryMs);
        return;
      }
      announce();
      setTimer(reload, announceDelayMs);
    };
    attempt();
    return true;
  };
}

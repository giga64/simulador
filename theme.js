// Aplica o tema escolhido (claro/escuro) antes do CSS, para a página não piscar.
try {
  const theme = localStorage.getItem('br26-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // sem armazenamento: segue o tema do sistema
}

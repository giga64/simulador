// Ícones SVG inline (somente o conteúdo do <svg>). Use icon('nome') para obter o elemento completo.
export const ICONS = {
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01"/>',
  wand: '<path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.2 5.8L21 11l-5.8 2.2L13 19l-2.2-5.8L5 11l5.8-2.2z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  share:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"/>',
  cl: '<path d="M15 18l-6-6 6-6"/>',
  cr: '<path d="M9 18l6-6-6-6"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  cols: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  img: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 8h.01M21 15l-5-5L5 21"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  down: '<path d="M12 3v12m0 0l-5-5m5 5l5-5M4 21h16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  alert: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
};

export const icon = (name) => `<svg class="i" viewBox="0 0 24 24">${ICONS[name]}</svg>`;

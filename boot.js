// Decide, antes da página pintar, se mostra a apresentação (primeira visita) ou o painel.
// Links de cenário compartilhado (?scenario=) vão direto ao painel; ?landing=1 força a apresentação.
(function () {
  var show = '0';
  try {
    var params = location.search;
    var forced = /[?&]landing=1(&|$)/.test(params);
    var shared = /[?&]scenario=/.test(params);
    var seen = localStorage.getItem('br26-landing-seen') === '1';
    show = forced || (!seen && !shared) ? '1' : '0';
  } catch (error) {
    show = '0';
  }
  document.documentElement.setAttribute('data-landing', show);
})();

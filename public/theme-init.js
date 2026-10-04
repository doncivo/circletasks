/* P-02 : thème appliqué avant le premier affichage (pas d'éclair blanc). Chargé de façon synchrone dans <head>, avant React.
   Lit le miroir local `ct.theme` du réglage `ui.theme` ; sans choix explicite (ou si le stockage est indisponible), aucun attribut :
   le thème suit alors prefers-color-scheme (système). Garder la clé alignée sur THEME_STORAGE_KEY (src/features/settings/theme.ts). */
/* global window, document */
(function () {
  try {
    var choice = window.localStorage.getItem('ct.theme');
    if (choice === 'light' || choice === 'dark') document.documentElement.setAttribute('data-theme', choice);
  } catch {
    /* thème système */
  }
})();

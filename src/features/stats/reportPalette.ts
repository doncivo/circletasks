import type { ReportColor } from '../../domain/reportLayout';

/**
 * Palette du rapport exporté (PNG, PDF) : un document est toujours en thème clair, quel que soit le thème de l'écran, donc les valeurs
 * ne peuvent pas être lues sur la page (elles suivraient le thème sombre). Ce sont les valeurs claires des jetons de
 * `src/ui/theme/tokens.css`, `src/features/routines/routineTokens.css` et `statsTokens.css` ; `reportPalette.test.ts` vérifie qu'elles
 * restent identiques.
 */
export const REPORT_PALETTE: { readonly [C in ReportColor]: string } = {
  bg: '#ffffff', // --ct-color-bg
  ink: '#2e2150', // --ct-color-text
  secondary: '#5e557a', // --ct-color-text-secondary
  tile: '#f3f1f6', // --ct-color-surface-input
  bar: '#c9bee6', // --ct-stats-bar
  barCurrent: '#3a2a66', // --ct-stats-bar-current
  barEmpty: '#ddd9e4', // --ct-stats-bar-empty
  heatAll: '#f2a7a0', // --ct-routine-done
  heatPartial: '#f9d3ce', // --ct-routine-heat-partial
  heatMissed: '#f3f1f6', // --ct-routine-heat-missed
  heatOff: '#ddd9e4', // --ct-routine-off-border
  border: '#e6e2ee', // --ct-color-border
};

/** Jetons CSS correspondants (pour le test de synchronisation). */
export const REPORT_PALETTE_TOKENS: { readonly [C in ReportColor]: string } = {
  bg: '--ct-color-bg',
  ink: '--ct-color-text',
  secondary: '--ct-color-text-secondary',
  tile: '--ct-color-surface-input',
  bar: '--ct-stats-bar',
  barCurrent: '--ct-stats-bar-current',
  barEmpty: '--ct-stats-bar-empty',
  heatAll: '--ct-routine-done',
  heatPartial: '--ct-routine-heat-partial',
  heatMissed: '--ct-routine-heat-missed',
  heatOff: '--ct-routine-off-border',
  border: '--ct-color-border',
};

import { flushSync } from 'react-dom';

/**
 * Ouvre une surcouche (feuille de saisie) DANS le traitement du geste de l'utilisateur : le rendu et les effets de mise en page
 * (dont le focus du champ) s'exécutent avant le retour du gestionnaire. Sur iPhone (WKWebView), un `focus()` posé hors du geste
 * ne fait pas monter le clavier (Q-05, ADR 0013 §4). À appeler depuis un gestionnaire d'événement, une minuterie ou un abonnement,
 * jamais depuis un rendu ni un effet.
 *
 * @example
 * <Fab onClick={() => openNow(() => setSheetOpen(true))} />
 */
export function openNow(open: () => void): void {
  flushSync(open);
}

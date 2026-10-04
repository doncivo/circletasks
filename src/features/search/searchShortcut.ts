import { useNavigationStore } from '../app/navigation';
import type { AppContainer } from '../app/container';

/** Identifiant du champ de saisie de la recherche (focalisé à l'ouverture et par un second Ctrl+K). */
export const SEARCH_INPUT_ID = 'ct-search-input';

/**
 * Ctrl+K (registre de raccourcis, actif aussi dans un champ de saisie) : ouvre la recherche depuis n'importe quel écran ; déjà ouverte,
 * le raccourci replace le focus dans le champ et sélectionne son texte. Renvoie la fonction qui retire le raccourci.
 */
export function registerSearchShortcut(container: Pick<AppContainer, 'shortcuts'>): () => void {
  return container.shortcuts.register('app.search', () => {
    const navigation = useNavigationStore.getState();
    if (navigation.overlays.at(-1)?.kind === 'search') {
      const input = document.getElementById(SEARCH_INPUT_ID);
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
      return;
    }
    navigation.openOverlay({ kind: 'search' });
  });
}

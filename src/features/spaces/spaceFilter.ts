import type { SpaceFilter } from '../../domain/types';
import { logDesktopFailure } from '../../platform';
import { useAppStore } from '../app/appStore';
import type { AppContainer } from '../app/container';
import type { ShortcutRegistry } from '../app/shortcuts';

/**
 * Filtre Pro / Perso / Tout (ES-03). Source de vérité unique : `useAppStore.spaceFilter`, lu par tous les écrans (jamais recopié dans
 * un store d'écran). Ce module le mémorise par appareil (réglage local `spaces.filter`, jamais synchronisé) et le restaure au
 * démarrage ; les raccourcis Ctrl+1 / Ctrl+2 / Ctrl+3 le changent.
 */

/** Lit le filtre mémorisé et le pose dans `useAppStore` ; un espace inconnu (base d'un autre appareil) retombe sur « Tout ». */
export async function restoreSpaceFilter(container: Pick<AppContainer, 'data'>): Promise<SpaceFilter> {
  let stored: SpaceFilter = 'all';
  try {
    stored = await container.data.repos.settings.get('spaces.filter');
  } catch {
    stored = 'all';
  }
  const { spaces, setSpaceFilter } = useAppStore.getState();
  const filter: SpaceFilter = stored !== 'all' && spaces.some((space) => space.id === stored) ? stored : 'all';
  setSpaceFilter(filter);
  return filter;
}

/** Mémorise chaque changement de filtre. Renvoie la fonction qui arrête l'écoute. Un échec d'écriture n'interrompt rien (filtre gardé en mémoire). */
export function persistSpaceFilter(container: Pick<AppContainer, 'data'>): () => void {
  let previous = useAppStore.getState().spaceFilter;
  return useAppStore.subscribe((state) => {
    if (state.spaceFilter === previous) return;
    previous = state.spaceFilter;
    container.data.repos.settings.set('spaces.filter', state.spaceFilter).catch((error: unknown) => logDesktopFailure('space-filter-save', error));
  });
}

/**
 * Ctrl+1 : premier espace (Pro) ; Ctrl+2 : second (Perso) ; Ctrl+3 : Tout. Actifs dans toute l'application, y compris liste focalisée
 * (registre de raccourcis, comparaison sur `event.code` : AZERTY). Renvoie la fonction qui retire les trois raccourcis.
 */
export function registerSpaceShortcuts(registry: ShortcutRegistry): () => void {
  const select = (rank: number) => (): void => {
    const { spaces, setSpaceFilter } = useAppStore.getState();
    const target = [...spaces].sort((a, b) => a.sortOrder - b.sortOrder)[rank];
    if (target) setSpaceFilter(target.id);
  };
  const offs = [
    registry.register('app.space.pro', select(0)),
    registry.register('app.space.perso', select(1)),
    registry.register('app.space.all', () => useAppStore.getState().setSpaceFilter('all')),
  ];
  return () => {
    for (const off of offs) off();
  };
}

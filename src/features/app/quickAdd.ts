import { create } from 'zustand';
import { DEFAULT_ROUTES, useNavigationStore } from './navigation';

/**
 * Demande « Ajout rapide » venue de la zone de notification (D-01, critère 5).
 * À l'ordre 1 : Aujourd'hui s'affiche et le champ « Nouvelle tâche » prend le focus, comme
 * Ctrl+N (T-01). Remplacé par la mini-fenêtre de capture à Q-01.
 *
 * Le drapeau reste levé jusqu'à ce qu'Aujourd'hui le consomme : la demande n'est pas perdue
 * si l'écran n'est pas encore monté (l'app était sur Réglages).
 */
export interface QuickAddState {
  readonly pending: boolean;
  /** Lève la demande et va sur Aujourd'hui. */
  request(): void;
  /** Appelé par Aujourd'hui : renvoie vrai une seule fois par demande. */
  consume(): boolean;
}

export const useQuickAddStore = create<QuickAddState>()((set, get) => ({
  pending: false,
  request: () => {
    useNavigationStore.getState().navigate(DEFAULT_ROUTES.tasks);
    set({ pending: true });
  },
  consume: () => {
    if (!get().pending) return false;
    set({ pending: false });
    return true;
  },
}));

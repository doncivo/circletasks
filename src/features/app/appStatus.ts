import { create } from 'zustand';
import type { AppStatusKind } from '../../domain/appStatus';
import { isOnline, watchOnline } from '../../platform/network';

/**
 * État de l'app visible dans le bandeau (A-09). Chaque source pose ou retire son état ; le bandeau n'en montre qu'un
 * (priorité du domaine). `offline` est posé par le réseau ; `syncTrouble`, `syncing`, `waitingIcloud` et `updateRequired` (Y-07) par la
 * synchro (`startSync.ts`), `calendarDisconnected` (avec son action « Reconnecter ») par les agendas (K-01 à K-03).
 */
export interface StatusSource {
  /** Nom de l'agenda (`calendarDisconnected`) ; code de l'état (`syncTrouble`, `SyncTroubleCode`) ; `remindersTrouble` : `undetermined` pour l'invitation « Autoriser ». */
  readonly detail?: string;
  /**
   * Texte déjà composé par la source (`syncTrouble`, `waitingIcloud` avec cause) : celui de la ligne de Réglages (A-09 D5), jamais
   * un chemin, une clé ni un contenu.
   */
  readonly message?: string;
  /** Autres états de la même source en attente (`syncTrouble` : « (+N) », critère 9 g). */
  readonly more?: number;
  /** Action du bouton du bandeau (« Reconnecter », « Voir »). */
  readonly onAction?: () => void;
}

export interface AppStatusState {
  readonly sources: Readonly<Partial<Record<AppStatusKind, StatusSource>>>;
  /** Pose (ou, avec `null`, retire) l'état d'une source. */
  setStatus(kind: AppStatusKind, source: StatusSource | null): void;
}

export const useAppStatusStore = create<AppStatusState>()((set) => ({
  sources: {},
  setStatus: (kind, source) =>
    set((state) => {
      const others = Object.entries(state.sources).filter(([key]) => key !== kind);
      return { sources: { ...Object.fromEntries(others), ...(source === null ? {} : { [kind]: source }) } };
    }),
}));

/** Suit le réseau de l'appareil : « Hors ligne » dès `offline`, retiré dès `online` (A-09 critères 3, 4). Renvoie l'arrêt. */
export function startNetworkStatus(): () => void {
  const apply = (online: boolean): void => useAppStatusStore.getState().setStatus('offline', online ? null : {});
  apply(isOnline());
  const stop = watchOnline(apply);
  return () => {
    stop();
    useAppStatusStore.getState().setStatus('offline', null);
  };
}

import { create } from 'zustand';
import type { AppStatusKind } from '../../domain/appStatus';
import { isOnline, watchOnline } from '../../platform/network';

/**
 * État de l'app visible dans le bandeau (A-09). Chaque source pose ou retire son état ; le bandeau n'en montre qu'un
 * (priorité du domaine). À l'ordre 1 seul `offline` est émis (réseau) ; `syncing` et `waitingIcloud` seront posés par la
 * synchro (Y-02), `calendarDisconnected` (avec son action « Reconnecter ») par les agendas (K-01 à K-03).
 */
export interface StatusSource {
  /** Nom de l'agenda (`calendarDisconnected`). */
  readonly detail?: string;
  /** Action du bouton du bandeau (« Reconnecter »). */
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

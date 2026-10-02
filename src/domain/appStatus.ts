/**
 * États de l'app affichés dans le bandeau (A-09). Un seul bandeau est affiché à la fois, selon une priorité
 * fixe : agenda déconnecté > en attente d'iCloud > synchro en cours > hors ligne.
 *
 * Émetteurs : `offline` par la plateforme (réseau) ; `syncing` et `waitingIcloud` par la synchro (Y-02, ordre 4) ;
 * `calendarDisconnected` par l'intégration des agendas (K-01 à K-03, ordre 2).
 */
export const APP_STATUS_PRIORITY = ['calendarDisconnected', 'waitingIcloud', 'syncing', 'offline'] as const;

export type AppStatusKind = (typeof APP_STATUS_PRIORITY)[number];

/** Un état actif ; `detail` : nom de l'agenda pour `calendarDisconnected`. */
export interface AppStatusEntry {
  readonly detail?: string;
}

export type ActiveStatuses = Readonly<Partial<Record<AppStatusKind, AppStatusEntry>>>;

/** L'état à afficher parmi ceux qui sont actifs (le plus prioritaire), null s'il n'y en a aucun. */
export function pickAppStatus(active: ActiveStatuses): AppStatusKind | null {
  return APP_STATUS_PRIORITY.find((kind) => active[kind] !== undefined) ?? null;
}

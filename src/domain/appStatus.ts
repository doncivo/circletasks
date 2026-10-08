/**
 * États de l'app affichés dans le bandeau (A-09). Un seul bandeau est affiché à la fois, selon une priorité fixe (critère 5 ; D1 du
 * solde du critère 9) : agenda déconnecté > problème de synchro > problème de rappels > mettez à jour l'app > en attente d'iCloud > synchro en cours >
 * hors ligne.
 *
 * Émetteurs : `offline` par la plateforme (réseau) ; `syncTrouble`, `syncing` et `waitingIcloud` par la synchro (`startSync.ts`, décision
 * de `syncBanners.ts`) ; `calendarDisconnected` par l'intégration des agendas (K-01 à K-03) ; `updateRequired` par la synchro quand un
 * autre appareil actif publie une version plus récente (Y-07 D1 : un appel à agir, jamais masqué par un état passager, mais derrière
 * l'agenda et derrière un échec de synchro, qui empêche la synchro alors qu'une version plus récente n'empêche pas la lecture).
 * `remindersTrouble` (N-01, ADR 0012 avenant N1.8) : posé par les rappels (`notificationStatus.ts`) quand les notifications ne peuvent pas partir
 * (autorisation refusée ou non décidée, échec de planification, fin de Focus, fuseau illisible) ; derrière la synchro, devant la mise à jour.
 * « Hors ligne » ne masque jamais un échec de synchro (critère 9 a).
 * `signingExpiry` (I-02, ADR 0013 §3.3) : moins de 24 h avant l'expiration de la signature SideStore, ou signature expirée (`detail` =
 * `soon` | `expired`) ; en tête : la fenêtre est courte et l'app cesse ensuite de s'ouvrir.
 */
export const APP_STATUS_PRIORITY = ['signingExpiry', 'calendarDisconnected', 'syncTrouble', 'remindersTrouble', 'updateRequired', 'waitingIcloud', 'syncing', 'offline'] as const;

export type AppStatusKind = (typeof APP_STATUS_PRIORITY)[number];

/** Un état actif ; `detail` : nom de l'agenda pour `calendarDisconnected`, code de l'état (`SyncTroubleCode`) pour `syncTrouble`. */
export interface AppStatusEntry {
  readonly detail?: string;
}

export type ActiveStatuses = Readonly<Partial<Record<AppStatusKind, AppStatusEntry>>>;

/** L'état à afficher parmi ceux qui sont actifs (le plus prioritaire), null s'il n'y en a aucun. */
export function pickAppStatus(active: ActiveStatuses): AppStatusKind | null {
  return APP_STATUS_PRIORITY.find((kind) => active[kind] !== undefined) ?? null;
}

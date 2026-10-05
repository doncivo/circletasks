import { logFailure } from '../platform/desktop/log';

/**
 * Journal technique de la synchronisation (ADR 0011, section 2.3, audit B6) : codes, compteurs, noms de tables, identifiants
 * d'appareil et d'époque seulement. Jamais de texte clair, de valeur de champ, de titre, de clé, ni de chemin.
 */
export type SyncLogDetail = Readonly<Record<string, string | number | boolean | null>>;

export interface SyncLogger {
  log(event: string, detail?: SyncLogDetail): void;
}

/** Journal par défaut : le journal technique unique de l'app (`logFailure`). */
export const defaultSyncLogger: SyncLogger = {
  log: (event, detail) => logFailure('sync', `${event} ${JSON.stringify(detail ?? {})}`),
};

/** Journal muet (tests). */
export const silentSyncLogger: SyncLogger = { log: () => undefined };

/** Journal en mémoire (tests : vérifier les événements et l'absence de contenu). */
export function createMemorySyncLogger(): SyncLogger & { readonly entries: { readonly event: string; readonly detail: SyncLogDetail }[] } {
  const entries: { event: string; detail: SyncLogDetail }[] = [];
  return { entries, log: (event, detail = {}) => entries.push({ event, detail }) };
}

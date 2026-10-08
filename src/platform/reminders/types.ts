import type { IsoDateTime } from '../../domain/types';
import type { ReminderDue, ReminderItem, ReminderList, RemindersAccess } from '../../domain/appleReminders';

/**
 * Contrat plateforme des Rappels Apple (K-05 à K-07, ADR 0008 §10.4). Implémentations :
 * - iPhone (`tauri`, `ios`) : plugin Swift `reminders` (EventKit) via `tauriReminders.ts`, seul fichier de `src` à nommer ses commandes ;
 * - PC et navigateur : `unavailableReminders.ts`, aucun appel (les Rappels n'arrivent sur PC que par la synchro) ;
 * - tests : `fakeReminders.ts` sur le magasin en mémoire de `tests/sim/reminders-sim.ts`.
 *
 * Les types de données sont ceux du domaine (`src/domain/appleReminders.ts`). Périmètre (K-05 D1) : titre, échéance, statut terminé,
 * récurrence en lecture seule ; notes, priorité, drapeau, sous-tâches, alertes et lieu ne passent jamais.
 */
export type { ReminderDue, ReminderItem, ReminderList, RemindersAccess };

/** Codes de rejet du plugin (seuls rejets, aucun texte) ; un rejet inconnu est ramené à `store-unavailable` par l'adaptateur. */
export type RemindersErrorCode =
  | 'access-denied'
  | 'store-unavailable'
  | 'read-failed'
  | 'write-failed'
  | 'not-found'
  | 'list-not-found'
  | 'read-only-list'
  | 'recurring-refused'
  | 'invalid-input';

export const REMINDERS_ERROR_CODES: readonly RemindersErrorCode[] = ['access-denied', 'store-unavailable', 'read-failed', 'write-failed', 'not-found', 'list-not-found', 'read-only-list', 'recurring-refused', 'invalid-input'];

export class RemindersError extends Error {
  constructor(readonly code: RemindersErrorCode) {
    super(`reminders:${code}`);
    this.name = 'RemindersError';
  }
}

export interface FetchRef {
  readonly id: string;
  readonly externalRef: string | null;
}

export interface FetchInput {
  readonly listIds: readonly string[];
  /**
   * Listes suivies : le détail (titre, échéance, statut) d'un élément relu par identifiant n'est rendu que s'il est dans l'une d'elles ; ailleurs seuls
   * son identifiant et sa liste (audit B1). Absent : `listIds`.
   */
  readonly scopeListIds?: readonly string[];
  readonly limitPerList: number;
  /** Éléments à relire par identifiant (liens suivis), terminés compris. */
  readonly ids: readonly FetchRef[];
}

export interface FetchedList {
  readonly listId: string;
  /** Nombre de rappels non terminés de la liste, avant le plafond. */
  readonly total: number;
  readonly items: readonly ReminderItem[];
}

export interface FetchResult {
  readonly lists: readonly FetchedList[];
  readonly byId: readonly ReminderItem[];
  /** Identifiants demandés et introuvables. */
  readonly missing: readonly string[];
  /** Listes demandées et introuvables. */
  readonly missingLists: readonly string[];
}

export interface UpsertInput {
  /** Null : création dans `listId`. */
  readonly id: string | null;
  readonly listId: string;
  readonly title: string;
  readonly due: ReminderDue | null;
  readonly completed: boolean;
  readonly completedAt: IsoDateTime | null;
}

export interface RemindersPlatform {
  /** Faux : PC et navigateur ; aucun passage, aucun appel. */
  readonly available: boolean;
  status(): Promise<RemindersAccess>;
  /** `requestFullAccessToReminders` ; seulement sur le geste « Autoriser l'accès aux Rappels », jamais au démarrage. */
  requestAccess(): Promise<RemindersAccess>;
  lists(): Promise<readonly ReminderList[]>;
  /** Non terminés des listes (échéance croissante, sans échéance ensuite, puis création), coupés à `limitPerList` ; plus les éléments demandés par identifiant. */
  fetch(input: FetchInput): Promise<FetchResult>;
  /** Rend l'élément RELU après enregistrement (`modifiedAt` compris : base de l'anti-boucle). */
  upsert(input: UpsertInput): Promise<ReminderItem>;
  setCompleted(input: { readonly id: string; readonly completed: boolean; readonly completedAt: IsoDateTime | null }): Promise<ReminderItem>;
  /** Idempotent : un rappel déjà absent est un succès. */
  delete(input: { readonly id: string }): Promise<void>;
  /** Événement `changed` (EKEventStoreChanged), sans contenu ; renvoie le désabonnement. */
  onChanged(listener: () => void): Promise<() => void>;
}

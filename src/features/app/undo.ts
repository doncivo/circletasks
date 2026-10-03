import { getLocale, tDynamic, type MessageKey } from '../../i18n';

/**
 * Actions annulables (T-13, ADR 0005) : terminer, reporter, déplacer, dupliquer,
 * supprimer (+ « Un jour », C-05 « Effacer les cochés » à l'ordre 2), valider ou rouvrir une routine (R-03), archiver, restaurer ou
 * mettre en pause une routine (R-05).
 *
 * Principe :
 * - le cas d'usage effectue l'action, construit la commande inverse à partir de
 *   l'état d'avant (renvoyé par les repositories) et la pousse dans `container.undo` ;
 * - annuler = NOUVELLE écriture (nouveau hlc), jamais réécriture de l'historique :
 *   la synchro voit une modification ordinaire ;
 * - si l'élément a changé depuis (autre action, synchro), `undo()` renvoie 'stale'
 *   sans rien écrire (comparaison du hlc enregistré après l'action) ;
 * - pile mémoire de 20 commandes, perdue à la fermeture (session) ;
 * - message « Annuler » visible 5 s sur la dernière commande ; Ctrl+Z annule la
 *   dernière commande de la pile, même après la disparition du message.
 */
export type UndoKind = 'complete' | 'reopen' | 'postpone' | 'move' | 'someday' | 'schedule' | 'duplicate' | 'delete' | 'series' | 'routine' | 'goal';

export type UndoOutcome = 'undone' | 'stale';

export interface UndoableCommand {
  readonly kind: UndoKind;
  /** Nombre d'éléments touchés (sélection multiple A-05). */
  readonly count: number;
  /** Paramètres du libellé du message « Annuler » (ex. { title } pour « « {title} » terminée »). */
  readonly labelParams?: Readonly<Record<string, string | number>>;
  /** Libellé propre à la commande (ex. report « à demain » / « au {date} ») ; sinon `UNDO_LABEL_KEYS[kind]`. */
  readonly labelKey?: MessageKey;
  undo(): Promise<UndoOutcome>;
}

export type UndoResult =
  | { readonly status: 'empty' }
  | { readonly status: UndoOutcome; readonly command: UndoableCommand };

export interface UndoSnapshot {
  /** Dernière commande annulable (celle du message « Annuler »). */
  readonly top: UndoableCommand | null;
  readonly size: number;
  /** Incrémenté à chaque `push` : relance le minuteur de 5 s du message. */
  readonly pushCount: number;
}

export interface UndoStack {
  push(command: UndoableCommand): void;
  /** Annule la dernière commande ; appels sérialisés (un double Ctrl+Z annule deux commandes). */
  undoLast(): Promise<UndoResult>;
  clear(): void;
  getSnapshot(): UndoSnapshot;
  /** Compatible `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
}

export const UNDO_STACK_CAPACITY = 20;
export const UNDO_TOAST_MS = 5_000;

/** Libellé du message « Annuler » par type d'action. */
export const UNDO_LABEL_KEYS: { readonly [K in UndoKind]: MessageKey } = {
  complete: 'undo.complete',
  reopen: 'undo.reopen',
  postpone: 'undo.postpone',
  move: 'undo.move',
  someday: 'undo.someday',
  schedule: 'undo.scheduleDate',
  duplicate: 'undo.duplicate',
  delete: 'undo.delete',
  series: 'undo.seriesOccurrence',
  // Les commandes de routine portent toujours leur propre `labelKey` (routines.undo.*) ; ce libellé générique est un repli.
  routine: 'undo.routine',
  // Les commandes d'objectif portent toujours leur propre `labelKey` (goals.undo.*) ; ce libellé générique est un repli.
  goal: 'undo.goal',
};

/** Libellé du message pour une action par lot (A-05) : « 3 tâches reportées » (pluriel via `Intl.PluralRules`). */
const UNDO_MANY_KEYS: { readonly [K in UndoKind]?: MessageKey } = {
  complete: 'undo.manyComplete',
  postpone: 'undo.manyPostpone',
  move: 'undo.manyMove',
  someday: 'undo.manySomeday',
  schedule: 'undo.manySchedule',
  duplicate: 'undo.manyDuplicate',
  delete: 'undo.deleteMany',
};

export function createUndoStack(capacity: number = UNDO_STACK_CAPACITY): UndoStack {
  let commands: UndoableCommand[] = [];
  let pushCount = 0;
  let snapshot: UndoSnapshot = { top: null, size: 0, pushCount: 0 };
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot = { top: commands.at(-1) ?? null, size: commands.length, pushCount };
    for (const listener of listeners) listener();
  };

  const undoNow = async (): Promise<UndoResult> => {
    const command = commands.pop();
    if (!command) return { status: 'empty' };
    publish();
    // Une commande en échec est retirée quand même : pas de boucle sur une erreur.
    const status = await command.undo();
    return { status, command };
  };

  return {
    push: (command) => {
      commands = [...commands, command].slice(-capacity);
      pushCount += 1;
      publish();
    },
    undoLast: () => {
      const run = chain.then(undoNow, undoNow);
      chain = run;
      return run;
    },
    clear: () => {
      commands = [];
      publish();
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Texte du message « Annuler » d'une commande : libellé propre à la commande (`labelKey`) s'il existe,
 * sinon pluriel d'un lot (`count` > 1) ou libellé du type d'action + `labelParams`.
 */
export function undoMessage(command: UndoableCommand): string {
  if (command.labelKey) return tDynamic(command.labelKey, command.labelParams);
  const many = UNDO_MANY_KEYS[command.kind];
  if (many && new Intl.PluralRules(getLocale()).select(command.count) !== 'one') {
    return tDynamic(many, { ...command.labelParams, count: command.count });
  }
  return tDynamic(UNDO_LABEL_KEYS[command.kind], command.labelParams);
}

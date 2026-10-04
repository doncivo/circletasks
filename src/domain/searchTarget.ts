import type { SearchHit } from './search';
import type { LocalDate } from './types';

/**
 * Ouverture d'un résultat de recherche (RC-03) : où aller selon le type. Le domaine décrit la cible sans connaître le routeur ; la
 * feature la traduit en navigation (`src/features/search/searchOpen.ts`).
 */
export interface ResultTarget {
  /** Onglet à ouvrir ; null : par-dessus l'onglet courant (fiche détail d'une tâche, critère 2). */
  readonly tab: 'tasks' | 'routines' | 'events' | 'checklists' | null;
  /** Écran de l'onglet « Tâches » : Aujourd'hui (au jour de `date`), « Un jour » ou Objectif. */
  readonly screen: 'today' | 'someday' | 'goals' | null;
  /** Jour affiché d'Aujourd'hui (tâche datée ouverte dans son onglet) ; null : jour courant. */
  readonly date: LocalDate | null;
  /** Checklist à ouvrir dans l'onglet Checklists. */
  readonly checklistId: string | null;
  /** Fiche à ouvrir : tâche, événement local, routine. */
  readonly detail: { readonly type: 'task' | 'event' | 'routine'; readonly id: string } | null;
}

const NONE = { tab: null, screen: null, date: null, checklistId: null, detail: null } as const satisfies ResultTarget;

export interface ResultTargetOptions {
  /** Ctrl+Entrée (PC, critère 6) : une tâche s'ouvre dans son onglet (Aujourd'hui à son jour, ou « Un jour »), pas par-dessus l'onglet courant. */
  readonly inTab: boolean;
}

/**
 * Cible d'un résultat (critères 2, 3, 4, 6) :
 * - tâche : fiche détail par-dessus l'onglet courant (une tâche « Un jour » ou terminée s'ouvre aussi) ; avec `inTab`, dans son onglet ;
 * - checklist (et item de checklist) : onglet Checklists, ouvert sur elle ;
 * - événement local : onglet Événements et feuille de modification ;
 * - routine : onglet Routines et fiche ; objectif : écran Objectif de l'onglet Tâches.
 */
export function resultTarget(hit: Pick<SearchHit, 'kind' | 'id' | 'date' | 'someday'>, options: ResultTargetOptions = { inTab: false }): ResultTarget {
  switch (hit.kind) {
    case 'task': {
      const detail = { type: 'task', id: hit.id } as const;
      if (!options.inTab) return { ...NONE, detail };
      if (hit.someday || hit.date === null) return { ...NONE, tab: 'tasks', screen: hit.someday ? 'someday' : 'today', detail };
      return { ...NONE, tab: 'tasks', screen: 'today', date: hit.date, detail };
    }
    case 'checklist':
      return { ...NONE, tab: 'checklists', checklistId: hit.id };
    case 'event':
      return { ...NONE, tab: 'events', detail: { type: 'event', id: hit.id } };
    case 'routine':
      return { ...NONE, tab: 'routines', detail: { type: 'routine', id: hit.id } };
    case 'goal':
      return { ...NONE, tab: 'tasks', screen: 'goals' };
  }
}

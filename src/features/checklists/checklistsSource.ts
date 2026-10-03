import { sortChecklistSummaries } from '../../domain/checklistRules';
import { registerTodaySource, type TodaySource } from '../today/todaySources';
import { onChecklistsChanged } from './checklistEvents';

/**
 * Source des checklists d'Aujourd'hui et de la Semaine (C-03, `registerTodaySource`, clé `checklists`, type `ChecklistSummary`) :
 * les checklists dont la date est ce jour, avec « cochés / total ». Une checklist n'est prévue que le jour de sa date et n'est jamais
 * reportée (ce n'est pas une tâche) ; les modèles et les checklists supprimées sont écartés par `buildTodayList`. Le filtre d'espace
 * est appliqué par le repository ; sous un filtre de projet, l'écran masque les checklists (elles n'ont pas de projet, ES-04).
 * `subscribe` relie les lignes aux écritures : cocher un item depuis le détail met à jour « 3/6 » sans recharger (critère 4).
 */
export const checklistsTodaySource: TodaySource = {
  id: 'checklists',
  async load(container, date, filter) {
    return { checklists: sortChecklistSummaries(await container.data.repos.checklists.listSummariesForDay(date, filter)) };
  },
  subscribe: (container, onChange) => onChecklistsChanged(container.data, onChange),
};

let unregister: (() => void) | null = null;

/** Branche la source de checklists sur Aujourd'hui et la Semaine, une seule fois (appelé au démarrage de l'app). */
export function registerChecklistsSource(): void {
  if (unregister) return;
  unregister = registerTodaySource(checklistsTodaySource);
}

/** Retire la source (tests). */
export function unregisterChecklistsSource(): void {
  unregister?.();
  unregister = null;
}

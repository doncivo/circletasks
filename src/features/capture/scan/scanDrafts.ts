import { parseQuickInput, type QuickContext, type QuickParse } from '../../../domain/quickInput';
import { addDays } from '../../../domain/localDate';
import type { LocalDate, LocalTime, ProjectId, SpaceId } from '../../../domain/types';
import { normalizeQuickText } from '../../../domain/spokenTimes';
import type { ScanProposal } from './scanLines';

/** « Date des tâches sans date » (Scan.html) : Aujourd'hui (défaut, D6), Demain, Un jour, ou une date choisie. */
export type DateDefault =
  | { readonly kind: 'today' }
  | { readonly kind: 'tomorrow' }
  | { readonly kind: 'someday' }
  | { readonly kind: 'date'; readonly date: LocalDate };

export interface ScanDraft {
  readonly title: string;
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
  /** null : tâche « Un jour » (sans date, donc sans heure). */
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly someday: boolean;
}

/** Ce que Q-02 et Q-06 lisent dans une ligne (« resto samedi », « Payer #perso @maison ») : date, heure, espace, projet. */
export function detectLine(text: string, context: QuickContext): QuickParse {
  return parseQuickInput(normalizeQuickText(text), context);
}

/** Jour posé sur une tâche sans date écrite. */
export function defaultDay(choice: DateDefault, today: LocalDate): LocalDate | null {
  switch (choice.kind) {
    case 'today':
      return today;
    case 'tomorrow':
      return addDays(today, 1);
    case 'someday':
      return null;
    case 'date':
      return choice.date;
  }
}

/**
 * Tâches à créer pour les lignes cochées (critère 9) : le titre est la ligne sans ses marques ni sa date (Q-02, Q-06) ; l'espace écrit
 * (« #pro ») l'emporte sur l'espace choisi ; une date écrite l'emporte sur « Date des tâches sans date ». Une ligne dont le titre serait
 * vide est ignorée. L'ordre des lignes est conservé.
 */
export function draftsFromProposals(
  proposals: readonly ScanProposal[],
  context: QuickContext,
  defaults: { readonly spaceId: SpaceId; readonly date: DateDefault; readonly today: LocalDate },
): ScanDraft[] {
  const fallbackDay = defaultDay(defaults.date, defaults.today);
  const drafts: ScanDraft[] = [];
  for (const proposal of proposals) {
    if (!proposal.checked) continue;
    const parse = detectLine(proposal.text, context);
    const title = parse.title.trim();
    if (title === '') continue;
    const written = parse.dateWritten && parse.date !== null;
    // Heure seule : elle se pose sur le jour par défaut ; « Un jour » n'a pas d'heure (invariant M18).
    const date = written ? parse.date : fallbackDay;
    const time = date === null ? null : parse.time;
    drafts.push({
      title,
      spaceId: parse.spaceId ?? defaults.spaceId,
      projectId: parse.projectId,
      date,
      time,
      someday: date === null,
    });
  }
  return drafts;
}

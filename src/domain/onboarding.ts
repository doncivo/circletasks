import { addDays } from './localDate';
import type { LocalDate, LocalTime, Weekday } from './types';

/**
 * Premier lancement (P-05) : étapes de l'assistant, détection du premier lancement et données d'exemple. Pur : les textes d'exemple sont
 * fournis par l'appelant (src/i18n), l'écriture passe par les cas d'usage des features.
 */

/** Étapes possibles, dans l'ordre du PRD (4 écrans au plus). L'association et les notifications arrivent avec leurs stories. */
export type OnboardingStepId = 'language' | 'spaces' | 'pairing' | 'notifications' | 'sample';

/** Modules livrés qui ajoutent leur étape (Y-01 / Y-06 : association ; I-05 : notifications, iPhone). Tous faux à l'ordre 3. */
export interface OnboardingCapabilities {
  readonly pairing: boolean;
  readonly notifications: boolean;
}

export const ORDER3_CAPABILITIES: OnboardingCapabilities = { pairing: false, notifications: false };

/** Nombre maximal d'étapes (PRD section 5). */
export const ONBOARDING_MAX_STEPS = 4;

/**
 * Étapes à afficher selon les modules livrés : « Langue et semaine » et « Espaces » toujours, l'association et les notifications seulement
 * si elles existent, « Données d'exemple » en dernier. Jamais plus de 4 (l'ordre 3 en montre 3).
 */
export function onboardingSteps(capabilities: OnboardingCapabilities = ORDER3_CAPABILITIES): readonly OnboardingStepId[] {
  const steps: OnboardingStepId[] = ['language', 'spaces'];
  if (capabilities.pairing) steps.push('pairing');
  if (capabilities.notifications) steps.push('notifications');
  steps.push('sample');
  return steps.slice(0, ONBOARDING_MAX_STEPS);
}

/** Étape de reprise : celle mémorisée si elle existe encore dans la liste, sinon la première. */
export function resumeStepIndex(steps: readonly OnboardingStepId[], saved: OnboardingStepId | null): number {
  const index = saved === null ? -1 : steps.indexOf(saved);
  return index >= 0 ? index : 0;
}

export type OnboardingDecision = 'show' | 'mark-done' | 'skip';

/**
 * Faut-il ouvrir l'assistant au lancement ? Déjà terminé ou passé : jamais. Sinon, base neuve (aucune tâche, routine, événement ni
 * checklist) : oui ; base qui contient déjà des données (installation existante) : on pose « terminé » sans rien montrer.
 */
export function decideOnboarding(input: { readonly completed: boolean; readonly hasContent: boolean }): OnboardingDecision {
  if (input.completed) return 'skip';
  return input.hasContent ? 'mark-done' : 'show';
}

/** Ids des éléments créés par « Ajouter des données d'exemple » (réglage local `sample.ids`). */
export interface SampleIds {
  readonly tasks: readonly string[];
  readonly routines: readonly string[];
  readonly checklists: readonly string[];
}

export const NO_SAMPLE_IDS: SampleIds = { tasks: [], routines: [], checklists: [] };

export function hasSampleIds(ids: SampleIds): boolean {
  return ids.tasks.length + ids.routines.length + ids.checklists.length > 0;
}

/** Textes des données d'exemple (src/i18n), dans la langue courante. */
export interface SampleTexts {
  readonly tasks: readonly { readonly title: string; readonly note?: string }[];
  readonly routines: readonly string[];
  readonly checklist: { readonly title: string; readonly items: readonly string[] };
}

/** Rang de l'espace : 0 = premier (Pro), 1 = second (Perso), quels que soient leurs noms. */
export type SampleSpaceRank = 0 | 1;

export interface SampleTaskPlan {
  readonly title: string;
  readonly note: string;
  readonly spaceRank: SampleSpaceRank;
  /** Date relative à aujourd'hui ; null : « Un jour ». */
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly someday: boolean;
}

export interface SampleRoutinePlan {
  readonly title: string;
  readonly spaceRank: SampleSpaceRank;
  readonly scheduleType: 'daily' | 'weekdays';
  readonly weekdays: readonly Weekday[];
  readonly time: LocalTime | null;
  readonly startDate: LocalDate;
}

export interface SampleDataPlan {
  readonly tasks: readonly SampleTaskPlan[];
  readonly routines: readonly SampleRoutinePlan[];
  readonly checklist: { readonly title: string; readonly spaceRank: SampleSpaceRank; readonly items: readonly string[] };
}

/** Nombres annoncés par l'étape « Données d'exemple » : « 6 tâches, 2 routines, 1 checklist ». */
export const SAMPLE_COUNTS = { tasks: 6, routines: 2, checklists: 1 } as const;

/**
 * Données d'exemple (P-05 critères 5 et 6) : 6 tâches (3 dans Pro, 3 dans Perso, dont une « Un jour »), 2 routines (une par espace) et
 * 1 checklist (Perso), les dates étant relatives à `today`. Le texte vient de l'appelant, dans l'ordre : tâches 1 à 3 pour Pro, 4 à 6 pour
 * Perso ; routine 1 pour Pro, 2 pour Perso.
 */
export function sampleData(today: LocalDate, texts: SampleTexts): SampleDataPlan {
  const task = (index: number, spaceRank: SampleSpaceRank, offset: number | null, time: LocalTime | null): SampleTaskPlan => ({
    title: texts.tasks[index]?.title ?? '',
    note: texts.tasks[index]?.note ?? '',
    spaceRank,
    date: offset === null ? null : addDays(today, offset),
    time,
    someday: offset === null,
  });
  return {
    tasks: [
      task(0, 0, 0, '09:30' as LocalTime),
      task(1, 0, 0, null),
      task(2, 0, 1, '14:00' as LocalTime),
      task(3, 1, 0, '18:30' as LocalTime),
      task(4, 1, 2, null),
      task(5, 1, null, null),
    ],
    routines: [
      { title: texts.routines[0] ?? '', spaceRank: 0, scheduleType: 'weekdays', weekdays: [5], time: null, startDate: today },
      { title: texts.routines[1] ?? '', spaceRank: 1, scheduleType: 'daily', weekdays: [], time: '07:30' as LocalTime, startDate: today },
    ],
    checklist: { title: texts.checklist.title, spaceRank: 1, items: texts.checklist.items },
  };
}

/** « A », « A, puis B », « A, puis B et C » : énumération du pied « Ensuite : … » (labels déjà traduits, mots de liaison fournis). */
export function joinNextSteps(labels: readonly string[], words: { readonly then: string; readonly and: string }): string {
  const [first, ...rest] = labels;
  if (first === undefined) return '';
  if (rest.length === 0) return first;
  const tail = rest.length === 1 ? (rest[0] ?? '') : `${rest.slice(0, -1).join(', ')} ${words.and} ${rest[rest.length - 1] ?? ''}`;
  return `${first}, ${words.then} ${tail}`;
}

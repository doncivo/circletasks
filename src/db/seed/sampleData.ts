import type { NewTask } from '../../domain/model';
import { asEntityId } from '../../domain/types';
import type { LocalDate, LocalTime, TaskId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from './defaultSpaces';

/**
 * Jeu de données de test (ordre 1, data-model) : tâches réalistes inspirées des
 * maquettes (docs/maquettes/Main.html, UnJour.html), utilisables par les tests
 * d'intégration des repositories et par un chargement de démonstration en dev
 * (ADR 0002 : base en mémoire vide à chaque rechargement).
 */

/** Identifiant stable et lisible, dérivé d'un suffixe hexadécimal court (tests déterministes). */
export function testTaskId(suffix: string): TaskId {
  return asEntityId<TaskId>(`10000000-0000-4000-8000-${suffix.padStart(12, '0')}`);
}

/** Identifiant de tâche de perf, numéroté, dans un espace de noms séparé du jeu curaté ci-dessus. */
export function bulkTaskId(index: number): TaskId {
  return asEntityId<TaskId>(`20000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
}

const DEFAULT_TASK_FIELDS = {
  spaceId: SPACE_PRO_ID,
  projectId: null,
  note: '',
  date: null,
  time: null,
  status: 'todo',
  doneAt: null,
  sortOrder: 0,
  carriedOver: false,
  recurrenceId: null,
  seriesIndex: null,
  seriesTemplate: null,
  goalId: null,
  icon: null,
  someday: false,
  source: 'local',
  externalId: null,
  externalEventId: null,
} satisfies Omit<NewTask, 'id' | 'title'>;

/** Construit une tâche de test complète ; `overrides` remplace les champs par défaut. */
export function sampleTask(overrides: Pick<NewTask, 'id' | 'title'> & Partial<NewTask>): NewTask {
  return { ...DEFAULT_TASK_FIELDS, ...overrides };
}

/** Tâches « Aujourd'hui » inspirées de docs/maquettes/Main.html. */
export function sampleTodayTasks(date: LocalDate): readonly NewTask[] {
  return [
    sampleTask({
      id: testTaskId('1'),
      title: 'Envoyer la facture',
      spaceId: SPACE_PRO_ID,
      date,
      time: '09:00' as LocalTime,
      sortOrder: 1,
    }),
    sampleTask({
      id: testTaskId('2'),
      title: 'Appeler le notaire',
      spaceId: SPACE_PERSO_ID,
      date,
      time: '14:00' as LocalTime,
      sortOrder: 2,
    }),
  ];
}

/** Tâches « Un jour » inspirées de docs/maquettes/UnJour.html. */
export function sampleSomedayTasks(): readonly NewTask[] {
  return [
    sampleTask({ id: testTaskId('3'), title: 'Renouveler le passeport', spaceId: SPACE_PERSO_ID, someday: true, sortOrder: 1 }),
    sampleTask({ id: testTaskId('4'), title: 'Préparer la présentation Q4', spaceId: SPACE_PRO_ID, someday: true, sortOrder: 2 }),
    sampleTask({ id: testTaskId('5'), title: 'Trier les photos de vacances', spaceId: SPACE_PERSO_ID, someday: true, sortOrder: 3 }),
  ];
}

/** Génère `count` tâches datées de `date`, réparties sur les deux espaces (jeux de perf). */
export function buildManyTasks(date: LocalDate, count: number): readonly NewTask[] {
  return Array.from({ length: count }, (_, i) =>
    sampleTask({
      id: bulkTaskId(i),
      title: `Tâche de test ${String(i)}`,
      spaceId: i % 2 === 0 ? SPACE_PRO_ID : SPACE_PERSO_ID,
      date,
      sortOrder: i,
    }),
  );
}

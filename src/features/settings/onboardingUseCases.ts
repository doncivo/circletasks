import {
  decideOnboarding,
  hasSampleIds,
  onboardingSteps,
  resumeStepIndex,
  sampleData,
  type OnboardingCapabilities,
  type OnboardingDecision,
  type OnboardingStepId,
  type SampleIds,
  type SampleSpaceRank,
  type SampleTexts,
} from '../../domain/onboarding';
import { todayLocal } from '../../domain/clock';
import type { ChecklistId, RoutineId, SpaceId, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import type { AppContainer } from '../app/container';
import { createChecklistUseCases } from '../checklists/checklistUseCases';
import { createRoutineUseCases } from '../routines/routineUseCases';
import { createTaskUseCases } from '../tasks/createTaskUseCases';

type Deps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo' | 'taskEntities'>;

export interface OnboardingStart {
  readonly decision: OnboardingDecision;
  readonly steps: readonly OnboardingStepId[];
  /** Étape de reprise (index dans `steps`). */
  readonly stepIndex: number;
}

export interface OnboardingUseCases {
  /**
   * Premier lancement : relit `onboarding.completed` et la base. Base qui contient déjà des données et réglage absent : pose `completed`
   * sans rien montrer. Sinon décide d'ouvrir l'assistant, à l'étape mémorisée (interruption). Rejette si la base échoue.
   */
  start(capabilities?: OnboardingCapabilities, options?: { readonly force?: boolean }): Promise<OnboardingStart>;
  /** Mémorise l'étape en cours (reprise après interruption). */
  saveStep(step: OnboardingStepId): Promise<void>;
  /** « Passer », croix ou Échap : l'assistant est terminé, les choix déjà faits restent, il ne réapparaît pas. */
  skip(): Promise<void>;
  /**
   * « Commencer » : crée les données d'exemple si demandé (et s'il n'en existe pas), puis pose `completed`. Si la création échoue, rien
   * n'est marqué terminé et l'erreur est relancée.
   */
  finish(options: { readonly withSamples: boolean }): Promise<void>;
  /** « Revoir le guide de bienvenue » : repart de la première étape (l'ouverture est forcée par `start(…, { force: true })`) ; aucune donnée n'est touchée. */
  relaunch(): Promise<void>;
  /** Des données d'exemple vivantes existent-elles ? (étape 3 et ligne « Supprimer les données d'exemple ») */
  sampleExists(): Promise<boolean>;
  createSampleData(): Promise<SampleIds>;
  /** Tâches et checklist d'exemple à la corbeille, routines archivées (chacune annulable). Renvoie le nombre d'éléments retirés. */
  removeSampleData(): Promise<number>;
}

/** Textes des données d'exemple dans la langue courante (src/i18n). */
export function sampleTextsNow(): SampleTexts {
  return {
    tasks: [
      { title: t('onboarding.sample.task1') },
      { title: t('onboarding.sample.task2') },
      { title: t('onboarding.sample.task3') },
      { title: t('onboarding.sample.task4'), note: t('onboarding.sample.task4Note') },
      { title: t('onboarding.sample.task5') },
      { title: t('onboarding.sample.task6') },
    ],
    routines: [t('onboarding.sample.routine1'), t('onboarding.sample.routine2')],
    checklist: {
      title: t('onboarding.sample.checklistTitle'),
      items: [t('onboarding.sample.checklistItem1'), t('onboarding.sample.checklistItem2'), t('onboarding.sample.checklistItem3')],
    },
  };
}

/** Cas d'usage du premier lancement (P-05). Les données d'exemple passent par les cas d'usage normaux des tâches, routines et checklists. */
export function createOnboardingUseCases(deps: Deps): OnboardingUseCases {
  const { settings, stats, spaces } = deps.data.repos;

  async function spaceOfRank(rank: SampleSpaceRank): Promise<SpaceId> {
    const all = await spaces.listAll();
    const space = all[rank] ?? all[0];
    if (!space) throw new Error('Aucun espace pour les données d’exemple');
    return space.id;
  }

  async function sampleExists(): Promise<boolean> {
    const ids = await settings.get('sample.ids');
    if (!hasSampleIds(ids)) return false;
    for (const id of ids.tasks) if (await deps.data.repos.tasks.getById(id as TaskId)) return true;
    for (const id of ids.routines) {
      const routine = await deps.data.repos.routines.getById(id as RoutineId);
      if (routine && !routine.archived) return true;
    }
    for (const id of ids.checklists) if (await deps.data.repos.checklists.getById(id as ChecklistId)) return true;
    return false;
  }

  async function createSampleData(): Promise<SampleIds> {
    const plan = sampleData(todayLocal(deps.clock), sampleTextsNow());
    const tasksCases = createTaskUseCases(deps);
    const routinesCases = createRoutineUseCases(deps);
    const checklistCases = createChecklistUseCases(deps);
    const tasks: string[] = [];
    const routines: string[] = [];
    const checklists: string[] = [];
    try {
      for (const item of plan.tasks) {
        const created = await tasksCases.create({
          title: item.title,
          spaceId: await spaceOfRank(item.spaceRank),
          date: item.date,
          time: item.time,
          someday: item.someday,
          note: item.note,
        });
        if (!created.ok) throw new Error(`Tâche d’exemple refusée : ${created.error}`);
        tasks.push(created.value.id);
      }
      for (const item of plan.routines) {
        const created = await routinesCases.create({
          fields: {
            spaceId: await spaceOfRank(item.spaceRank),
            title: item.title,
            icon: null,
            scheduleType: item.scheduleType,
            weekdays: item.weekdays,
            timesPerWeek: null,
            interval: null,
            startDate: item.startDate,
            time: item.time,
            paused: false,
            archived: false,
          },
          reminderOffsets: [],
        });
        if (!created.ok) throw new Error(`Routine d’exemple refusée : ${created.error}`);
        routines.push(created.value.id);
      }
      const list = await checklistCases.create({ title: plan.checklist.title, icon: null, spaceId: await spaceOfRank(plan.checklist.spaceRank) });
      if (!list.ok) throw new Error(`Checklist d’exemple refusée : ${list.error}`);
      checklists.push(list.value.id);
      for (const text of plan.checklist.items) await checklistCases.addItem(list.value.id as ChecklistId, text);
    } finally {
      // Même en cas d'échec au milieu, ce qui existe déjà est mémorisé : « Supprimer les données d'exemple » les retrouve.
      const ids: SampleIds = { tasks, routines, checklists };
      if (hasSampleIds(ids)) await settings.set('sample.ids', ids);
    }
    return { tasks, routines, checklists };
  }

  return {
    async start(capabilities, options = {}) {
      const steps = onboardingSteps(capabilities);
      // Relance depuis Réglages : l'assistant s'ouvre quoi que contienne la base.
      if (options.force) return { decision: 'show', steps, stepIndex: 0 };
      const completed = await settings.get('onboarding.completed');
      if (completed) return { decision: 'skip', steps, stepIndex: 0 };
      const decision = decideOnboarding({ completed, hasContent: await stats.hasAnyContent() });
      if (decision === 'mark-done') {
        await settings.set('onboarding.completed', true);
        return { decision, steps, stepIndex: 0 };
      }
      return { decision, steps, stepIndex: resumeStepIndex(steps, await settings.get('onboarding.step')) };
    },

    saveStep: (step) => settings.set('onboarding.step', step),

    async skip() {
      await settings.set('onboarding.completed', true);
      await settings.set('onboarding.step', null);
    },

    async finish({ withSamples }) {
      if (withSamples && !(await sampleExists())) await createSampleData();
      await settings.set('onboarding.completed', true);
      await settings.set('onboarding.step', null);
    },

    async relaunch() {
      await settings.set('onboarding.step', null);
    },

    sampleExists,
    createSampleData,

    async removeSampleData() {
      const ids = await settings.get('sample.ids');
      let removed = 0;
      const liveTasks: TaskId[] = [];
      for (const id of ids.tasks) if (await deps.data.repos.tasks.getById(id as TaskId)) liveTasks.push(id as TaskId);
      if (liveTasks.length > 0) {
        await createTaskUseCases(deps).remove(liveTasks);
        removed += liveTasks.length;
      }
      const routinesCases = createRoutineUseCases(deps);
      for (const id of ids.routines) {
        const routine = await deps.data.repos.routines.getById(id as RoutineId);
        if (routine && !routine.archived && (await routinesCases.setArchived(routine.id as RoutineId, true))) removed += 1;
      }
      const checklistCases = createChecklistUseCases(deps);
      for (const id of ids.checklists) {
        if ((await deps.data.repos.checklists.getById(id as ChecklistId)) && (await checklistCases.remove(id as ChecklistId))) removed += 1;
      }
      return removed;
    },
  };
}

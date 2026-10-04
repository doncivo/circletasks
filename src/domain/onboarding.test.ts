import { describe, expect, it } from 'vitest';
import {
  decideOnboarding,
  hasSampleIds,
  joinNextSteps,
  ONBOARDING_MAX_STEPS,
  onboardingSteps,
  resumeStepIndex,
  SAMPLE_COUNTS,
  sampleData,
  type SampleTexts,
} from './onboarding';
import type { LocalDate } from './types';

const texts: SampleTexts = {
  tasks: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((title) => ({ title })),
  routines: ['R1', 'R2'],
  checklist: { title: 'Valise', items: ['a', 'b', 'c'] },
};

describe('Étapes de l’assistant (P-05 critère 2)', () => {
  it('à l’ordre 3 : langue et semaine, espaces, données d’exemple (3 étapes)', () => {
    expect(onboardingSteps()).toEqual(['language', 'spaces', 'sample']);
  });

  it('l’association et les notifications s’insèrent avant les données d’exemple, jusqu’à 4 étapes', () => {
    expect(onboardingSteps({ pairing: true, notifications: false })).toEqual(['language', 'spaces', 'pairing', 'sample']);
    expect(onboardingSteps({ pairing: false, notifications: true })).toEqual(['language', 'spaces', 'notifications', 'sample']);
  });

  it('jamais plus de 4 étapes', () => {
    const all = onboardingSteps({ pairing: true, notifications: true });
    expect(all).toHaveLength(ONBOARDING_MAX_STEPS);
    expect(all).toEqual(['language', 'spaces', 'pairing', 'notifications']);
  });

  it('reprise : l’étape mémorisée si elle existe, sinon la première', () => {
    const steps = onboardingSteps();
    expect(resumeStepIndex(steps, 'spaces')).toBe(1);
    expect(resumeStepIndex(steps, 'sample')).toBe(2);
    expect(resumeStepIndex(steps, null)).toBe(0);
    expect(resumeStepIndex(steps, 'pairing')).toBe(0);
  });
});

describe('Faut-il ouvrir l’assistant ? (critère 1)', () => {
  it('base neuve et réglage absent : oui', () => {
    expect(decideOnboarding({ completed: false, hasContent: false })).toBe('show');
  });

  it('base qui contient déjà des données : on pose « terminé » sans rien montrer', () => {
    expect(decideOnboarding({ completed: false, hasContent: true })).toBe('mark-done');
  });

  it('déjà terminé ou passé : jamais', () => {
    expect(decideOnboarding({ completed: true, hasContent: false })).toBe('skip');
    expect(decideOnboarding({ completed: true, hasContent: true })).toBe('skip');
  });
});

describe('Données d’exemple (critères 5 et 6)', () => {
  const today = '2026-10-05' as LocalDate;
  const plan = sampleData(today, texts);

  it('6 tâches, 2 routines, 1 checklist', () => {
    expect(plan.tasks).toHaveLength(SAMPLE_COUNTS.tasks);
    expect(plan.routines).toHaveLength(SAMPLE_COUNTS.routines);
    expect(plan.checklist.items).toHaveLength(3);
    expect(plan.tasks.map((task) => task.title)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
  });

  it('dans Pro et Perso (rangs 0 et 1), trois tâches chacun, une routine chacun', () => {
    expect(plan.tasks.filter((task) => task.spaceRank === 0)).toHaveLength(3);
    expect(plan.tasks.filter((task) => task.spaceRank === 1)).toHaveLength(3);
    expect(plan.routines.map((routine) => routine.spaceRank)).toEqual([0, 1]);
    expect(plan.checklist.spaceRank).toBe(1);
  });

  it('dates relatives à aujourd’hui ; la tâche « Un jour » n’a ni date ni heure', () => {
    expect(plan.tasks.map((task) => task.date)).toEqual(['2026-10-05', '2026-10-05', '2026-10-06', '2026-10-05', '2026-10-07', null]);
    const someday = plan.tasks[5];
    expect(someday).toMatchObject({ someday: true, date: null, time: null });
    expect(plan.tasks.filter((task) => task.someday)).toHaveLength(1);
    // Aucune heure sans date.
    expect(plan.tasks.every((task) => task.time === null || task.date !== null)).toBe(true);
    // Le lendemain d’un changement de mois reste une vraie date.
    expect(sampleData('2026-10-31' as LocalDate, texts).tasks[2]?.date).toBe('2026-11-01');
  });

  it('les routines commencent aujourd’hui', () => {
    expect(plan.routines.every((routine) => routine.startDate === today)).toBe(true);
  });

  it('hasSampleIds', () => {
    expect(hasSampleIds({ tasks: [], routines: [], checklists: [] })).toBe(false);
    expect(hasSampleIds({ tasks: [], routines: [], checklists: ['x'] })).toBe(true);
  });
});

describe('Pied « Ensuite : … » (critère 2)', () => {
  const words = { then: 'puis', and: 'et' };

  it('énumère seulement les étapes suivantes', () => {
    expect(joinNextSteps([], words)).toBe('');
    expect(joinNextSteps(['données d’exemple'], words)).toBe('données d’exemple');
    expect(joinNextSteps(['espaces', 'données d’exemple'], words)).toBe('espaces, puis données d’exemple');
    expect(joinNextSteps(['association avec le PC', 'notifications', 'données d’exemple'], words)).toBe('association avec le PC, puis notifications et données d’exemple');
    expect(joinNextSteps(['a', 'b', 'c', 'd'], words)).toBe('a, puis b, c et d');
  });
});

import { describe, expect, it } from 'vitest';
import type { ReplanOutcome, ReplanTrigger } from './replanNotifications';
import { createNotificationRunner } from './notificationRunner';

const planned = (n: number): ReplanOutcome => ({ status: 'planned', report: { scheduled: n, cancelled: 0, kept: 0 }, coverage: { state: 'complete' }, total: n });

/** Passage contrôlé : chaque appel est une promesse résolue à la main, le nombre de passages simultanés est mesuré. */
function controlledPass() {
  const started: ReplanTrigger[] = [];
  const gates: ((outcome: ReplanOutcome) => void)[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const pass = (trigger: ReplanTrigger): Promise<ReplanOutcome> => {
    started.push(trigger);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    return new Promise((resolve) => {
      gates.push((outcome) => {
        concurrent -= 1;
        resolve(outcome);
      });
    });
  };
  return { pass, started, gates, max: () => maxConcurrent };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('NotificationRunner : sérialisation et coalescence (N-01 critère 8)', () => {
  it('un seul déclencheur : un passage, sa promesse porte son résultat', async () => {
    const c = controlledPass();
    const runner = createNotificationRunner(c.pass);
    const result = runner.request('open');
    expect(c.started).toEqual(['open']);
    c.gates[0]?.(planned(3));
    expect(await result).toEqual(planned(3));
  });

  it('une rafale de 20 déclencheurs pendant un passage : un seul passage en attente, jamais deux passages simultanés', async () => {
    const c = controlledPass();
    const runner = createNotificationRunner(c.pass);
    const first = runner.request('open');
    const burst = Array.from({ length: 20 }, (_, index) => runner.request(index % 2 === 0 ? 'edit' : 'sync'));
    expect(c.started).toEqual(['open']);
    c.gates[0]?.(planned(1));
    expect(await first).toEqual(planned(1));
    await flush();
    // Un seul passage relancé pour les 20 déclencheurs.
    expect(c.started).toHaveLength(2);
    c.gates[1]?.(planned(2));
    const results = await Promise.all(burst);
    expect(results.every((result) => result.status === 'planned' && result.report.scheduled === 2)).toBe(true);
    await flush();
    expect(c.started).toHaveLength(2);
    expect(c.max()).toBe(1);
  });

  it('les déclencheurs arrivés pendant le passage en attente en préparent un nouveau, toujours un seul à la fois', async () => {
    const c = controlledPass();
    const runner = createNotificationRunner(c.pass);
    void runner.request('open');
    const second = runner.request('edit');
    c.gates[0]?.(planned(1));
    await flush();
    expect(c.started).toEqual(['open', 'edit']);
    const third = runner.request('hide');
    const fourth = runner.request('resume');
    c.gates[1]?.(planned(2));
    expect(await second).toEqual(planned(2));
    await flush();
    expect(c.started).toHaveLength(3);
    c.gates[2]?.(planned(3));
    expect(await third).toEqual(planned(3));
    expect(await fourth).toEqual(planned(3));
    expect(c.max()).toBe(1);
  });

  it('aucun déclencheur en attente : le coordinateur repart à zéro (le suivant démarre aussitôt)', async () => {
    const c = controlledPass();
    const runner = createNotificationRunner(c.pass);
    const first = runner.request('open');
    c.gates[0]?.(planned(1));
    await first;
    const next = runner.request('resume');
    expect(c.started).toEqual(['open', 'resume']);
    c.gates[1]?.(planned(1));
    await next;
  });

  it('un passage qui rejetterait (garde-fou) rend un échec et laisse le coordinateur utilisable', async () => {
    let calls = 0;
    const runner = createNotificationRunner(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('imprévu')) : Promise.resolve(planned(1));
    });
    expect(await runner.request('open')).toEqual({ status: 'failed', reason: 'schedule-failed' });
    expect(await runner.request('open')).toEqual(planned(1));
  });
});

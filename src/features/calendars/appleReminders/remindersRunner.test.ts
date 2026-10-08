import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REPORT, type PassKind, type PassReport } from './remindersPass';
import { createRemindersRunner, HIDE_PASS_BUDGET_MS, PUSH_DELAY_MS, type RunnerTimers } from './remindersRunner';

/** Coordinateur des passages (K-05 critère 11) : jamais deux passages simultanés, une rafale de 20 déclencheurs donne au plus deux passages. */
interface Timer {
  readonly handler: () => void;
  readonly ms: number;
  cleared: boolean;
}

function setup(options: { readonly failFirst?: boolean } = {}) {
  const started: { kind: PassKind; deadlineAt: number | undefined }[] = [];
  const gates: (() => void)[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const timers: Timer[] = [];
  const fakeTimers: RunnerTimers = {
    setTimeout: (handler, ms) => {
      const timer: Timer = { handler, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => void ((handle as Timer).cleared = true),
  };
  const pass = vi.fn(
    (kind: PassKind, deadlineAt?: number): Promise<PassReport> =>
      new Promise((resolve, reject) => {
        started.push({ kind, deadlineAt });
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        gates.push(() => {
          concurrent -= 1;
          if (options.failFirst === true && started.length === 1) reject(new Error('boom'));
          else resolve({ ...EMPTY_REPORT, created: started.length });
        });
      }),
  );
  const runner = createRemindersRunner(pass, fakeTimers, () => 1_000);
  const release = async (): Promise<void> => {
    gates.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { runner, started, release, timers, maxConcurrent: () => maxConcurrent, pass };
}

afterEach(() => vi.useRealTimers());

describe('coordinateur des passages (K-05 critère 11)', () => {
  it('une rafale de 20 déclencheurs donne au plus deux passages, jamais simultanés', async () => {
    const { runner, started, release, maxConcurrent } = setup();
    const promises = Array.from({ length: 20 }, () => runner.request('changed'));
    expect(started).toHaveLength(1);
    await release();
    expect(started).toHaveLength(2);
    await release();
    const reports = await Promise.all(promises);
    expect(started).toHaveLength(2);
    expect(maxConcurrent()).toBe(1);
    // Le premier déclencheur reçoit le premier passage, les 19 suivants le second.
    expect(reports[0]?.created).toBe(1);
    expect(new Set(reports.slice(1).map((report) => report.created))).toEqual(new Set([2]));
  });

  it('un déclencheur après la fin d’un passage en lance un nouveau', async () => {
    const { runner, started, release } = setup();
    const first = runner.request('open');
    await release();
    await first;
    const second = runner.request('resume');
    expect(started).toHaveLength(2);
    await release();
    await second;
  });

  it('une écriture locale programme UN passage push après le délai ; une rafale n’en programme pas d’autre', async () => {
    const { runner, started, release, timers } = setup();
    const a = runner.request('edit');
    const b = runner.request('edit');
    expect(started).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(PUSH_DELAY_MS);
    expect(PUSH_DELAY_MS).toBeGreaterThan(5_000);
    timers[0]?.handler();
    expect(started.map((entry) => entry.kind)).toEqual(['push']);
    await release();
    expect(await Promise.all([a, b])).toHaveLength(2);
    // Une nouvelle écriture reprogramme.
    void runner.request('edit');
    expect(timers).toHaveLength(2);
  });

  it('un passage complet en attente absorbe un push ; un push en attente devient complet quand un complet arrive', async () => {
    const { runner, started, release, timers } = setup();
    const running = runner.request('open');
    void runner.request('edit');
    timers[0]?.handler();
    // Le push est mis en attente derrière le passage en cours, puis un complet arrive : un seul passage suivant, complet.
    void runner.request('resume');
    await release();
    expect(started.map((entry) => entry.kind)).toEqual(['full', 'full']);
    await release();
    await running;
    expect(started).toHaveLength(2);
  });

  it('au masquage de l’iPhone le passage reçoit une échéance de 8 s', async () => {
    const { runner, started, release } = setup();
    const done = runner.request('hide');
    expect(started[0]?.deadlineAt).toBe(1_000 + HIDE_PASS_BUDGET_MS);
    expect(HIDE_PASS_BUDGET_MS).toBe(8_000);
    await release();
    await done;
    const other = runner.request('open');
    expect(started[1]?.deadlineAt).toBeUndefined();
    await release();
    await other;
  });

  it('un passage qui lève une exception ne bloque pas le coordinateur : échec rendu, passage suivant possible', async () => {
    const { runner, started, release } = setup({ failFirst: true });
    const first = runner.request('open');
    await release();
    expect(await first).toMatchObject({ status: 'failed', code: 'pass-failed' });
    const second = runner.request('resume');
    expect(started).toHaveLength(2);
    await release();
    expect(await second).toMatchObject({ status: 'done' });
  });

  it('dispose annule le push programmé sans rendre le coordinateur inutilisable (remontage)', async () => {
    const { runner, started, release, timers } = setup();
    const pending = runner.request('edit');
    runner.dispose();
    expect(timers[0]?.cleared).toBe(true);
    expect(await pending).toMatchObject({ status: 'skipped' });
    expect(started).toEqual([]);
    const after = runner.request('open');
    expect(started).toHaveLength(1);
    await release();
    await after;
  });
});

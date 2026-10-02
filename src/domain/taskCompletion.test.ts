import { describe, expect, it } from 'vitest';
import { asIsoDateTime } from './types';
import { completeTask, isCompleted, reopenTask } from './taskCompletion';

const NOW = asIsoDateTime('2026-10-05T10:00:00.000Z');
const EARLIER = asIsoDateTime('2026-10-05T08:00:00.000Z');

describe('completeTask / reopenTask (T-04)', () => {
  it('completeTask pose status = done et doneAt = instant fourni (critère 1)', () => {
    expect(completeTask({ status: 'todo', doneAt: null }, NOW)).toEqual({ status: 'done', doneAt: NOW });
  });

  it('completeTask est idempotent : une tâche déjà terminée garde son doneAt', () => {
    expect(completeTask({ status: 'done', doneAt: EARLIER }, NOW)).toEqual({ status: 'done', doneAt: EARLIER });
    expect(isCompleted({ status: 'done', doneAt: EARLIER })).toBe(true);
    expect(isCompleted({ status: 'todo', doneAt: null })).toBe(false);
  });

  it('reopenTask pose status = todo et doneAt = null (critère 5)', () => {
    expect(reopenTask()).toEqual({ status: 'todo', doneAt: null });
  });
});

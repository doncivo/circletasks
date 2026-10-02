import { describe, expect, it, vi } from 'vitest';
import { UNDO_LABEL_KEYS, UNDO_STACK_CAPACITY, UNDO_TOAST_MS, createUndoStack, undoMessage, type UndoableCommand } from './undo';

const command = (undo: () => Promise<'undone' | 'stale'> = async () => 'undone'): UndoableCommand => ({
  kind: 'complete',
  count: 1,
  undo,
});

describe('pile d’annulation (T-13)', () => {
  it('garde les 20 dernières commandes et annule la plus récente d’abord', async () => {
    const stack = createUndoStack();
    const calls: number[] = [];
    for (let i = 0; i < 25; i += 1) stack.push(command(async () => (calls.push(i), 'undone')));
    expect(UNDO_STACK_CAPACITY).toBe(20);
    expect(stack.getSnapshot()).toMatchObject({ size: 20, pushCount: 25 });
    await stack.undoLast();
    await stack.undoLast();
    expect(calls).toEqual([24, 23]);
    expect(stack.getSnapshot().size).toBe(18);
  });

  it('signale une pile vide et une commande périmée', async () => {
    const stack = createUndoStack();
    expect(await stack.undoLast()).toEqual({ status: 'empty' });
    const stale = command(async () => 'stale');
    stack.push(stale);
    expect(await stack.undoLast()).toEqual({ status: 'stale', command: stale });
  });

  it('sérialise les annulations successives (double Ctrl+Z)', async () => {
    const stack = createUndoStack();
    const order: string[] = [];
    let release: () => void = () => undefined;
    stack.push(command(async () => (order.push('a'), 'undone')));
    stack.push(
      command(
        () =>
          new Promise((resolve) => {
            release = () => {
              order.push('b');
              resolve('undone');
            };
          }),
      ),
    );
    const first = stack.undoLast();
    const second = stack.undoLast();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['b', 'a']);
  });

  it('retire une commande en échec et continue avec les suivantes', async () => {
    const stack = createUndoStack();
    stack.push(command());
    stack.push(command(async () => Promise.reject(new Error('base occupée'))));
    await expect(stack.undoLast()).rejects.toThrow('base occupée');
    expect(await stack.undoLast()).toMatchObject({ status: 'undone' });
  });

  it('notifie les abonnés et se vide', () => {
    const stack = createUndoStack(2);
    const listener = vi.fn();
    const unsubscribe = stack.subscribe(listener);
    const c = command();
    stack.push(c);
    expect(stack.getSnapshot().top).toBe(c);
    stack.clear();
    expect(stack.getSnapshot()).toMatchObject({ top: null, size: 0 });
    unsubscribe();
    stack.push(command());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('expose la durée du message et les libellés', () => {
    expect(UNDO_TOAST_MS).toBe(5000);
    expect(UNDO_LABEL_KEYS.delete).toBe('undo.delete');
  });
});

describe('undoMessage (T-04, critère 3)', () => {
  it('interpole le titre dans le libellé de la commande', async () => {
    const { undoMessage } = await import('./undo');
    expect(undoMessage({ kind: 'complete', count: 1, labelParams: { title: 'Courses' }, undo: async () => 'undone' })).toBe(
      '« Courses » terminée',
    );
    expect(undoMessage({ kind: 'delete', count: 1, labelParams: { title: 'Courses' }, undo: async () => 'undone' })).toBe('« Courses » supprimée');
  });
});

describe('undoMessage (typage de t, T-05)', () => {
  it('compose le libellé du type, ou le libellé propre à la commande, avec ses paramètres', () => {
    expect(undoMessage({ ...command(), labelParams: { title: 'Courses' } })).toBe('« Courses » terminée');
    expect(undoMessage({ ...command(), kind: 'postpone' })).toBe('Tâche reportée');
    expect(undoMessage({ ...command(), kind: 'postpone', labelKey: 'undo.postponeTomorrow', labelParams: { title: 'Courses' } })).toBe('« Courses » reportée à demain');
  });
});

describe('undoMessage au pluriel (T-13, critère 6)', () => {
  it('un lot de plusieurs éléments donne le message au pluriel, un seul le singulier', () => {
    expect(undoMessage({ ...command(), kind: 'postpone', count: 3 })).toBe('3 tâches reportées');
    expect(undoMessage({ ...command(), kind: 'complete', count: 2 })).toBe('2 tâches terminées');
    expect(undoMessage({ ...command(), kind: 'move', count: 4 })).toBe('4 tâches déplacées');
    expect(undoMessage({ ...command(), kind: 'someday', count: 3 })).toBe('3 tâches rangées dans « Un jour »');
    expect(undoMessage({ ...command(), kind: 'postpone', count: 1 })).toBe('Tâche reportée');
  });

  it('le message de déplacement cite le titre et le jour', () => {
    expect(undoMessage({ ...command(), kind: 'move', labelKey: 'undo.moveDate', labelParams: { title: 'Courses', date: 'jeu. 24' } })).toBe(
      '« Courses » déplacée au jeu. 24',
    );
  });
});

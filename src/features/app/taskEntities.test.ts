import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../domain/model';
import type { Hlc, TaskId } from '../../domain/types';
import { createTaskEntities } from './taskEntities';

const task = (id: string, hlc: string, title = 'A'): Task => ({ id: id as TaskId, hlc: hlc as Hlc, title }) as unknown as Task;

describe('taskEntities (ADR 0004, avenant)', () => {
  it('publie, lit et notifie les abonnés', () => {
    const entities = createTaskEntities();
    const listener = vi.fn();
    entities.subscribe(listener);
    const a = task('a', '001');
    entities.publish([a]);
    expect(entities.get(a.id)).toBe(a);
    expect(listener).toHaveBeenCalledTimes(1);
    entities.publish([a]); // identique : aucune notification
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('une entité plus ancienne (hlc inférieur) n’écrase pas une plus récente', () => {
    const entities = createTaskEntities();
    entities.publish([task('a', '002', 'récente')]);
    entities.publish([task('a', '001', 'ancienne')]);
    expect(entities.get('a' as TaskId)?.title).toBe('récente');
  });

  it('retire des entités et renouvelle le snapshot', () => {
    const entities = createTaskEntities();
    entities.publish([task('a', '001')]);
    const before = entities.getSnapshot();
    entities.remove(['a' as TaskId]);
    expect(entities.get('a' as TaskId)).toBeUndefined();
    expect(entities.getSnapshot()).not.toBe(before);
  });
});

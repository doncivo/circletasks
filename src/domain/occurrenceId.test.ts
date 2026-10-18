import { describe, expect, it } from 'vitest';
import { occurrenceReminderId, occurrenceTaskId, uuidV5 } from './occurrenceId';
import { asEntityId, isId, type RecurrenceId, type TaskId } from './types';

const R = asEntityId<RecurrenceId>('11111111-1111-4111-8111-111111111111');

describe('UUID v5 des occurrences (T-TECH-01 critère 1)', () => {
  it('vecteur de la RFC 9562 (espace DNS, www.example.com)', async () => {
    expect(await uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('identifiant de tâche : littéral figé (même valeur sur Windows, iPhone et Node), valide, version 5', async () => {
    const id = await occurrenceTaskId(R, 1);
    expect(id).toBe('5383ca26-81c7-5174-b5c4-98210d6b3475');
    expect(isId(id)).toBe(true);
    expect(id[14]).toBe('5');
    expect('89ab').toContain(id[19]);
  });

  it('deux calculs donnent le même identifiant, deux couples différents deux identifiants différents', async () => {
    expect(await occurrenceTaskId(R, 1)).toBe(await occurrenceTaskId(R, 1));
    expect(await occurrenceTaskId(R, 2)).toBe('248be55e-76da-570a-97a7-48d46ca80e78');
    const other = asEntityId<RecurrenceId>('22222222-2222-4222-8222-222222222222');
    expect(await occurrenceTaskId(other, 1)).not.toBe(await occurrenceTaskId(R, 1));
  });

  it('identifiant de rappel : littéral figé, un par avance', async () => {
    const task = await occurrenceTaskId(R, 1);
    expect(await occurrenceReminderId(task, 60)).toBe('2f9fd5e6-3e7c-56b7-8b33-b6c1a6149d72');
    expect(await occurrenceReminderId(task, 5)).toBe('0e484a06-17a9-5c3e-887f-8803ca2dd28f');
    expect(isId(await occurrenceReminderId(asEntityId<TaskId>(task), 0))).toBe(true);
  });
});

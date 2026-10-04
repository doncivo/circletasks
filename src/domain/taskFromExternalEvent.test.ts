import { describe, expect, it } from 'vitest';
import { taskFromExternalEvent } from './taskFromExternalEvent';
import type { SpaceId } from './types';

const PRO = 'space-pro' as SpaceId;
const timed = (startUtc: string, endUtc: string | null = null) => ({ title: 'Point client', allDay: false, startUtc, endUtc });

describe('taskFromExternalEvent (K-04)', () => {
  it('titre de l’événement, date locale du début, espace de l’agenda, sans heure (critère 2)', () => {
    expect(taskFromExternalEvent(timed('2026-09-23T08:00:00Z', '2026-09-23T09:00:00Z'), { spaceId: PRO }, 'Europe/Paris', '(Sans titre)')).toEqual({ title: 'Point client', date: '2026-09-23', spaceId: PRO });
  });

  it('la date suit le fuseau de l’appareil (T-11) : 23:30Z est déjà le lendemain à Paris, encore la veille à New York', () => {
    const event = timed('2026-09-23T23:30:00Z');
    expect(taskFromExternalEvent(event, null, 'Europe/Paris', 'x')?.date).toBe('2026-09-24');
    expect(taskFromExternalEvent(event, null, 'America/New_York', 'x')?.date).toBe('2026-09-23');
    expect(taskFromExternalEvent(event, null, 'Pacific/Auckland', 'x')?.date).toBe('2026-09-24');
  });

  it('journée entière ou plusieurs jours : premier jour, sans décalage de fuseau (critère 4)', () => {
    const day = { title: 'Congé', allDay: true, startUtc: '2026-09-24', endUtc: '2026-09-27' };
    for (const zone of ['Europe/Paris', 'Pacific/Honolulu', 'Pacific/Kiritimati']) expect(taskFromExternalEvent(day, null, zone, 'x')?.date).toBe('2026-09-24');
    expect(taskFromExternalEvent(timed('2026-09-24T22:00:00Z', '2026-09-26T10:00:00Z'), null, 'UTC', 'x')?.date).toBe('2026-09-24');
  });

  it('agenda sans espace : null (l’appelant applique l’espace par défaut) ; événement sans titre : texte fourni ; titre trop long : borné', () => {
    expect(taskFromExternalEvent(timed('2026-09-23T08:00:00Z'), { spaceId: null }, 'UTC', 'x')?.spaceId).toBeNull();
    expect(taskFromExternalEvent({ ...timed('2026-09-23T08:00:00Z'), title: '   ' }, null, 'UTC', '(Sans titre)')?.title).toBe('(Sans titre)');
    expect(taskFromExternalEvent({ ...timed('2026-09-23T08:00:00Z'), title: 'x'.repeat(500) }, null, 'UTC', 'x')?.title).toHaveLength(200);
  });

  it('instant illisible : ni date ni tâche', () => {
    expect(taskFromExternalEvent(timed('pas une date'), null, 'UTC', 'x')).toBeNull();
  });
});

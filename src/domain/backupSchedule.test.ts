import { describe, expect, it } from 'vitest';
import { backupDay, backupStamp, dayToLocalDate, isDailyBackupDue, sortBackupVersions, summarizeBackups, type BackupVersionInfo } from './backupSchedule';
import { createManualClock } from './clock';

const daily = (day: string, modifiedMs: number): BackupVersionInfo => ({ name: `circletasks-daily-${day}.db`, kind: 'daily', stamp: day, modifiedMs });
const local = (iso: string): number => new Date(iso).getTime();

describe('Sauvegarde quotidienne (P-04 critère 10, horloge injectable)', () => {
  it('le jour est celui de l’horloge locale, au format du nom de fichier', () => {
    expect(backupDay(createManualClock(local('2026-10-05T10:15:00')))).toBe('20261005');
    expect(backupDay(createManualClock(local('2026-12-31T23:59:59')))).toBe('20261231');
    expect(dayToLocalDate('20261005')).toBe('2026-10-05');
  });

  it('l’horodatage de la copie de sécurité est en UTC compact', () => {
    expect(backupStamp(createManualClock('2026-10-05T10:15:00.250Z'))).toBe('20261005T101500Z');
  });

  it('une seule sauvegarde par jour : due tant qu’aucune quotidienne ne porte le jour', () => {
    const clock = createManualClock(local('2026-10-05T08:00:00'));
    expect(isDailyBackupDue([], clock)).toBe(true);
    expect(isDailyBackupDue([daily('20261004', 1)], clock)).toBe(true);
    expect(isDailyBackupDue([daily('20261005', 1)], clock)).toBe(false);
    // Les sauvegardes avant migration ou restauration ne comptent pas comme la sauvegarde du jour.
    const other: BackupVersionInfo = { name: 'x', kind: 'pre-migration', stamp: '20261005T080000Z', modifiedMs: 1 };
    expect(isDailyBackupDue([other], clock)).toBe(true);
  });

  it('à partir de minuit, la première occasion en crée une nouvelle', () => {
    const clock = createManualClock(local('2026-10-05T23:59:30'));
    const versions = [daily('20261005', 1)];
    expect(isDailyBackupDue(versions, clock)).toBe(false);
    clock.advance(60_000); // 00:00:30 le 6 octobre
    expect(isDailyBackupDue(versions, clock)).toBe(true);
  });

  it('plus récentes d’abord', () => {
    const sorted = sortBackupVersions([daily('20261003', 10), daily('20261005', 30), daily('20261004', 20)]);
    expect(sorted.map((v) => v.stamp)).toEqual(['20261005', '20261004', '20261003']);
  });
});

describe('Résumé de la ligne de Réglages (critère 3)', () => {
  it('aucune sauvegarde quotidienne : « none »', () => {
    const clock = createManualClock(local('2026-10-05T10:00:00'));
    expect(summarizeBackups([], clock)).toEqual({ kind: 'none' });
    expect(summarizeBackups([{ name: 'x', kind: 'pre-migration', stamp: 's', modifiedMs: 1 }], clock)).toEqual({ kind: 'none' });
  });

  it('aujourd’hui, hier ou une autre date, avec le nombre de quotidiennes', () => {
    const clock = createManualClock(local('2026-10-05T10:00:00'));
    const today = local('2026-10-05T03:12:00');
    const yesterday = local('2026-10-04T21:40:00');
    const old = local('2026-10-01T09:00:00');
    expect(summarizeBackups([daily('20261005', today), daily('20261004', yesterday)], clock)).toEqual({ kind: 'last', modifiedMs: today, day: 'today', count: 2 });
    expect(summarizeBackups([daily('20261004', yesterday)], clock)).toEqual({ kind: 'last', modifiedMs: yesterday, day: 'yesterday', count: 1 });
    expect(summarizeBackups([daily('20261001', old)], clock)).toMatchObject({ day: 'other' });
  });
});

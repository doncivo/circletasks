import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  CSV_HEADERS,
  csvCell,
  csvChunk,
  csvHeader,
  EXPORT_SCHEMA_VERSION,
  exportFileName,
  filterFileSuffix,
  historyToJson,
  localDateOfInstant,
  recurrenceCode,
  tasksToCsv,
  type ExportTask,
} from './historyExport';
import { ALL_ITEMS } from './itemFilter';
import { makeLog, makeRoutine } from './routineTestKit';
import type { IsoDateTime, LocalDate } from './types';

const d = (value: string) => value as LocalDate;

function task(overrides: Partial<ExportTask> = {}): ExportTask {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    title: 'Envoyer la facture',
    note: '',
    date: d('2026-09-23'),
    time: '09:30',
    status: 'todo',
    doneAt: null,
    someday: false,
    spaceId: 's1',
    spaceName: 'Pro',
    projectId: null,
    projectName: null,
    goalId: null,
    goalTitle: null,
    recurrence: null,
    createdAt: '2026-09-01T08:00:00.000Z' as IsoDateTime,
    updatedAt: '2026-09-01T08:00:00.000Z' as IsoDateTime,
    ...overrides,
  };
}

describe('CSV (H-03 critère 2)', () => {
  it('première ligne : BOM puis les en-têtes, séparés par « ; », les six premières colonnes étant le format d’import de P-07', () => {
    expect(csvHeader()).toBe(`${CSV_BOM}titre;date;heure;espace;projet;note;statut;termine_le;objectif;repetition\r\n`);
    expect(CSV_HEADERS.slice(0, 6)).toEqual(['titre', 'date', 'heure', 'espace', 'projet', 'note']);
  });

  it('une ligne par tâche : dates AAAA-MM-JJ, heures HH:MM, statut en français', () => {
    const rows = csvChunk([task(), task({ title: 'Courses', date: null, time: null, status: 'done', doneAt: '2026-09-20T12:00:00.000Z' as IsoDateTime, spaceName: 'Perso' })]);
    expect(rows.split('\r\n')).toEqual(['Envoyer la facture;2026-09-23;09:30;Pro;;;à faire;;;', 'Courses;;;Perso;;;fait;2026-09-20;;', '']);
  });

  it('accents conservés, guillemets doublés, point-virgule et retours à la ligne des notes entre guillemets', () => {
    expect(csvCell('Réunion « équipe »')).toBe('Réunion « équipe »');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('ligne 1\nligne 2')).toBe('"ligne 1\nligne 2"');
    const csv = tasksToCsv([task({ note: 'ligne 1\nligne 2; fin' })]);
    expect(csv).toContain('"ligne 1\nligne 2; fin"');
    expect(csv.startsWith(CSV_BOM)).toBe(true);
  });

  it('une cellule qui commencerait comme une formule est neutralisée', () => {
    expect(csvCell('=SOMME(A1:A2)')).toBe("'=SOMME(A1:A2)");
    expect(csvCell('@mention')).toBe("'@mention");
    expect(csvCell('+33 6 00')).toBe("'+33 6 00");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(csvCell('＝1+1')).toBe("'＝1+1");
    expect(csvCell('－1+1')).toBe("'－1+1");
    expect(csvCell('\n=1')).toBe('"\'\n=1"');
    expect(csvCell('-5 degrés')).toBe("'-5 degrés");
    expect(csvCell('- point')).toBe("'- point");
  });

  it('un nombre négatif pur reste lisible', () => {
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('-2,5')).toBe('-2,5');
    expect(csvCell('-2.5')).toBe('-2.5');
    expect(csvCell('-5-')).toBe("'-5-");
  });

  it('objectif et répétition', () => {
    const rule = { freq: 'weekly' as const, interval: 2, weekdays: [1, 3], monthDay: null, nthWeekday: null, until: null, count: null };
    const cells = csvChunk([task({ goalTitle: 'Finir le dossier', recurrence: rule })]);
    expect(cells).toContain(';Finir le dossier;weekly/2/mon,wed');
  });
});

describe('recurrenceCode', () => {
  it('codes stables', () => {
    expect(recurrenceCode(null)).toBe('');
    expect(recurrenceCode({ freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null })).toBe('daily/1');
    expect(recurrenceCode({ freq: 'monthly', interval: 1, weekdays: [], monthDay: 15, nthWeekday: null, until: d('2027-01-01'), count: null })).toBe('monthly/1/day15/until=2027-01-01');
    expect(recurrenceCode({ freq: 'monthly', interval: 1, weekdays: [], monthDay: null, nthWeekday: { nth: 2, weekday: 1 }, until: null, count: 5 })).toBe('monthly/1/2mon/count=5');
  });
});

describe('noms de fichier (H-03 critères 2 à 6)', () => {
  const base = { today: d('2026-10-04'), month: { year: 2026, month: 9 } };
  it('CSV, JSON, PDF et PNG', () => {
    expect(exportFileName('csv', { ...base, spaceName: null })).toBe('circletasks-taches-2026-10-04.csv');
    expect(exportFileName('json', { ...base, spaceName: null })).toBe('circletasks-historique-2026-10-04.json');
    expect(exportFileName('pdf', { ...base, spaceName: null })).toBe('circletasks-rapport-2026-09.pdf');
    expect(exportFileName('png', { ...base, spaceName: null })).toBe('circletasks-rapport-2026-09.png');
  });
  it('filtre d’espace : suffixe -pro', () => {
    expect(exportFileName('csv', { ...base, spaceName: 'Pro' })).toBe('circletasks-taches-2026-10-04-pro.csv');
    expect(filterFileSuffix('Mon Espace é')).toBe('-mon-espace-e');
    expect(filterFileSuffix('???')).toBe('');
  });
});

describe('localDateOfInstant', () => {
  it('date locale d’un instant UTC (midi : même jour sous tous les fuseaux courants)', () => {
    expect(localDateOfInstant('2026-09-20T12:00:00.000Z')).toBe('2026-09-20');
  });
});

describe('JSON (H-03 critère 3)', () => {
  it('schema_version, exported_at, filter, tasks, routines (validations et pauses), focus_sessions, goals', () => {
    const routine = makeRoutine({ title: 'Sport' });
    const json = historyToJson({
      exportedAt: '2026-10-04T10:00:00.000Z' as IsoDateTime,
      filter: ALL_ITEMS,
      spaceName: null,
      projectName: null,
      period: { kind: 'all' },
      tasks: [task({ doneAt: '2026-09-20T12:00:00.000Z' as IsoDateTime, status: 'done' })],
      routines: [routine],
      routineLogs: [makeLog(routine, '2026-09-20')],
      routinePauses: [],
      focusSessions: [],
      goals: [],
    });
    expect(Object.keys(json)).toEqual(['schema_version', 'exported_at', 'filter', 'tasks', 'routines', 'focus_sessions', 'goals']);
    expect(json['schema_version']).toBe(EXPORT_SCHEMA_VERSION);
    const tasks = json['tasks'] as Record<string, unknown>[];
    expect(tasks[0]).toMatchObject({ id: '20000000-0000-4000-8000-000000000001', done_at: '2026-09-20T12:00:00.000Z', done_date: '2026-09-20', date: '2026-09-23' });
    const routines = json['routines'] as { logs: { date: string }[]; pauses: unknown[] }[];
    expect(routines[0]?.logs.map((log) => log.date)).toEqual(['2026-09-20']);
    expect(routines[0]?.pauses).toEqual([]);
    expect(JSON.stringify(json)).not.toMatch(/token|secret|password/i);
  });
});

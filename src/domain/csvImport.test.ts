import { describe, expect, it } from 'vitest';
import {

  detectDelimiter,
  IMPORT_MAX_ROWS,
  importTemplateCsv,
  parseCsv,
  parseImportDate,
  parseImportFile,
  parseImportTime,
  rejectedReportCsv,
  stripFormulaGuard,
  titleDateKey,
  validateImportRows,
  type ImportContext,
  type ImportTable,
} from './csvImport';
import { tasksToCsv, type ExportTask } from './historyExport';
import { asEntityId } from './types';
import type { LocalDate, ProjectId, SpaceId } from './types';

const PRO = asEntityId<SpaceId>('00000000-0000-4000-8000-0000000000a1');
const PERSO = asEntityId<SpaceId>('00000000-0000-4000-8000-0000000000a2');
const MISSION = asEntityId<ProjectId>('00000000-0000-4000-8000-0000000000b1');
const ARCHIVED = asEntityId<ProjectId>('00000000-0000-4000-8000-0000000000b2');

const context: ImportContext = {
  spaces: [
    { id: PRO, name: 'Pro' },
    { id: PERSO, name: 'Perso' },
  ],
  defaultSpaceId: PRO,
  projects: [
    { id: MISSION, spaceId: PRO, name: 'Mission client', archived: false },
    { id: ARCHIVED, spaceId: PRO, name: 'Ancien', archived: true },
  ],
  undated: 'today',
  today: '2026-10-05' as LocalDate,
};

function table(text: string): ImportTable {
  const result = parseImportFile(text);
  if (!result.ok) throw new Error(result.error);
  return result.table;
}

describe('Séparateur et lecture CSV (critère 2)', () => {
  it('reconnaît « ; », « , » et la tabulation d’après l’en-tête', () => {
    expect(detectDelimiter('titre;date;heure\nA;B;C')).toBe(';');
    expect(detectDelimiter('titre,date,heure\nA,B,C')).toBe(',');
    expect(detectDelimiter('titre\tdate\theure\nA\tB\tC')).toBe('\t');
    expect(detectDelimiter('titre\nA')).toBe(';');
    expect(detectDelimiter('"a;b;c",titre,date\n')).toBe(',');
  });

  it('guillemets doublés, séparateur et retours à la ligne dans une cellule, CRLF et LF, lignes vides ignorées', () => {
    const records = parseCsv('titre;note\r\nA;"ligne 1\nligne ""2""; fin"\r\n\r\nB;\n', ';');
    expect(records).toEqual([
      { line: 1, cells: ['titre', 'note'] },
      { line: 2, cells: ['A', 'ligne 1\nligne "2"; fin'] },
      { line: 5, cells: ['B', ''] },
    ]);
  });

  it('en-têtes comparés sans accents ni casse, colonne inconnue ignorée', () => {
    const t = table('TITRE;Date;Heure;Espace;Projet;Note;Priorité;statut\nA;;;;;;1;fait');
    expect(t.columns).toEqual({ titre: 0, date: 1, heure: 2, espace: 3, projet: 4, note: 5 });
    expect(t.ignored).toEqual(['Priorité', 'statut']);
    expect(table('Titre,Date\nA,').columns.heure).toBe(-1);
  });

  it('refuse un fichier vide, sans colonne titre, ou de plus de 5 000 lignes', () => {
    expect(parseImportFile('')).toEqual({ ok: false, error: 'empty' });
    expect(parseImportFile('﻿\n\n')).toEqual({ ok: false, error: 'empty' });
    expect(parseImportFile('date;heure\n2026-10-05;10:00')).toEqual({ ok: false, error: 'no-title-column' });
    const many = `titre\n${Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `T${String(i)}`).join('\n')}`;
    expect(parseImportFile(many)).toEqual({ ok: false, error: 'too-many-rows' });
    const exact = `titre\n${Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => `T${String(i)}`).join('\n')}`;
    expect(parseImportFile(exact).ok).toBe(true);
  });
});

describe('Dates et heures (critère 4)', () => {
  it('AAAA-MM-JJ, JJ/MM/AAAA et JJ/MM/AA', () => {
    expect(parseImportDate('2026-10-05')).toBe('2026-10-05');
    expect(parseImportDate('05/10/2026')).toBe('2026-10-05');
    expect(parseImportDate('5/1/2026')).toBe('2026-01-05');
    expect(parseImportDate('05/10/26')).toBe('2026-10-05');
    expect(parseImportDate('29/02/2028')).toBe('2028-02-29');
  });

  it('dates qui n’existent pas ou autres formats : refusées', () => {
    for (const bad of ['31/02/2026', '29/02/2027', '2026-13-01', '2026-10-32', '10/05', '5 octobre', '2026/10/05', '00/10/2026', '05-10-2026']) {
      expect(parseImportDate(bad), bad).toBeNull();
    }
  });

  it('HH:MM et HHhMM, 24 h', () => {
    expect(parseImportTime('09:30')).toBe('09:30');
    expect(parseImportTime('9h30')).toBe('09:30');
    expect(parseImportTime('14H05')).toBe('14:05');
    expect(parseImportTime('0:00')).toBe('00:00');
    for (const bad of ['24:00', '12:60', '9h', '9:5', '10 h 30', '1030', 'midi']) expect(parseImportTime(bad), bad).toBeNull();
  });
});

describe('Validation des lignes (critères 4, 5 et 11)', () => {
  const run = (rows: string[], overrides: Partial<ImportContext> = {}) => validateImportRows(table(`titre;date;heure;espace;projet;note\n${rows.join('\n')}`), { ...context, ...overrides });

  it('une ligne complète est valide ; l’espace vide prend l’espace par défaut ; casse et accents ignorés', () => {
    const { valid, rejected, warnings } = run(['Appeler Paul;2026-10-06;10:00;PERSO;;note', 'Sans espace;06/10/2026;;;;', 'Autre;;;pérso;;']);
    expect(rejected).toEqual([]);
    expect(warnings).toEqual([]);
    expect(valid.map((v) => [v.title, v.date, v.time, v.spaceName])).toEqual([
      ['Appeler Paul', '2026-10-06', '10:00', 'Perso'],
      ['Sans espace', '2026-10-06', null, 'Pro'],
      ['Autre', '2026-10-05', null, 'Perso'],
    ]);
    expect(valid[0]?.note).toBe('note');
  });

  it('sans date : Aujourd’hui par défaut, ou « Un jour » selon le choix', () => {
    const today = run(['A;;;;;']).valid[0];
    expect(today).toMatchObject({ date: '2026-10-05', someday: false });
    const someday = run(['A;;;;;'], { undated: 'someday' }).valid[0];
    expect(someday).toMatchObject({ date: null, someday: true, time: null });
  });

  it('rejets avec motif : titre vide ou trop long, date, heure, heure sans date, espace inconnu', () => {
    const long = 'x'.repeat(201);
    const { valid, rejected } = run([`;2026-10-05;;;;`, `${long};;;;;`, 'A;31/02/2026;;;;', 'B;2026-10-05;25:00;;;', 'C;;10:00;;;', 'D;;;Famille;;', 'OK;;;;;']);
    expect(valid.map((v) => v.title)).toEqual(['OK']);
    expect(rejected.map((r) => [r.line, r.reason])).toEqual([
      [2, { code: 'title-empty' }],
      [3, { code: 'title-too-long', length: 201 }],
      [4, { code: 'date-invalid', value: '31/02/2026' }],
      [5, { code: 'time-invalid', value: '25:00' }],
      [6, { code: 'time-without-date', value: '10:00' }],
      [7, { code: 'space-unknown', value: 'Famille' }],
    ]);
    expect(rejected[4]?.cells).toEqual(['C', '', '10:00', '', '', '']);
  });

  it('un titre de 200 caractères passe ; les emoji comptent pour un caractère', () => {
    expect(run([`${'x'.repeat(200)};;;;;`]).valid).toHaveLength(1);
    expect(run([`${'😀'.repeat(200)};;;;;`]).valid).toHaveLength(1);
  });

  it('avertissements : projet inconnu ou archivé (importée sans projet), note tronquée à 10 000 caractères', () => {
    const { valid, rejected, warnings } = run(['A;;;pro;Mission Client;', 'B;;;Pro;Inconnu;', 'C;;;Pro;Ancien;', 'D;;;Perso;Mission client;', `E;;;;;${'n'.repeat(10_001)}`]);
    expect(rejected).toEqual([]);
    expect(valid).toHaveLength(5);
    expect(valid[0]?.projectId).toBe(MISSION);
    expect(valid[1]?.projectId).toBeNull();
    expect(valid[2]?.projectId).toBeNull();
    expect(valid[3]?.projectId).toBeNull(); // le projet est cherché dans l'espace de la ligne
    expect(valid[4]?.note).toHaveLength(10_000);
    expect(warnings.map((w) => [w.line, w.warning.code])).toEqual([
      [3, 'project-unknown'],
      [4, 'project-unknown'],
      [5, 'project-unknown'],
      [6, 'note-truncated'],
    ]);
  });

  it('critère 11 : une cellule commençant par = + - @ reste du texte, jamais interprétée', () => {
    const { valid } = run(['=SOMME(A1:A3);;;;;', '+33612345678;;;;;', '-5 degrés;;;;;', '@cmd;;;;;', '-5;;;;;']);
    expect(valid.map((v) => v.title)).toEqual(['=SOMME(A1:A3)', '+33612345678', '-5 degrés', '@cmd', '-5']);
  });

  it('lignes entièrement vides ignorées ; cellules manquantes vides', () => {
    const { valid, rejected } = run([';;;;;', 'Seul', '   ;  ;;;;']);
    expect(rejected).toEqual([]);
    expect(valid.map((v) => v.title)).toEqual(['Seul']);
  });

  it('fichier sans colonne date ni espace : tout va dans aujourd’hui et l’espace par défaut', () => {
    const { valid } = validateImportRows(table('titre\nA\nB'), context);
    expect(valid.map((v) => [v.date, v.spaceName])).toEqual([
      ['2026-10-05', 'Pro'],
      ['2026-10-05', 'Pro'],
    ]);
  });

  it('5 000 lignes s’analysent et se valident en moins de 1 s (critère 12, hors écriture)', () => {
    const lines = Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => `Tâche ${String(i)};${i % 3 === 0 ? '2026-10-06' : '06/10/2026'};${i % 2 === 0 ? '09:30' : '9h30'};${i % 2 === 0 ? 'Pro' : 'Perso'};Mission client;note ${String(i)}`);
    const text = `titre;date;heure;espace;projet;note\n${lines.join('\n')}`;
    const start = performance.now();
    const result = validateImportRows(table(text), context);
    const elapsed = performance.now() - start;
    expect(result.valid).toHaveLength(IMPORT_MAX_ROWS);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('Apostrophe de l’export H-03 (notes de la fiche)', () => {
  it('stripFormulaGuard retire l’apostrophe ajoutée devant = + @ - tabulation et retours à la ligne, pas les autres', () => {
    expect(stripFormulaGuard("'=SOMME(A1)")).toBe('=SOMME(A1)');
    expect(stripFormulaGuard("'+33")).toBe('+33');
    expect(stripFormulaGuard("'@cmd")).toBe('@cmd');
    expect(stripFormulaGuard("'-5 degrés")).toBe('-5 degrés');
    expect(stripFormulaGuard("'\tx")).toBe('\tx');
    expect(stripFormulaGuard("'＝x")).toBe('＝x');
    expect(stripFormulaGuard("L'avion")).toBe("L'avion");
    expect(stripFormulaGuard("'Bonjour")).toBe("'Bonjour");
    expect(stripFormulaGuard("''=x")).toBe("''=x");
    expect(stripFormulaGuard('-5')).toBe('-5');
  });

  it('critère 9 : un fichier produit par l’export s’importe sans erreur et redonne titres et notes d’origine', () => {
    const task = (title: string, note: string, extra: Partial<ExportTask> = {}): ExportTask => ({
      id: title,
      title,
      note,
      date: '2026-10-06' as LocalDate,
      time: null,
      spaceName: 'Pro',
      projectName: null,
      status: 'todo',
      doneAt: null,
      goalTitle: null,
      someday: false,
      spaceId: PRO,
      projectId: null,
      goalId: null,
      createdAt: '2026-10-01T00:00:00.000Z' as ExportTask['createdAt'],
      updatedAt: '2026-10-01T00:00:00.000Z' as ExportTask['updatedAt'],
      recurrence: null,
      ...extra,
    });
    const tasks: ExportTask[] = [
      task('=SOMME(A1:A3)', '+33 6 12\nsuite'),
      task('-5 degrés', '@Paul "dit" ; ok'),
      task('Réunion « équipe »', 'ligne 1\nligne 2', { time: '09:30' as ExportTask['time'] }),
      task('Tâche faite', '', { status: 'done', doneAt: '2026-10-06T08:00:00.000Z' as ExportTask['doneAt'], projectName: 'Mission client' }),
      task('-5', "'quote"),
    ];
    const csv = tasksToCsv(tasks);
    const result = parseImportFile(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.ignored).toEqual(['statut', 'termine_le', 'objectif', 'repetition']);
    const { valid, rejected, warnings } = validateImportRows(result.table, context);
    expect(rejected).toEqual([]);
    expect(warnings).toEqual([]);
    expect(valid.map((v) => [v.title, v.note])).toEqual([
      ['=SOMME(A1:A3)', '+33 6 12\nsuite'],
      ['-5 degrés', '@Paul "dit" ; ok'],
      ['Réunion « équipe »', 'ligne 1\nligne 2'],
      ['Tâche faite', ''],
      ['-5', "'quote"],
    ]);
    expect(valid[2]?.time).toBe('09:30');
    expect(valid[3]?.projectId).toBe(MISSION);
  });
});

describe('Doublons, modèle et rapport', () => {
  it('clé titre + date identique à celle des repositories', () => {
    expect(titleDateKey({ title: 'A', date: '2026-10-05' as LocalDate })).toBe('A\u00002026-10-05');
    expect(titleDateKey({ title: 'A', date: null })).toBe('A\u0000');
  });

  it('modèle : BOM, en-têtes dans l’ordre et une ligne d’exemple', () => {
    const csv = importTemplateCsv({ title: 'Appeler Paul', date: '2026-10-06', time: '10:00', space: 'Pro', project: '', note: '' });
    expect(csv).toBe('﻿titre;date;heure;espace;projet;note\r\nAppeler Paul;2026-10-06;10:00;Pro;;\r\n');
  });

  it('rapport : ligne, motif puis ligne d’origine, cellules neutralisées', () => {
    const t = table('titre;date\nA;31/02/2026\n=cmd;');
    const { rejected } = validateImportRows(t, context);
    const csv = rejectedReportCsv(t, rejected, (reason) => reason.code, { line: 'ligne', reason: 'motif' });
    expect(csv).toBe("﻿ligne;motif;titre;date\r\n2;date-invalid;A;31/02/2026\r\n");
    const t2 = table('titre;date\n;2026-10-05\n');
    const rep2 = rejectedReportCsv(t2, validateImportRows(t2, context).rejected, () => 'titre vide', { line: 'ligne', reason: 'motif' });
    expect(rep2).toContain('2;titre vide;;2026-10-05');
    const t3 = table('titre;date\n=1+1;pasunedate');
    expect(rejectedReportCsv(t3, validateImportRows(t3, context).rejected, () => 'date', { line: 'ligne', reason: 'motif' })).toContain("'=1+1");
  });
});

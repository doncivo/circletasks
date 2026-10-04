import { CSV_BOM, csvRow } from './historyExport';
import { daysInMonth, makeLocalDate } from './localDate';
import { TASK_TITLE_MAX_LENGTH } from './taskRules';
import type { LocalDate, LocalTime, ProjectId, SpaceId } from './types';

/**
 * Import de tâches depuis un CSV (P-07) : lecture du fichier (encodage, séparateur, guillemets), lecture des en-têtes, validation ligne par
 * ligne avec motifs. Pur : aucun accès à la base ni au fichier ; les espaces, projets et la date du jour viennent de l'appelant. Le contenu
 * du fichier n'est jamais exécuté ni interprété comme une formule (une cellule commençant par `=`, `+`, `-` ou `@` reste du texte).
 */

/** Taille maximale d'un fichier d'import (2 Mo), la même que `MAX_IMPORT_BYTES` de `src-tauri/src/import.rs`. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/** Nombre maximal de lignes de données. */
export const IMPORT_MAX_ROWS = 5000;
/** Longueur maximale d'une note importée. */
export const IMPORT_NOTE_MAX_LENGTH = 10_000;
/** Colonnes lues, dans l'ordre du modèle ; toute autre colonne est ignorée. */
export const IMPORT_COLUMNS = ['titre', 'date', 'heure', 'espace', 'projet', 'note'] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export type Delimiter = ';' | ',' | '\t';

/** Octets -> texte : UTF-8 avec ou sans BOM ; si l'UTF-8 est invalide, repli sur Windows-1252 (Excel français). */
export function decodeImportBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Sans accents, en minuscules, espaces simples : comparaison des en-têtes, des espaces et des projets. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Début d'une cellule neutralisée par l'export H-03 (voir `neutralizeFormula` de `historyExport.ts`). */
const GUARDED = /^'[=+@\-\t\r\n＝＋＠－]/;

/**
 * Retire l'apostrophe ajoutée par l'export contre l'injection de formule, pour qu'un aller-retour redonne le texte d'origine. Une
 * apostrophe suivie d'un autre caractère est un contenu normal et reste.
 */
export function stripFormulaGuard(value: string): string {
  return GUARDED.test(value) ? value.slice(1) : value;
}

/** Séparateur d'après l'en-tête : celui des trois qui apparaît le plus (hors guillemets) ; « ; » en cas d'égalité. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char as Delimiter] += 1;
  }
  const ordered: Delimiter[] = [';', ',', '\t'];
  return ordered.reduce((best, current) => (counts[current] > counts[best] ? current : best), ';' as Delimiter);
}

export interface CsvRecord {
  /** Numéro de ligne dans le fichier (1 = en-tête) ; une cellule entre guillemets sur plusieurs lignes garde la ligne de début. */
  readonly line: number;
  readonly cells: readonly string[];
}

/** Lecture CSV (guillemets doublés, retours à la ligne dans une cellule entre guillemets, CRLF / LF / CR). Les lignes vides sont ignorées. */
export function parseCsv(text: string, delimiter: Delimiter): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let hasContent = false;

  const endCell = (): void => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = (): void => {
    endCell();
    if (hasContent || cells.some((value) => value.length > 0)) records.push({ line: startLine, cells });
    cells = [];
    hasContent = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (text.charAt(index + 1) === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else {
        if (char === '\n') line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) {
      quoted = true;
      hasContent = true;
    } else if (char === delimiter) {
      hasContent = true;
      endCell();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text.charAt(index + 1) === '\n') index += 1;
      endRecord();
      line += 1;
      startLine = line;
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || cells.length > 0 || hasContent) endRecord();
  return records;
}

export type ImportFileError = 'empty' | 'no-title-column' | 'too-many-rows';

export interface ImportTable {
  readonly delimiter: Delimiter;
  /** Position de chaque colonne connue dans le fichier (-1 : absente). */
  readonly columns: Readonly<Record<ImportColumn, number>>;
  /** En-têtes ignorés (colonnes inconnues), tels qu'écrits. */
  readonly ignored: readonly string[];
  /** En-têtes d'origine (rapport des lignes rejetées). */
  readonly header: readonly string[];
  readonly rows: readonly CsvRecord[];
}

export type ImportFileResult = { readonly ok: true; readonly table: ImportTable } | { readonly ok: false; readonly error: ImportFileError };

/**
 * Lit le fichier : séparateur reconnu d'après l'en-tête, colonnes comparées sans accents ni casse, colonne inconnue ignorée. Refus : fichier
 * vide, colonne `titre` absente, plus de 5 000 lignes de données.
 */
export function parseImportFile(text: string): ImportFileResult {
  // Marque d'ordre des octets (U+FEFF) éventuelle en tête du texte.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(clean);
  const [headerRecord, ...rows] = parseCsv(clean, delimiter);
  if (!headerRecord) return { ok: false, error: 'empty' };
  const columns: Record<ImportColumn, number> = { titre: -1, date: -1, heure: -1, espace: -1, projet: -1, note: -1 };
  const ignored: string[] = [];
  headerRecord.cells.forEach((name, position) => {
    const known = IMPORT_COLUMNS.find((column) => column === normalizeName(name));
    if (known && columns[known] === -1) columns[known] = position;
    else if (name.trim() !== '') ignored.push(name.trim());
  });
  if (columns.titre === -1) return { ok: false, error: 'no-title-column' };
  if (rows.length > IMPORT_MAX_ROWS) return { ok: false, error: 'too-many-rows' };
  return { ok: true, table: { delimiter, columns, ignored, header: headerRecord.cells.map((name) => name.trim()), rows } };
}

/** `AAAA-MM-JJ`, `JJ/MM/AAAA` ou `JJ/MM/AA` (20AA) ; null si la date n'existe pas au calendrier. */
export function parseImportDate(value: string): LocalDate | null {
  const text = value.trim();
  let year: number;
  let month: number;
  let day: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(text);
    if (!match) return null;
    [day, month] = [Number(match[1]), Number(match[2])];
    year = match[3]?.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  }
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return makeLocalDate(year, month, day);
}

/** `HH:MM` ou `HHhMM` (24 h) ; null sinon. */
export function parseImportTime(value: string): LocalTime | null {
  const match = /^(\d{1,2})[:hH](\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` as LocalTime;
}

export interface ImportSpace {
  readonly id: SpaceId;
  readonly name: string;
}

export interface ImportProject {
  readonly id: ProjectId;
  readonly spaceId: SpaceId;
  readonly name: string;
  readonly archived: boolean;
}

export type UndatedTarget = 'today' | 'someday';

export interface ImportContext {
  readonly spaces: readonly ImportSpace[];
  /** Espace des lignes sans espace (ES-02). */
  readonly defaultSpaceId: SpaceId;
  readonly projects: readonly ImportProject[];
  /** « Tâches sans date » : Aujourd'hui (défaut) ou Un jour. */
  readonly undated: UndatedTarget;
  readonly today: LocalDate;
}

export interface ImportTaskDraft {
  readonly line: number;
  readonly title: string;
  readonly note: string;
  /** Date finale : celle du fichier, aujourd'hui pour une ligne sans date (choix « Aujourd'hui »), null pour « Un jour ». */
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly someday: boolean;
  readonly spaceId: SpaceId;
  readonly spaceName: string;
  readonly projectId: ProjectId | null;
  readonly projectName: string;
}

export type RejectReason =
  | { readonly code: 'title-empty' }
  | { readonly code: 'title-too-long'; readonly length: number }
  | { readonly code: 'date-invalid'; readonly value: string }
  | { readonly code: 'time-invalid'; readonly value: string }
  | { readonly code: 'time-without-date'; readonly value: string }
  | { readonly code: 'space-unknown'; readonly value: string };

export type RowWarning = { readonly code: 'project-unknown'; readonly value: string } | { readonly code: 'note-truncated' };

export interface RejectedRow {
  readonly line: number;
  readonly reason: RejectReason;
  readonly cells: readonly string[];
}

export interface ImportRowWarning {
  readonly line: number;
  readonly warning: RowWarning;
}

export interface ImportValidation {
  readonly valid: readonly ImportTaskDraft[];
  readonly rejected: readonly RejectedRow[];
  readonly warnings: readonly ImportRowWarning[];
}

/**
 * Valide chaque ligne (P-07 critères 4 et 5). Rejets (un seul motif par ligne, dans cet ordre) : titre vide ou de plus de 200 caractères,
 * date invalide, heure invalide, heure sans date, espace inconnu. Avertissements (la ligne est importée) : projet inconnu ou archivé
 * (importée sans projet), note tronquée à 10 000 caractères. Une ligne entièrement vide est ignorée.
 */
export function validateImportRows(table: ImportTable, context: ImportContext): ImportValidation {
  const valid: ImportTaskDraft[] = [];
  const rejected: RejectedRow[] = [];
  const warnings: ImportRowWarning[] = [];
  const spaces = new Map(context.spaces.map((space) => [normalizeName(space.name), space]));

  for (const row of table.rows) {
    if (row.cells.every((value) => value.trim() === '')) continue;
    const cell =(column: ImportColumn): string => {
      const position = table.columns[column];
      return position >= 0 ? (row.cells[position] ?? '') : '';
    };
    const reject = (reason: RejectReason): void => {
      rejected.push({ line: row.line, reason, cells: row.cells });
    };

    const title = stripFormulaGuard(cell('titre').trim());
    if (title === '') {
      reject({ code: 'title-empty' });
      continue;
    }
    const titleLength = [...title].length;
    if (titleLength > TASK_TITLE_MAX_LENGTH) {
      reject({ code: 'title-too-long', length: titleLength });
      continue;
    }

    const rawDate = cell('date').trim();
    const date = rawDate === '' ? null : parseImportDate(rawDate);
    if (rawDate !== '' && date === null) {
      reject({ code: 'date-invalid', value: rawDate });
      continue;
    }
    const rawTime = cell('heure').trim();
    const time = rawTime === '' ? null : parseImportTime(rawTime);
    if (rawTime !== '' && time === null) {
      reject({ code: 'time-invalid', value: rawTime });
      continue;
    }
    if (time !== null && date === null) {
      reject({ code: 'time-without-date', value: rawTime });
      continue;
    }

    const rawSpace = stripFormulaGuard(cell('espace').trim());
    const space = rawSpace === '' ? context.spaces.find((candidate) => candidate.id === context.defaultSpaceId) : spaces.get(normalizeName(rawSpace));
    if (!space) {
      reject({ code: 'space-unknown', value: rawSpace });
      continue;
    }

    const rawProject = stripFormulaGuard(cell('projet').trim());
    let project: ImportProject | undefined;
    if (rawProject !== '') {
      const wanted = normalizeName(rawProject);
      project = context.projects.find((candidate) => candidate.spaceId === space.id && !candidate.archived && normalizeName(candidate.name) === wanted);
      if (!project) warnings.push({ line: row.line, warning: { code: 'project-unknown', value: rawProject } });
    }

    let note = stripFormulaGuard(cell('note'));
    if ([...note].length > IMPORT_NOTE_MAX_LENGTH) {
      note = [...note].slice(0, IMPORT_NOTE_MAX_LENGTH).join('');
      warnings.push({ line: row.line, warning: { code: 'note-truncated' } });
    }

    const someday = date === null && context.undated === 'someday';
    valid.push({
      line: row.line,
      title,
      note,
      date: date ?? (someday ? null : context.today),
      time,
      someday,
      spaceId: space.id,
      spaceName: space.name,
      projectId: project?.id ?? null,
      projectName: project?.name ?? '',
    });
  }
  return { valid, rejected, warnings };
}

/** Clé de comparaison avec les tâches existantes (titre exact + date ; même forme que `existingTitleDates`). */
export function titleDateKey(draft: Pick<ImportTaskDraft, 'title' | 'date'>): string {
  return `${draft.title}\u0000${draft.date ?? ''}`;
}

/** Modèle téléchargeable : en-têtes et une ligne d'exemple, UTF-8 avec BOM, séparateur « ; ». */
export function importTemplateCsv(example: { readonly title: string; readonly date: string; readonly time: string; readonly space: string; readonly project: string; readonly note: string }): string {
  return `${CSV_BOM}${[csvRow(IMPORT_COLUMNS), csvRow([example.title, example.date, example.time, example.space, example.project, example.note])].join('\r\n')}\r\n`;
}

/**
 * Rapport des lignes rejetées : numéro de ligne, motif (texte fourni par l'appelant), puis la ligne d'origine sous ses propres en-têtes.
 * Les cellules sont neutralisées contre l'injection de formule comme à l'export.
 */
export function rejectedReportCsv(table: Pick<ImportTable, 'header'>, rejected: readonly RejectedRow[], reasonText: (reason: RejectReason) => string, labels: { readonly line: string; readonly reason: string }): string {
  const lines = [csvRow([labels.line, labels.reason, ...table.header])];
  for (const row of rejected) lines.push(csvRow([String(row.line), reasonText(row.reason), ...row.cells]));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

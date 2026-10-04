import type { DataAccess, ExportCursor } from '../../db/repositories';
import { monthSpan } from '../../domain/focusTotals';
import { csvChunk, csvHeader, historyToJson, type ExportHistoryInput, type ExportTask } from '../../domain/historyExport';
import type { ItemFilter } from '../../domain/itemFilter';
import { firstDayOf, hasRoutinesAndGoals, lastDayOf, type MonthRef } from '../../domain/monthReport';
import type { FocusSession } from '../../domain/model';
import type { IsoDateTime, LocalDate } from '../../domain/types';

/** Lignes lues par bloc : l'interface reste réactive entre deux blocs (H-03 critère 8). */
export const EXPORT_PAGE_SIZE = 500;

export type ExportPeriod = 'all' | 'month';

export interface HistoryExportParams {
  readonly filter: ItemFilter;
  readonly period: ExportPeriod;
  readonly month: MonthRef;
  readonly exportedAt: IsoDateTime;
  readonly spaceName: string | null;
  readonly projectName: string | null;
}

const NEVER_BEFORE = '0000-01-01' as LocalDate;
const NEVER_AFTER = '9999-12-31' as LocalDate;

/** Rend la main au navigateur entre deux blocs (affichage de l'indicateur, saisie). */
const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function rangeOf(params: HistoryExportParams): { from: LocalDate; to: LocalDate } | null {
  return params.period === 'month' ? { from: firstDayOf(params.month), to: lastDayOf(params.month) } : null;
}

/** Parcourt toutes les pages de tâches du filtre et de la période, bloc après bloc. */
async function forEachTaskPage(data: DataAccess, params: HistoryExportParams, onPage: (tasks: ExportTask[]) => void): Promise<void> {
  let after: ExportCursor | null = null;
  do {
    const page: Awaited<ReturnType<DataAccess['repos']['stats']['listTasksForExport']>> = await data.repos.stats.listTasksForExport({
      filter: params.filter,
      range: rangeOf(params),
      after,
      limit: EXPORT_PAGE_SIZE,
    });
    onPage(page.tasks);
    after = page.next;
    if (after !== null) await yieldToUi();
  } while (after !== null);
}

/** CSV des tâches (H-03 critère 2) : BOM, en-têtes, une ligne par tâche, écrit par blocs puis assemblé en UTF-8. */
export async function buildHistoryCsv(data: DataAccess, params: HistoryExportParams): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode(csvHeader())];
  await forEachTaskPage(data, params, (tasks) => chunks.push(encoder.encode(csvChunk(tasks))));
  return concat(chunks);
}

async function allFocusSessions(data: DataAccess, params: HistoryExportParams): Promise<FocusSession[]> {
  const sessions: FocusSession[] = [];
  let afterId: string | null = null;
  const span = params.period === 'month' ? monthSpan(firstDayOf(params.month)) : null;
  for (;;) {
    const page = await data.repos.focusSessions.listForExport({ filter: params.filter, span, afterId, limit: EXPORT_PAGE_SIZE });
    sessions.push(...page);
    const last = page[page.length - 1];
    if (page.length < EXPORT_PAGE_SIZE || !last) break;
    afterId = last.id;
    await yieldToUi();
  }
  return sessions;
}

/** Données du JSON (H-03 critère 3) : tâches par blocs, routines (validations, pauses), sessions Focus, objectifs. */
export async function collectHistory(data: DataAccess, params: HistoryExportParams): Promise<ExportHistoryInput> {
  const { repos } = data;
  const tasks: ExportTask[] = [];
  await forEachTaskPage(data, params, (page) => tasks.push(...page));
  const scoped = hasRoutinesAndGoals(params.filter);
  const range = rangeOf(params) ?? { from: NEVER_BEFORE, to: NEVER_AFTER };
  const [routines, routineLogs, routinePauses, goals, focusSessions] = await Promise.all([
    scoped ? repos.routines.listForFilter(params.filter.space, { includeArchived: true }) : Promise.resolve([]),
    scoped ? repos.routineLogs.listForRange(range, params.filter.space) : Promise.resolve([]),
    scoped ? repos.routines.listPauses(params.filter.space) : Promise.resolve([]),
    scoped ? repos.goals.listHistory(range, params.filter.space) : Promise.resolve([]),
    allFocusSessions(data, params),
  ]);
  return {
    exportedAt: params.exportedAt,
    filter: params.filter,
    spaceName: params.spaceName,
    projectName: params.projectName,
    period: params.period === 'month' ? { kind: 'month', from: range.from, to: range.to } : { kind: 'all' },
    tasks,
    routines,
    routineLogs,
    routinePauses,
    focusSessions,
    goals,
  };
}

/** JSON complet encodé en UTF-8 (sans BOM). */
export async function buildHistoryJson(data: DataAccess, params: HistoryExportParams): Promise<Uint8Array> {
  const history = await collectHistory(data, params);
  return new TextEncoder().encode(JSON.stringify(historyToJson(history), null, 2));
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}

import type { DataAccess } from '../../db/repositories';
import { EXPORT_MIME, exportFileName, type ExportKind } from '../../domain/historyExport';
import type { ItemFilter } from '../../domain/itemFilter';
import type { MonthRef, MonthReport } from '../../domain/monthReport';
import { reportLayout } from '../../domain/reportLayout';
import type { IsoDateTime, LocalDate } from '../../domain/types';
import { formatReportMonth } from '../../i18n/formatStats';
import type { SaveRequest } from '../../platform/files';
import { buildHistoryCsv, buildHistoryJson, type ExportPeriod } from './exportHistory';
import { renderReportPdf, renderReportPng } from './reportImage';
import { reportTextsOf } from './reportTexts';

export interface ExportContext {
  readonly data: DataAccess;
  readonly filter: ItemFilter;
  readonly month: MonthRef;
  readonly today: LocalDate;
  readonly now: IsoDateTime;
  /** Rapport du mois affiché (PDF et image). */
  readonly report: MonthReport;
  /** Nom de l'espace filtré (« Pro »), null sous « Tout ». */
  readonly spaceName: string | null;
  readonly projectName: string | null;
  /** « Tout », « Pro », « Pro · Mission client » : rappel du filtre en vigueur. */
  readonly filterLabel: string;
}

/** Construit le fichier à enregistrer : nom, type et octets (H-03 critères 2 à 6). */
export async function createExportFile(kind: ExportKind, period: ExportPeriod, context: ExportContext): Promise<SaveRequest> {
  const suggestedName = exportFileName(kind, { today: context.today, month: context.month, spaceName: context.spaceName });
  const mime = EXPORT_MIME[kind];
  if (kind === 'csv' || kind === 'json') {
    const params = { filter: context.filter, period, month: context.month, exportedAt: context.now, spaceName: context.spaceName, projectName: context.projectName };
    const data = kind === 'csv' ? await buildHistoryCsv(context.data, params) : await buildHistoryJson(context.data, params);
    return { suggestedName, mime, data };
  }
  const layout = reportLayout(reportTextsOf(context.report, { currentYear: Number(context.today.slice(0, 4)), filterLabel: context.filterLabel, today: context.today }));
  const title = `CircleTasks · ${formatReportMonth(context.month, Number(context.today.slice(0, 4)))}`;
  const data = kind === 'png' ? await renderReportPng(layout) : await renderReportPdf(layout, title);
  return { suggestedName, mime, data };
}

import { clearEpochCarryNoticeFailure, epochCarryNoticeFailure } from './carryNoticeState';
import type { DataAccess, Repositories } from '../db/repositories';
import type { EpochCarryReport } from '../domain/sync/epochCarryReport';
import type { SyncLogger } from './log';
import { EPOCH_CARRY_REPORT_FAILED_META, EPOCH_CARRY_REPORT_READ_FAILED_EVENT, parentReplacedCount, recreatedCount, restoredCount } from '../domain/sync/epochCarryReportView';

/**
 * Y-TECH-05 : ce qui lève le bandeau du compte rendu du changement d’époque (`carry-report`), lu par le moteur à chaque cycle et par le
 * bandeau de l’app. Module à la demande : le départ n’en contient que l’import dynamique (`engine.ts`, `startSync.ts`).
 * Levé tant qu’il existe un compte rendu non acquitté avec bandeau (`carryReportBanner`, mode `replace`, au moins une ligne nommée), ou une
 * marque d’échec d’enregistrement (`sync_meta.epochCarryReportFailed`, jamais effacée par le moteur : « J’ai vu » l’efface).
 */
export interface CarryReportFailure {
  readonly epoch: string;
  readonly at: string;
  /** Code d’erreur (jamais un libellé). */
  readonly code: string;
}

export interface CarryReportBannerFacts {
  readonly failure: CarryReportFailure | null;
  /** Comptes rendus non acquittés qui lèvent le bandeau, du plus récent au plus ancien. */
  readonly reports: readonly EpochCarryReport[];
}

/** Marque illisible : l’échec reste signalé (jamais ignoré), avec un code neutre. */
function parseFailure(raw: string | null): CarryReportFailure | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<CarryReportFailure> | null;
    return { epoch: String(value?.epoch ?? ''), at: String(value?.at ?? ''), code: String(value?.code ?? 'unknown') };
  } catch {
    return { epoch: '', at: '', code: 'unreadable' };
  }
}

/** Échec d'enregistrement d'un compte rendu : marque persistante, ou à défaut l'indicateur de la session (marque elle-même impossible à écrire : l'échec reste visible). */
export async function carryReportFailure(repos: Repositories): Promise<CarryReportFailure | null> {
  return parseFailure(await repos.sync.getMeta(EPOCH_CARRY_REPORT_FAILED_META)) ?? (epochCarryNoticeFailure() ? { epoch: '', at: '', code: 'unrecorded' } : null);
}

export async function carryReportBannerFacts(repos: Repositories): Promise<CarryReportBannerFacts> {
  const failure = await carryReportFailure(repos);
  const reports = (await (await repos.carryReports()).unacknowledged()).filter((report) => report.banner);
  return { failure, reports };
}

/** Moteur : l’avertissement `carry-report` est-il levé ? */
export async function carryReportRaised(repos: Repositories): Promise<boolean> {
  const { failure, reports } = await carryReportBannerFacts(repos);
  return failure !== null || reports.length > 0;
}

/**
 * Revue S2 : `carryReportRaised` pour le cycle du moteur. Une lecture impossible ne fait jamais échouer le cycle avant la publication :
 * journalisée (code d'erreur seulement) et l'avertissement est levé (visible, sans bloquer) ; le bandeau relit et montre son propre échec.
 */
export async function carryReportRaisedOrLogged(repos: Repositories, logger: SyncLogger): Promise<boolean> {
  try {
    return await carryReportRaised(repos);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    logger.log(EPOCH_CARRY_REPORT_READ_FAILED_EVENT, { code: typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown' });
    return true;
  }
}

/** Nombre exact de lignes rétablies (débordement compris) des comptes rendus du bandeau : « Éléments rétablis : {n} » (ADR 0011 §29 point 5). */
export function carryReportElements(reports: readonly EpochCarryReport[]): number {
  return reports.reduce((sum, report) => sum + restoredCount(report), 0);
}

/** Autres lignes nommées (recréées, rattachées, mises de côté, débordement compris) : dites quand aucune ligne n'est rétablie. */
export function carryReportOthers(reports: readonly EpochCarryReport[]): number {
  return reports.reduce((sum, report) => sum + recreatedCount(report) + parentReplacedCount(report), 0);
}

/** « J’ai vu » sur l’échec d’enregistrement : efface la marque (vrai si elle existait). */
export async function clearCarryReportFailure(data: DataAccess): Promise<boolean> {
  const cleared = await data.transaction(async (repos) => {
    if ((await repos.sync.getMeta(EPOCH_CARRY_REPORT_FAILED_META)) === null) return false;
    await repos.sync.setMeta(EPOCH_CARRY_REPORT_FAILED_META, null);
    return true;
  });
  clearEpochCarryNoticeFailure();
  return cleared;
}

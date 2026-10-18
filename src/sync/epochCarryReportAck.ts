import type { DataAccess } from '../db/repositories';
import { EPOCH_CARRY_NOTICE_META, parseEpochCarryNotice } from '../domain/sync/epochCarryNotice';
import { noticeAfterAcknowledge } from '../domain/sync/epochCarryReportView';
import type { IsoDateTime } from '../domain/types';

/**
 * Y-TECH-05 : « J'ai vu » d'un compte rendu du report d'époque (contrat de la phase 2, écran chargé à la demande ; ce module l'est aussi).
 * Une seule transaction : `acknowledged_at` du **seul** compte rendu affiché (jamais un acquittement global) ; puis, si plus aucun
 * compte rendu non acquitté ne nomme de ligne rattachée, la notice de Y-FIX-04 perd ses lignes rattachées (`carry-reattached` disparaît),
 * les lignes mises de côté restent (`carry-held`). Vrai si ce compte rendu vient d'être acquitté (faux : déjà acquitté ou absent).
 */
export async function acknowledgeEpochCarryReport(data: DataAccess, id: number, at: IsoDateTime): Promise<boolean> {
  return data.transaction(async (repos) => {
    const reports = await repos.carryReports();
    if (!(await reports.acknowledge(id, at))) return false;
    const raw = await repos.sync.getMeta(EPOCH_CARRY_NOTICE_META);
    const notice = parseEpochCarryNotice(raw);
    const next = noticeAfterAcknowledge(notice, await reports.unacknowledged());
    if (next !== notice) await repos.sync.setMeta(EPOCH_CARRY_NOTICE_META, next === null ? null : JSON.stringify(next));
    return true;
  });
}

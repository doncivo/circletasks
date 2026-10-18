import { useCallback, useEffect, useState } from 'react';
import type { EpochCarryReport } from '../../domain/sync/epochCarryReport';
import { EPOCH_CARRY_REPORT_KEEP } from '../../domain/sync/epochCarryReportView';
import { tCarry } from '../../i18n/syncCarryReportText';
import { carryReportFailure, clearCarryReportFailure, type CarryReportFailure } from '../../sync/epochCarryReportBanner';
import { logFailure } from '../../platform/desktop/log';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { CarryReportSheet } from './CarryReportSheet';
import { peekCarryReportOpen, requestCarryReportOpen } from './carryReportOpen';
import { carryCauseText, carryDateTime, carryFailureCause } from './carryReportText';
import { refreshCarryLine } from './carryReportBannerLine';
import { syncStore } from './syncStore';
import './CarryReport.css';

/** Revue S10 : l'échec de « J'ai vu » est journalisé en plus d'être affiché (nom de l'erreur seulement, jamais son message). */
function logSeenFailure(event: string, error: unknown): void {
  logFailure('sync', `${event} ${JSON.stringify({ name: error instanceof Error ? error.name : typeof error })}`);
}

interface Loaded {
  readonly reports: readonly EpochCarryReport[];
  readonly failure: CarryReportFailure | null;
}

/**
 * Ligne « Compte rendu du changement d'époque » de Réglages › Synchronisation › Détails (Y-TECH-05 critères 14, 17 et 18) : les 20
 * derniers comptes rendus et tous ceux qui ne sont pas acquittés (du plus récent au plus ancien, « Non vu »), chacun ouvrant l'écran de détail ; l'échec d'enregistrement d'un
 * compte rendu, avec « J'ai vu » qui efface la marque. Absente sans compte rendu ni échec. Bloc à la demande : jamais au départ.
 * Ouverte par le bandeau (« Voir »), elle ouvre d'elle-même le compte rendu non acquitté.
 */
export function SyncDetailsCarryReport() {
  const container = useAppContainer();
  const devices = useFeatureStore(syncStore, (s) => s.status.devices);
  const lastSyncAt = useFeatureStore(syncStore, (s) => s.status.lastSyncAt);
  const [loaded, setLoaded] = useState<Loaded | 'failed' | null>(null);
  const [version, setVersion] = useState(0);
  const [openId, setOpenId] = useState<number | null>(() => peekCarryReportOpen());
  const [seenFailed, setSeenFailed] = useState(false);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => requestCarryReportOpen(null), []);

  useEffect(() => {
    let alive = true;
    const read = async (): Promise<Loaded> => {
      const repo = await container.data.repos.carryReports();
      // Revue I2 : les non acquittés ne sont jamais élagués, donc tous listés (sinon le bandeau ne pourrait plus disparaître), avec les 20 derniers.
      const merged = new Map<number, EpochCarryReport>();
      for (const report of [...(await repo.unacknowledged()), ...(await repo.list(EPOCH_CARRY_REPORT_KEEP))]) merged.set(report.id, report);
      return { reports: [...merged.values()].sort((a, b) => b.id - a.id), failure: await carryReportFailure(container.data.repos) };
    };
    read().then(
      (next) => alive && setLoaded(next),
      () => alive && setLoaded('failed'),
    );
    return () => {
      alive = false;
    };
  }, [container, lastSyncAt, version]);

  if (loaded === null) return null;
  if (loaded === 'failed') {
    return (
      <>
        <h2 className="ct-settings__section">{tCarry('title')}</h2>
        <div className="ct-settings__row ct-carry__problem" role="alert">
          <span>{tCarry('loadFailed')}</span>
          <Button variant="secondary" onClick={reload}>
            {tCarry('retry')}
          </Button>
        </div>
      </>
    );
  }
  if (loaded.reports.length === 0 && !loaded.failure) return null;
  const open = loaded.reports.find((report) => report.id === openId) ?? null;

  const seen = async (report: EpochCarryReport): Promise<void> => {
    try {
      const { acknowledgeEpochCarryReport } = await import('../../sync/epochCarryReportAck');
      await acknowledgeEpochCarryReport(container.data, report.id, new Date(container.clock.nowMs()).toISOString() as EpochCarryReport['createdAt']);
      setSeenFailed(false);
      // Le bandeau disparaît tout de suite, sans attendre le cycle suivant ; ce compte rendu reste lisible dans l'historique.
      await refreshCarryLine(container);
      reload();
    } catch (error) {
      logSeenFailure('carry-report-seen-failed', error);
      setSeenFailed(true);
    }
  };

  const failureSeen = async (): Promise<void> => {
    try {
      await clearCarryReportFailure(container.data);
      setSeenFailed(false);
      await refreshCarryLine(container);
      reload();
    } catch (error) {
      logSeenFailure('carry-report-failure-seen-failed', error);
      setSeenFailed(true);
    }
  };

  return (
    <>
      <h2 className="ct-settings__section">{tCarry('title')}</h2>
      {loaded.failure && (
        <div className="ct-settings__row ct-carry__problem" data-testid="carry-report-failed">
          <span>{tCarry('failed', { cause: carryFailureCause(loaded.failure.code) })}</span>
          <Button variant="secondary" className="ct-carry__seen" onClick={() => void failureSeen()}>
            {tCarry('seen')}
          </Button>
        </div>
      )}
      {seenFailed && !open && (
        <p className="ct-settings__error" role="alert">
          {tCarry('seenFailed')}
        </p>
      )}
      <ul role="list" aria-label={tCarry('listLabel', { title: tCarry('title'), count: loaded.reports.length })} className="ct-carry__history">
        {loaded.reports.map((report) => {
          const epoch = carryDateTime(report.createdAt);
          const seenAt = report.acknowledgedAt ? carryDateTime(report.acknowledgedAt) : null;
          return (
            <li key={report.id}>
              <button type="button" className="ct-settings__row ct-settings__rowButton ct-carry__entry" onClick={() => setOpenId(report.id)}>
                <span className="ct-carry__entryText">
                  <span>{tCarry('epochAt', { date: epoch.date, time: epoch.time })}</span>
                  <span className="ct-sync__sub">{carryCauseText(report.cause)}</span>
                </span>
                <span className="ct-settings__value" data-unseen={seenAt ? 'false' : 'true'}>
                  {seenAt ? tCarry('seenOn', { date: seenAt.date, time: seenAt.time }) : tCarry('unseen')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {open && <CarryReportSheet report={open} devices={devices} onClose={() => setOpenId(null)} onSeen={() => seen(open)} seenFailed={seenFailed} />}
    </>
  );
}

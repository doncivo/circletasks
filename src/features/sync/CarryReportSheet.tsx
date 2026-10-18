import { useState, type ReactNode } from 'react';
import { carriedWrites, namedCount } from '../../domain/sync/epochCarryReportView';
import type { EpochCarryNamedItem, EpochCarryParentItem, EpochCarryReport } from '../../domain/sync/epochCarryReport';
import type { DeviceId } from '../../domain/types';
import { tCarry } from '../../i18n/syncCarryReportText';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { Button, Sheet } from '../../ui';
import { carryCauseText, carryDateTime, carryDeviceName, carryKindText, carryLabelText } from './carryReportText';
import './CarryReport.css';

/** Lignes montrées d'abord, et ajoutées à chaque « Afficher 50 de plus » : le premier rendu d'un compte rendu de 500 lignes n'en pose que 50. */
export const CARRY_REPORT_PAGE = 50;

interface PagedListProps<T> {
  readonly title: string;
  /** Éléments gardés dans le compte rendu (au plus 500 toutes listes). */
  readonly items: readonly T[];
  /** Éléments au-delà de la borne, comptés mais non nommés (« et {n} autres »). */
  readonly overflow: number;
  readonly itemKey: (item: T) => string;
  readonly render: (item: T) => ReactNode;
}

/**
 * Liste nommée, paginée par pages de 50 (sans délai ni virtualisation) : `<ul>` annoncée avec son nombre exact (gardés et au-delà de la
 * borne), « Afficher 50 de plus » tant qu'il en reste, « et N autres » une fois la liste entièrement affichée.
 */
function PagedList<T>({ title, items, overflow, itemKey, render }: PagedListProps<T>) {
  const [shown, setShown] = useState(CARRY_REPORT_PAGE);
  const visible = items.slice(0, shown);
  const all = items.length <= shown;
  return (
    <section className="ct-carry__block">
      <h3 className="ct-settings__section">{title}</h3>
      <ul role="list" aria-label={tCarry('listLabel', { title, count: items.length + overflow })} className="ct-carry__list">
        {visible.map((item) => (
          <li key={itemKey(item)} className="ct-carry__item">
            {render(item)}
          </li>
        ))}
      </ul>
      {!all && (
        <Button variant="secondary" className="ct-carry__more" onClick={() => setShown((n) => n + CARRY_REPORT_PAGE)}>
          {tCarry('showMore')}
        </Button>
      )}
      {all && overflow > 0 && <p className="ct-carry__overflow">{tCarry('more', { count: overflow })}</p>}
    </section>
  );
}

export interface CarryReportSheetProps {
  readonly report: EpochCarryReport;
  readonly devices: readonly SyncDeviceStatus[];
  readonly onClose: () => void;
  /** « J'ai vu » : acquitte ce seul compte rendu. Résout quand c'est fait. */
  readonly onSeen: () => Promise<void>;
  /** « J'ai vu » en échec : message affiché sous le bouton (jamais d'échec muet). */
  readonly seenFailed: boolean;
}

/**
 * Écran de détail d'un compte rendu du changement d'époque (Y-TECH-05 critères 17 à 22), feuille de Réglages › Synchronisation › Détails.
 * Ordre de lecture et de focus : « Fermer », résumé (époque, cause, appareils, écritures par auteur), listes (rétablis, recréés,
 * rattachés ou mis de côté), puis « J'ai vu » en dernier. Chargé à la demande avec son catalogue de textes.
 */
export function CarryReportSheet({ report, devices, onClose, onSeen, seenFailed }: CarryReportSheetProps) {
  const [busy, setBusy] = useState(false);
  const name = (id: DeviceId): string => carryDeviceName(id, report.reporter, devices);
  const epoch = carryDateTime(report.createdAt);
  const restoredTotal = report.restored.length + report.overflowBy.restored;
  const reattached = report.parentReplaced.filter((item) => item.kind === 'reattached');
  const held = report.parentReplaced.filter((item) => item.kind === 'held');
  const parentKey = (item: EpochCarryParentItem): string => `${item.table}:${item.rowId}:${item.column}`;
  const namedKey = (item: EpochCarryNamedItem): string => `${item.table}:${item.rowId}`;
  const seenAt = report.acknowledgedAt ? carryDateTime(report.acknowledgedAt) : null;

  const seen = (): void => {
    setBusy(true);
    void onSeen().finally(() => setBusy(false));
  };

  const parentItem = (item: EpochCarryParentItem): ReactNode => (
    <>
      <span className="ct-carry__kind">{carryKindText(item.table)}</span>
      <span className="ct-carry__label">{carryLabelText(item.label, item.rowId)}</span>
    </>
  );

  return (
    <Sheet open onClose={onClose} label={tCarry('title')} className="ct-sheet--tall ct-carry">
      <div className="ct-carry__top">
        <Button variant="secondary" onClick={onClose} className="ct-carry__close">
          {tCarry('close')}
        </Button>
      </div>
      <h2 className="ct-carry__title">{tCarry('title')}</h2>
      {report.damaged && (
        <p className="ct-settings__hint ct-settings__hint--danger" role="status">
          {tCarry('damaged')}
        </p>
      )}
      {restoredTotal === 0 && <p className="ct-settings__hint ct-carry__none">{tCarry('noRestored')}</p>}

      <section className="ct-carry__block ct-carry__summary">
        <p className="ct-carry__epoch">{tCarry('epochAt', { date: epoch.date, time: epoch.time })}</p>
        <p>{carryCauseText(report.cause)}</p>
        <p>{tCarry('openedBy', { device: name(report.opener) })}</p>
        <p>{tCarry('reportedBy', { device: name(report.reporter) })}</p>
        <p className="ct-carry__count">{tCarry('summary', { count: namedCount(report) })}</p>
        {carriedWrites(report) === 0 ? (
          <p>{tCarry('nothingCarried')}</p>
        ) : (
          <ul role="list" aria-label={tCarry('listLabel', { title: tCarry('writesTitle'), count: report.authors.length })} className="ct-carry__list">
            {report.authors.map((author) => (
              <li key={author.device} className="ct-carry__item">
                <span className="ct-carry__label">{tCarry('writesBy', { device: name(author.device), count: author.fields + author.tombs + author.late })}</span>
                <span className="ct-carry__meta">{tCarry('writesDetail', { fields: author.fields, rows: author.rows, tombs: author.tombs, late: author.late })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {restoredTotal > 0 && (
        <PagedList
          title={tCarry('restoredTitle')}
          items={report.restored}
          overflow={report.overflowBy.restored}
          itemKey={namedKey}
          render={(item) => {
            const deleted = item.deletedAt ? carryDateTime(item.deletedAt) : null;
            return (
              <>
                <span className="ct-carry__kind">{carryKindText(item.table)}</span>
                <span className="ct-carry__label">{carryLabelText(item.label, item.rowId)}</span>
                <span className="ct-carry__meta">{tCarry('restoredBy', { device: name(item.by) })}</span>
                {deleted && item.deletedBy && <span className="ct-carry__meta">{tCarry('deletedOn', { date: deleted.date, time: deleted.time, device: name(item.deletedBy) })}</span>}
              </>
            );
          }}
        />
      )}
      {report.recreated.length + report.overflowBy.recreated > 0 && (
        <PagedList
          title={tCarry('recreatedTitle')}
          items={report.recreated}
          overflow={report.overflowBy.recreated}
          itemKey={namedKey}
          render={(item) => (
            <>
              <span className="ct-carry__kind">{carryKindText(item.table)}</span>
              <span className="ct-carry__label">{carryLabelText(item.label, item.rowId)}</span>
              <span className="ct-carry__meta">{tCarry('recreatedBy', { device: name(item.by) })}</span>
            </>
          )}
        />
      )}
      {(reattached.length > 0 || (held.length === 0 && report.overflowBy.parentReplaced > 0)) && <PagedList title={tCarry('reattachedTitle')} items={reattached} overflow={held.length === 0 ? report.overflowBy.parentReplaced : 0} itemKey={parentKey} render={parentItem} />}
      {held.length > 0 && <PagedList title={tCarry('heldTitle')} items={held} overflow={report.overflowBy.parentReplaced} itemKey={parentKey} render={parentItem} />}

      <div className="ct-carry__footer">
        {seenAt ? (
          <p className="ct-settings__hint">{tCarry('seenOn', { date: seenAt.date, time: seenAt.time })}</p>
        ) : (
          <Button onClick={seen} disabled={busy} className="ct-carry__seen">
            {tCarry('seen')}
          </Button>
        )}
        {seenFailed && (
          <p className="ct-settings__error" role="alert">
            {tCarry('seenFailed')}
          </p>
        )}
      </div>
    </Sheet>
  );
}

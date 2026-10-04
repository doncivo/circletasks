import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { todayLocal } from '../../domain/clock';
import { holidaysOfYear, type HolidayEntry } from '../../domain/holidays';
import { makeLocalDate } from '../../domain/localDate';
import type { HolidayCountry } from '../../domain/model';
import { t } from '../../i18n';
import { formatDetailDate } from '../../i18n/format';
import { Button, DatePrompt, DetailPanel, Icon, Sheet, useDetailSlot, useLayout } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { DetailRow } from '../tasks/DetailRow';
import { onEventsChanged } from './eventEvents';
import { createHolidayUseCases, loadHolidayData } from './holidayUseCases';
import { countryName, holidayName } from './holidayText';
import './HolidayDetail.css';

interface HolidayDetailProps {
  readonly country: HolidayCountry;
  readonly holidayKey: string;
  readonly year: number;
}

function HolidayDetail({ country, holidayKey, year }: HolidayDetailProps) {
  const container = useAppContainer();
  const layout = useLayout();
  const slot = useDetailSlot();
  const closeDetail = useNavigationStore((s) => s.closeDetail);
  const appDay = useAppStore((s) => s.day);
  const today = appDay ?? todayLocal(container.clock);
  const [entry, setEntry] = useState<HolidayEntry | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      const data = await loadHolidayData(container, makeLocalDate(year, 1, 1), makeLocalDate(year, 12, 31));
      // Les deux calendriers : la fiche d'un férié reste lisible même si son pays vient d'être désactivé.
      const found = holidaysOfYear({ year, countries: { FR: true, TN: true }, rows: data.rows }).find((holiday) => holiday.country === country && holiday.key === holidayKey);
      if (alive) setEntry(found ?? null);
    };
    void load();
    const off = onEventsChanged(container.data, () => void load());
    return () => {
      alive = false;
      off();
    };
  }, [container, country, holidayKey, year]);

  if (entry === null) return null;
  const useCases = createHolidayUseCases(container);

  const note =
    entry.kind === 'lunar'
      ? entry.overridden
        ? t('events.holidayDetail.manual')
        : t('events.holidayDetail.estimated')
      : entry.kind === 'computed'
        ? t('events.holidayDetail.computed')
        : t('events.holidayDetail.fixed');

  const content = (
    <div className="ct-task-detail">
      <div className="ct-task-detail__header">
        <h2 className="ct-task-detail__title">{holidayName(entry.key)}</h2>
        {layout === 'mobile' && (
          <button type="button" className="ct-holiday-detail__close" aria-label={t('events.holidayDetail.close')} onClick={closeDetail}>
            <Icon icon={X} />
          </button>
        )}
      </div>
      <p className="ct-holiday-detail__note">{note}</p>
      <DetailRow label={t('events.holidayDetail.country')}>{countryName(entry.country)}</DetailRow>
      <DetailRow label={t('events.holidayDetail.date')}>{formatDetailDate(entry.date)}</DetailRow>
      {entry.overridden && entry.tableDate !== null && <p className="ct-holiday-detail__note">{t('events.holidayDetail.tableDate', { date: formatDetailDate(entry.tableDate) })}</p>}
      {error && (
        <p className="ct-holiday-detail__error" role="alert">
          {error}
        </p>
      )}
      {entry.editable && (
        <div className="ct-holiday-detail__actions">
          <Button variant="secondary" onClick={() => setPromptOpen(true)}>
            {t('events.holidayDetail.modify')}
          </Button>
          {entry.overridden && (
            <Button
              variant="secondary"
              onClick={() => {
                setError(null);
                void useCases.restoreTableDate(entry);
              }}
            >
              {t('events.holidayDetail.restore')}
            </Button>
          )}
        </div>
      )}
      <DatePrompt
        open={promptOpen}
        label={t('events.holidayDetail.promptLabel')}
        confirmLabel={t('events.holidayDetail.promptConfirm')}
        today={today}
        initialValue={entry.date}
        allowSomeday={false}
        onClose={() => setPromptOpen(false)}
        onConfirm={(date) => {
          setPromptOpen(false);
          if (!date) return;
          void useCases.overrideDate(entry, date).then((result) => setError(result.ok ? null : t('events.holidayDetail.error')));
        }}
      />
    </div>
  );

  const label = t('events.holidayDetail.label');
  if (layout === 'pc') {
    const panel = (
      <DetailPanel label={label} onClose={closeDetail} width={588}>
        {content}
      </DetailPanel>
    );
    return slot ? createPortal(panel, slot) : panel;
  }
  return (
    <Sheet open onClose={closeDetail} label={label} className="ct-sheet--tall">
      {content}
    </Sheet>
  );
}

/**
 * Fiche d'un jour férié (E-03 critère 5), à la demande de `DetailTarget { type: 'holiday' }` : pays, date, mention « date estimée »
 * d'une fête religieuse tunisienne tant qu'elle n'est pas confirmée. « Modifier la date » ouvre le sélecteur de date et enregistre une
 * saisie manuelle (prioritaire sur la table) ; « Rétablir la date de la table » la restaure. Une fête fixe ou calculée n'est pas modifiable.
 * Panneau à droite sur PC, feuille sur iPhone.
 */
export function HolidayDetailHost() {
  const detail = useNavigationStore((s) => s.detail);
  if (detail?.type !== 'holiday') return null;
  return <HolidayDetail key={`${detail.country}:${detail.key}:${String(detail.year)}`} country={detail.country} holidayKey={detail.key} year={detail.year} />;
}

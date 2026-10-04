import { useEffect, useMemo, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import type { ItemFilter } from '../../domain/itemFilter';
import type { MonthRef, MonthReport } from '../../domain/monthReport';
import type { LocalDate } from '../../domain/types';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useEffectiveProjectFilter } from '../spaces';
import { loadMonthReport } from './monthReportLoader';

export interface MonthReportState {
  /** Dernier rapport calculé (gardé affiché pendant un recalcul, sans clignotement). */
  readonly report: MonthReport | null;
  readonly status: 'loading' | 'ready' | 'error';
  readonly today: LocalDate;
  /** Filtre effectivement appliqué : espace global et projet actif (ES-08). */
  readonly filter: ItemFilter;
  /** Date de la plus ancienne donnée (borne du « Mois précédent »). */
  readonly oldest: LocalDate | null;
}

/**
 * Rapport d'un mois selon le filtre d'espace global et le projet choisi (ES-03, ES-04, ES-08) : se recalcule à chaque changement de
 * mois ou de filtre. Le jour courant est celui de l'application (`useAppStore.day`, horloge du conteneur).
 */
export function useMonthReport(month: MonthRef): MonthReportState {
  const container = useAppContainer();
  const space = useAppStore((s) => s.spaceFilter);
  const project = useEffectiveProjectFilter();
  const today = useAppStore((s) => s.day) ?? todayLocal(container.clock);
  const firstWeekday = getFirstWeekday();
  const filter: ItemFilter = useMemo(() => ({ space, project }), [space, project]);
  const [result, setResult] = useState<{ report: MonthReport | null; status: 'loading' | 'ready' | 'error' }>({ report: null, status: 'loading' });
  const [oldest, setOldest] = useState<LocalDate | null>(null);

  useEffect(() => {
    let alive = true;
    container.data.repos.stats
      .oldestActivity()
      .then((value) => {
        if (alive) setOldest(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [container]);

  useEffect(() => {
    let alive = true;
    loadMonthReport(container.data, { month, today, filter, firstWeekday })
      .then((report) => {
        if (alive) setResult({ report, status: 'ready' });
      })
      .catch(() => {
        if (alive) setResult((previous) => ({ report: previous.report, status: 'error' }));
      });
    return () => {
      alive = false;
    };
  }, [container, month, today, filter, firstWeekday]);

  return { report: result.report, status: result.status, today, filter, oldest };
}

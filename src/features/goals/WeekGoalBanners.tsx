import { Target } from 'lucide-react';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { Icon, IconView, resolveIconRefColor } from '../../ui';
import { useAppStore } from '../app/appStore';
import { usePinnedGoalEntries } from './useGoalEntries';
import './WeekGoalBanners.css';

/**
 * Bandeaux « OBJECTIF · titre · 2/5 » au-dessus des sept colonnes de la Semaine PC (OB-02 critère 6, PC-Semaine-UnJour.html) : un bandeau par
 * objectif épinglé de la semaine affichée, filtré par l'espace global ; masqués sous un filtre projet (un objectif n'a pas de projet).
 */
export function WeekGoalBanners({ weekStart, hidden = false }: { weekStart: LocalDate; hidden?: boolean }) {
  const filter = useAppStore((s) => s.spaceFilter);
  const entries = usePinnedGoalEntries(weekStart, filter);
  if (hidden || entries.length === 0) return null;
  return (
    <div className="ct-week-goals" role="group" aria-label={t('goals.bannersLabel')}>
      {entries.map(({ goal, progress }) => {
        const achieved = goal.status === 'achieved';
        return (
          <div key={goal.id} className="ct-week-goal" aria-label={t('goals.bannerLabel', { title: goal.title })} role="group">
            {goal.icon ? <IconView icon={goal.icon} size={22} color={resolveIconRefColor(goal.icon)} /> : <Icon icon={Target} size={22} color="var(--ct-color-goal)" />}
            <span className="ct-week-goal__caption">{t('goals.bannerCaption')}</span>
            <span className="ct-week-goal__title">{goal.title}</span>
            {achieved ? (
              <span className="ct-week-goal__achieved">{t('goals.achieved')}</span>
            ) : (
              progress.total > 0 && (
                <span className="ct-week-goal__progress" aria-label={t('today.goalProgress', { done: progress.done, total: progress.total })}>
                  {progress.done}/{progress.total}
                </span>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

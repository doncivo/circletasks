import { useEffect, useMemo } from 'react';
import { todayLocal } from '../../domain/clock';
import { goalsToReview } from '../../domain/goalRules';
import { addDays } from '../../domain/localDate';
import { isoWeekOf } from '../../domain/week';
import { t } from '../../i18n';
import { formatWeekRange } from '../../i18n/format';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { GoalIcon } from './GoalSection';
import { goalsStore } from './goalsStore';
import './GoalReviewCards.css';

/**
 * Propositions de fin de semaine en tête d'Aujourd'hui (OB-05, carte non dessinée) : « Objectif non atteint : <titre> » avec
 * « Reconduire » et « Clore », une carte par objectif encore ouvert d'une semaine terminée. Les cartes restent tant qu'on n'a pas
 * répondu (même le mercredi) ; le filtre d'espace global s'applique. Masquées sous un filtre projet (`hidden`).
 */
export function GoalReviewCards({ hidden = false }: { hidden?: boolean }) {
  const container = useAppContainer();
  const filter = useAppStore((s) => s.spaceFilter);
  const appDay = useAppStore((s) => s.day);
  const reviews = useFeatureStore(goalsStore, (s) => s.reviews);
  const loadReviews = useFeatureStore(goalsStore, (s) => s.loadReviews);
  const carryOver = useFeatureStore(goalsStore, (s) => s.carryOver);
  const close = useFeatureStore(goalsStore, (s) => s.close);
  const today = appDay ?? todayLocal(container.clock);

  // Le démarrage (startup.ts) lit déjà les objectifs à réviser ; relecture à l'ouverture de l'écran et au changement de jour.
  useEffect(() => {
    void loadReviews(today);
  }, [loadReviews, today]);

  const shown = useMemo(() => goalsToReview(today, reviews, filter), [today, reviews, filter]);
  if (hidden || shown.length === 0) return null;
  return (
    <ul className="ct-goal-reviews" aria-label={t('goals.review.listLabel')}>
      {shown.map((goal) => (
        <li key={goal.id} className="ct-goal-review">
          <div className="ct-goal-review__head">
            <GoalIcon icon={goal.icon} size={24} />
            <div className="ct-goal-review__text">
              <span className="ct-goal-review__title">{t('goals.review.title', { title: goal.title })}</span>
              <span className="ct-goal-review__week">
                {t('goals.weekLine', { number: isoWeekOf(goal.weekStart).week, range: formatWeekRange(goal.weekStart, addDays(goal.weekStart, 6), 'short') })}
              </span>
            </div>
          </div>
          <div className="ct-goal-review__actions">
            <Button fullWidth onClick={() => void carryOver(goal.id)} ariaLabel={t('goals.review.carryOverLabel', { title: goal.title })}>
              {t('goals.review.carryOver')}
            </Button>
            <Button variant="secondary" fullWidth onClick={() => void close(goal.id)} ariaLabel={t('goals.review.closeLabel', { title: goal.title })}>
              {t('goals.review.close')}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

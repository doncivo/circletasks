import type { Streaks } from '../../domain/routineStreaks';
import { t } from '../../i18n';
import { formatStreak } from '../../i18n/formatRoutine';

/**
 * Encart de série du formulaire de modification (ModifierRoutine.html) : « Série en cours 4 séances · Meilleure 11 ». Le nombre de
 * la meilleure série est seul à l'écran (comme la maquette) ; son libellé complet est annoncé aux lecteurs d'écran.
 */
export function RoutineStreakBox({ streaks }: { readonly streaks: Streaks }) {
  return (
    <div className="ct-routine-form__streak">
      <span className="ct-routine-form__streakCurrent">
        {t('routines.streak.current')} <b>{formatStreak(streaks.current, streaks.unit)}</b>
      </span>
      <span aria-label={`${t('routines.streak.best')} ${formatStreak(streaks.best, streaks.unit)}`}>
        {t('routines.streak.bestShort')} <b>{streaks.best}</b>
      </span>
    </div>
  );
}

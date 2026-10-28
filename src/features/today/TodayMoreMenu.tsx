import { ChartColumn, Check, Rows3, SquarePen, Target } from 'lucide-react';
import { t } from '../../i18n';
import { tTodayMenu } from '../../i18n/todayMenuText';
import { Icon, Sheet, SomedayIcon } from '../../ui';
import './TodayMoreMenu.css';

export interface TodayMoreMenuProps {
  readonly somedayCount: number;
  readonly compact: boolean;
  readonly editMode: boolean;
  readonly onSomeday: () => void;
  readonly onGoals: () => void;
  readonly onReport: () => void;
  readonly onCompact: (value: boolean) => void;
  readonly onEditMode: (value: boolean) => void;
  readonly onClose: () => void;
}

/**
 * Menu « Plus d’options » de l'en-tête d'Aujourd'hui sur iPhone (UI-REFONTE-02, critère 2) : Un jour (SD-01), Objectif de la semaine
 * (OB-01), Rapport mensuel (T-07), puis les deux interrupteurs Vue compacte (A-06) et Mode édition (A-05) que la maquette retire de
 * l'écran. Les deux interrupteurs sont en tête : le bas de la feuille peut être recouvert cinq secondes par le message « Annuler »
 * (UndoToast, au-dessus des feuilles pour rester annulable). Feuille à la demande (hôte `LazyTodayMoreMenu`), catalogue chargé avec
 * elle ; chaque choix referme la feuille.
 */
export function TodayMoreMenu({ somedayCount, compact, editMode, onSomeday, onGoals, onReport, onCompact, onEditMode, onClose }: TodayMoreMenuProps) {
  const choose = (action: () => void) => (): void => {
    action();
    onClose();
  };
  // Même libellé que l'icône « Un jour » (SD-01 critère 6) : « Un jour », « Un jour, 1 tâche », « Un jour, 6 tâches ».
  const somedayLabel = somedayCount === 0 ? t('someday.open') : somedayCount === 1 ? t('someday.openCountOne') : t('someday.openCount', { count: somedayCount });
  return (
    <Sheet open onClose={onClose} label={t('today.moreOptions')} className="ct-sheet--today-menu">
      <div className="ct-today-menu" role="menu" aria-label={t('today.moreOptions')}>
        <button type="button" role="menuitemcheckbox" aria-checked={compact} className="ct-today-menu__item" onClick={choose(() => onCompact(!compact))}>
          <Icon icon={Rows3} size={22} />
          <span>{tTodayMenu('compact')}</span>
          {compact && <Icon icon={Check} size={20} className="ct-today-menu__check" />}
        </button>
        <button type="button" role="menuitemcheckbox" aria-checked={editMode} className="ct-today-menu__item" onClick={choose(() => onEditMode(!editMode))}>
          <Icon icon={SquarePen} size={22} />
          <span>{tTodayMenu('edit')}</span>
          {editMode && <Icon icon={Check} size={20} className="ct-today-menu__check" />}
        </button>
        <div className="ct-today-menu__separator" role="separator" />
        <button type="button" role="menuitem" className="ct-today-menu__item" onClick={choose(onSomeday)}>
          <SomedayIcon size={22} />
          <span>{somedayLabel}</span>
        </button>
        <button type="button" role="menuitem" className="ct-today-menu__item" onClick={choose(onGoals)}>
          <Icon icon={Target} size={22} />
          <span>{tTodayMenu('goals')}</span>
        </button>
        <button type="button" role="menuitem" className="ct-today-menu__item" onClick={choose(onReport)}>
          <Icon icon={ChartColumn} size={22} />
          <span>{tTodayMenu('report')}</span>
        </button>
        <button type="button" className="ct-today-menu__item ct-today-menu__item--close" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Sheet>
  );
}

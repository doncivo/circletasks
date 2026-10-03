import { Target } from 'lucide-react';
import { useEffect, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { goalsAvailableFor } from '../../domain/goalRules';
import type { Goal } from '../../domain/model';
import type { GoalId, LocalDate } from '../../domain/types';
import { weekStartOf } from '../../domain/week';
import { t } from '../../i18n';
import { ChoiceDialog, Icon, Switch } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { onGoalsChanged } from './goalEvents';
import './GoalAttachSwitch.css';

export interface GoalAttachSwitchProps {
  /** Date de la tâche : sa semaine est la semaine de référence ; null (Un jour) : la semaine en cours (OB-03 critère 8). */
  readonly taskDate: LocalDate | null;
  /** Objectif auquel la tâche est rattachée, s'il y en a un. */
  readonly attachedGoalId: GoalId | null;
  /** Rattache (id) ou détache (null) ; appelé après le choix éventuel dans la liste. */
  readonly onChange: (goalId: GoalId | null) => void;
  /**
   * `sheet` : ligne de la feuille d'ajout (Ajout.html, icône cible + « Rattacher à mon objectif ») ; `detail` : ligne de la fiche
   * (PC-Aujourdhui.html : état à gauche, interrupteur à droite).
   */
  readonly variant: 'sheet' | 'detail';
}

/**
 * Interrupteur « Rattacher à mon objectif » (OB-03), commun à la feuille d'ajout et à la fiche détail. Un seul objectif ouvert dans
 * la semaine de la tâche : rattachement direct ; plusieurs (tous espaces confondus) : liste à choisir, fermer sans choisir laisse
 * l'interrupteur désactivé (QB-13) ; aucun : interrupteur inactif avec l'aide « Aucun objectif cette semaine ».
 */
export function GoalAttachSwitch({ taskDate, attachedGoalId, onChange, variant }: GoalAttachSwitchProps) {
  const container = useAppContainer();
  const appDay = useAppStore((s) => s.day);
  const spaces = useAppStore((s) => s.spaces);
  const today = appDay ?? todayLocal(container.clock);
  const [available, setAvailable] = useState<readonly Goal[]>([]);
  const [attached, setAttached] = useState<Goal | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    let current = true;
    const run = (): void => {
      Promise.all([
        container.data.repos.goals.listForWeek(weekStartOf(taskDate ?? today), 'all'),
        attachedGoalId ? container.data.repos.goals.getById(attachedGoalId) : Promise.resolve(null),
      ]).then(
        ([week, goal]) => {
          if (!current) return;
          setAvailable(goalsAvailableFor(taskDate, today, week));
          setAttached(goal);
          setLoaded(true);
        },
        () => {
          if (!current) return;
          setAvailable([]);
          setAttached(null);
          setLoaded(true);
        },
      );
    };
    run();
    const off = onGoalsChanged(container.data, run);
    return () => {
      current = false;
      off();
    };
  }, [container, taskDate, today, attachedGoalId]);

  const isOn = attachedGoalId !== null;
  const none = loaded && !isOn && available.length === 0;
  const disabled = !loaded || none;

  function toggle(next: boolean): void {
    if (!next) {
      onChange(null);
      return;
    }
    if (available.length === 1) onChange((available[0] as Goal).id);
    else if (available.length > 1) setChoosing(true);
  }

  const status = isOn ? (attached ? t('goals.attachedTo', { title: attached.title }) : t('goals.attachedLoading')) : t('detail.goalNone');
  // OB-03 critère 2 : aucun objectif cette semaine, l'interrupteur est inactif et l'aide le dit.
  const help = none ? t('goals.noneThisWeek') : null;
  const spaceName = (goal: Goal): string => spaces.find((space) => space.id === goal.spaceId)?.name ?? '';

  return (
    <div className="ct-goal-attach" data-variant={variant}>
      {variant === 'sheet' && (
        <span className="ct-goal-attach__label">
          <Icon icon={Target} size={22} color="var(--ct-color-goal)" />
          {t('goals.attachSwitch')}
        </span>
      )}
      {variant === 'detail' && (
        <span className="ct-goal-attach__statusBlock">
          <span className="ct-goal-attach__status">{status}</span>
          {help && <span className="ct-goal-attach__help">{help}</span>}
        </span>
      )}
      <Switch checked={isOn} onChange={toggle} label={t('goals.attachSwitch')} disabled={disabled} />
      {variant === 'sheet' && (
        <span className="ct-goal-attach__help" data-visible={isOn || none}>
          {isOn ? status : (help ?? '')}
        </span>
      )}
      {choosing && (
        <ChoiceDialog
          title={t('goals.chooseTitle')}
          options={available.map((goal) => ({ id: goal.id, label: `${goal.title} · ${spaceName(goal)}` }))}
          onChoose={(id) => {
            setChoosing(false);
            onChange(id);
          }}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}

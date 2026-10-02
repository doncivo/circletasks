import { CalendarDays, CalendarPlus, Sunrise } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { todayLocal } from '../../domain/clock';
import type { Task } from '../../domain/model';
import { nextDayFrom, type PostponeTarget } from '../../domain/taskPostpone';
import { t } from '../../i18n';
import { ActionMenu, Button, DatePrompt, Icon, type ActionMenuItem } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';

interface PostponeActionProps {
  /** Tâche reportée (fiche détail) ; absente pour une sélection multiple (A-05). */
  task?: Pick<Task, 'status' | 'someday'>;
  /** Applique le report ; ne rejette jamais (store). */
  onPostpone: (target: PostponeTarget) => Promise<void>;
  /** Nom accessible du menu ; « Reporter la tâche » par défaut. */
  menuLabel?: string;
  /** Déclencheur propre à l'appelant (barre de sélection) ; bouton « Reporter » par défaut. */
  trigger?: (state: { readonly expanded: boolean; readonly toggle: () => void }) => ReactNode;
  /** Le menu s'ouvre au-dessus du déclencheur (barre en bas d'écran). */
  menuAbove?: boolean;
}

/**
 * Bouton « Reporter » de la fiche détail (T-05) et son menu : « Demain », « Semaine
 * prochaine », « Choisir une date ». Une tâche « Un jour » affiche « Planifier »
 * (SD-02) avec le même menu ; une tâche terminée n'a pas de bouton (critère 9).
 * A-05 : même menu pour la sélection multiple, avec un déclencheur dans la barre de sélection.
 */
export function PostponeAction({ task, onPostpone, menuLabel, trigger, menuAbove }: PostponeActionProps) {
  const container = useAppContainer();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);

  if (task?.status === 'done') return null;

  const items: ActionMenuItem[] = [
    { id: 'tomorrow', label: t('tasks.postponeTomorrow'), icon: <Icon icon={Sunrise} size={18} /> },
    { id: 'next-week', label: t('tasks.postponeNextWeek'), icon: <Icon icon={CalendarPlus} size={18} /> },
    { id: 'date', label: t('tasks.postponePickDate'), icon: <Icon icon={CalendarDays} size={18} /> },
  ];

  function select(id: string): void {
    setMenuOpen(false);
    if (id === 'date') setDateOpen(true);
    else void onPostpone(id === 'next-week' ? 'next-week' : 'tomorrow');
  }

  const toggle = (): void => setMenuOpen((open) => !open);

  return (
    <div className={menuAbove ? 'ct-task-detail__postpone ct-task-detail__postpone--above' : 'ct-task-detail__postpone'}>
      {trigger ? (
        trigger({ expanded: menuOpen, toggle })
      ) : (
        <Button variant="secondary" onClick={toggle} haspopup="menu" expanded={menuOpen} className="ct-task-detail__postponeButton">
          <Icon icon={CalendarDays} size={18} />
          {t(task?.someday ? 'tasks.schedule' : 'tasks.postpone')}
        </Button>
      )}
      <ActionMenu open={menuOpen} label={menuLabel ?? t('tasks.postponeMenuLabel')} items={items} onSelect={select} onClose={() => setMenuOpen(false)} />
      <DatePrompt
        open={dateOpen}
        label={t('tasks.postponePickDate')}
        confirmLabel={t('tasks.postponeConfirm')}
        today={todayLocal(container.clock)}
        initialValue={nextDayFrom(todayLocal(container.clock))}
        onConfirm={(date) => {
          setDateOpen(false);
          if (date) void onPostpone({ date });
        }}
        onClose={() => setDateOpen(false)}
      />
    </div>
  );
}

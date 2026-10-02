import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import type { Routine, Space } from '../../domain/model';
import { t } from '../../i18n';
import { Button, Icon, IconView, resolveIconRefColor } from '../../ui';
import './RoutinesArchived.css';

export interface RoutinesArchivedProps {
  /** Routines archivées de l'espace filtré. */
  readonly routines: readonly Routine[];
  readonly spaces: readonly Space[];
  readonly onRestore: (routine: Routine) => void;
}

/**
 * Section « Archivées » en bas de l'onglet Routines (R-05 critères 8 et 9, QB-05) : repliée par défaut, absente quand il n'y a rien
 * d'archivé ; dépliée, elle liste les routines archivées avec un bouton « Restaurer ».
 */
export function RoutinesArchived({ routines, spaces, onRestore }: RoutinesArchivedProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (routines.length === 0) return null;
  return (
    <section className="ct-routines-archived">
      <button type="button" className="ct-routines-archived__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
        <Icon icon={open ? ChevronDown : ChevronRight} size={18} />
        {t('routines.archived.toggle', { count: routines.length })}
      </button>
      {open && (
        <ul id={listId} className="ct-routines-archived__list" aria-label={t('routines.archived.listLabel')}>
          {routines.map((routine) => (
            <li key={routine.id} className="ct-routines-archived__item">
              {routine.icon && <IconView icon={routine.icon} color={resolveIconRefColor(routine.icon) ?? 'currentColor'} size={24} />}
              <span className="ct-routines-archived__title">{routine.title}</span>
              <span className="ct-routines-archived__space">{spaces.find((space) => space.id === routine.spaceId)?.name}</span>
              <Button variant="secondary" ariaLabel={t('routines.archived.restoreLabel', { title: routine.title })} onClick={() => onRestore(routine)}>
                {t('routines.archived.restore')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

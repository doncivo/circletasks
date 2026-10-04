import { t } from '../i18n';
import './AddSegments.css';

export type AddSegment = 'task' | 'event' | 'routine';

const SEGMENTS: readonly { readonly id: AddSegment; readonly labelKey: 'events.segments.task' | 'events.segments.event' | 'events.segments.routine' }[] = [
  { id: 'task', labelKey: 'events.segments.task' },
  { id: 'event', labelKey: 'events.segments.event' },
  { id: 'routine', labelKey: 'events.segments.routine' },
];

export interface AddSegmentsProps {
  value: AddSegment;
  onChange: (segment: AddSegment) => void;
  className?: string;
}

/**
 * Segments « Tâche / Événement / Routine » de la feuille Ajout (Ajout.html, AjoutEvenement.html, E-01 critère 2) : boutons à état
 * (`aria-pressed`), le segment choisi sur fond blanc. Changer de segment ne perd jamais le titre : l'appelant le garde.
 *
 * @example
 * <AddSegments value={segment} onChange={setSegment} />
 */
export function AddSegments({ value, onChange, className }: AddSegmentsProps) {
  return (
    <div role="group" aria-label={t('events.segments.label')} className={['ct-add-segments', className].filter(Boolean).join(' ')}>
      {SEGMENTS.map((segment) => (
        <button key={segment.id} type="button" className="ct-add-segments__button" aria-pressed={value === segment.id} onClick={() => value !== segment.id && onChange(segment.id)}>
          {t(segment.labelKey)}
        </button>
      ))}
    </div>
  );
}

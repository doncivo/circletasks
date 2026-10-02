import type { ReactNode } from 'react';
import './ListRow.css';

export interface ListRowProps {
  /** Titre de l'élément (donnée utilisateur, ex. titre de tâche). */
  title: string;
  /** Sous-ligne heure / espace (ex. « 09:00 · Pro »), peut contenir des segments colorés. */
  subtitle?: ReactNode;
  /** Icône de fin de ligne (ex. `<IconView icon={task.icon} color={...} />`). */
  icon?: ReactNode;
  /** Élément de tête (ex. `<Checkbox .../>`). */
  leading?: ReactNode;
  /** Élément terminé : titre barré, couleur atténuée (Main.html, « Faire mon lit »). */
  done?: boolean;
  /** Élément de fin de ligne, après l'icône (ex. bouton « Restaurer » de la corbeille, T-08). */
  trailing?: ReactNode;
  /** Ouvre le détail (A-08) ; sans cette prop, le titre n'est pas interactif. */
  onActivate?: () => void;
  className?: string;
}

/**
 * Ligne de liste des maquettes (Main.html, PC-Aujourdhui.html) : case, titre,
 * sous-ligne, icône.
 *
 * @example
 * <ListRow
 *   leading={<Checkbox checked={task.done} onChange={toggle} label={t('tasks.complete', { title: task.title })} />}
 *   title={task.title}
 *   subtitle={<>{formatTime(task.time)} · <span style={{ color: spaceColor }}>{spaceName}</span></>}
 *   icon={<IconView icon={task.icon} color={iconColor} size={28} />}
 *   done={task.done}
 *   onActivate={() => openDetail(task.id)}
 * />
 */
export function ListRow({ title, subtitle, icon, trailing, leading, done, onActivate, className }: ListRowProps) {
  return (
    <div className={['ct-list-row', className].filter(Boolean).join(' ')} data-done={done ?? false}>
      {leading}
      <div className="ct-list-row__body">
        {onActivate ? (
          <button type="button" onClick={onActivate} className="ct-list-row__title" data-done={done ?? false}>
            {title}
          </button>
        ) : (
          <span className="ct-list-row__title" data-done={done ?? false}>
            {title}
          </span>
        )}
        {subtitle !== undefined && <span className="ct-list-row__subtitle">{subtitle}</span>}
      </div>
      {icon}
      {trailing}
    </div>
  );
}

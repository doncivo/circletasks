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
  /** Ligne sélectionnée (mode édition, A-05) : fond #F1EEF7. */
  selected?: boolean;
  /**
   * Vue compacte (A-06, Main-Compact.html) : une ligne d'au moins 44 px, pastille de couleur avant le titre (tronqué par « … »),
   * heure à droite ; sous-ligne et icône masquées.
   */
  compact?: boolean;
  /** PC (PC-Aujourdhui.html) : la sous-ligne passe à droite du titre, sur une seule ligne, avant l'icône. */
  inlineSubtitle?: boolean;
  /** Heure affichée à droite en vue compacte (format 24 h) ; rien si absente. */
  time?: string | null;
  /** Couleur de la pastille de la vue compacte (couleur de l'icône de l'élément). */
  dotColor?: string;
  /** Élément de fin de ligne, après l'icône (ex. bouton « Restaurer » de la corbeille, T-08). */
  trailing?: ReactNode;
  /** Ouvre le détail (A-08) ; sans cette prop, le titre n'est pas interactif. */
  onActivate?: () => void;
  /** Ligne qui se déploie au clic (« Un jour », SD-02) : annoncée `aria-expanded` par le bouton du titre. */
  expanded?: boolean;
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
export function ListRow({ title, subtitle, icon, trailing, leading, done, selected, compact, time, dotColor, inlineSubtitle, onActivate, expanded, className }: ListRowProps) {
  return (
    <div
      className={['ct-list-row', className].filter(Boolean).join(' ')}
      data-done={done ?? false}
      data-selected={selected ? 'true' : undefined}
      data-compact={compact ? 'true' : undefined}
    >
      {leading}
      {compact && <span className="ct-list-row__dot" style={{ background: dotColor ?? 'var(--ct-color-text-secondary)' }} aria-hidden="true" />}
      <div className="ct-list-row__body">
        {onActivate ? (
          <button type="button" onClick={onActivate} className="ct-list-row__title" data-done={done ?? false} {...(expanded !== undefined ? { 'aria-expanded': expanded } : {})}>
            {title}
          </button>
        ) : (
          <span className="ct-list-row__title" data-done={done ?? false}>
            {title}
          </span>
        )}
        {!compact && !inlineSubtitle && subtitle !== undefined && <span className="ct-list-row__subtitle">{subtitle}</span>}
      </div>
      {!compact && inlineSubtitle && subtitle !== undefined && <span className="ct-list-row__meta">{subtitle}</span>}
      {compact && time && <span className="ct-list-row__time">{time}</span>}
      {!compact && icon}
      {trailing}
    </div>
  );
}

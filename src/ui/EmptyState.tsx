import type { LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { Icon } from './Icon';
import './EmptyState.css';

export interface EmptyStateIcon {
  icon: LucideIcon;
  /** Couleur du trait (jeton `--ct-color-icon-*`) ; la pastille reste #F3F1F6 (`--ct-color-surface-input`). */
  color?: string;
}

export interface EmptyStateAction {
  /** Libellé déjà résolu par t() (« Ajouter une tâche »). */
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  /** Phrase d'accroche (titre de niveau 2) : « Rien de prévu ce dimanche. » */
  title: string;
  /** Phrase d'explication facultative. */
  text?: string;
  /**
   * Variantes (P-06 D1) : 3 icônes = trois pastilles de 64 px (Main-Vide.html, Aujourd'hui seulement) ; 1 icône = une pastille ;
   * aucune = titre, texte et action.
   */
  icons?: readonly EmptyStateIcon[];
  /** Action principale (bouton contour de 44 px) : elle fait ce que son libellé annonce. */
  action?: EmptyStateAction;
  /** Identifiant d'écran du registre `emptyStateScreens` (attribut `data-empty-screen`, utilisé par les tests de balayage). */
  screen?: string;
  className?: string;
}

/**
 * État vide unique de l'application (P-06, PRD section 5) : titre h2, texte, icônes décoratives sur pastilles, action principale.
 * Annoncé poliment à son apparition (région `aria-live="polite"` masquée, remplie après le montage). Remplace tous les « Aucun... » dispersés des écrans à liste.
 *
 * @example
 * <EmptyState title={t('routines.emptyTitle')} icons={[{ icon: Repeat }]} action={{ label: t('routines.create'), onClick: openCreate }} />
 */
export function EmptyState({ title, text, icons = [], action, screen, className }: EmptyStateProps) {
  const variant = icons.length >= 3 ? 'three' : icons.length > 0 ? 'one' : 'none';
  // Titre rendu dès le premier passage (pas de saut de mise en page) ; l'annonce passe par une région live masquée, toujours montée et
  // remplie après coup (les lecteurs d'écran n'annoncent que le texte ajouté à une région existante).
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setAnnouncement(t('empty.announcement', { title })), 0);
    return () => window.clearTimeout(id);
  }, [title]);
  return (
    <div className={className ? `ct-empty ${className}` : 'ct-empty'} data-variant={variant} data-empty-screen={screen}>
      <h2 className="ct-empty__title">{title}</h2>
      <span className="ct-visually-hidden" aria-live="polite" data-empty-announcement="">
        {announcement}
      </span>
      {icons.length > 0 && (
        <div className="ct-empty__icons" aria-hidden="true">
          {icons.slice(0, 3).map((item, index) => (
            <span key={index} className="ct-empty__pill">
              <Icon icon={item.icon} size={30} color={item.color ?? 'var(--ct-color-icon-purple)'} />
            </span>
          ))}
        </div>
      )}
      {text && <p className="ct-empty__text">{text}</p>}
      {action && (
        <button type="button" className="ct-empty__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

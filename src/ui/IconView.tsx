import type { IconRef } from '../domain/model/icon';
import { Icon } from './Icon';
import { resolveIconComponent } from './iconCatalog';

export interface IconViewProps {
  /** Icône d'un élément (tâche, routine, objectif, événement), T-03. */
  icon: IconRef;
  /** Côté du carré en pixels ; les maquettes utilisent 18 à 30 px pour les icônes de ligne. */
  size?: number;
  /** Couleur du trait (icône Lucide) ; sans effet sur un emoji. `currentColor` par défaut. */
  color?: string;
  className?: string;
  /** Texte accessible (clé i18n déjà résolue par l'appelant) ; omis = icône décorative. */
  label?: string;
}

/**
 * Rend un `IconRef` : icône Lucide colorée du catalogue, ou emoji tel quel.
 *
 * @example
 * <IconView icon={{ kind: 'lucide', name: 'file-text' }} color="#B5483B" size={28} />
 * <IconView icon={{ kind: 'emoji', value: '📄' }} size={28} label={t('tasks.icon')} />
 */
export function IconView({ icon, size = 24, color = 'currentColor', className, label }: IconViewProps) {
  if (icon.kind === 'emoji') {
    return (
      <span
        className={className}
        style={{ fontSize: size, lineHeight: 1, display: 'inline-block' }}
        role={label === undefined ? undefined : 'img'}
        aria-label={label}
        aria-hidden={label === undefined ? true : undefined}
      >
        {icon.value}
      </span>
    );
  }
  const Component = resolveIconComponent(icon.name);
  if (!Component) return null;
  return (
    <Icon
      icon={Component}
      size={size}
      color={color}
      {...(className !== undefined ? { className } : {})}
      {...(label !== undefined ? { label } : {})}
    />
  );
}

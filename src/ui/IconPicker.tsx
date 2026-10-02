import { ICON_NAMES, type IconName, type IconRef } from '../domain/model/icon';
import { t } from '../i18n';
import { Icon } from './Icon';
import { ICON_CATALOG_ENTRIES } from './iconCatalog';
import './IconPicker.css';

export interface IconPickerProps {
  /** Icône Lucide choisie, ou `null` (aucune) ; une valeur `emoji` est ignorée (un seul champ icon, critère 2). */
  value: IconRef | null;
  /** Un second toucher sur l'icône choisie la désélectionne (`null`), critère 1. */
  onChange: (icon: IconRef | null) => void;
  className?: string;
}

/**
 * Rangée défilante horizontale d'icônes Lucide colorées (Ajout.html, T-03,
 * critère 1) : pastilles de 52 px, bordure accentuée sur l'icône choisie,
 * libellé accessible français issu de `src/i18n` (critère 6).
 *
 * @example
 * <IconPicker value={icon?.kind === 'lucide' ? icon : null} onChange={setIcon} />
 */
export function IconPicker({ value, onChange, className }: IconPickerProps) {
  const selectedName = value?.kind === 'lucide' ? value.name : null;
  return (
    <div role="group" aria-label={t('icons.pickerLabel')} className={['ct-icon-picker', className].filter(Boolean).join(' ')}>
      {ICON_NAMES.map((name) => (
        <IconPickerButton key={name} name={name} chosen={selectedName === name} onToggle={onChange} />
      ))}
    </div>
  );
}

function IconPickerButton({
  name,
  chosen,
  onToggle,
}: {
  name: IconName;
  chosen: boolean;
  onToggle: (icon: IconRef | null) => void;
}) {
  const entry = ICON_CATALOG_ENTRIES[name];
  const plainLabel = t(entry.labelKey);
  const label = chosen ? t('icons.chosenSuffix', { label: plainLabel }) : plainLabel;
  return (
    <button
      type="button"
      aria-pressed={chosen}
      aria-label={label}
      data-chosen={chosen}
      className="ct-icon-picker__button"
      onClick={() => onToggle(chosen ? null : { kind: 'lucide', name })}
    >
      <Icon icon={entry.component} size={26} color={entry.color} />
    </button>
  );
}

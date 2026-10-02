import { useState } from 'react';
import { EMOJI_MAX_LENGTH, isValidIconRef, type IconRef } from '../domain/model/icon';
import { t } from '../i18n';
import { EMOJI_CATALOG, type EmojiCatalogEntry } from './emojiCatalog';
import { TextField } from './TextField';
import './EmojiPicker.css';

export interface EmojiPickerProps {
  /** Emoji choisi, ou `null` (aucun) ; une valeur `lucide` est ignorée (un seul champ icon, critère 2). */
  value: IconRef | null;
  /** Un second toucher sur l'emoji choisi le désélectionne, par symétrie avec `IconPicker`. */
  onChange: (icon: IconRef | null) => void;
  className?: string;
}

/**
 * Liste embarquée d'emoji (T-03, critère 2) : aucun chargement réseau, catalogue
 * limité et documenté (`src/ui/emojiCatalog.ts`), complété d'un champ libre pour
 * tout autre emoji (sous-tâche 5) : un seul graphème, validé par le domaine
 * (`isValidIconRef`, même règle qu'à l'enregistrement). Choisir un emoji remplace
 * toute icône Lucide déjà choisie (un seul champ `icon` par tâche).
 *
 * @example
 * <EmojiPicker value={icon?.kind === 'emoji' ? icon : null} onChange={setIcon} />
 */
export function EmojiPicker({ value, onChange, className }: EmojiPickerProps) {
  const selectedValue = value?.kind === 'emoji' ? value.value : null;
  const [customDraft, setCustomDraft] = useState('');
  const customTrimmed = customDraft.trim();
  const customInvalid = customTrimmed.length > 0 && !isValidIconRef({ kind: 'emoji', value: customTrimmed });

  function handleCustomChange(raw: string): void {
    setCustomDraft(raw);
    const trimmed = raw.trim();
    if (trimmed.length > 0 && isValidIconRef({ kind: 'emoji', value: trimmed })) {
      onChange({ kind: 'emoji', value: trimmed });
    }
  }

  return (
    <div className={['ct-emoji-picker-wrap', className].filter(Boolean).join(' ')}>
      <div role="group" aria-label={t('icons.emojiPickerLabel')} className="ct-emoji-picker">
        {EMOJI_CATALOG.map((entry) => (
          <EmojiPickerButton key={entry.value} entry={entry} chosen={selectedValue === entry.value} onToggle={onChange} />
        ))}
      </div>
      <div className="ct-emoji-picker__custom">
        <TextField
          label={t('icons.customEmojiLabel')}
          visibleLabel
          placeholder={t('icons.customEmojiHint')}
          value={customDraft}
          onChange={handleCustomChange}
          maxLength={EMOJI_MAX_LENGTH}
        />
        {customInvalid && (
          <span role="alert" className="ct-emoji-picker__customError">
            {t('icons.customEmojiError')}
          </span>
        )}
      </div>
    </div>
  );
}

function EmojiPickerButton({
  entry,
  chosen,
  onToggle,
}: {
  entry: EmojiCatalogEntry;
  chosen: boolean;
  onToggle: (icon: IconRef | null) => void;
}) {
  const plainLabel = t('icons.emojiLabel', { name: t(entry.nameKey) });
  const label = chosen ? t('icons.chosenSuffix', { label: plainLabel }) : plainLabel;
  return (
    <button
      type="button"
      aria-pressed={chosen}
      aria-label={label}
      data-chosen={chosen}
      className="ct-emoji-picker__button"
      onClick={() => onToggle(chosen ? null : { kind: 'emoji', value: entry.value })}
    >
      <span aria-hidden="true">{entry.value}</span>
    </button>
  );
}

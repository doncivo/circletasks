import { useState, type FormEvent, type ReactNode } from 'react';
import type { Space } from '../../domain/model';
import { SPACE_NAME_MAX_LENGTH, spacePalette } from '../../domain/spaceRules';
import type { HexColor } from '../../domain/types';
import { t, tDynamic, type MessageKey } from '../../i18n';
import { ColorSwatches, TextField, spaceTextColor } from '../../ui';
import type { SpaceRenameOutcome } from './spacesStore';

export interface SpaceEditorProps {
  readonly space: Space;
  /** Tous les espaces (rang, palette de l'espace). */
  readonly spaces: readonly Space[];
  readonly onRename: (raw: string) => Promise<SpaceRenameOutcome>;
  readonly onColor: (color: HexColor) => Promise<boolean>;
  /** Zone sous la couleur (projets, ES-04). */
  readonly children?: ReactNode;
}

const NAME_ERRORS = {
  'empty-name': 'spaces.nameEmpty',
  'name-too-long': 'spaces.nameTooLong',
  'name-taken': 'spaces.nameTaken',
  error: 'spaces.saveError',
} as const;

/**
 * Édition d'un espace (ES-01, carte « ESPACE n » de Bienvenue.html) : nom (enregistré à Entrée ou à la sortie du champ, refusé s'il est
 * vide, trop long ou identique à l'autre espace : l'ancien nom est alors conservé) et couleur de la palette de l'espace (enregistrée
 * aussitôt). Composant réutilisé par le premier lancement (P-05). Ni suppression ni création d'espace.
 */
export function SpaceEditor({ space, spaces, onRename, onColor, children }: SpaceEditorProps) {
  const [draft, setDraft] = useState(space.name);
  const [loadedName, setLoadedName] = useState(space.name);
  const [errorKey, setErrorKey] = useState<(typeof NAME_ERRORS)[keyof typeof NAME_ERRORS] | null>(null);
  const number = [...spaces].sort((a, b) => a.sortOrder - b.sortOrder).findIndex((s) => s.id === space.id) + 1;
  const accent = spaceTextColor(space.color);

  // Le nom enregistré change (autre écran, synchro) : le champ le suit.
  if (space.name !== loadedName) {
    setLoadedName(space.name);
    setDraft(space.name);
  }

  async function commit(): Promise<void> {
    if (draft === space.name) {
      setErrorKey(null);
      return;
    }
    const outcome = await onRename(draft);
    if (outcome === 'ok') {
      setErrorKey(null);
      return;
    }
    setErrorKey(NAME_ERRORS[outcome]);
    // Refus : l'ancien nom est conservé et réaffiché.
    setDraft(space.name);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    void commit();
  }

  const palette = spacePalette(spaces, space.id).map((choice) => ({ ...choice, label: tDynamic(`spaces.colors.${choice.id}` as MessageKey) }));

  return (
    <section className="ct-space-editor" style={{ borderColor: accent }} aria-label={space.name}>
      <form onSubmit={submit} noValidate className="ct-space-editor__form">
        <span className="ct-space-editor__caption" style={{ color: accent }} aria-hidden="true">
          {t('spaces.spaceCaption', { number })}
        </span>
        <TextField
          label={t('spaces.nameLabel', { number })}
          value={draft}
          onChange={(value) => {
            setDraft(value);
            if (errorKey) setErrorKey(null);
          }}
          onBlur={() => void commit()}
          maxLength={SPACE_NAME_MAX_LENGTH + 10}
        />
        {errorKey && (
          <p className="ct-space-editor__error" role="alert">
            {t(errorKey)}
          </p>
        )}
      </form>
      <div className="ct-space-editor__colors">
        <span className="ct-space-editor__colorCaption">{t('spaces.colorCaption')}</span>
        <ColorSwatches label={t('spaces.colorGroup', { name: space.name })} choices={palette} value={space.color} onChange={(color) => void onColor(color)} />
      </div>
      {children}
    </section>
  );
}

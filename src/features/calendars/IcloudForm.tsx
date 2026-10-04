import { useState, type FormEvent } from 'react';
import { t, type PlainMessageKey } from '../../i18n';
import { Button, TextField } from '../../ui';

export interface IcloudFormProps {
  readonly initialUsername: string;
  /** Reconnexion d'un compte existant : l'identifiant ne change pas (K-02 critère 6, formulaire pré-rempli). */
  readonly usernameLocked: boolean;
  readonly onCancel: () => void;
  /** Rend null en cas de succès, sinon la clé du message d'erreur à afficher. */
  readonly onSubmit: (username: string, password: string) => Promise<PlainMessageKey | null>;
}

/**
 * Formulaire iCloud (K-02 critère 1) : identifiant Apple, mot de passe d'application, consigne « pas votre mot de passe Apple » et
 * chemin pour le créer. Le mot de passe n'existe que dans ce champ, le temps de la saisie : il est transmis une fois au coffre puis le
 * champ est vidé, que la connexion réussisse ou non (critère 7 : jamais dans le DOM après validation).
 */
export function IcloudForm({ initialUsername, usernameLocked, onCancel, onSubmit }: IcloudFormProps) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [errorKey, setErrorKey] = useState<PlainMessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const secret = password;
    setPassword('');
    try {
      setErrorKey(await onSubmit(username, secret));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ct-calendars__form" onSubmit={(event) => void submit(event)} aria-label={t('calendars.icloudTitle')}>
      <h3 className="ct-calendars__caption">{t('calendars.icloudTitle')}</h3>
      <p className="ct-calendars__hint">{t('calendars.icloudHint')}</p>
      <p className="ct-calendars__hint">{t('calendars.icloudHowTo')}</p>
      <TextField label={t('calendars.icloudUsername')} placeholder={t('calendars.icloudUsername')} value={username} onChange={setUsername} disabled={usernameLocked || busy} visibleLabel />
      <TextField label={t('calendars.icloudPassword')} placeholder={t('calendars.icloudPasswordPlaceholder')} value={password} onChange={setPassword} disabled={busy} secret visibleLabel />
      {errorKey && (
        <p className="ct-calendars__error" role="alert">
          {t(errorKey)}
        </p>
      )}
      <div className="ct-calendars__actions">
        <Button type="submit" disabled={busy || username.trim() === '' || password === ''}>
          {t('calendars.icloudSubmit')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('calendars.icloudCancel')}
        </Button>
      </div>
    </form>
  );
}

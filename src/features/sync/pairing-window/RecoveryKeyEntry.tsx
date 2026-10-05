import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../../ui/Button';
import { useFocusTrap } from '../../../ui/useFocusTrap';
import type { PairingPlatform } from './pairingPlatform';
import { fill, pairingErrorText, pairingTexts, type PairingTexts } from './pairingText';
import './pairing.css';

/**
 * Saisie de la clé de secours dans l'instance `import` de la fenêtre `pairing` (sans maquette : composée avec les composants existants ;
 * Y-06 critères 10 à 12, 16 et 22 ; ADR 0011 sections 2.1 et 10.3).
 *
 * La saisie ne vit que dans le champ (non contrôlé : React ne la recopie dans aucun état) ; elle est lue à l'envoi, transmise telle
 * quelle à Rust (décodage, tolérance et contrôle en Rust seulement) et le champ est **vidé aussitôt**. La fenêtre affiche sa propre
 * minuterie de 5 minutes (D4) : Rust la détruit à l'échéance, l'interface la vide d'abord.
 */
export interface RecoveryKeyEntryProps {
  readonly platform: PairingPlatform;
  readonly texts?: PairingTexts;
  readonly now?: () => number;
  /** Durée de vie de la fenêtre (5 minutes). */
  readonly closeAfterMs: number;
}

type Phase = 'idle' | 'busy' | 'done' | 'closed';

export function RecoveryKeyEntry({ platform, texts = pairingTexts(), now = Date.now, closeAfterMs }: RecoveryKeyEntryProps) {
  const input = useRef<HTMLInputElement>(null);
  const [deadline] = useState(() => now() + closeAfterMs);
  const [nowMs, setNowMs] = useState(now);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const closing = useRef(false);

  const close = useCallback(() => {
    if (input.current) input.current.value = '';
    setPhase('closed');
    if (closing.current) return;
    closing.current = true;
    void platform.closePairing().catch(() => undefined);
  }, [platform]);

  const ref = useFocusTrap<HTMLElement>({ active: true, onEscape: close });

  useEffect(() => {
    const tick = (): void => {
      const current = now();
      setNowMs(current);
      if (current >= deadline) close();
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadline, now, close]);

  // Démontage : le champ est vidé (la fenêtre est détruite par Rust juste après).
  useEffect(() => {
    const field = input.current;
    return () => {
      if (field) field.value = '';
    };
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const field = input.current;
    if (!field || phase === 'busy' || phase === 'closed') return;
    const recoveryKey = field.value;
    field.value = '';
    if (recoveryKey.trim() === '') return;
    setPhase('busy');
    setMessage(null);
    try {
      await platform.import({ recoveryKey });
      // Réussite : Rust émet `sync-paired` vers la fenêtre principale et détruit cette fenêtre.
      setPhase('done');
      setMessage(texts.import.done);
    } catch (error) {
      setPhase('idle');
      setMessage(pairingErrorText(texts, error));
      field.focus();
    }
  };

  const remaining = Math.max(0, deadline - nowMs);
  const minutes = Math.ceil(remaining / 60_000);
  const closesIn = remaining < 60_000 ? texts.import.closesSoon : minutes === 1 ? texts.import.closesInOne : fill(texts.import.closesIn, { n: minutes });

  return (
    <main ref={ref} className="ct-pair ct-pair--import" tabIndex={-1} aria-labelledby="ct-pair-import-title">
      <span className="ct-pair__section">{texts.window.section}</span>
      <h1 id="ct-pair-import-title" className="ct-pair__title">
        {texts.import.title}
      </h1>
      <form className="ct-pair__form" onSubmit={(event) => void submit(event)} noValidate>
        <p className="ct-pair__text">{texts.import.text}</p>
        <label className="ct-pair__label" htmlFor="ct-pair-recovery">
          {texts.import.field}
        </label>
        <input
          ref={input}
          id="ct-pair-recovery"
          className="ct-pair__input"
          type="text"
          name="ct-recovery"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          autoCorrect="off"
          inputMode="text"
          disabled={phase === 'done' || phase === 'closed'}
        />
        {message && (
          <p className="ct-pair__message" role="status" data-testid="pairing-import-message">
            {message}
          </p>
        )}
        <p className="ct-pair__validity" data-testid="pairing-import-timer">
          {closesIn}
        </p>
        <div className="ct-pair__actions">
          <Button type="submit" disabled={phase !== 'idle'}>
            {phase === 'busy' ? texts.import.busy : texts.import.submit}
          </Button>
          <Button variant="secondary" ariaLabel={texts.window.cancelLabel} onClick={close}>
            {texts.window.cancel}
          </Button>
        </div>
      </form>
    </main>
  );
}

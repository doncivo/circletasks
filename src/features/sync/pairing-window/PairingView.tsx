import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type qrcodeFactory from 'qrcode-generator';
import { PAIRING_VALIDITY_MS } from '../../../domain/sync/limits';
import { syncErrorCodeOf } from '../../../platform/sync/types';
import { Button } from '../../../ui/Button';
import { useFocusTrap } from '../../../ui/useFocusTrap';
import type { PairingPlatform } from './pairingPlatform';
import { fill, pairingTexts, type PairingTexts } from './pairingText';
import { RecoveryKeyEntry } from './RecoveryKeyEntry';
import './pairing.css';

/**
 * Fenêtre dédiée `pairing` (maquette PC-Appairage.html ; Y-06 critères 5 à 8, 16 et 22 ; ADR 0011 sections 2.1 et 10.3).
 *
 * La clé n'existe côté interface qu'ici : le texte du QR et la clé de secours sont dans une **case secrète** propre à l'instance du
 * composant (jamais Zustand, jamais un journal, jamais l'URL ni le stockage du navigateur), vidée à la fermeture, à l'expiration et au
 * démontage. Rust détruit la fenêtre dans ces trois cas ; l'interface vide d'abord son état.
 */

/** Contenu sensible affiché : texte du QR, clé de secours, échéance. */
export interface PairingSecrets {
  readonly qrText: string;
  readonly recoveryKey: string;
  readonly expiresAt: number;
}

/** État local sensible de `PairingView` (une case par instance ; les tests peuvent en fournir une pour la lire avant et après). */
export interface SecretSlot {
  peek(): PairingSecrets | null;
  set(value: PairingSecrets): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

export function createSecretSlot(): SecretSlot {
  let value: PairingSecrets | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => listeners.forEach((listener) => listener());
  return {
    peek: () => value,
    set(next) {
      value = next;
      emit();
    },
    clear() {
      if (value === null) return;
      value = null;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type QrFactory = typeof qrcodeFactory;

/** Chemin SVG des modules sombres (zone calme de 4 modules), à partir du texte du QR. */
export function qrPath(factory: QrFactory, text: string): { readonly size: number; readonly d: string } {
  const qr = factory(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) if (qr.isDark(row, col)) parts.push(`M${String(col + 4)} ${String(row + 4)}h1v1h-1z`);
  }
  return { size: count + 8, d: parts.join('') };
}

/** Durée restante affichée : « 5 minutes », …, « 1 minute », puis les secondes. */
function validityText(texts: PairingTexts, remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (seconds >= 120) return fill(texts.window.validMinutes, { n: Math.ceil(seconds / 60) });
  if (seconds >= 60) return texts.window.validMinute;
  return fill(texts.window.validSeconds, { n: seconds });
}

export interface PairingViewProps {
  readonly platform: PairingPlatform;
  readonly texts?: PairingTexts;
  /** Horloge (ms Unix), injectée par les tests. */
  readonly now?: () => number;
  /** Case secrète (tests) ; par défaut, une case propre à l'instance. */
  readonly slot?: SecretSlot;
  /** Impression (tests) ; par défaut `window.print`. */
  readonly print?: () => void;
  /** Chargement du dessinateur de QR (tests) ; par défaut `qrcode-generator`, à la demande. */
  readonly loadQr?: () => Promise<QrFactory>;
  /** L'instance est en mode `import` (`pairingPayload` refusé en `wrong-mode`). */
  readonly onImportMode?: () => void;
}

const defaultLoadQr = async (): Promise<QrFactory> => (await import('qrcode-generator')).default;

type Load = { readonly kind: 'loading' } | { readonly kind: 'ready' } | { readonly kind: 'failed' } | { readonly kind: 'expired' } | { readonly kind: 'closed' };

/** Instance `show` : QR, clé de secours, minuteur, « Nouveau code », impression, fermeture. */
export function PairingView({ platform, texts = pairingTexts(), now = Date.now, slot: injected, print = () => window.print(), loadQr = defaultLoadQr, onImportMode }: PairingViewProps) {
  const [slot] = useState<SecretSlot>(() => injected ?? createSecretSlot());
  const secrets = useSyncExternalStore(slot.subscribe, slot.peek);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [qr, setQr] = useState<QrFactory | null>(null);
  const [nowMs, setNowMs] = useState(now);
  const [message, setMessage] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const requested = useRef(false);
  const closing = useRef(false);

  /** Fermeture (Annuler, Échap, expiration) : l'état est vidé avant que Rust détruise la fenêtre. */
  const close = useCallback(
    (kind: 'closed' | 'expired') => {
      slot.clear();
      setPrinting(false);
      setLoad({ kind });
      if (closing.current) return;
      closing.current = true;
      void platform.closePairing().catch(() => undefined);
    },
    [platform, slot],
  );

  const ref = useFocusTrap<HTMLElement>({ active: true, onEscape: () => close('closed') });

  // Un seul appel de `pairingPayload` par instance (le jeton de consentement est à usage unique).
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    platform.pairingPayload().then(
      (payload) => {
        slot.set({ qrText: payload.qrText, recoveryKey: payload.recoveryKey, expiresAt: payload.expiresAt });
        setNowMs(now());
        setLoad({ kind: 'ready' });
      },
      (error: unknown) => {
        if (syncErrorCodeOf(error) === 'wrong-mode') onImportMode?.();
        else setLoad({ kind: 'failed' });
      },
    );
  }, [platform, slot, now, onImportMode]);

  // Démontage : plus rien de sensible.
  useEffect(() => () => slot.clear(), [slot]);

  useEffect(() => {
    if (!secrets || qr) return;
    let cancelled = false;
    loadQr().then(
      (factory) => {
        if (!cancelled) setQr(() => factory);
      },
      () => {
        if (!cancelled) setLoad({ kind: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [secrets, qr, loadQr]);

  // Compte à rebours depuis `expiresAt` ; à l'échéance, état vidé puis fenêtre détruite.
  const expiresAt = secrets?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return;
    const tick = (): void => {
      const current = now();
      setNowMs(current);
      if (current >= expiresAt) close('expired');
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, now, close]);

  const drawn = useMemo(() => (qr && secrets ? qrPath(qr, secrets.qrText) : null), [qr, secrets]);

  const renew = async (): Promise<void> => {
    if (renewing) return;
    setRenewing(true);
    setMessage(null);
    try {
      const payload = await platform.pairingPayload({ renew: true });
      slot.set({ qrText: payload.qrText, recoveryKey: payload.recoveryKey, expiresAt: payload.expiresAt });
      setNowMs(now());
    } catch (error) {
      // D7 : l'ancien code reste affiché (il est toujours valable) jusqu'à son échéance.
      const code = syncErrorCodeOf(error);
      setMessage(code === 'consent-denied' ? texts.window.renewDenied : code === 'rate-limited' ? texts.window.renewRateLimited : texts.window.renewFailed);
    } finally {
      setRenewing(false);
    }
  };

  const confirmPrint = (): void => {
    print();
    setPrinting(false);
  };

  const [before, after] = texts.window.step1.split('{path}');
  let body: ReactNode;
  if (load.kind === 'loading' || (load.kind === 'ready' && !secrets)) {
    body = (
      <p className="ct-pair__status" role="status">
        {texts.window.loading}
      </p>
    );
  } else if (load.kind !== 'ready' || !secrets) {
    body = (
      <p className="ct-pair__status" role="status">
        {load.kind === 'expired' ? texts.window.expired : load.kind === 'failed' ? texts.window.loadFailed : null}
      </p>
    );
  } else {
    body = (
      <div className="ct-pair__columns">
        <div className="ct-pair__left">
          <p className="ct-pair__warning">{texts.window.warning}</p>
          <ol className="ct-pair__steps">
            <li>
              <span className="ct-pair__n" aria-hidden="true">
                1
              </span>
              <span>
                {before}
                <b>{texts.window.step1Path}</b>
                {after}
              </span>
            </li>
            <li>
              <span className="ct-pair__n" aria-hidden="true">
                2
              </span>
              <span>{texts.window.step2}</span>
            </li>
            <li>
              <span className="ct-pair__n" aria-hidden="true">
                3
              </span>
              <span>{texts.window.step3}</span>
            </li>
          </ol>
          <div className="ct-pair__spacer" />
          <div className="ct-pair__recovery">
            <span className="ct-pair__recoveryTitle">{texts.window.recoveryTitle}</span>
            <span className="ct-pair__recoveryKey" data-testid="pairing-recovery-key">
              {secrets.recoveryKey}
            </span>
            <span className="ct-pair__recoveryText">{texts.window.recoveryText}</span>
          </div>
          {printing && (
            <p className="ct-pair__printWarning" role="alert">
              {texts.window.printWarning}
            </p>
          )}
          <div className="ct-pair__actions">
            {printing ? (
              <Button variant="secondary" onClick={confirmPrint}>
                {texts.window.printConfirm}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setPrinting(true)}>
                {texts.window.print}
              </Button>
            )}
            <Button variant="secondary" className="ct-pair__cancel" ariaLabel={texts.window.cancelLabel} onClick={() => close('closed')}>
              {texts.window.cancel}
            </Button>
          </div>
        </div>
        <div className="ct-pair__right">
          <div className="ct-pair__qr">
            {drawn ? (
              <svg role="img" aria-label={texts.window.qrLabel} viewBox={`0 0 ${String(drawn.size)} ${String(drawn.size)}`} width={232} height={232} shapeRendering="crispEdges">
                <rect width={drawn.size} height={drawn.size} fill="#ffffff" />
                <path d={drawn.d} fill="#000000" />
              </svg>
            ) : (
              <span className="ct-pair__qrPlaceholder" />
            )}
          </div>
          <span className="ct-pair__waiting" role="status">
            <span className="ct-pair__dot" aria-hidden="true" />
            {texts.window.waiting}
          </span>
          <span className="ct-pair__validity">
            <span data-testid="pairing-validity">{validityText(texts, secrets.expiresAt - nowMs)}</span>
            {' · '}
            <button type="button" className="ct-pair__link" aria-label={texts.window.renewLabel} onClick={() => void renew()} disabled={renewing}>
              {renewing ? texts.window.renewing : texts.window.renew}
            </button>
          </span>
          <span className="ct-pair__noCapture">{texts.window.noCapture}</span>
          {message && (
            <p className="ct-pair__message" role="status">
              {message}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <main ref={ref} className="ct-pair" tabIndex={-1} aria-labelledby="ct-pair-title">
      <span className="ct-pair__section">{texts.window.section}</span>
      <h1 id="ct-pair-title" className="ct-pair__title">
        {texts.window.title}
      </h1>
      {body}
      {load.kind !== 'ready' && load.kind !== 'loading' && (
        <div className="ct-pair__actions">
          <Button variant="secondary" onClick={() => close(load.kind === 'expired' ? 'expired' : 'closed')}>
            {texts.window.close}
          </Button>
        </div>
      )}
      {printing && secrets && (
        <section className="ct-pair__sheet" aria-hidden="true">
          <p className="ct-pair__sheetTitle">{texts.window.printSheetTitle}</p>
          <p className="ct-pair__sheetKey">{secrets.recoveryKey}</p>
        </section>
      )}
    </main>
  );
}

/** Racine de la fenêtre : affichage du QR (`show`) ou saisie de la clé de secours (`import`), selon l'instance ouverte par Rust. */
export function PairingWindow({ platform, texts = pairingTexts(), now = Date.now }: { readonly platform: PairingPlatform; readonly texts?: PairingTexts; readonly now?: () => number }) {
  const [mode, setMode] = useState<'show' | 'import'>('show');
  const toImport = useCallback(() => setMode('import'), []);
  useEffect(() => {
    document.title = 'CircleTasks';
  }, []);
  if (mode === 'import') return <RecoveryKeyEntry platform={platform} texts={texts} now={now} closeAfterMs={PAIRING_VALIDITY_MS} />;
  return <PairingView platform={platform} texts={texts} now={now} onImportMode={toImport} />;
}

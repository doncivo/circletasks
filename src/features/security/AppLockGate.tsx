import { Component, lazy, Suspense, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { Button } from '../../ui';
import { useAppLockStore } from './appLockStore';
import { appReload, ensureLockLayer } from './lockLayer';
import './security.css';

// Écran de verrou chargé à la demande (iPhone verrouillé seulement ; bundle de départ, PERF-02). Le contenu est déjà masqué par le
// contrôleur pendant le chargement : rien n'est lisible entre-temps.
const LockScreen = lazy(() => import('./LockScreen').then((module) => ({ default: module.LockScreen })));

/**
 * Verrou statique (revue 3) : le code de l'écran de verrou n'a pas pu être chargé. L'app reste verrouillée, le message est annoncé et
 * « Réessayer » relance l'app (un import échoué ne se réessaie pas dans le même chargement de page).
 */
function StaticLock() {
  return createPortal(
    <main className="ct-lock" aria-labelledby="ct-lock-static-title">
      <h1 id="ct-lock-static-title" className="ct-lock__title">
        {t('security.lock.title')}
      </h1>
      <p className="ct-lock__message" role="alert">
        {t('security.lock.loadFailed')}
      </p>
      <div className="ct-lock__actions">
        <Button fullWidth onClick={() => appReload.run()}>
          {t('security.lock.retry')}
        </Button>
      </div>
    </main>,
    ensureLockLayer(),
  );
}

class LockScreenBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <StaticLock /> : this.props.children;
  }
}

/**
 * Porte du verrouillage (I-03, ADR 0013 §2.4, écart 2) au-dessus de la coquille :
 * - verrouillé au lancement : la coquille n'est PAS montée (aucune ligne dans le DOM), l'écran de verrou est le seul contenu ;
 * - verrouillé au retour : la coquille reste montée (écran, saisie en cours conservés) mais `hidden`, `inert` et `aria-hidden` ;
 *   raccourcis, bouton + et bandeau « Annuler » inactifs avec elle.
 * Le contrôleur (`startAppLock`) masque en plus tout le contenu de `body` par écriture DOM directe, dans le traitement qui verrouille.
 * Écran de verrou introuvable (chargement en échec) : verrou statique, jamais la coquille.
 */
export function AppLockGate({ children }: { readonly children: ReactNode }) {
  const phase = useAppLockStore((s) => s.phase);
  const shellReady = useAppLockStore((s) => s.shellReady);
  const locked = phase !== 'unlocked';
  const content = useRef<HTMLDivElement>(null);

  // `inert` n'est pas typé par React 18 : posé sur le DOM avant la peinture.
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    if (locked) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  }, [locked, shellReady]);

  return (
    <>
      {shellReady && (
        <div ref={content} className="ct-lock-content" data-testid="app-lock-content" hidden={locked} aria-hidden={locked ? true : undefined}>
          {children}
        </div>
      )}
      {phase === 'locked' && (
        <LockScreenBoundary>
          <Suspense fallback={null}>
            <LockScreen />
          </Suspense>
        </LockScreenBoundary>
      )}
    </>
  );
}

import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { logFailure } from '../../platform/desktop/log';
import { Button } from '../../ui';

/**
 * Y-TECH-05 : ligne du compte rendu du changement d'époque et son écran de détail, avec leurs textes (`SyncDetailsCarryReport`) : bloc à la
 * demande, importé quand les Détails de la synchro s'affichent, jamais au départ. Ce fichier remplace `lazyScreen` (qui rendrait
 * `lazyScreens.tsx`, un module du départ, dépendance d'un bloc à la demande : il quitterait le bloc principal et alourdirait le départ).
 * Même comportement : un échec de chargement montre le message de la frontière des écrans à la demande et « Réessayer » (un nouvel import,
 * puis une relance de la page si le second essai échoue aussi), jamais rien.
 */
type Loader = () => Promise<{ default: () => ReactNode }>;
const defaultLoad: Loader = () => import('./SyncDetailsCarryReport').then((m) => ({ default: m.SyncDetailsCarryReport }));

class Boundary extends Component<{ readonly onRetry: () => void; readonly reload: boolean; readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    logFailure('screen-load', error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="ct-settings__row" role="alert">
        <span>{t('app.screenError')}</span>
        <Button variant="secondary" onClick={this.props.reload ? () => window.location.reload() : this.props.onRetry}>
          {this.props.reload ? t('app.screenReload') : t('app.screenRetry')}
        </Button>
      </div>
    );
  }
}

/** `load` : chargeur du bloc (tests : échec de chargement simulé). */
export function SyncDetailsCarryReportHost({ load = defaultLoad }: { readonly load?: Loader }) {
  const [Lazy, setLazy] = useState(() => lazy(load));
  const [attempt, setAttempt] = useState(0);
  return (
    <Boundary
      key={attempt}
      reload={attempt >= 1}
      onRetry={() => {
        setLazy(() => lazy(load));
        setAttempt((n) => n + 1);
      }}
    >
      <Suspense fallback={null}>
        <Lazy />
      </Suspense>
    </Boundary>
  );
}

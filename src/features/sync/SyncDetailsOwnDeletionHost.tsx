import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { logFailure } from '../../platform/desktop/log';
import { Button } from '../../ui';

/** Y-IOS-02-FIX-01 : hote propre du signal de suppression, charge seulement en presence de cet etat. */
type Loader = () => Promise<{ default: () => ReactNode }>;
const defaultLoad: Loader = () => import('./SyncDetailsOwnDeletion').then((m) => ({ default: m.SyncDetailsOwnDeletion }));

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
export function SyncDetailsOwnDeletionHost({ load = defaultLoad }: { readonly load?: Loader }) {
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

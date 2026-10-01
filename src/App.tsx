import { useEffect } from 'react';
import { bootstrapDatabase } from './features/app/bootstrap';
import { useAppStore } from './features/app/appStore';
import { t } from './i18n';
import { useLayout } from './ui/useLayout';

/**
 * Coquille de l'app : aucun écran réel (PREP-02). Les onglets verticaux, la liste
 * Aujourd'hui et le panneau de détail PC arriveront avec les stories de l'ordre 1.
 */
export function App() {
  const layout = useLayout();
  const dbStatus = useAppStore((s) => s.dbStatus);

  useEffect(() => {
    if (useAppStore.getState().dbStatus === 'idle') void bootstrapDatabase();
  }, []);

  return (
    <div className="app-shell" data-layout={layout} data-db-status={dbStatus}>
      <h1>{t('app.name')}</h1>
      {dbStatus === 'loading' && <p role="status">{t('app.loading')}</p>}
      {dbStatus === 'error' && <p role="alert">{t('app.dbError')}</p>}
    </div>
  );
}

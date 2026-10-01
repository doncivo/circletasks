import type { ReactNode } from 'react';
import { useLayout } from './useLayout';
import './AppShell.css';

export interface AppShellProps {
  /** `<TabRail />` déjà composé par la feature (couleurs, onglet actif). */
  tabRail: ReactNode;
  /** Contenu de l'écran courant (Aujourd'hui, Semaine…). */
  children: ReactNode;
  /** `<DetailPanel />` ; affiché à droite sur PC seulement (≥ 1024 px), ignoré sur mobile. */
  detail?: ReactNode;
  /** Bouton d'ajout flottant (`<Fab />`), ancré en bas à droite au-dessus du contenu. */
  fab?: ReactNode;
  className?: string;
}

/**
 * Coquille d'écran (PRD section 5) : onglets + zone centrale, avec un panneau de
 * détail optionnel sur PC (≥ 1024 px). Sur iPhone, le détail se présente en
 * feuille (`Sheet`) rendue par la feature, hors de cette coquille.
 *
 * @example
 * <AppShell tabRail={<TabRail .../>} detail={detail && <DetailPanel .../>} fab={<Fab .../>}>
 *   <TodayScreen />
 * </AppShell>
 */
export function AppShell({ tabRail, children, detail, fab, className }: AppShellProps) {
  const layout = useLayout();
  return (
    <div className={['ct-app-shell', className].filter(Boolean).join(' ')} data-layout={layout}>
      {tabRail}
      <main className="ct-app-shell__main">{children}</main>
      {layout === 'pc' ? detail : null}
      {fab ? <div className="ct-app-shell__fab-slot">{fab}</div> : null}
    </div>
  );
}

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useLayout } from './useLayout';
import './AppShell.css';

/** Emplacement du panneau de détail PC (pleine hauteur, contre le bord droit) ; null hors coquille ou sur iPhone. */
const DetailSlotContext = createContext<HTMLElement | null>(null);

/**
 * Emplacement où la fiche détail PC se loge (`createPortal`) : à droite de la zone centrale, sans la marge de celle-ci
 * (PC-Aujourdhui.html). Null hors de la coquille (tests, iPhone) : la fiche se rend alors sur place.
 */
export function useDetailSlot(): HTMLElement | null {
  return useContext(DetailSlotContext);
}

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
 * Coquille d'écran (PRD section 5) : onglets + zone centrale, avec un panneau de détail optionnel sur PC (≥ 1024 px). Sur iPhone,
 * le détail se présente en feuille (`Sheet`) rendue par la feature, hors de cette coquille.
 *
 * @example
 * <AppShell tabRail={<TabRail .../>} detail={detail && <DetailPanel .../>} fab={<Fab .../>}>
 *   <TodayScreen />
 * </AppShell>
 */
export function AppShell({ tabRail, children, detail, fab, className }: AppShellProps) {
  const layout = useLayout();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <div className={['ct-app-shell', className].filter(Boolean).join(' ')} data-layout={layout}>
      {tabRail}
      <DetailSlotContext.Provider value={layout === 'pc' ? slot : null}>
        <main className="ct-app-shell__main">{children}</main>
      </DetailSlotContext.Provider>
      {layout === 'pc' ? (
        <div ref={setSlot} className="ct-app-shell__detail">
          {detail}
        </div>
      ) : null}
      {fab ? <div className="ct-app-shell__fab-slot">{fab}</div> : null}
    </div>
  );
}

import { Search } from 'lucide-react';
import { t } from '../../i18n';
import { Icon, Kbd, useLayout } from '../../ui';
import { useNavigationStore } from '../app/navigation';
import './SearchOverlay.css';

/**
 * Accès à la recherche depuis l'en-tête d'Aujourd'hui (RC-01 critère 2) : loupe de 44 pt sur iPhone (Main.html), champ
 * « Rechercher  Ctrl K » sur PC (PC-Aujourdhui.html). Ouvre la surcouche de recherche ; le focus lui revient à la fermeture.
 */
export function SearchButton({ iconClassName }: { readonly iconClassName?: string }) {
  const layout = useLayout();
  const openOverlay = useNavigationStore((s) => s.openOverlay);
  const open = (): void => openOverlay({ kind: 'search' });
  if (layout === 'pc') {
    return (
      <button type="button" className="ct-search-field-button" aria-label={t('search.open')} aria-keyshortcuts="Control+K" onClick={open}>
        <Icon icon={Search} size={18} />
        {t('search.open')}
        <Kbd keys="Ctrl+K" separator=" " className="ct-search-field-button__kbd" />
      </button>
    );
  }
  return (
    <button type="button" className={iconClassName} aria-label={t('search.open')} onClick={open}>
      <Icon icon={Search} size={26} />
    </button>
  );
}

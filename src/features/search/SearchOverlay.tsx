import { Search } from 'lucide-react';
import { useEffect } from 'react';
import { t } from '../../i18n';
import { Icon, Kbd, useFocusTrap, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { SearchGroups } from './SearchResults';
import { SEARCH_INPUT_ID } from './searchShortcut';
import { searchStore } from './searchStore';
import './SearchOverlay.css';


/**
 * Surcouche de recherche (M14) : écran plein sur iPhone (Recherche.html), palette centrée sur PC. Montée par la coquille quand la
 * surcouche `search` est au sommet de la pile de navigation ; Échap et « Annuler » la ferment, le focus revient à l'élément qui l'avait
 * ouverte (piège de focus, PRD section 5).
 */
export function SearchOverlay() {
  const open = useNavigationStore((s) => s.overlays.at(-1)?.kind === 'search');
  return open ? <SearchSurface /> : null;
}

function SearchSurface() {
  const container = useAppContainer();
  const layout = useLayout();
  const closeOverlay = useNavigationStore((s) => s.closeOverlay);
  const spaces = useAppStore((s) => s.spaces);
  const query = useFeatureStore(searchStore, (s) => s.query);
  const status = useFeatureStore(searchStore, (s) => s.status);
  const outcome = useFeatureStore(searchStore, (s) => s.outcome);
  const errorKey = useFeatureStore(searchStore, (s) => s.errorKey);
  const ref = useFocusTrap<HTMLElement>({ active: true, onEscape: closeOverlay });

  // Ouverture : champ vide, espace du filtre global (RC-01 critère 10) ; fermeture : état remis à zéro.
  useEffect(() => {
    const store = searchStore.get(container).getState();
    void store.open(useAppStore.getState().spaceFilter);
    return () => store.reset();
  }, [container]);

  const count = outcome?.results.length ?? 0;
  const showResults = status === 'ready' && outcome !== null;

  const panel = (
    <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('search.dialogLabel')} className="ct-search" data-layout={layout}>
      <div className="ct-search__bar">
        <div className="ct-search__field">
          <Icon icon={Search} size={22} />
          <input
            id={SEARCH_INPUT_ID}
            className="ct-search__input"
            type="search"
            aria-label={t('search.fieldLabel')}
            value={query}
            placeholder={t('search.placeholder')}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => void searchStore.get(container).getState().setQuery(event.target.value)}
          />
          {layout === 'pc' && <Kbd keys="Escape" />}
        </div>
        {layout === 'mobile' && (
          <button type="button" className="ct-search__cancel" onClick={closeOverlay}>
            {t('search.cancel')}
          </button>
        )}
      </div>

      <div className="ct-search__body">
        {/* Zone annoncée aux lecteurs d'écran (« 5 résultats ») : ni role="status", réservé au bandeau « Annuler ». */}
        <p className="ct-search__count" aria-live="polite" aria-atomic="true">
          {status === 'too-short'
            ? t('search.tooShort')
            : showResults
              ? count === 0
                ? t('search.noResult', { query: outcome.text })
                : count === 1
                  ? t('search.countOne')
                  : t('search.count', { count })
              : ''}
        </p>
        {status === 'error' && errorKey && (
          <p className="ct-search__error" role="alert">
            {t(errorKey)}
          </p>
        )}
        {showResults && count > 0 && <SearchGroups results={outcome.results} spaces={spaces} />}
        {showResults && outcome.truncated && <p className="ct-search__hint">{t('search.tooMany')}</p>}
      </div>
    </section>
  );

  if (layout === 'mobile') return panel;
  return (
    <div
      className="ct-search__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeOverlay();
      }}
    >
      {panel}
    </div>
  );
}

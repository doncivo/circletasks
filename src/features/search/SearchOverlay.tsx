import { Search } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SearchResult } from '../../domain/search';
import { t } from '../../i18n';
import { Icon, Kbd, useFocusTrap, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { RecentSearches } from './RecentSearches';
import { SearchFilterBar } from './SearchFilterBar';
import { SearchGroups, rowDomId } from './SearchResults';
import { openSearchResult, type OpenOutcome } from './searchOpen';
import { SEARCH_INPUT_ID } from './searchShortcut';
import { searchStore } from './searchStore';
import { useSearchSelection } from './useSearchSelection';
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
  const recent = useFeatureStore(searchStore, (s) => s.recent);
  const ref = useFocusTrap<HTMLElement>({ active: true, onEscape: closeOverlay });
  const selection = useSearchSelection(outcome?.results ?? []);
  /** Échec de l'ouverture du dernier résultat touché : élément supprimé entre-temps, ou base muette. */
  const [openProblem, setOpenProblem] = useState<Exclude<OpenOutcome, 'opened'> | null>(null);
  /** Ouverture en cours : un second Entrée ou clic est ignoré. */
  const opening = useRef(false);

  // Ouverture : champ vide, espace du filtre global (RC-01 critère 10) ; fermeture : état remis à zéro.
  useEffect(() => {
    const store = searchStore.get(container).getState();
    void store.open(useAppStore.getState().spaceFilter);
    return () => store.reset();
  }, [container]);

  // La ligne sélectionnée reste visible quand la sélection bouge (critère 1).
  const selectedKey = selection.selected?.key ?? null;
  useEffect(() => {
    if (selection.selected) document.getElementById(rowDomId(selection.selected))?.scrollIntoView?.({ block: 'nearest' });
  }, [selection.selected]);

  async function open(result: SearchResult, inTab: boolean): Promise<void> {
    if (opening.current) return;
    opening.current = true;
    try {
      // RC-04 critère 3 : ouvrir un résultat mémorise la recherche.
      void searchStore.get(container).getState().recordQuery();
      const outcomeOfOpen = await openSearchResult(container, result, { inTab });
      if (outcomeOfOpen === 'opened') closeOverlay();
      else setOpenProblem(outcomeOfOpen);
    } finally {
      opening.current = false;
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selection.move(event.key === 'ArrowDown' ? 'next' : 'previous');
    } else if ((event.key === 'Home' || event.key === 'End') && event.ctrlKey) {
      // Dans le champ, Début / Fin déplacent le curseur : Ctrl+Début / Ctrl+Fin vont au premier / dernier résultat.
      event.preventDefault();
      selection.move(event.key === 'Home' ? 'first' : 'last');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (selection.selected) void open(selection.selected, event.ctrlKey);
      // RC-04 critère 3 : Entrée avec 2 caractères au moins mémorise la recherche (même sans résultat).
      else void searchStore.get(container).getState().recordQuery();
    }
  }

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
            {...(showResults && count > 0 && selection.selected ? { 'aria-activedescendant': rowDomId(selection.selected) } : {})}
            value={query}
            placeholder={t('search.placeholder')}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => {
              setOpenProblem(null);
              void searchStore.get(container).getState().setQuery(event.target.value);
            }}
            onKeyDown={handleInputKeyDown}
          />
          {layout === 'pc' && <Kbd keys="Escape" />}
        </div>
        {layout === 'mobile' && (
          <button type="button" className="ct-search__cancel" onClick={closeOverlay}>
            {t('search.cancel')}
          </button>
        )}
      </div>

      <SearchFilterBar />

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
        {openProblem && (
          <p className="ct-search__error" role="alert">
            {t(openProblem === 'missing' ? 'search.missing' : 'search.openError')}
          </p>
        )}
        {showResults && count > 0 && (
          <SearchGroups
            results={outcome.results}
            spaces={spaces}
            selectedKey={selectedKey}
            onSelect={selection.select}
            onOpen={(result, inTab) => void open(result, inTab)}
            onMove={selection.move}
          />
        )}
        {showResults && outcome.truncated && <p className="ct-search__hint">{t('search.tooMany')}</p>}
        {status === 'idle' && (
          <RecentSearches
            recent={recent}
            onPick={(text) => {
              void searchStore.get(container).getState().setQuery(text);
              document.getElementById(SEARCH_INPUT_ID)?.focus();
            }}
            onRemove={(text) => void searchStore.get(container).getState().removeRecent(text)}
            onClear={() => void searchStore.get(container).getState().clearRecent()}
          />
        )}
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

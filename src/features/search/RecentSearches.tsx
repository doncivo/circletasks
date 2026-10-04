import { X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { t } from '../../i18n';
import { Icon } from '../../ui';

export interface RecentSearchesProps {
  /** Recherches récentes, la plus récente en premier. */
  readonly recent: readonly string[];
  /** Toucher une puce : le champ prend ce texte et les résultats s'affichent (critère 2). */
  readonly onPick: (query: string) => void;
  /** Croix d'une puce, ou Suppr sur la puce (critère 5). */
  readonly onRemove: (query: string) => void;
  /** « Effacer » : vide la liste, avec un message « Annuler » de 5 s (critère 5). */
  readonly onClear: () => void;
}

/**
 * Section « Recherches récentes » du champ vide (Recherche.html, RC-04) : puces #F3F1F6, une croix par puce, « Effacer » à côté du titre
 * (ajouts à la maquette, qui ne dessine aucun bouton d'effacement). Sans historique, la section est absente. Au clavier : Tab, Entrée
 * pour reprendre une recherche, Suppr pour la retirer (le focus passe à la puce voisine, ou au champ s'il n'en reste aucune).
 */
export function RecentSearches({ recent, onPick, onRemove, onClear }: RecentSearchesProps) {
  if (recent.length === 0) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, query: string, index: number): void {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    onRemove(query);
    // Le focus ne doit pas tomber sur le corps de la page : la puce suivante (ou précédente) le reçoit, sinon le champ de recherche.
    const next = recent[index + 1] ?? recent[index - 1];
    requestAnimationFrame(() => {
      const target =
        next === undefined ? document.querySelector<HTMLElement>('.ct-search__input') : Array.from(document.querySelectorAll<HTMLElement>('[data-recent]')).find((chip) => chip.dataset['recent'] === next);
      target?.focus();
    });
  }

  return (
    <section className="ct-search__recent" aria-labelledby="ct-search-recent-title">
      <div className="ct-search__recentHeader">
        <h2 id="ct-search-recent-title" className="ct-search__groupTitle">
          {t('search.recent.title')}
        </h2>
        <button type="button" className="ct-search__recentClear" aria-label={t('search.recent.clearLabel')} onClick={onClear}>
          {t('search.recent.clear')}
        </button>
      </div>
      <ul className="ct-search__recentList">
        {recent.map((query, index) => (
          <li key={query} className="ct-search__recentChip">
            <button
              type="button"
              className="ct-search__recentPick"
              data-recent={query}
              aria-label={t('search.recent.chip', { query })}
              onClick={() => onPick(query)}
              onKeyDown={(event) => handleKeyDown(event, query, index)}
            >
              {query}
            </button>
            <button type="button" className="ct-search__recentRemove" aria-label={t('search.recent.remove', { query })} onClick={() => onRemove(query)}>
              <Icon icon={X} size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { Calendar, ClipboardList, FileText, Repeat, Target, type LucideIcon } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { Space } from '../../domain/model';
import { groupSearchResults, type SearchKind, type SearchResult, type TextSegment } from '../../domain/search';
import { t } from '../../i18n';
import { Icon, IconView, spaceTextColor } from '../../ui';
import { resultLabel, subtitleParts } from './searchRowText';
import type { SelectionMove } from './useSearchSelection';

/** Icône et couleur par défaut de chaque type (Recherche.html : fiche rouge, liste ochre, calendrier bleu). */
const KIND_ICON: Readonly<Record<SearchKind, { readonly icon: LucideIcon; readonly color: string }>> = {
  task: { icon: FileText, color: 'var(--ct-color-icon-red)' },
  checklist: { icon: ClipboardList, color: 'var(--ct-color-icon-amber)' },
  event: { icon: Calendar, color: 'var(--ct-color-icon-blue)' },
  routine: { icon: Repeat, color: 'var(--ct-color-icon-green)' },
  goal: { icon: Target, color: 'var(--ct-color-goal)' },
};

/** Texte avec les mots trouvés surlignés (`<mark>`, #FDE9A8). */
export function Highlighted({ segments }: { readonly segments: readonly TextSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="ct-search__hl">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

type RowSpaces = readonly Pick<Space, 'id' | 'name' | 'color'>[];

/** « Note : « contester la <mark>facture</mark> » » : le libellé encadre l'extrait surligné. */
function CitationText({ result }: { readonly result: SearchResult }) {
  if (!result.citation) return null;
  const [before = '', after = ''] = t(result.citation.source === 'note' ? 'search.citeNote' : 'search.citeItem', { text: '\u0000' }).split('\u0000');
  return (
    <>
      {before}
      <Highlighted segments={result.citation.segments} />
      {after}
    </>
  );
}

/** Contenu d'une ligne : icône, titre surligné, sous-ligne (citation, date, espace coloré, état). */
export function SearchResultContent({ result, spaces }: { readonly result: SearchResult; readonly spaces: RowSpaces }) {
  const { hit } = result;
  const kind = KIND_ICON[hit.kind];
  const parts = subtitleParts(result, spaces);
  return (
    <>
      <span className="ct-search__resultIcon" aria-hidden="true">
        {hit.icon ? <IconView icon={hit.icon} size={24} color={kind.color} /> : <Icon icon={kind.icon} size={24} color={kind.color} />}
      </span>
      <span className="ct-search__resultText">
        <span className="ct-search__resultTitle" data-muted={hit.status === 'done' ? 'true' : undefined}>
          <Highlighted segments={result.titleSegments} />
        </span>
        {parts.length > 0 && (
          <span className="ct-search__resultSub">
            {parts.map((part, index) => (
              <span key={part.key}>
                {index > 0 ? ' · ' : ''}
                {part.citation && result.citation ? (
                  <CitationText result={result} />
                ) : part.spaceColor ? (
                  <span className="ct-search__space" style={{ color: spaceTextColor(part.spaceColor) }}>
                    {part.text}
                  </span>
                ) : (
                  part.text
                )}
              </span>
            ))}
          </span>
        )}
      </span>
    </>
  );
}

/** Identifiant DOM d'une ligne (aria-activedescendant du champ, focus au clavier). */
export const rowDomId = (result: SearchResult): string => `ct-search-row-${result.hit.kind}-${result.hit.id}`;

export interface SearchGroupsProps {
  readonly results: readonly SearchResult[];
  readonly spaces: RowSpaces;
  /** Clé de la ligne sélectionnée (surlignée, seule dans l'ordre de tabulation). */
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
  /** Ouvre la ligne ; `inTab` : Ctrl+Entrée (PC). */
  readonly onOpen: (result: SearchResult, inTab: boolean) => void;
  /** Flèches, Début et Fin dans la liste : le parent déplace la sélection et rend la nouvelle ligne sélectionnée (null : aucune). */
  readonly onMove: (move: SelectionMove) => SearchResult | null;
}

const MOVE_OF_KEY: Readonly<Record<string, SelectionMove>> = { ArrowDown: 'next', ArrowUp: 'previous', Home: 'first', End: 'last' };

/**
 * Résultats groupés par type, chaque en-tête avec son nombre (« TÂCHES · 3 »). Chaque ligne est un bouton d'au moins 44 pt au nom
 * complet (« Tâche, Envoyer la facture, mer. 23 sept., Pro, à faire »). La ligne sélectionnée est la seule dans l'ordre de tabulation
 * (Tab : champ, puces, liste) ; ↑ / ↓ / Début / Fin y déplacent le focus, Entrée ouvre, Ctrl+Entrée ouvre dans l'onglet.
 */
export function SearchGroups({ results, spaces, selectedKey, onSelect, onOpen, onMove }: SearchGroupsProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, result: SearchResult): void {
    const move = MOVE_OF_KEY[event.key];
    if (move) {
      event.preventDefault();
      const target = onMove(move);
      if (target) document.getElementById(rowDomId(target))?.focus();
      return;
    }
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      onOpen(result, true);
    }
  }

  return (
    <div role="region" aria-label={t('search.listLabel')}>
      {groupSearchResults(results).map((group) => {
        const title = t('search.group', { type: t(`search.groups.${group.kind}`), count: group.results.length });
        return (
          <section key={group.kind} className="ct-search__group" aria-labelledby={`ct-search-group-${group.kind}`}>
            <h2 id={`ct-search-group-${group.kind}`} className="ct-search__groupTitle">
              {title}
            </h2>
            <ul className="ct-search__list">
              {group.results.map((result) => (
                <li key={result.key}>
                  <button
                    type="button"
                    id={rowDomId(result)}
                    className="ct-search__result"
                    data-kind={result.hit.kind}
                    data-selected={selectedKey === result.key ? 'true' : 'false'}
                    tabIndex={selectedKey === result.key ? 0 : -1}
                    aria-label={resultLabel(result, spaces)}
                    onFocus={() => onSelect(result.key)}
                    onClick={() => onOpen(result, false)}
                    onKeyDown={(event) => handleKeyDown(event, result)}
                  >
                    <SearchResultContent result={result} spaces={spaces} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

import { Calendar, ClipboardList, FileText, Repeat, Target, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import type { Space } from '../../domain/model';
import { groupSearchResults, type SearchKind, type SearchResult, type TextSegment } from '../../domain/search';
import { t } from '../../i18n';
import { Icon, IconView, spaceTextColor } from '../../ui';
import { resultLabel, subtitleParts, type SubtitlePart } from './searchRowText';
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
export function SearchResultContent({ result, spaces, parts: given }: { readonly result: SearchResult; readonly spaces: RowSpaces; readonly parts?: readonly SubtitlePart[] }) {
  const { hit } = result;
  const kind = KIND_ICON[hit.kind];
  const parts = given ?? subtitleParts(result, spaces);
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

interface SearchRowProps {
  readonly result: SearchResult;
  readonly spaces: RowSpaces;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
  readonly onOpen: (result: SearchResult, inTab: boolean) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, result: SearchResult) => void;
}

/**
 * Une ligne de résultat, mémoïsée : elle ne se redessine que si son résultat, les espaces ou sa sélection changent. Sous-ligne et nom
 * accessible sont calculés une fois par résultat, pas à chaque rendu de la liste (RC-02 critère 8, budget 200 ms).
 */
const SearchRow = memo(function SearchRow({ result, spaces, selected, onSelect, onOpen, onKeyDown }: SearchRowProps) {
  const parts = useMemo(() => subtitleParts(result, spaces), [result, spaces]);
  const label = useMemo(() => resultLabel(result, spaces, parts), [result, spaces, parts]);
  return (
    <li>
      <button
        type="button"
        id={rowDomId(result)}
        className="ct-search__result"
        data-kind={result.hit.kind}
        data-selected={selected ? 'true' : 'false'}
        tabIndex={selected ? 0 : -1}
        aria-label={label}
        onFocus={() => onSelect(result.key)}
        onClick={() => onOpen(result, false)}
        onKeyDown={(event) => onKeyDown(event, result)}
      >
        <SearchResultContent result={result} spaces={spaces} parts={parts} />
      </button>
    </li>
  );
});

/**
 * Résultats groupés par type, chaque en-tête avec son nombre (« TÂCHES · 3 »). Chaque ligne est un bouton d'au moins 44 pt au nom
 * complet (« Tâche, Envoyer la facture, mer. 23 sept., Pro, à faire »). La ligne sélectionnée est la seule dans l'ordre de tabulation
 * (Tab : champ, puces, liste) ; ↑ / ↓ / Début / Fin y déplacent le focus, Entrée ouvre, Ctrl+Entrée ouvre dans l'onglet.
 */
export function SearchGroups({ results, spaces, selectedKey, onSelect, onOpen, onMove }: SearchGroupsProps) {
  // Les rappels du parent changent à chaque rendu : les lignes mémoïsées reçoivent des fonctions stables qui appellent la dernière version.
  const latest = useRef({ onOpen, onMove });
  useLayoutEffect(() => {
    latest.current = { onOpen, onMove };
  });
  const stableOpen = useCallback((result: SearchResult, inTab: boolean) => latest.current.onOpen(result, inTab), []);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, result: SearchResult): void => {
    const move = MOVE_OF_KEY[event.key];
    if (move) {
      event.preventDefault();
      const target = latest.current.onMove(move);
      if (target) document.getElementById(rowDomId(target))?.focus();
      return;
    }
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      latest.current.onOpen(result, true);
    }
  }, []);
  const groups = useMemo(() => groupSearchResults(results), [results]);

  return (
    <div role="region" aria-label={t('search.listLabel')}>
      {groups.map((group) => {
        const title = t('search.group', { type: t(`search.groups.${group.kind}`), count: group.results.length });
        return (
          <section key={group.kind} className="ct-search__group" aria-labelledby={`ct-search-group-${group.kind}`}>
            <h2 id={`ct-search-group-${group.kind}`} className="ct-search__groupTitle">
              {title}
            </h2>
            <ul className="ct-search__list">
              {group.results.map((result) => (
                <SearchRow key={result.key} result={result} spaces={spaces} selected={selectedKey === result.key} onSelect={onSelect} onOpen={stableOpen} onKeyDown={handleKeyDown} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

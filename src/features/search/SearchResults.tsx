import { Calendar, ClipboardList, FileText, Repeat, Target, type LucideIcon } from 'lucide-react';
import type { Space } from '../../domain/model';
import { groupSearchResults, type SearchKind, type SearchResult, type TextSegment } from '../../domain/search';
import { t } from '../../i18n';
import { Icon, IconView, spaceTextColor } from '../../ui';
import { subtitleParts } from './searchRowText';

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

export interface SearchResultRowProps {
  readonly result: SearchResult;
  readonly spaces: readonly Pick<Space, 'id' | 'name' | 'color'>[];
}

/** Contenu d'une ligne : icône, titre surligné, sous-ligne (citation, date, espace coloré, état). */
export function SearchResultContent({ result, spaces }: SearchResultRowProps) {
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

export interface SearchGroupsProps {
  readonly results: readonly SearchResult[];
  readonly spaces: readonly Pick<Space, 'id' | 'name' | 'color'>[];
}

/** Résultats groupés par type, chaque en-tête avec son nombre (« TÂCHES · 3 »). */
export function SearchGroups({ results, spaces }: SearchGroupsProps) {
  return (
    <div role="region" aria-label={t('search.listLabel')}>
      {groupSearchResults(results).map((group) => {
        const title = t('search.group', { type: t(`search.groups.${group.kind}`), count: group.results.length });
        return (
          <section key={group.kind} className="ct-search__group" aria-labelledby={`ct-search-group-${group.kind}`}>
            <h2 id={`ct-search-group-${group.kind}`} className="ct-search__groupTitle">{title}</h2>
            <ul className="ct-search__list">
              {group.results.map((result) => (
                <li key={result.key}>
                  <div className="ct-search__result" data-kind={result.hit.kind}>
                    <SearchResultContent result={result} spaces={spaces} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

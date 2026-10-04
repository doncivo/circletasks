import { useMemo, useState } from 'react';
import { t } from '../../i18n';
import { Button, useFocusTrap } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { buildHelpGroups } from '../app/shortcutsHelp';
import { quickCaptureStore } from './quickCaptureStore';
import './ShortcutsHelp.css';

/**
 * Fenêtre « Raccourcis clavier » (P-08), ouverte par Ctrl+/ depuis n'importe quel écran. Montée par la coquille quand la
 * surcouche `shortcutsHelp` est au sommet de la pile. PC seulement : le raccourci n'est enregistré que par la coquille PC.
 */
export function ShortcutsHelp() {
  const open = useNavigationStore((s) => s.overlays.at(-1)?.kind === 'shortcutsHelp');
  return open ? <ShortcutsHelpDialog /> : null;
}

function ShortcutsHelpDialog() {
  const container = useAppContainer();
  const closeOverlay = useNavigationStore((s) => s.closeOverlay);
  const quickKeys = useFeatureStore(quickCaptureStore, (s) => s.keys);
  const quickStatus = useFeatureStore(quickCaptureStore, (s) => s.status);
  const [query, setQuery] = useState('');
  // Raccourcis ayant un gestionnaire à l'ouverture : ceux de l'écran courant (la fenêtre n'en ajoute pas pour ces portées).
  const activeIds = useMemo(() => container.shortcuts.activeIds(), [container]);
  const ref = useFocusTrap<HTMLElement>({ active: true, onEscape: closeOverlay });
  const groups = buildHelpGroups({ quickCapture: { keys: quickKeys, state: quickStatus }, activeIds, query });

  return (
    <div className="ct-shortcuts__backdrop">
      <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="ct-shortcuts-title" className="ct-shortcuts">
        <header className="ct-shortcuts__header">
          <h2 id="ct-shortcuts-title" className="ct-shortcuts__title">
            {t('shortcutsUi.title')}
          </h2>
          <Button variant="secondary" onClick={closeOverlay}>
            {t('common.close')}
          </Button>
        </header>
        <input
          type="search"
          className="ct-shortcuts__filter"
          aria-label={t('shortcutsUi.filterLabel')}
          placeholder={t('shortcutsUi.filterPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {/* Zone défilante atteignable au clavier (Tab, puis ↑ ↓ Page ↑ Page ↓ défilent sans souris). */}
        <div className="ct-shortcuts__scroll" tabIndex={0} role="region" aria-label={t('shortcutsUi.tableLabel')}>
          {groups.length === 0 ? (
            <p className="ct-shortcuts__empty" role="status">
              {t('shortcutsUi.empty')}
            </p>
          ) : (
            <table className="ct-shortcuts__table">
              <caption className="ct-shortcuts__srOnly">{t('shortcutsUi.tableLabel')}</caption>
              <thead className="ct-shortcuts__srOnly">
                <tr>
                  <th scope="col">{t('shortcutsUi.colKeys')}</th>
                  <th scope="col">{t('shortcutsUi.colAction')}</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.scope} data-scope={group.scope}>
                  <tr>
                    <th scope="colgroup" colSpan={2} className="ct-shortcuts__group">
                      {group.label}
                    </th>
                  </tr>
                  {group.entries.map((entry) => (
                    <tr key={entry.id} className="ct-shortcuts__row" data-dimmed={entry.dimmed || undefined} data-shortcut={entry.id}>
                      <td className="ct-shortcuts__keys">
                        <kbd className="ct-kbd">
                          <span aria-hidden="true">{entry.keys}</span>
                          <span className="ct-shortcuts__srOnly">{entry.spoken}</span>
                        </kbd>
                      </td>
                      <td>
                        {entry.description}
                        {entry.note && <span className="ct-shortcuts__note"> {entry.note}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

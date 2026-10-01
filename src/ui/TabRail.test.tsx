import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TabRail, type TabRailItem } from './TabRail';

const items: TabRailItem[] = [
  { id: 'tasks', labelKey: 'nav.tabs.tasks', colorVar: '--ct-color-tab-tasks' },
  { id: 'week', labelKey: 'nav.tabs.week', colorVar: '--ct-color-tab-week' },
];
const settingsItem: TabRailItem = { id: 'settings', labelKey: 'nav.tabs.settings', colorVar: '--ct-color-tab-settings' };

describe('TabRail', () => {
  it('marque l’onglet actif avec aria-current', () => {
    render(<TabRail items={items} settingsItem={settingsItem} activeId="week" onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Semaine' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Tâches' })).not.toHaveAttribute('aria-current');
  });

  it('place Réglages à part (dernier onglet)', () => {
    render(<TabRail items={items} settingsItem={settingsItem} activeId="tasks" onSelect={() => undefined} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.at(-1)).toHaveTextContent('Réglages');
  });

  it('appelle onSelect au clic', () => {
    const onSelect = vi.fn();
    render(<TabRail items={items} settingsItem={settingsItem} activeId="tasks" onSelect={onSelect} />);
    screen.getByRole('button', { name: 'Semaine' }).click();
    expect(onSelect).toHaveBeenCalledWith('week');
  });

  it('se déplace au clavier avec les flèches', () => {
    render(<TabRail items={items} settingsItem={settingsItem} activeId="tasks" onSelect={() => undefined} />);
    const tasks = screen.getByRole('button', { name: 'Tâches' });
    tasks.focus();
    tasks.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(screen.getByRole('button', { name: 'Semaine' })).toHaveFocus();
  });

  it('porte un nom de navigation accessible', () => {
    render(<TabRail items={items} settingsItem={settingsItem} activeId="tasks" onSelect={() => undefined} />);
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();
  });
});

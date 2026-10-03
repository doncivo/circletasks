import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChecklistId } from '../../domain/types';
import { mockViewport, renderChecklists, seedChecklist, setupChecklists, teardownChecklists, type ChecklistsHarness } from './testKit';

const valise = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', ['Passeport', true], ['Chargeur', true], ['Billets d’avion', true]] as const;

const check = (text: string, checked = false) => screen.getByRole('button', { name: `${checked ? 'Décocher' : 'Cocher'} : ${text}` });
const rowTexts = (): string[] => Array.from(document.querySelectorAll('.ct-checklist-item__text')).map((node) => node.textContent ?? '');
const stored = async (h: ChecklistsHarness, id: string) => (await h.container.data.repos.checklistItems.listForChecklist(id as ChecklistId)).map((item) => [item.text, item.checked]);

describe('Checklists : cocher et progression (C-02), iPhone', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('311');
    mockViewport(440);
  });
  afterEach(() => teardownChecklists(h));

  it('« 3 / 6 », barre à 50 % (critère 1)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: valise });
    renderChecklists(h.container);
    expect(await screen.findByText('3 / 6')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Progression : 3 sur 6' });
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemax', '6');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('50%');
    expect(screen.getByRole('status')).toHaveTextContent('3 / 6');
  });

  it('cocher met à jour « 4 / 6 », la barre et le barré sans recharger ; une nouvelle touche décoche (critère 2)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: valise });
    renderChecklists(h.container);
    await screen.findByText('3 / 6');
    expect(check('Chargeur', true)).toHaveAttribute('aria-pressed', 'true');
    expect(check('Crème solaire')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(check('Crème solaire'));
    expect(await screen.findByText('4 / 6')).toBeInTheDocument();
    expect(check('Crème solaire', true)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Modifier : Crème solaire' })).toHaveAttribute('data-checked', 'true');
    expect((screen.getByRole('progressbar').firstElementChild as HTMLElement).style.width).toBe('67%');
    await waitFor(async () => expect((await stored(h, checklist.id)).find(([text]) => text === 'Crème solaire')?.[1]).toBe(true));

    fireEvent.click(check('Crème solaire', true));
    expect(await screen.findByText('3 / 6')).toBeInTheDocument();
    await waitFor(async () => expect((await stored(h, checklist.id)).find(([text]) => text === 'Crème solaire')?.[1]).toBe(false));
  });

  it('deux touches rapides : l’état final est celui du dernier geste (critère 3)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport', 'Chargeur'] });
    renderChecklists(h.container);
    await screen.findByText('0 / 2');
    const button = check('Passeport');
    fireEvent.click(button);
    fireEvent.click(check('Passeport', true));
    await waitFor(async () => expect((await stored(h, checklist.id)).find(([text]) => text === 'Passeport')?.[1]).toBe(false));
    expect(screen.getByText('0 / 2')).toBeInTheDocument();

    fireEvent.click(check('Passeport'));
    fireEvent.click(check('Passeport', true));
    fireEvent.click(check('Passeport'));
    await waitFor(async () => expect((await stored(h, checklist.id)).find(([text]) => text === 'Passeport')?.[1]).toBe(true));
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeInTheDocument());
  });

  it('les items cochés restent à leur place (critère 4)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: ['A', 'B', 'C'] });
    renderChecklists(h.container);
    await screen.findByText('0 / 3');
    fireEvent.click(check('B'));
    await screen.findByText('1 / 3');
    fireEvent.click(check('A'));
    await screen.findByText('2 / 3');
    expect(rowTexts()).toEqual(['A', 'B', 'C']);
  });

  it('sans item : « 0 / 0 » et barre masquée ; tout coché : « 6 / 6 » et barre pleine (critère 6)', async () => {
    await seedChecklist(h, { title: 'Vide' });
    await seedChecklist(h, { title: 'Pleine', items: [['a', true], ['b', true]] });
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Pleine' });
    await screen.findByText('2 / 2');
    expect((screen.getByRole('progressbar').firstElementChild as HTMLElement).style.width).toBe('100%');
    const empty = (await h.container.data.repos.checklists.listSummaries('all')).find((s) => s.checklist.title === 'Vide');
    fireEvent.change(screen.getByRole('combobox', { name: 'Choisir une checklist' }), { target: { value: empty?.checklist.id } });
    await screen.findByText('0 / 0');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('aucun message « Annuler » au cochage (décision D2)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport'] });
    renderChecklists(h.container);
    await screen.findByText('0 / 1');
    fireEvent.click(check('Passeport'));
    await screen.findByText('1 / 1');
    expect(screen.queryByRole('button', { name: 'Annuler' })).toBeNull();
  });

  it('l’état coché est conservé après fermeture et réouverture (critère 8)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport', 'Chargeur'] });
    const first = renderChecklists(h.container);
    await screen.findByText('0 / 2');
    fireEvent.click(check('Chargeur'));
    await screen.findByText('1 / 2');
    await waitFor(async () => expect(await stored(h, (await h.container.data.repos.checklists.listSummaries('all'))[0]?.checklist.id ?? '')).toEqual([['Passeport', false], ['Chargeur', true]]));
    first.unmount();
    renderChecklists(h.container);
    expect(await screen.findByText('1 / 2')).toBeInTheDocument();
    expect(check('Chargeur', true)).toBeInTheDocument();
  });

  describe('texte modifiable en ligne (critère 5)', () => {
    it('toucher le texte ouvre un champ ; Entrée valide', async () => {
      const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport'] });
      renderChecklists(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Modifier : Passeport' }));
      const input = screen.getByLabelText('Texte de l’élément');
      expect(input).toHaveValue('Passeport');
      expect(input).toHaveAttribute('maxlength', '200');
      fireEvent.change(input, { target: { value: '  Passeport valide ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(await screen.findByRole('button', { name: 'Modifier : Passeport valide' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Texte de l’élément')).toBeNull();
      expect(await stored(h, checklist.id)).toEqual([['Passeport valide', false]]);
    });

    it('Échap annule et rend l’ancien texte', async () => {
      const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport'] });
      renderChecklists(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Modifier : Passeport' }));
      const input = screen.getByLabelText('Texte de l’élément');
      fireEvent.change(input, { target: { value: 'Autre' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(await screen.findByRole('button', { name: 'Modifier : Passeport' })).toBeInTheDocument();
      expect(await stored(h, checklist.id)).toEqual([['Passeport', false]]);
    });

    it('un texte vide est refusé : le champ reste ouvert, le texte inchangé', async () => {
      const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport'] });
      renderChecklists(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Modifier : Passeport' }));
      const input = screen.getByLabelText('Texte de l’élément');
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(await screen.findByText('Un élément ne peut pas être vide.')).toBeInTheDocument();
      expect(screen.getByLabelText('Texte de l’élément')).toHaveAttribute('aria-invalid', 'true');
      expect(await stored(h, checklist.id)).toEqual([['Passeport', false]]);
      fireEvent.blur(screen.getByLabelText('Texte de l’élément'));
      expect(await screen.findByRole('button', { name: 'Modifier : Passeport' })).toBeInTheDocument();
    });

    it('perdre le focus enregistre un texte valide', async () => {
      const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport'] });
      renderChecklists(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Modifier : Passeport' }));
      const input = screen.getByLabelText('Texte de l’élément');
      fireEvent.change(input, { target: { value: 'Visa' } });
      fireEvent.blur(input);
      await waitFor(async () => expect(await stored(h, checklist.id)).toEqual([['Visa', false]]));
    });
  });

  it('la vue compacte réduit les lignes, se mémorise et réutilise CompactToggle (critère 9)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport'] });
    renderChecklists(h.container);
    const toggle = await screen.findByRole('button', { name: 'Vue compacte' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.ct-checklist-items')).not.toHaveAttribute('data-compact');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.ct-checklist-items')).toHaveAttribute('data-compact');
    await waitFor(async () => expect(await h.container.data.repos.settings.get('view.compact')).toMatchObject({ checklists: true, routines: false }));
  });
});

describe('Checklists : progression dans le volet (C-02), PC', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('312');
    mockViewport(1440);
  });
  afterEach(() => teardownChecklists(h));

  it('« 3 / 6 » dans le détail et dans le volet, qui suit le cochage sans recharger (critères 1, 2)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: valise });
    await seedChecklist(h, { title: 'Courses', items: ['Lait', 'Pain'] });
    renderChecklists(h.container);
    const list = await screen.findByRole('list', { name: 'Mes checklists' });
    await screen.findByRole('heading', { level: 2, name: 'Courses' });
    fireEvent.click(within(list).getByRole('button', { name: /^Valise voyage/ }));
    await screen.findByRole('heading', { level: 2, name: 'Valise voyage' });
    await waitFor(() => expect(screen.getAllByText('3 / 6')).toHaveLength(2));
    expect(within(list).getByRole('button', { name: /^Courses/ })).toHaveTextContent('0 / 2');
    fireEvent.click(check('Crème solaire'));
    await waitFor(() => expect(screen.getAllByText('4 / 6')).toHaveLength(2));
  });
});

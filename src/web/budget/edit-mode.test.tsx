import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { budgetGroup, sampleBudget } from '../test/budget-fixtures';
import { fakeApi, json, undoStack, writes } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';
import { reorderedIds, reorderOnDragEnd } from './reorder';

describe('the reorder handler', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves the dragged id to where it was dropped', () => {
    expect(reorderedIds(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderedIds(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderedIds(ids, 'b', 'b')).toBeNull();
    expect(reorderedIds(ids, 'b', null)).toBeNull();
    expect(reorderedIds(ids, 'x', 'b')).toBeNull();
  });

  it('sends the whole new order once, and nothing for a drop in place or outside', () => {
    const reorder = vi.fn();
    const onDragEnd = reorderOnDragEnd(ids, reorder);
    const drop = (active: string, over: string | null) =>
      onDragEnd({ active: { id: active }, over: over === null ? null : { id: over } } as Parameters<typeof onDragEnd>[0]);
    drop('c', 'a');
    drop('c', 'c');
    drop('c', null);
    expect(reorder.mock.calls).toEqual([[['c', 'a', 'b', 'd']]]);
  });
});

describe('edit mode', () => {
  const budget = () => {
    const view = sampleBudget();
    view.groups.push(budgetGroup({ id: 'g-spare', name: 'Spare' }));
    return view;
  };

  async function edit(routes: Parameters<typeof fakeApi>[0] = {}) {
    const stack = undoStack();
    const server = fakeApi({ ...SIGNED_IN, ...stack.route, 'GET /api/budget/:month': { body: budget() }, ...routes });
    renderApp('/budget?month=2026-11');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit categories' }));
    return { ...server, stack };
  }
  const sheet = () => screen.getByRole('dialog');

  it('lists every group and category, hidden ones too, with only the controls each allows', async () => {
    await edit();
    const groups = screen.getByRole('list', { name: 'Groups' });
    expect(within(groups).getAllByRole('region').map((group) => group.textContent)).toEqual([
      expect.stringMatching(/^Bills/),
      expect.stringMatching(/^Everyday/),
      expect.stringMatching(/^Credit Card Payments/),
      expect.stringMatching(/^Old stuffHidden/),
      expect.stringMatching(/^Spare/),
    ]);
    const everyday = within(screen.getByRole('list', { name: 'Categories in Everyday' }));
    expect(everyday.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Groceries',
      'Eating out',
      'Fun money',
      'GiftsHidden',
    ]);
    expect(everyday.getByRole('button', { name: 'Reorder Gifts' })).toHaveAttribute('aria-roledescription', 'sortable');
    expect(screen.getAllByRole('button', { name: /^Add a category to/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Add a category to Bills',
      'Add a category to Everyday',
      'Add a category to Old stuff',
      'Add a category to Spare',
    ]);
    expect(screen.queryByTestId('rta-banner')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByTestId('rta-banner')).toBeInTheDocument();
  });

  it('adds a group and a category, checking the name first', async () => {
    const { requests, stack } = await edit({
      'POST /api/category-groups': () => {
        stack.push('Create group "Savings"');
        return { status: 201, body: {} };
      },
      'POST /api/categories': { status: 201, body: {} },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add group' }));
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Add group' }));
    expect(within(sheet()).getByRole('textbox', { name: 'Name' })).toHaveAccessibleDescription('Enter a name.');
    await userEvent.type(within(sheet()).getByRole('textbox', { name: 'Name' }), '  Savings ');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Add group' }));
    // dnd-kit's live regions are status elements too.
    expect(await screen.findByText('Create group "Savings"')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add a category to Bills' }));
    expect(sheet()).toHaveAccessibleName('New category in Bills');
    await userEvent.type(within(sheet()).getByRole('textbox', { name: 'Name' }), 'Water');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(requests)).toEqual([
      { method: 'POST', path: '/api/category-groups', body: { name: 'Savings' } },
      { method: 'POST', path: '/api/categories', body: { groupId: 'g-bills', name: 'Water' } },
    ]);
  });

  it('renames a category and moves it to another group in one save, and hides it', async () => {
    const { requests } = await edit({ 'PATCH /api/categories/:id': { body: {} } });
    await userEvent.click(screen.getByRole('button', { name: 'Rent' }));
    const name = within(sheet()).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Rent & fees');
    expect(within(within(sheet()).getByRole('combobox', { name: 'Group' })).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Bills',
      'Everyday',
      'Old stuff',
      'Spare',
    ]);
    await userEvent.selectOptions(within(sheet()).getByRole('combobox', { name: 'Group' }), 'Everyday');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Electricity' }));
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Hide category' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(requests)).toEqual([
      { method: 'PATCH', path: '/api/categories/c-rent', body: { name: 'Rent & fees', groupId: 'g-everyday' } },
      { method: 'PATCH', path: '/api/categories/c-power', body: { hidden: true } },
    ]);
  });

  it('deletes a category into another regular category it names', async () => {
    const { requests } = await edit({
      'DELETE /api/categories/:id': (request) =>
        request.path.endsWith('=c-gifts')
          ? json({ code: 'invalid_destination', message: 'Choose another regular category to receive the money and transactions.' }, 422)
          : { body: { id: 'c-fun' } },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Fun money' }));
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Delete category' }));
    const destination = within(sheet()).getByRole('combobox', { name: 'Move its money and transactions to' });
    expect(destination).toHaveAccessibleDescription('Choose the category that takes them over.');
    expect(within(destination).queryByRole('option', { name: /Fun money|Visa/ })).toBeNull();
    await userEvent.selectOptions(destination, 'c-gifts');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Delete category' }));
    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('Choose another regular category');
    await userEvent.selectOptions(destination, 'c-groceries');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Delete category' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(requests).map((r) => `${r.method} ${r.path}`)).toEqual([
      'DELETE /api/categories/c-fun?destinationCategoryId=c-gifts',
      'DELETE /api/categories/c-fun?destinationCategoryId=c-groceries',
    ]);
  });

  it("only hides card payment categories and the app's groups", async () => {
    await edit();
    await userEvent.click(screen.getByRole('button', { name: 'Visa' }));
    expect(sheet()).toHaveTextContent('This category follows its account: rename or delete the account instead.');
    expect(within(sheet()).getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual([
      'Close',
      'Hide category',
    ]);
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Close' }));
    await userEvent.click(screen.getByRole('button', { name: 'Credit Card Payments' }));
    expect(within(sheet()).queryByRole('textbox')).toBeNull();
    expect(within(sheet()).queryByRole('button', { name: 'Delete group' })).toBeNull();
    expect(within(sheet()).getByRole('button', { name: 'Hide group' })).toBeInTheDocument();
  });

  it('renames and unhides groups, and deletes only an empty one', async () => {
    const { requests } = await edit({
      'PATCH /api/category-groups/:id': { body: {} },
      'DELETE /api/category-groups/:id': { body: { id: 'g-spare' } },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Bills' }));
    expect(within(sheet()).getByRole('button', { name: 'Delete group' })).toBeDisabled();
    expect(sheet()).toHaveTextContent('Move or delete its categories first.');
    await userEvent.type(within(sheet()).getByRole('textbox', { name: 'Name' }), ' & utilities');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: /^Old stuff/ }));
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Unhide group' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Spare' }));
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Delete group' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(requests)).toEqual([
      { method: 'PATCH', path: '/api/category-groups/g-bills', body: { name: 'Bills & utilities' } },
      { method: 'PATCH', path: '/api/category-groups/g-old', body: { hidden: false } },
      { method: 'DELETE', path: '/api/category-groups/g-spare', body: undefined },
    ]);
  });

  it('reorders categories with the keyboard, sending the whole group, and holds the order until the server answers', async () => {
    // jsdom has no layout: give every row a 40 px slot by its place in its list, as dnd-kit measures rows.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
      return DOMRect.fromRect({ x: 0, y: index * 40, width: 300, height: 40 });
    });
    let answer: (response: Response) => void = () => {};
    const { requests } = await edit({
      'PUT /api/categories/order': () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    const everyday = () => within(screen.getByRole('list', { name: 'Categories in Everyday' }));
    everyday().getByRole('button', { name: 'Reorder Groceries' }).focus();
    await userEvent.keyboard('[Space]');
    await userEvent.keyboard('[ArrowDown]');
    await userEvent.keyboard('[Space]');
    await waitFor(() => expect(writes(requests)).toHaveLength(1));
    expect(writes(requests)[0]).toEqual({
      method: 'PUT',
      path: '/api/categories/order',
      body: { groupId: 'g-everyday', ids: ['c-eating', 'c-groceries', 'c-fun', 'c-gifts'] },
    });
    expect(everyday().getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Eating out',
      'Groceries',
      'Fun money',
      'GiftsHidden',
    ]);
    answer(json({ code: 'internal', message: 'Something went wrong.' }, 500));
    await waitFor(() => expect(everyday().getAllByRole('listitem')[0]).toHaveTextContent('Groceries'));
  });

  it('cannot reorder while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await edit();
    expect(screen.getByRole('button', { name: 'Reorder Bills' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reorder Rent' })).toBeDisabled();
  });
});

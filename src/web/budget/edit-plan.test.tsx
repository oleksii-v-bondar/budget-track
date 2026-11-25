import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { budgetGroup, monthlyTarget, sampleBudget } from '../test/budget-fixtures';
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

describe('Edit Plan', () => {
  /** Rent 2 000 + Electricity 250 a month, Groceries 350 every Tuesday (four in November 2026): 3 650 zł. */
  const budget = () => {
    const view = sampleBudget();
    const everyday = view.groups.find((g) => g.id === 'g-everyday')!;
    everyday.categories[0]!.target = monthlyTarget('c-groceries', 35_000, { cadence: 'weekly', dueWeekday: 2 });
    view.groups.push(budgetGroup({ id: 'g-spare', name: 'Spare' }));
    return view;
  };

  async function openEditPlan(routes: Parameters<typeof fakeApi>[0] = {}) {
    const stack = undoStack();
    const server = fakeApi({
      ...SIGNED_IN,
      ...stack.route,
      'GET /api/budget/:month': { body: budget() },
      'GET /api/budget/settings': { body: { expectedMonthlyIncome: 500_000 } },
      ...routes,
    });
    renderApp('/budget?month=2026-11');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Plan' }));
    await screen.findByRole('heading', { name: 'Edit Plan', level: 1 });
    return { ...server, stack };
  }
  const sheet = () => screen.getByRole('dialog');
  const group = (name: string) => within(screen.getByRole('region', { name }));
  const row = (id: string) => screen.getByTestId(`plan-row-${id}`);

  it('replaces the Plan with the cost of every target, and closes with ✓', async () => {
    await openEditPlan();
    expect(screen.queryByTestId('rta-banner')).toBeNull();
    expect(screen.getByTestId('cost-to-be-me')).toHaveTextContent('3 650,00 zł');
    expect(screen.getByText('Cost to Be Me')).toBeInTheDocument();
    expect(screen.getByText('November’s Targets')).toBeInTheDocument();
    expect(screen.getByTestId('targets-total')).toHaveTextContent('3 650,00 zł');
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual([
      'Edit Plan',
      'Bills',
      'Everyday',
      'Credit Card Payments',
      'Spare',
      'Hidden',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('heading', { name: 'Edit Plan' })).toBeNull();
    expect(screen.getByTestId('rta-banner')).toBeInTheDocument();
  });

  it("shows each category's monthly target, naming cadences other than monthly", async () => {
    await openEditPlan();
    expect(row('c-rent')).toHaveTextContent(/^Rent2 000,00 zł$/);
    expect(row('c-groceries')).toHaveTextContent(/^Groceries1 400,00 zł350,00 zł Weekly$/);
    expect(row('c-fun')).toHaveTextContent(/^Fun moneyNo target$/);
    expect(group('Everyday').getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Groceries/),
      expect.stringMatching(/^Eating out/),
      expect.stringMatching(/^Fun money/),
    ]);
  });

  it("compares the month's targets with the expected income, set in a sheet", async () => {
    let income: number | null = null;
    const { requests, stack } = await openEditPlan({
      'GET /api/budget/settings': () => ({ body: { expectedMonthlyIncome: income } }),
      'PUT /api/budget/settings': (request) => {
        income = (request.body as { expectedMonthlyIncome: number | null }).expectedMonthlyIncome;
        stack.push('Set the expected monthly income');
        return { body: request.body };
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Monthly Income: Set income' }));
    const bar = screen.getByRole('progressbar', { name: 'Targets as a share of income' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(sheet()).toHaveAccessibleName('Monthly Income');
    for (const key of ['5', '0', '0', '0']) await userEvent.click(within(sheet()).getByRole('button', { name: key }));
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Set the expected monthly income')).toBeInTheDocument();
    // Accessible names keep formatMoney's no-break spaces.
    const setTo5000 = /^Monthly Income: 5\s000,00\szł$/;
    expect(await screen.findByRole('button', { name: setTo5000 })).toBeInTheDocument();
    // 3 650 of 5 000 zł.
    expect(bar).toHaveAttribute('aria-valuenow', '73');

    await userEvent.click(screen.getByRole('button', { name: setTo5000 }));
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Clear income' }));
    expect(await screen.findByRole('button', { name: 'Monthly Income: Set income' })).toBeInTheDocument();
    expect(writes(requests)).toEqual([
      { method: 'PUT', path: '/api/budget/settings', body: { expectedMonthlyIncome: 500_000 } },
      { method: 'PUT', path: '/api/budget/settings', body: { expectedMonthlyIncome: null } },
    ]);
  });

  it('adds a group with New Group and a category with ⊕, checking the name first', async () => {
    const { requests, stack } = await openEditPlan({
      'POST /api/category-groups': () => {
        stack.push('Create group "Savings"');
        return { status: 201, body: {} };
      },
      'POST /api/categories': { status: 201, body: {} },
    });
    await userEvent.click(screen.getByRole('button', { name: 'New Group' }));
    expect(sheet()).toHaveAccessibleName('New Group');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Add group' }));
    expect(within(sheet()).getByRole('textbox', { name: 'Name' })).toHaveAccessibleDescription('Enter a name.');
    await userEvent.type(within(sheet()).getByRole('textbox', { name: 'Name' }), '  Savings ');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Add group' }));
    expect(await screen.findByText('Create group "Savings"')).toBeInTheDocument();

    await userEvent.click(group('Bills').getByRole('button', { name: 'Add a category to Bills' }));
    expect(sheet()).toHaveAccessibleName('New category in Bills');
    await userEvent.type(within(sheet()).getByRole('textbox', { name: 'Name' }), 'Water');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(requests)).toEqual([
      { method: 'POST', path: '/api/category-groups', body: { name: 'Savings' } },
      { method: 'POST', path: '/api/categories', body: { groupId: 'g-bills', name: 'Water' } },
    ]);
  });

  it("renames, hides and deletes a group from its ⋯ menu, showing the server's refusal", async () => {
    const { requests } = await openEditPlan({
      'PATCH /api/category-groups/:id': { body: {} },
      'DELETE /api/category-groups/:id': (request) =>
        request.path.endsWith('g-bills')
          ? json({ code: 'group_not_empty', message: "Move or delete this group's categories first." }, 422)
          : { body: { id: 'g-spare' } },
    });
    const menu = async (name: string) => {
      await userEvent.click(group(name).getByRole('button', { name: `Actions for ${name}` }));
      return within(screen.getByRole('menu', { name: `Actions for ${name}` }));
    };
    expect((await menu('Bills')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Rename',
      'Hide',
      'Delete',
    ]);
    await userEvent.keyboard('[Escape]');
    expect(screen.queryByRole('menu')).toBeNull();

    await userEvent.click((await menu('Bills')).getByRole('menuitem', { name: 'Rename' }));
    expect(sheet()).toHaveAccessibleName('Rename Bills');
    await userEvent.type(within(sheet()).getByRole('textbox', { name: 'Name' }), ' & utilities');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click((await menu('Bills')).getByRole('menuitem', { name: 'Delete' }));
    expect(await group('Bills').findByRole('alert')).toHaveTextContent("Move or delete this group's categories first.");
    await userEvent.click((await menu('Spare')).getByRole('menuitem', { name: 'Hide' }));
    await userEvent.click((await menu('Spare')).getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(writes(requests)).toHaveLength(4));
    expect(writes(requests)).toEqual([
      { method: 'PATCH', path: '/api/category-groups/g-bills', body: { name: 'Bills & utilities' } },
      { method: 'DELETE', path: '/api/category-groups/g-bills', body: undefined },
      { method: 'PATCH', path: '/api/category-groups/g-spare', body: { hidden: true } },
      { method: 'DELETE', path: '/api/category-groups/g-spare', body: undefined },
    ]);
  });

  it('renames a category and moves it to another group in one save, and hides it', async () => {
    const { requests } = await openEditPlan({ 'PATCH /api/categories/:id': { body: {} } });
    await userEvent.click(row('c-rent'));
    expect(sheet()).toHaveAccessibleName('Rent');
    expect(within(sheet()).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Details', 'Target']);
    const name = within(sheet()).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Rent & fees');
    const groups = within(sheet()).getByRole('combobox', { name: 'Group' });
    expect(within(groups).getAllByRole('option').map((o) => o.textContent)).toEqual(['Bills', 'Everyday', 'Old stuff', 'Spare']);
    await userEvent.selectOptions(groups, 'Everyday');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(row('c-power'));
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Hide category' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(requests)).toEqual([
      { method: 'PATCH', path: '/api/categories/c-rent', body: { name: 'Rent & fees', groupId: 'g-everyday' } },
      { method: 'PATCH', path: '/api/categories/c-power', body: { hidden: true } },
    ]);
  });

  it("edits a category's target in its sheet", async () => {
    const { requests } = await openEditPlan({ 'PUT /api/categories/:id/target': { body: {} } });
    await userEvent.click(row('c-fun'));
    await userEvent.click(within(sheet()).getByRole('tab', { name: 'Target' }));
    await userEvent.type(within(sheet()).getByRole('textbox', { name: 'Amount' }), '120');
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Save target' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(requests)).toEqual([
      {
        method: 'PUT',
        path: '/api/categories/c-fun/target',
        body: { kind: 'spending', amount: 12_000, mode: 'set_aside', cadence: 'monthly', dueDayOfMonth: null, startMonth: '2026-11' },
      },
    ]);
  });

  it('deletes a category into another regular category it names', async () => {
    const { requests } = await openEditPlan({
      'DELETE /api/categories/:id': (request) =>
        request.path.endsWith('=c-gifts')
          ? json({ code: 'invalid_destination', message: 'Choose another regular category to receive the money and transactions.' }, 422)
          : { body: { id: 'c-fun' } },
    });
    await userEvent.click(row('c-fun'));
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

  it("leaves card payment categories and the app's groups as the server allows: hide and target only", async () => {
    await openEditPlan();
    const cards = group('Credit Card Payments');
    expect(cards.queryByRole('button', { name: /^Add a category/ })).toBeNull();
    await userEvent.click(cards.getByRole('button', { name: 'Actions for Credit Card Payments' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Hide']);
    await userEvent.keyboard('[Escape]');

    await userEvent.click(row('c-visa'));
    expect(sheet()).toHaveTextContent('This category follows its account: rename or delete the account instead.');
    expect(within(sheet()).queryByRole('textbox')).toBeNull();
    expect(within(sheet()).queryByRole('button', { name: 'Delete category' })).toBeNull();
    expect(within(sheet()).getByRole('button', { name: 'Hide category' })).toBeInTheDocument();
    expect(within(sheet()).getByRole('tab', { name: 'Target' })).toBeInTheDocument();
  });

  it('lists hidden groups and categories at the bottom, with Unhide', async () => {
    const { requests } = await openEditPlan({
      'PATCH /api/categories/:id': { body: {} },
      'PATCH /api/category-groups/:id': { body: {} },
    });
    const hidden = group('Hidden');
    expect(hidden.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'GiftsEverydayUnhide',
      'Old stuffGroup · 1 categoryUnhide',
    ]);
    expect(group('Everyday').queryByText('Gifts')).toBeNull();
    await userEvent.click(hidden.getByRole('button', { name: 'Unhide Old stuff' }));
    await userEvent.click(hidden.getByRole('button', { name: 'Unhide Gifts' }));
    await waitFor(() => expect(writes(requests)).toHaveLength(2));
    expect(writes(requests)).toEqual([
      { method: 'PATCH', path: '/api/category-groups/g-old', body: { hidden: false } },
      { method: 'PATCH', path: '/api/categories/c-gifts', body: { hidden: false } },
    ]);
  });

  it('enters reorder mode with drag handles, and leaves it with ✓', async () => {
    await openEditPlan();
    expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Reorder' }));
    expect(screen.getByRole('button', { name: 'Reorder' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Reorder Bills' })).toHaveAttribute('aria-roledescription', 'sortable');
    expect(group('Everyday').getAllByRole('button', { name: /^Reorder / }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Reorder Everyday',
      'Reorder Groceries',
      'Reorder Eating out',
      'Reorder Fun money',
    ]);
    expect(screen.queryByRole('button', { name: /^Add a category/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Done reordering' }));
    expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Edit Plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reorder' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reorders categories with the keyboard, sending the whole group (hidden ones too), and holds the order until the server answers', async () => {
    // jsdom has no layout: give every row a 40 px slot by its place in its list, as dnd-kit measures rows.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
      return DOMRect.fromRect({ x: 0, y: index * 40, width: 300, height: 40 });
    });
    let answer: (response: Response) => void = () => {};
    const { requests } = await openEditPlan({
      'PUT /api/categories/order': () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Reorder' }));
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
      expect.stringMatching(/^Eating out/),
      expect.stringMatching(/^Groceries/),
      expect.stringMatching(/^Fun money/),
    ]);
    answer(json({ code: 'internal', message: 'Something went wrong.' }, 500));
    await waitFor(() => expect(everyday().getAllByRole('listitem')[0]).toHaveTextContent(/^Groceries/));
  });

  it('cannot reorder while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openEditPlan();
    await userEvent.click(screen.getByRole('button', { name: 'Reorder' }));
    expect(screen.getByRole('button', { name: 'Reorder Bills' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reorder Rent' })).toBeDisabled();
  });
});

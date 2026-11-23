import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { rtaBreakdown, sampleBudget } from '../test/budget-fixtures';
import { fakeApi, json, undoStack, writes } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';

describe('Ready to Assign', () => {
  it('opens its breakdown from the banner and auto-assigns every category', async () => {
    const stack = undoStack();
    const budget = sampleBudget({
      rta: rtaBreakdown(10000, {
        leftoverPrev: 20000,
        income: 500000,
        assignedThisMonth: 490000,
        cashOverspentPrev: 5000,
        leftover: 25000,
        assignedFuture: 15000,
      }),
    });
    const { requests } = fakeApi({
      ...SIGNED_IN,
      ...stack.route,
      'GET /api/budget/:month': { body: budget },
      'POST /api/budget/:month/auto-assign': () => {
        stack.push('Auto-assign: Underfunded');
        return { body: { assignments: [{ month: '2026-11', categoryId: 'c-power', amount: 25000 }] } };
      },
    });
    renderApp('/budget?month=2026-11');
    await userEvent.click(await screen.findByRole('button', { name: /Ready to Assign/ }));
    const sheet = screen.getByRole('dialog', { name: 'Ready to Assign' });
    const lines = within(sheet)
      .getAllByRole('term')
      .map((term) => `${term.textContent}: ${term.nextElementSibling?.textContent}`);
    expect(lines).toEqual([
      'Left over from last month: 200,00\u00a0zł',
      'Income this month: 5\u00a0000,00\u00a0zł',
      'Assigned this month: -4\u00a0900,00\u00a0zł',
      'Assigned in future months: -150,00\u00a0zł',
      'Cash overspent last month: -50,00\u00a0zł',
      'Ready to Assign: 100,00\u00a0zł',
    ]);

    const strategies = within(within(sheet).getByRole('region', { name: 'Auto-assign all' })).getAllByRole('button');
    expect(strategies.map((button) => button.firstChild?.textContent)).toEqual([
      'Underfunded',
      'Assigned last month',
      'Spent last month',
      'Average assigned',
      'Average spent',
      'Reset available',
      'Reset assigned',
    ]);
    await userEvent.click(within(sheet).getByRole('button', { name: /^Underfunded/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Auto-assign: Underfunded');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(requests)).toEqual([
      {
        method: 'POST',
        path: '/api/budget/2026-11/auto-assign',
        body: { strategy: 'underfunded', scope: { type: 'all' } },
      },
    ]);
  });

  it("shows the server's reason when auto-assign is refused, and keeps the sheet open", async () => {
    fakeApi({
      ...SIGNED_IN,
      'GET /api/budget/:month': { body: sampleBudget() },
      'POST /api/budget/:month/auto-assign': json(
        { code: 'month_out_of_range', message: 'Pick a month from 2026-09 to 2028-11.' },
        422,
      ),
    });
    renderApp('/budget?month=2026-11');
    await userEvent.click(await screen.findByRole('button', { name: /Ready to Assign/ }));
    const sheet = screen.getByRole('dialog', { name: 'Ready to Assign' });
    await userEvent.click(within(sheet).getByRole('button', { name: /^Reset assigned/ }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Pick a month from 2026-09 to 2028-11.');
  });

  it('cannot auto-assign while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fakeApi({ ...SIGNED_IN, 'GET /api/budget/:month': { body: sampleBudget() } });
    renderApp('/budget?month=2026-11');
    await userEvent.click(await screen.findByRole('button', { name: /Ready to Assign/ }));
    const sheet = screen.getByRole('dialog', { name: 'Ready to Assign' });
    expect(within(sheet).getByRole('button', { name: /^Underfunded/ })).toBeDisabled();
  });
});

describe('the month note', () => {
  it('is written in a sheet and saved as an undoable command', async () => {
    const stack = undoStack();
    let note: string | null = null;
    const { requests } = fakeApi({
      ...SIGNED_IN,
      ...stack.route,
      'GET /api/budget/:month': () => ({ body: sampleBudget({ note }) }),
      'PUT /api/budget/:month/note': (request) => {
        note = (request.body as { note: string }).note || null;
        stack.push('Edit the note for 2026-11');
        return { body: { month: '2026-11', note } };
      },
    });
    renderApp('/budget?month=2026-11');
    await userEvent.click(await screen.findByRole('button', { name: 'Add a note for November 2026' }));
    const sheet = screen.getByRole('dialog', { name: 'Note for November 2026' });
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Note' }), 'Bonus arrives on the 20th');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save note' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Edit the note for 2026-11');
    expect(await screen.findByRole('button', { name: /Bonus arrives on the 20th/ })).toBeInTheDocument();
    expect(writes(requests)).toEqual([
      { method: 'PUT', path: '/api/budget/2026-11/note', body: { note: 'Bonus arrives on the 20th' } },
    ]);

    await userEvent.click(screen.getByRole('button', { name: /Bonus arrives on the 20th/ }));
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Bonus arrives on the 20th');
  });

  it('refuses a note over 2000 characters before sending it', async () => {
    const { requests } = fakeApi({ ...SIGNED_IN, 'GET /api/budget/:month': { body: sampleBudget() } });
    renderApp('/budget?month=2026-11');
    await userEvent.click(await screen.findByRole('button', { name: 'Add a note for November 2026' }));
    const textbox = screen.getByRole('textbox', { name: 'Note' });
    await userEvent.click(textbox);
    await userEvent.paste('x'.repeat(2001));
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(textbox).toHaveAccessibleDescription('Use at most 2000 characters.');
    expect(writes(requests)).toEqual([]);
  });
});

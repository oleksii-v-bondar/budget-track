import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BudgetMonthDto } from '../../shared/api/budget';
import type { TargetDto } from '../../shared/api/targets';
import { monthlyTarget, sampleBudget } from '../test/budget-fixtures';
import { fakeApi, json, undoStack, writes } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';
import { describeTarget, type TargetForm, targetForm, targetRequestOf } from './target-form';

const blank = targetForm(null, 'normal', '2026-11');
const request = (changes: Partial<TargetForm>, existingStart: string | null = null) => {
  const result = targetRequestOf({ ...blank, ...changes }, existingStart);
  return result.ok ? result.request : result.errors;
};

describe('targetRequestOf', () => {
  it('builds every spending cadence with only the fields it uses', () => {
    const spending = { kind: 'spending', amount: 12000, mode: 'set_aside', startMonth: '2026-11' };
    expect(request({ cadence: 'weekly', amount: '120', dueWeekday: '5' })).toEqual({ ...spending, cadence: 'weekly', dueWeekday: 5 });
    expect(request({ cadence: 'monthly', amount: '100+20', mode: 'refill' })).toEqual({
      ...spending,
      mode: 'refill',
      cadence: 'monthly',
      dueDayOfMonth: null,
    });
    expect(request({ cadence: 'monthly', amount: '120', dueDayOfMonth: '15' })).toMatchObject({ dueDayOfMonth: 15 });
    expect(request({ cadence: 'yearly', amount: '120', dueDate: '15.12.2026' })).toEqual({
      ...spending,
      cadence: 'yearly',
      dueDate: '2026-12-15',
    });
    expect(request({ cadence: 'custom', amount: '120', dueDate: '1.3.2027' })).toEqual({
      ...spending,
      cadence: 'custom',
      dueDate: '2027-03-01',
      repeatUnit: null,
      repeatEvery: null,
    });
    expect(request({ cadence: 'custom', amount: '120', dueDate: '1.3.2027', repeat: 'month', repeatEvery: '3' })).toMatchObject({
      repeatUnit: 'month',
      repeatEvery: 3,
    });
  });

  it('builds balance and debt targets', () => {
    expect(request({ kind: 'balance', amount: '5000' })).toEqual({
      kind: 'balance',
      amount: 500000,
      dueDate: null,
      startMonth: '2026-11',
    });
    expect(request({ kind: 'balance', amount: '5000', dueDate: '31.12.2027' })).toMatchObject({ dueDate: '2027-12-31' });
    expect(request({ kind: 'debt' })).toEqual({ kind: 'debt', debtMode: 'min_payment', startMonth: '2026-11' });
    expect(request({ kind: 'debt', debtMode: 'fixed', amount: '300' })).toEqual({
      kind: 'debt',
      debtMode: 'fixed',
      amount: 30000,
      startMonth: '2026-11',
    });
    expect(request({ kind: 'debt', debtMode: 'payoff_by_date', dueDate: '30.06.2028' })).toEqual({
      kind: 'debt',
      debtMode: 'payoff_by_date',
      dueDate: '2028-06-30',
      startMonth: '2026-11',
    });
  });

  it('sends the start month of an existing target only when it changed', () => {
    expect(request({ amount: '10', startMonth: '2026-09' }, '2026-09')).not.toHaveProperty('startMonth');
    expect(request({ amount: '10', startMonth: '2026-10' }, '2026-09')).toMatchObject({ startMonth: '2026-10' });
  });

  it('says what is wrong with a field, before anything is sent', () => {
    const fields = (changes: Partial<TargetForm>) => (request(changes) as { fields: Record<string, string> }).fields;
    expect(fields({ amount: '' })).toEqual({ amount: 'Enter an amount.' });
    expect(fields({ amount: '12+' })).toEqual({ amount: 'Finish the calculation.' });
    expect(fields({ amount: '−5' })).toEqual({ amount: 'Enter 0 or more.' });
    expect(fields({ amount: '200000000000' })).toEqual({ amount: 'Amounts can be at most 100\u00a0000\u00a0000\u00a0000,00.' });
    expect(fields({ cadence: 'yearly', amount: '1', dueDate: '' })).toEqual({ dueDate: 'Enter a date.' });
    expect(fields({ cadence: 'yearly', amount: '1', dueDate: '31.02.2027' })).toEqual({ dueDate: 'Use the format dd.mm.yyyy.' });
    expect(fields({ cadence: 'custom', amount: '1', dueDate: '1.1.2027', repeat: 'year', repeatEvery: '0' })).toEqual({
      repeatEvery: 'Enter a whole number from 1 to 120.',
    });
  });

  it('starts from an existing target and sends it back unchanged', () => {
    const target: TargetDto = {
      ...monthlyTarget('c', 123456, { mode: 'refill' }),
      cadence: 'custom',
      dueDate: '2027-03-01',
      repeatUnit: 'year',
      repeatEvery: 2,
    };
    const form = targetForm(target, 'normal', '2026-11');
    expect(form).toMatchObject({ amount: '1234,56', dueDate: '01.03.2027', repeat: 'year', repeatEvery: '2', startMonth: '2026-09' });
    expect(targetRequestOf(form, target.startMonth)).toEqual({
      ok: true,
      request: {
        kind: 'spending',
        cadence: 'custom',
        amount: 123456,
        mode: 'refill',
        dueDate: '2027-03-01',
        repeatUnit: 'year',
        repeatEvery: 2,
      },
    });
  });
});

describe('describeTarget', () => {
  it('puts a target in one sentence', () => {
    const t = monthlyTarget('c', 25000);
    expect(describeTarget(t)).toBe('250,00\u00a0zł every month by the last day (set aside), from September 2026');
    expect(describeTarget({ ...t, dueDayOfMonth: 22, mode: 'refill' })).toBe(
      '250,00\u00a0zł every month by the 22nd (refill), from September 2026',
    );
    expect(describeTarget({ ...t, cadence: 'weekly', dueWeekday: 5 })).toMatch(/^250,00\u00a0zł every Friday/);
    expect(describeTarget({ ...t, cadence: 'custom', dueDate: '2027-03-01', repeatUnit: 'month', repeatEvery: 3 })).toMatch(
      /by 01\.03\.2027, then every 3 months/,
    );
    expect(describeTarget({ ...t, kind: 'balance', cadence: 'none', mode: null, dueDate: '2027-12-31' })).toBe(
      'Have 250,00\u00a0zł by 31.12.2027, from September 2026',
    );
    expect(describeTarget({ ...t, kind: 'debt', mode: null, debtMode: 'min_payment' })).toBe(
      'Pay the minimum payment each month, from September 2026',
    );
  });
});

describe('the Target tab', () => {
  async function openTarget(id: string, budget: BudgetMonthDto = sampleBudget(), routes: Parameters<typeof fakeApi>[0] = {}) {
    const stack = undoStack();
    const server = fakeApi({ ...SIGNED_IN, ...stack.route, 'GET /api/budget/:month': { body: budget }, ...routes });
    renderApp('/budget?month=2026-11');
    await userEvent.click(await screen.findByTestId(`category-${id}`));
    const sheet = screen.getByRole('dialog');
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Target' }));
    return { ...server, stack, sheet };
  }
  /** The form's labelled fields, in order. */
  const labels = (sheet: HTMLElement) => [...sheet.querySelectorAll('form label')].map((label) => label.textContent);

  it("shows each type's own fields for a new target, and saves it", async () => {
    const { sheet, stack, requests } = await openTarget('c-fun', sampleBudget(), {
      'PUT /api/categories/:id/target': () => {
        stack.push('Set the target for "Fun money"');
        return { body: {} };
      },
    });
    expect(within(sheet).getAllByRole('radio', { name: /Spending|Balance|Debt/ }).map((r) => r.textContent)).toEqual([
      'Spending',
      'Balance',
    ]);
    expect(labels(sheet)).toEqual(['Repeats', 'Amount', 'Due on day', 'Starts in']);
    const repeats = within(sheet).getByRole('combobox', { name: 'Repeats' });
    await userEvent.selectOptions(repeats, 'Weekly');
    expect(labels(sheet)).toEqual(['Repeats', 'Amount', 'Due on', 'Starts in']);
    await userEvent.selectOptions(repeats, 'Yearly');
    expect(labels(sheet)).toEqual(['Repeats', 'Amount', 'Due date', 'Starts in']);
    await userEvent.selectOptions(repeats, 'Custom');
    await userEvent.selectOptions(within(sheet).getByRole('combobox', { name: 'Then' }), 'Repeats every few months');
    expect(labels(sheet)).toEqual(['Repeats', 'Amount', 'Due date', 'Then', 'Every how many months', 'Starts in']);
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Balance' }));
    expect(labels(sheet)).toEqual(['Balance to have', 'By date (optional)', 'Starts in']);

    await userEvent.click(within(sheet).getByRole('radio', { name: 'Spending' }));
    await userEvent.selectOptions(within(sheet).getByRole('combobox', { name: 'Repeats' }), 'Weekly');
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Amount' }), '120');
    await userEvent.selectOptions(within(sheet).getByRole('combobox', { name: 'Due on' }), 'Friday');
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Refill' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save target' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Set the target for "Fun money"');
    expect(writes(requests)).toEqual([
      {
        method: 'PUT',
        path: '/api/categories/c-fun/target',
        body: { kind: 'spending', cadence: 'weekly', amount: 12000, mode: 'refill', dueWeekday: 5, startMonth: '2026-11' },
      },
    ]);
  });

  it('offers debt targets to card payment categories', async () => {
    const { sheet, stack, requests } = await openTarget('c-visa', sampleBudget(), {
      'PUT /api/categories/:id/target': () => {
        stack.push('Set the target for "Visa"');
        return { body: {} };
      },
    });
    expect(within(sheet).getByRole('radio', { name: 'Debt' })).toHaveAttribute('aria-checked', 'true');
    const pay = within(sheet).getByRole('combobox', { name: 'Pay' });
    expect(labels(sheet)).toEqual(['Pay', 'Starts in']);
    await userEvent.selectOptions(pay, 'A fixed amount each month');
    expect(labels(sheet)).toEqual(['Pay', 'Amount each month', 'Starts in']);
    await userEvent.selectOptions(pay, 'Enough to pay it off by a date');
    expect(labels(sheet)).toEqual(['Pay', 'Paid off by', 'Starts in']);
    await userEvent.selectOptions(pay, 'The minimum payment');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save target' }));
    await screen.findByRole('status');
    expect(writes(requests)).toEqual([
      { method: 'PUT', path: '/api/categories/c-visa/target', body: { kind: 'debt', debtMode: 'min_payment', startMonth: '2026-11' } },
    ]);
  });

  it("shows field errors before sending, and the server's under the field", async () => {
    const { sheet, requests } = await openTarget('c-fun', sampleBudget(), {
      'PUT /api/categories/:id/target': json(
        { code: 'validation', message: 'Some fields are invalid.', fieldErrors: { amount: ['Enter at most 100 000 000 000,00.'] } },
        400,
      ),
    });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save target' }));
    expect(within(sheet).getByRole('textbox', { name: 'Amount' })).toHaveAccessibleDescription('Enter an amount.');
    expect(writes(requests)).toEqual([]);
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Amount' }), '50');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save target' }));
    expect(await within(sheet).findByText('Enter at most 100 000 000 000,00.')).toBeInTheDocument();
  });

  it('shows a target, and snoozes, edits or deletes it', async () => {
    const { sheet, requests } = await openTarget('c-power', sampleBudget(), {
      'POST /api/categories/:id/target/snooze': { body: {} },
      'PUT /api/categories/:id/target': { body: {} },
      'DELETE /api/categories/:id/target': { body: { id: 'c-power' } },
    });
    expect(sheet).toHaveTextContent('250,00 zł every month by the last day (set aside), from September 2026');
    expect(sheet).toHaveTextContent('Needed in November 2026: 250,00 zł');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Snooze this month' }));
    await userEvent.click(await screen.findByTestId('category-c-power'));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('tab', { name: 'Target' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Edit target' }));
    const amount = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Amount' });
    expect(amount).toHaveValue('250');
    await userEvent.clear(amount);
    await userEvent.type(amount, '300');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save target' }));
    await userEvent.click(await screen.findByTestId('category-c-power'));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('tab', { name: 'Target' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete target' }));
    expect(writes(requests)).toEqual([
      { method: 'POST', path: '/api/categories/c-power/target/snooze', body: { month: '2026-11' } },
      {
        method: 'PUT',
        path: '/api/categories/c-power/target',
        body: { kind: 'spending', cadence: 'monthly', amount: 30000, mode: 'set_aside', dueDayOfMonth: null },
      },
      { method: 'DELETE', path: '/api/categories/c-power/target', body: undefined },
    ]);
  });

  it('unsnoozes a target snoozed this month', async () => {
    const budget = sampleBudget();
    const power = budget.groups[0]!.categories[1]!;
    power.target = { ...power.target!, snoozedMonth: '2026-11' };
    const { sheet, requests } = await openTarget('c-power', budget, { 'DELETE /api/categories/:id/target/snooze': { body: {} } });
    expect(sheet).toHaveTextContent('(snoozed)');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Unsnooze' }));
    expect(writes(requests)).toEqual([{ method: 'DELETE', path: '/api/categories/c-power/target/snooze', body: undefined }]);
  });
});

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { formatMonthShort, thisMonth } from '../lib/format';
import { budgetMonth, monthOfPath, sampleBudget } from '../test/budget-fixtures';
import { fakeApi, type FakeRequest, json } from '../test/fake-api';
import { renderApp, SIGNED_IN } from '../test/render';

// toHaveTextContent collapses whitespace, so the no-break spaces of formatted amounts compare equal to spaces.

async function openBudget(routes: Parameters<typeof fakeApi>[0], path = '/budget?month=2026-11') {
  const server = fakeApi({ ...SIGNED_IN, ...routes });
  const app = renderApp(path);
  return { ...server, ...app, user: userEvent.setup() };
}

const row = (id: string) => screen.getByTestId(`category-${id}`);
const pill = (id: string) => within(row(id)).getByText(/zł$/);

describe('the Plan screen', () => {
  it('shows Ready to Assign and the categories by group, with Available pills and status lines', async () => {
    await openBudget({ 'GET /api/budget/:month': { body: sampleBudget() } });
    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nov 2026' })).toBeInTheDocument();
    const banner = await screen.findByTestId('rta-banner');
    expect(banner).toHaveTextContent('100,00 zł');
    expect(banner).toHaveTextContent('Ready to Assign');
    expect(banner).toHaveAttribute('data-tone', 'green');

    const sections = screen.getAllByRole('region').map((section) => section.getAttribute('aria-label'));
    expect(sections).toEqual(['Uncategorized', 'Bills', 'Everyday', 'Credit Card Payments', 'Hidden categories']);
    expect(screen.getByRole('button', { name: 'Bills' })).toHaveAttribute('aria-expanded', 'true');

    expect(pill('c-rent')).toHaveTextContent('2 000,00 zł');
    expect(pill('c-rent')).toHaveAttribute('data-tone', 'green');
    expect(row('c-rent')).toHaveTextContent('Funded');
    expect(pill('c-power')).toHaveAttribute('data-tone', 'yellow');
    expect(row('c-power')).toHaveTextContent('150,00 zł more needed this month');
    expect(pill('c-groceries')).toHaveTextContent('-80,00 zł');
    expect(pill('c-groceries')).toHaveAttribute('data-tone', 'red');
    expect(row('c-groceries')).toHaveTextContent('Overspent');
    expect(pill('c-eating')).toHaveAttribute('data-tone', 'yellow');
    expect(row('c-eating')).toHaveTextContent('Overspent on credit');
    expect(pill('c-fun')).toHaveAttribute('data-tone', 'grey');
    expect(row('c-visa')).toHaveTextContent('Need 1 200,00 zł to pay in full');
    expect(row('c-uncategorized')).toHaveTextContent('Give these transactions a category');
  });

  it('lists hidden categories, with their group, in a section that opens on request', async () => {
    const { user } = await openBudget({ 'GET /api/budget/:month': { body: sampleBudget() } });
    const toggle = await screen.findByRole('button', { name: 'Hidden categories (2)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('category-c-gifts')).toBeNull();
    await user.click(toggle);
    expect(row('c-gifts')).toHaveTextContent('Everyday');
    expect(row('c-hobby')).toHaveTextContent('Old stuff');
  });

  it('remembers collapsed groups on this device', async () => {
    const { user, unmount } = await openBudget({ 'GET /api/budget/:month': { body: sampleBudget() } });
    const bills = await screen.findByRole('button', { name: 'Bills' });
    await user.click(bills);
    expect(bills).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('category-c-rent')).toBeNull();
    unmount();

    renderApp('/budget?month=2026-11');
    expect(await screen.findByRole('button', { name: 'Bills' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Everyday' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('category-c-rent')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Bills' }));
    expect(row('c-rent')).toBeInTheDocument();
  });

  it("picks a month from the budget's first month to 24 months ahead", async () => {
    const month = (request: FakeRequest) => {
      const m = monthOfPath(request.path);
      return { body: budgetMonth({ month: m, firstMonth: '2026-10', currentMonth: '2026-11', lastMonth: '2027-01' }) };
    };
    const { user, history } = await openBudget({ 'GET /api/budget/:month': month });
    const open = async (label: string) => {
      await user.click(await screen.findByRole('button', { name: label }));
      return screen.getByRole('dialog', { name: 'Choose a month' });
    };

    let picker = await open('Nov 2026');
    expect(within(picker).getByRole('button', { name: 'November 2026' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(picker).getByRole('button', { name: 'September 2026' })).toBeDisabled();
    expect(within(picker).getByRole('button', { name: 'Previous year' })).toBeDisabled();
    expect(within(picker).queryByRole('button', { name: 'Go to this month' })).toBeNull();
    await user.click(within(picker).getByRole('button', { name: 'October 2026' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Oct 2026' })).toBeInTheDocument();
    expect(history.location.search).toBe('?month=2026-10');

    picker = await open('Oct 2026');
    await user.click(within(picker).getByRole('button', { name: 'Next year' }));
    expect(within(picker).getByRole('button', { name: 'January 2027' })).toBeEnabled();
    expect(within(picker).getByRole('button', { name: 'February 2027' })).toBeDisabled();
    expect(within(picker).getByRole('button', { name: 'Next year' })).toBeDisabled();
    await user.click(within(picker).getByRole('button', { name: 'Go to this month' }));
    expect(await screen.findByRole('button', { name: 'Nov 2026' })).toBeInTheDocument();
  });

  it('keeps the filter in the address, and clears it from its chip', async () => {
    const { user, history } = await openBudget(
      { 'GET /api/budget/:month': { body: sampleBudget() } },
      '/budget?month=2026-11&filter=overspent',
    );
    expect(await screen.findByTestId('category-c-groceries')).toBeInTheDocument();
    expect(screen.queryByTestId('category-c-rent')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show all categories (now: Overspent)' }));
    expect(await screen.findByTestId('category-c-rent')).toBeInTheDocument();
    expect(history.location.search).toBe('?month=2026-11');
  });

  it("opens this device's month without a month in the address, and says when a month is out of range", async () => {
    const outOfRange = { code: 'month_out_of_range', message: 'Pick a month from 2026-09 to 2028-11.' };
    const { user, requests } = await openBudget(
      {
        'GET /api/budget/:month': (request) => {
          const month = monthOfPath(request.path);
          return month === '2020-01' ? json(outOfRange, 422) : { body: budgetMonth({ month }) };
        },
      },
      '/budget?month=2020-01',
    );
    expect(await screen.findByText('Pick a month from 2026-09 to 2028-11.')).toBeInTheDocument();
    expect(screen.queryByTestId('rta-banner')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Go to this month' }));
    expect(await screen.findByRole('button', { name: formatMonthShort(thisMonth()) })).toBeInTheDocument();
    expect(await screen.findByTestId('rta-banner')).toHaveAttribute('data-tone', 'grey');
    expect(requests.some((r) => r.path === `/api/budget/${thisMonth()}`)).toBe(true);
  });

  it('offers to try again when the month cannot be loaded', async () => {
    let calls = 0;
    const { user } = await openBudget({
      'GET /api/budget/:month': () =>
        ++calls === 1 ? json({ code: 'not_found', message: 'Not found.' }, 404) : { body: sampleBudget() },
    });
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('rta-banner')).toHaveTextContent('100,00 zł');
  });

  it('says when the budget has no categories yet', async () => {
    await openBudget({});
    expect(
      await screen.findByText('No categories yet. Tap Edit Plan to add a group and its categories.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('rta-banner')).toHaveTextContent('0,00 zł');
  });
});

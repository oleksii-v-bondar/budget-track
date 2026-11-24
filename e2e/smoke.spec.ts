// The callbacks passed to addInitScript run in the browser.
/// <reference lib="dom" />
import { expect, type Page, test } from '@playwright/test';
import { baseURL, E2E_PASSWORD, E2E_USERNAME } from './env';

test.use({ baseURL: baseURL() });

/** Collects Content-Security-Policy violations on every page load, to check that the built app needs no exceptions. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('reportCspViolation', (violation: string) => violations.push(violation));
  await page.addInitScript(() => {
    const report = (window as unknown as { reportCspViolation: (v: string) => void }).reportCspViolation;
    document.addEventListener('securitypolicyviolation', (e) =>
      report(`${e.violatedDirective} (${e.blockedURI}) at ${e.sourceFile}:${e.lineNumber} on ${location.pathname}`),
    );
  });
  return violations;
}

test('sign in, add an account and a category, assign, spend, and undo', async ({ page }) => {
  const cspViolations = await watchCsp(page);
  const tab = (name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name });

  // 1. Sign in.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await page.getByLabel('Username').fill(E2E_USERNAME);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  // 2. A checking account with a starting balance; its register opens.
  await tab('Accounts').click();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: 'Add account' });
  await wizard.getByRole('button', { name: 'Checking', exact: true }).click();
  await wizard.getByLabel('Account name').fill('Checking');
  await wizard.getByRole('button', { name: 'Continue' }).click();
  await wizard.getByRole('button', { name: 'Continue' }).click();
  await wizard.getByLabel('Balance').fill('1000');
  await wizard.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Balances' }).getByRole('heading', { name: 'Checking' })).toBeVisible();

  // 3. A group and a category, in the Plan's edit mode.
  await tab('Plan').click();
  const banner = page.getByTestId('rta-banner');
  await expect(banner).toHaveText(/1\s000,00\szł/);
  await page.getByRole('button', { name: 'Edit categories' }).click();
  await page.getByRole('button', { name: 'Add group' }).click();
  const newGroup = page.getByRole('dialog', { name: 'New group' });
  await newGroup.getByLabel('Name').fill('Everyday');
  await newGroup.getByRole('button', { name: 'Add group' }).click();
  await expect(page.getByText('Create group "Everyday"')).toBeVisible();
  await page.getByRole('button', { name: 'Add a category to Everyday' }).click();
  const newCategory = page.getByRole('dialog', { name: 'New category in Everyday' });
  await newCategory.getByLabel('Name').fill('Groceries');
  await newCategory.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByText('Create category "Groceries"')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  // 4. Assign with a keypad expression.
  const groceries = page.getByRole('button', { name: /^Groceries/ });
  await groceries.click();
  const sheet = page.getByRole('dialog', { name: 'Groceries' });
  for (const key of ['2', '0', '0', 'Plus', '1', '0', '0']) {
    await sheet.getByRole('button', { name: key, exact: true }).click();
  }
  await expect(sheet.getByTestId('keypad-result')).toHaveText(/= 300,00\szł/);
  await sheet.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByText('Assign money to "Groceries"')).toBeVisible();
  await expect(banner).toHaveText(/700,00\szł/);
  await expect(groceries).toContainText(/300,00\szł/);

  // 5. A transaction with "+ Transaction": the keypad, a new payee typed inline, and the category.
  await page.getByRole('button', { name: 'New transaction' }).click();
  const newTransaction = page.getByRole('dialog', { name: 'New transaction' });
  for (const key of '25,5') {
    await newTransaction.getByRole('button', { name: key === ',' ? 'Decimal comma' : key, exact: true }).click();
  }
  await newTransaction.getByRole('button', { name: 'Done' }).click();
  await newTransaction.getByRole('combobox', { name: 'Payee' }).fill('Lidl');
  await page.getByRole('option', { name: 'Create "Lidl"', exact: true }).click();
  await newTransaction.getByRole('button', { name: 'Category: Uncategorized' }).click();
  await page.getByRole('option', { name: /Groceries/ }).click();
  await newTransaction.getByRole('button', { name: 'Add transaction', exact: true }).click();
  await expect(newTransaction).toBeHidden();

  // 6. Spending lists it; the account's register shows it, and the new working balance.
  await tab('Spending').click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Lidl' })).toContainText(/Groceries.*-25,50\szł.*Checking/);
  await tab('Accounts').click();
  await page.getByRole('link', { name: /^Checking/ }).click();
  const balances = page.getByRole('region', { name: 'Balances' });
  await expect(balances.getByText('Working').locator('xpath=..')).toContainText(/974,50\szł/);
  const lidl = page.getByRole('listitem').filter({ hasText: 'Lidl' });
  await expect(lidl).toContainText('Groceries');
  await expect(lidl).toContainText(/-25,50\szł/);

  // 7. Reflect breaks the month's spending down.
  await tab('Reflect').click();
  await expect(page.getByTestId('spent-total')).toHaveText(/25,50\szł/);

  // 8. Back on the Plan: the category's Activity and Available.
  await tab('Plan').click();
  await expect(groceries).toContainText(/274,50\szł/);
  await groceries.click();
  const activity = sheet.getByRole('term').filter({ hasText: 'Activity' }).locator('xpath=following-sibling::dd');
  await expect(activity).toHaveText(/-25,50\szł/);
  await sheet.getByRole('button', { name: 'Close' }).click();

  // 9. Undo the transaction from the "…" menu: Available is back to what was assigned.
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Undo Add transaction "Lidl"' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Undone: Add transaction "Lidl"' })).toBeVisible();
  await expect(groceries).toContainText(/300,00\szł/);

  expect(cspViolations).toEqual([]);
});

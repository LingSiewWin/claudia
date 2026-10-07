import { expect, test } from '@playwright/test';

const expected: Array<[string, string, string]> = [
  ['prompt_injection', 'Chainlink CRE', 'RECIPIENT_MISMATCH'],
  ['prompt_injection_direct', 'Chainlink CRE', 'RECIPIENT_MISMATCH'],
  ['recipient_swap', 'Cardano Vault', 'R16'],
  ['amount_swap', 'Cardano Vault', 'R6'],
  ['replay', 'Cardano Vault', 'R8'],
  ['expired', 'Cardano Vault', 'R7'],
  ['revoked', 'Cardano Vault', 'R4'],
  ['daily_cap', 'Cardano Vault', 'R12'],
  ['cfo_bypass', 'Cardano Vault', 'R11'],
];

test('every Attack Lab entry fails at the expected layer with no funds moved', async ({ page }) => {
  await page.goto('/live');
  for (const [id, layer, code] of expected) {
    const row = page.getByTestId(`attack-${id}`);
    await row.getByRole('button', { name: 'Run' }).click();
    await expect(row.getByTestId('attack-result')).toHaveText(`Funds moved: $0. Stopped by ${layer} ${code}`, { timeout: 20_000 });
  }
  await expect(page.getByTestId('attack-lab')).toContainText('Attack Lab');
  const lastCard = page.getByTestId('attack-lab').getByTestId('action-card').last();
  await expect(lastCard.getByRole('heading', { level: 3 })).toHaveText('Payment outside the mandate');
  await expect(lastCard.getByTestId('status')).toHaveText('Stopped by the vault');
  await lastCard.getByRole('button', { name: 'WHY?' }).click();
  await expect(lastCard.getByTestId('row-may')).toContainText('BYPASSED');
  await expect(lastCard.getByTestId('row-enforced')).toContainText('REJECTED');
  await lastCard.getByRole('button', { name: 'Protocol view' }).click();
  await expect(lastCard.getByTestId('protocol-view')).toContainText('attempted tx body');
});

test('prompt injection shows the stage line', async ({ page }) => {
  await page.goto('/live');
  await page.getByTestId('attack-prompt_injection').getByRole('button', { name: 'Run' }).click();
  await expect(page.getByTestId('attack-lab')).toContainText("The AI was fooled. The money wasn't.", { timeout: 20_000 });
});

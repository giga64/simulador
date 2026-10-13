import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Falha o teste com qualquer erro de JavaScript ou de rede na página.
test.beforeEach(async ({ page }, testInfo) => {
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  testInfo.problems = problems;
});
test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.problems, 'erros no navegador').toEqual([]);
});

const waitForSimulation = (page) => expect(page.locator('#tab td.dim')).toHaveCount(0);

test('início: classificação, jogo ao vivo e abas', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#tab-home')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.mini-table tbody tr')).toHaveCount(20);
  await expect(page.locator('.home-live .mc.is-live')).toHaveCount(1);
  await expect(page.locator('.mini-table .live-chip')).toHaveCount(2);
  await expect(page.locator('#statusPill')).toHaveClass(/live/);
});

test('simulador: palpite muda a tabela; jogo ao vivo não aceita placar', async ({ page }) => {
  await page.goto('/simular');
  await waitForSimulation(page);
  const status = page.locator('#st');
  await expect(status).toContainText('0 de');
  // Na rodada atual (dados fixos) os jogos já acabaram ou estão ao vivo.
  await expect(page.locator('.live-sim-card')).toHaveCount(1);
  await expect(page.locator('.live-sim-card input')).toHaveCount(0);
  await page.locator('[data-act="select-round"][data-round="31"]').click();
  await page.locator('[data-act="quick-score"][data-result="1"]').first().click();
  await expect(status).toContainText('1 de');
  await page.locator('[data-act="share"]').click();
  await expect(page.locator('#shareLink')).toHaveValue(/scenario=/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#mod')).toBeHidden();
});

test('chances: classificação final, mapa e vagas', async ({ page }) => {
  await page.goto('/chances');
  await expect(page.locator('#v-cor table tbody tr').first()).toBeVisible();
  await page.locator('[data-act="sub-view"][data-value="map"]').click();
  await expect(page).toHaveURL(/\/chances\/mapa$/);
  await expect(page.locator('.pmap tbody tr')).toHaveCount(20);
  await page.locator('[data-act="sub-view"][data-value="vagas"]').click();
  await expect(page.getByText('Chance de vaga na Libertadores 2027')).toBeVisible();
});

test('copas: tema por competição, chaveamento e chances', async ({ page }) => {
  await page.goto('/copas/libertadores');
  await expect(page.locator('html')).toHaveAttribute('data-cup', 'libertadores');
  await expect(page.locator('.bracket .tie').first()).toBeVisible();
  await expect(page.locator('.group-card')).toHaveCount(8);
  await page.locator('[data-act="cup-select"][data-cup="copaDoBrasil"]').click();
  await expect(page).toHaveURL(/\/copas\/copa-do-brasil$/);
  await expect(page.locator('html')).toHaveAttribute('data-cup', 'copaDoBrasil');
  await expect(page.locator('.group-card')).toHaveCount(0);
  await page.locator('#tab-home').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-cup', /./);
});

test('endereços: abrir direto, navegar e voltar', async ({ page }) => {
  await page.goto('/clube/palmeiras');
  await expect(page.locator('#clubProfileSelect')).toHaveValue('PAL');
  await expect(page).toHaveTitle(/Palmeiras/);
  await expect(page.locator('.math-list li')).toHaveCount(4);
  await page.locator('#tab-est').click();
  await expect(page).toHaveURL(/\/estatisticas$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/clube\/palmeiras$/);
  await expect(page.locator('#tab-clubs')).toHaveAttribute('aria-selected', 'true');
});

test('tema claro/escuro persiste ao recarregar', async ({ page }) => {
  await page.goto('/');
  await page.locator('#themeButton').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('sem rolagem horizontal da página', async ({ page }) => {
  for (const path of ['/', '/simular', '/chances', '/copas/libertadores', '/clube/flamengo']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});

// Acessibilidade: nenhuma violação séria ou crítica (WCAG 2 A/AA).
for (const path of ['/', '/simular', '/chances', '/copas/libertadores', '/clube/flamengo', '/estatisticas']) {
  test(`acessibilidade em ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations
      .filter((violation) => ['serious', 'critical'].includes(violation.impact))
      .map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes.length}) ex.: ${violation.nodes[0]?.target}`,
      );
    expect(serious).toEqual([]);
  });
}

test.describe('tema escuro', () => {
  test.use({ colorScheme: 'dark' });
  for (const path of ['/', '/simular', '/copas/sul-americana', '/chances/vagas']) {
    test(`acessibilidade (escuro) em ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const serious = results.violations
        .filter((violation) => ['serious', 'critical'].includes(violation.impact))
        .map((violation) => `${violation.id} (${violation.nodes.length}) ex.: ${violation.nodes[0]?.target}`);
      expect(serious).toEqual([]);
    });
  }
});

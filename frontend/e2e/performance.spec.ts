import { test, expect } from '@playwright/test';

test.describe('Performance Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Mock Freighter wallet
    await page.evaluate(() => {
      (window as any).freighter = {
        isConnected: async () => true,
        getPublicKey: async () => 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        signTransaction: async (xdr: string) => xdr,
      };
    });

    // Mock API responses
    await page.route('**/api/v1/analytics/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            totalDistributed: 1000,
            primaryRoyaltiesTotal: 600,
            secondaryRoyaltiesTotal: 400,
            collaboratorStats: [],
          },
        }),
      });
    });

    await page.route('**/api/v1/collaborators/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/api/v1/secondary-royalty/stats/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalRoyaltiesGenerated: 400,
          totalSales: 10,
          averageRoyalty: 40,
        }),
      });
    });

    await page.route('**/api/v1/history/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    await page.route('**/api/v1/secondary-royalty/sales/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sales: [] }),
      });
    });
  });

  test('Page loads within performance thresholds', async ({ page }) => {
    const startTime = Date.now();
    
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const loadTime = Date.now() - startTime;
    
    // Page should load within 3 seconds
    expect(loadTime).toBeLessThan(3000);
  });

  test('First Contentful Paint is within threshold', async ({ page }) => {
    await page.goto('/');
    
    const fcp = await page.evaluate(() => {
      const entry = performance.getEntriesByName('first-contentful-paint')[0] as PerformanceEntry;
      return entry ? entry.startTime : 0;
    });
    
    // FCP should be less than 1.8 seconds
    expect(fcp).toBeLessThan(1800);
  });

  test('Largest Contentful Paint is within threshold', async ({ page }) => {
    await page.goto('/');
    
    // Wait for LCP to be recorded
    await page.waitForTimeout(2000);
    
    const lcp = await page.evaluate(() => {
      const entries = performance.getEntriesByName('largest-contentful-paint');
      const lastEntry = entries[entries.length - 1] as PerformanceEntry;
      return lastEntry ? lastEntry.startTime : 0;
    });
    
    // LCP should be less than 2.5 seconds
    expect(lcp).toBeLessThan(2500);
  });

  test('Cumulative Layout Shift is within threshold', async ({ page }) => {
    await page.goto('/');
    
    // Wait for CLS to stabilize
    await page.waitForTimeout(2000);
    
    const cls = await page.evaluate(() => {
      let clsValue = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsValue += (entry as any).value;
          }
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
      return clsValue;
    });
    
    // CLS should be less than 0.1
    expect(cls).toBeLessThan(0.1);
  });

  test('Total Blocking Time is within threshold', async ({ page }) => {
    await page.goto('/');
    
    // Wait for TBT to be recorded
    await page.waitForTimeout(2000);
    
    const tbt = await page.evaluate(() => {
      const entries = performance.getEntriesByName('total-blocking-time');
      const lastEntry = entries[entries.length - 1] as PerformanceEntry;
      return lastEntry ? lastEntry.duration : 0;
    });
    
    // TBT should be less than 300ms
    expect(tbt).toBeLessThan(300);
  });

  test('Interactive time is within threshold', async ({ page }) => {
    const startTime = Date.now();
    
    await page.goto('/');
    
    // Wait for page to be interactive
    await page.waitForLoadState('domcontentloaded');
    
    const interactiveTime = Date.now() - startTime;
    
    // Interactive time should be less than 3.5 seconds
    expect(interactiveTime).toBeLessThan(3500);
  });

  test('No layout shifts during user interaction', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /connect/i }).click();
    await page.waitForTimeout(1000);
    
    // Track layout shifts
    let clsValue = 0;
    await page.evaluate(() => {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsValue += (entry as any).value;
          }
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
    });
    
    // Perform some interactions
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    
    // Wait for any potential layout shifts
    await page.waitForTimeout(1000);
    
    // CLS should still be low after interactions
    expect(clsValue).toBeLessThan(0.1);
  });

  test('Resources are loaded efficiently', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const resources = await page.evaluate(() => {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.initiatorType,
        duration: entry.duration,
        transferSize: entry.transferSize,
      }));
    });
    
    // Check that no resource takes more than 1 second to load
    const slowResources = resources.filter((r) => r.duration > 1000);
    expect(slowResources).toHaveLength(0);
    
    // Check that total transfer size is reasonable
    const totalTransferSize = resources.reduce((sum, r) => sum + r.transferSize, 0);
    expect(totalTransferSize).toBeLessThan(500000); // 500KB
  });
});

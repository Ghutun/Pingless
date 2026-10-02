const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');

const PORT = process.env.PORT || 10000;
const SERVER_ID = process.env.SERVER_ID;
const AFK_SECONDS = parseInt(process.env.AFK_SECONDS || '1800', 10);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'alive', uptime: process.uptime() }));
});
server.listen(PORT, () => log(`[SERVER] listening on port ${PORT}`));

function getBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  }).then(browser => {
    return browser.newContext({
      storageState: './storage_state.json',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }).then(context => ({ browser, context }));
  });
}

// --- Renew every 48 hours ---
async function renewServer() {
  log('[RENEW] Starting renewal...');
  const { browser, context } = await getBrowser();
  const page = await context.newPage();
  try {
    await page.goto(`https://dash.pingless.org/servers/${SERVER_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
    const renewBtn = page.locator('button', { hasText: /renew/i }).first();
    if (await renewBtn.isVisible().catch(() => false)) {
      await renewBtn.click();
      await page.waitForTimeout(3000);
      const confirmBtn = page.locator('button', { hasText: /confirm|yes|renew/i }).last();
      if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
      log('[RENEW] ✅ Done');
    } else {
      log('[RENEW] No renew button found (already renewed?)');
    }
  } catch (e) {
    log(`[RENEW] ERROR: ${e.message}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

// --- Claim daily reward every 18 hours ---
async function claimReward() {
  log('[REWARD] Claiming daily reward...');
  const { browser, context } = await getBrowser();
  const page = await context.newPage();
  try {
    await page.goto('https://dash.pingless.org/', { waitUntil: 'networkidle', timeout: 30000 });

    // Look for reward/claim button on dashboard
    const rewardBtn = page.locator('button, a', { hasText: /claim|reward|daily/i }).first();
    if (await rewardBtn.isVisible().catch(() => false)) {
      await rewardBtn.click();
      await page.waitForTimeout(3000);
      log('[REWARD] ✅ Claimed');
    } else {
      // Maybe it's in a dropdown or profile menu
      const menu = page.locator('[class*="menu"], [class*="dropdown"], [class*="profile"]').first();
      if (await menu.isVisible().catch(() => false)) {
        await menu.click();
        await page.waitForTimeout(1000);
        const rewardItem = page.locator('text=/reward|daily|claim/i').first();
        if (await rewardItem.isVisible().catch(() => false)) {
          await rewardItem.click();
          await page.waitForTimeout(3000);
          log('[REWARD] ✅ Claimed (via menu)');
        }
      } else {
        log('[REWARD] No reward button found (already claimed?)');
      }
    }
  } catch (e) {
    log(`[REWARD] ERROR: ${e.message}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

// --- AFK ---
async function afkCycle() {
  log(`[AFK] Starting for ${AFK_SECONDS}s...`);
  const { browser, context } = await getBrowser();
  const page = await context.newPage();
  try {
    await page.goto('https://dash.pingless.org/afk', { waitUntil: 'networkidle', timeout: 30000 });
    const startBtn = page.locator('button', { hasText: /start|collect|afk/i }).first();
    if (await startBtn.isVisible().catch(() => false)) {
      await startBtn.click();
      await page.waitForTimeout(2000);
    }
    const interval = 30000;
    const totalChecks = Math.ceil(AFK_SECONDS / (interval / 1000));
    for (let i = 0; i < totalChecks; i++) {
      await page.waitForTimeout(interval);
      await page.evaluate(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
      }).catch(() => {});
      log(`[AFK] ${((i + 1) / totalChecks * 100).toFixed(0)}%`);
    }
    log('[AFK] ✅ Complete');
  } catch (e) {
    log(`[AFK] ERROR: ${e.message}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

// --- Schedules ---
log('[START] Pingless bot running');

// Run everything once on startup
claimReward();
renewServer();
afkCycle();

// Then on intervals
setInterval(renewServer, 48 * 60 * 60 * 1000);   // every 48h
setInterval(claimReward, 18 * 60 * 60 * 1000);   // every 18h
setInterval(afkCycle, 4 * 60 * 60 * 1000);       // every 4h (adjust if needed)

process.on('SIGTERM', () => {
  log('SIGTERM, shutting down...');
  server.close(() => process.exit(0));
});   

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');

const PORT = process.env.PORT || 10000;
const SERVER_ID = process.env.SERVER_ID;
const AFK_SECONDS = parseInt(process.env.AFK_SECONDS || '1800', 10);
const RENEW = process.env.RENEW !== 'false';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- HTTP server (keeps Render from spinning down) ---
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'alive', uptime: process.uptime() }));
});
server.listen(PORT, () => log(`[SERVER] listening on port ${PORT}`));

// --- AFK cycle ---
async function afkCycle() {
  const storagePath = process.env.STORAGE_STATE_PATH || './storage_state.json';
  if (!fs.existsSync(storagePath)) {
    log('ERROR: storage_state.json not found');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    storageState: storagePath,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // Renew
    if (RENEW && SERVER_ID) {
      log(`Renewing server ${SERVER_ID}...`);
      await page.goto(`https://dash.pingless.org/servers/${SERVER_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
      const renewBtn = page.locator('button', { hasText: /renew/i }).first();
      if (await renewBtn.isVisible().catch(() => false)) {
        await renewBtn.click();
        await page.waitForTimeout(3000);
        const confirmBtn = page.locator('button', { hasText: /confirm|yes|renew/i }).last();
        if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
        log('✅ Renewal attempted');
      }
    }

    // AFK
    log(`Starting AFK for ${AFK_SECONDS}s...`);
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
      log(`AFK: ${((i + 1) / totalChecks * 100).toFixed(0)}%`);
    }
    log('✅ AFK session complete');

  } catch (err) {
    log(`ERROR: ${err.message}`);
    try { await page.screenshot({ path: 'error.png' }); } catch {}
  } finally {
    await context.close();
    await browser.close();
  }
}

// --- Run on schedule ---
log('[START] Pingless bot running');
afkCycle();
setInterval(afkCycle, 4 * 60 * 60 * 1000); // every 4 hours

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});   

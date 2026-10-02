const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');

const PORT = process.env.PORT || 10000;
const SERVER_ID = process.env.SERVER_ID;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- HTTP server (Render keep-alive) ---
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'alive', uptime: process.uptime() }));
});
server.listen(PORT, () => log(`[SERVER] listening on port ${PORT}`));

// --- AFK: persistent browser (24/7) ---
async function startAFK() {
  log('[AFK] Starting persistent AFK session...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    storageState: './storage_state.json',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto('https://dash.pingless.org/afk', { waitUntil: 'networkidle', timeout: 30000 });

    const startBtn = page.locator('button', { hasText: /start|collect|afk/i }).first();
    if (await startBtn.isVisible().catch(() => false)) {
      await startBtn.click();
      log('[AFK] Clicked start');
    }
    log('[AFK] ✅ Running 24/7');

    // Keep alive: mousemove every 30s + reload if page dies
    setInterval(async () => {
      try {
        await page.evaluate(() => {
          document.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.random() * 500, clientY: Math.random() * 500 }));
        });
      } catch (e) {
        // Page crashed — reload
        log('[AFK] Page died, reloading...');
        try {
          await page.goto('https://dash.pingless.org/afk', { waitUntil: 'networkidle', timeout: 30000 });
          const btn = page.locator('button', { hasText: /start|collect|afk/i }).first();
          if (await btn.isVisible().catch(() => false)) await btn.click();
          log('[AFK] ✅ Recovered');
        } catch (e2) {
          log(`[AFK] Reload failed: ${e2.message}`);
        }
      }
    }, 30000);

  } catch (e) {
    log(`[AFK] ERROR: ${e.message}`);
    await browser.close();
    // Retry in 5 min
    setTimeout(startAFK, 5 * 60 * 1000);
  }
}

// --- Claim daily reward (every 24h) ---
async function claimReward() {
  log('[REWARD] Claiming daily reward...');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      storageState: './storage_state.json',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    await page.goto('https://dash.pingless.org/dashboard', { waitUntil: 'networkidle', timeout: 30000 });

    const claimBtn = page.locator('button', { hasText: /claim/i }).first();
    if (await claimBtn.isVisible().catch(() => false)) {
      await claimBtn.click();
      await page.waitForTimeout(3000);
      log('[REWARD] ✅ Claimed 150 credits');
    } else {
      log('[REWARD] No claim button (already claimed)');
    }
  } catch (e) {
    log(`[REWARD] ERROR: ${e.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

// --- Renew server (every 48h, costs 500 credits) ---
async function renewServer() {
  log('[RENEW] Renewing server (500 credits)...');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      storageState: './storage_state.json',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    await page.goto(`https://dash.pingless.org/servers/${SERVER_ID}`, { waitUntil: 'networkidle', timeout: 30000 });

    const renewBtn = page.locator('button', { hasText: /renew/i }).first();
    if (await renewBtn.isVisible().catch(() => false)) {
      await renewBtn.click();
      await page.waitForTimeout(3000);
      const confirmBtn = page.locator('button', { hasText: /confirm|yes|renew/i }).last();
      if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
      await page.waitForTimeout(2000);
      log('[RENEW] ✅ Done (-500 credits)');
    } else {
      log('[RENEW] No renew button found (already renewed?)');
    }
  } catch (e) {
    log(`[RENEW] ERROR: ${e.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

// --- Startup ---
log('[START] Pingless bot v2');
startAFK();
claimReward();
renewServer();

setInterval(claimReward, 24 * 60 * 60 * 1000);  // every 24h
setInterval(renewServer, 48 * 60 * 60 * 1000);  // every 48h

process.on('SIGTERM', () => {
  log('SIGTERM, shutting down...');
  server.close(() => process.exit(0));
});   

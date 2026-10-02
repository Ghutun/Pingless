const { chromium } = require('playwright');
const http = require('http');

const PORT = process.env.PORT || 10000;
const SERVER_ID = '1488944a';
const SESSION = 's%3AaQiZM6asrmiAcuxbtOaRTJA4WW7mU4R1.j6CRk%2B9fHfCXRCaZBqRz8dFMHrGG8TptVv%2FzM69xHP4';
const USER_ID = '342814841943228420';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const server = http.createServer((q, s) => s.end('alive'));
server.listen(PORT, () => log(`[SERVER] listening on ${PORT}`));

async function getBrowser() {
  log('[BROWSER] Launching Chromium...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  log('[BROWSER] Launched OK');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  await context.addCookies([
    { name: 'pingless.session', value: SESSION, domain: 'dash.pingless.org', path: '/', secure: true, httpOnly: true },
    { name: 'userId', value: USER_ID, domain: 'dash.pingless.org', path: '/', secure: true }
  ]);
  log('[BROWSER] Cookies set');
  return { browser, context };
}

// --- AFK: just open the page and stay there ---
async function startAFK() {
  log('[AFK] Starting...');
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();

    log('[AFK] Navigating to /afk...');
    const resp = await page.goto('https://dash.pingless.org/afk', { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[AFK] Page loaded, status: ${resp ? resp.status() : 'no response'}`);

    // Wait a bit for Cloudflare challenge to resolve
    await page.waitForTimeout(5000);
    const title = await page.title().catch(() => 'unknown');
    log(`[AFK] Page title: "${title}"`);

    // Screenshot for debugging
    await page.screenshot({ path: '/tmp/afk.png' }).catch(() => {});
    log('[AFK] Screenshot saved to /tmp/afk.png');

    // Keep alive: mousemove every 30s
    log('[AFK] ✅ Running 24/7, keeping page alive...');
    setInterval(async () => {
      try {
        await page.evaluate(() => {
          document.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.random() * 500, clientY: Math.random() * 500 }));
        });
      } catch (e) {
        log(`[AFK] Page died: ${e.message}, reloading...`);
        try {
          await page.goto('https://dash.pingless.org/afk', { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(5000);
          log('[AFK] ✅ Recovered');
        } catch (e2) {
          log(`[AFK] Reload failed: ${e2.message}`);
        }
      }
    }, 30000);

  } catch (e) {
    log(`[AFK] ERROR: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
    log('[AFK] Retrying in 5 min...');
    setTimeout(startAFK, 5 * 60 * 1000);
  }
}

// --- Claim daily reward (every 24h) ---
async function claimReward() {
  log('[REWARD] Starting...');
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();

    log('[REWARD] Navigating to /dashboard...');
    const resp = await page.goto('https://dash.pingless.org/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[REWARD] Page loaded, status: ${resp ? resp.status() : 'no response'}`);
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    log(`[REWARD] Page title: "${title}"`);

    // Look for claim button
    const claimBtn = page.locator('button', { hasText: /claim/i }).first();
    const visible = await claimBtn.isVisible().catch(() => false);
    log(`[REWARD] Claim button visible: ${visible}`);

    if (visible) {
      await claimBtn.click();
      await page.waitForTimeout(3000);
      log('[REWARD] ✅ Claimed');
    } else {
      log('[REWARD] No claim button found (already claimed or not available)');
    }

    await page.screenshot({ path: '/tmp/reward.png' }).catch(() => {});
  } catch (e) {
    log(`[REWARD] ERROR: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- Renew server (every 48h) ---
async function renewServer() {
  log(`[RENEW] Starting... (server: ${SERVER_ID})`);
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();

    const url = `https://dash.pingless.org/servers/${SERVER_ID}`;
    log(`[RENEW] Navigating to ${url}...`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[RENEW] Page loaded, status: ${resp ? resp.status() : 'no response'}`);
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    log(`[RENEW] Page title: "${title}"`);

    const renewBtn = page.locator('button', { hasText: /renew/i }).first();
    const visible = await renewBtn.isVisible().catch(() => false);
    log(`[RENEW] Renew button visible: ${visible}`);

    if (visible) {
      await renewBtn.click();
      await page.waitForTimeout(3000);
      const confirmBtn = page.locator('button', { hasText: /confirm|yes/i }).last();
      const confVisible = await confirmBtn.isVisible().catch(() => false);
      log(`[RENEW] Confirm button visible: ${confVisible}`);
      if (confVisible) {
        await confirmBtn.click();
        await page.waitForTimeout(2000);
      }
      log('[RENEW] ✅ Done');
    } else {
      log('[RENEW] No renew button (already renewed?)');
    }

    await page.screenshot({ path: '/tmp/renew.png' }).catch(() => {});
  } catch (e) {
    log(`[RENEW] ERROR: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- Start ---
log('[START] Pingless bot v3');
log(`[START] Server ID: ${SERVER_ID}`);
log(`[START] Session: ${SESSION.slice(0, 20)}...`);

startAFK();
claimReward();
renewServer();

setInterval(claimReward, 24 * 60 * 60 * 1000);
setInterval(renewServer, 48 * 60 * 60 * 1000);

process.on('SIGTERM', () => {
  log('SIGTERM received');
  server.close(() => process.exit(0));
});   

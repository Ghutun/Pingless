const { chromium } = require('playwright');
const http = require('http');

const PORT = process.env.PORT || 10000;
const SERVER_ID = '1488944a';
const SID = 's%3AaQiZM6asrmiAcuxbtOaRTJA4WW7mU4R1.j6CRk%2B9fHfCXRCaZBqRz8dFMHrGG8TptVv%2FzM69xHP4';
const USER_ID = '342814841943228420';
const HOST = 'dash.pingless.org';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const server = http.createServer((q, s) => s.end('alive'));
server.listen(PORT, () => log(`[SERVER] listening on ${PORT}`));

async function getBrowser() {
  log('[BROWSER] Launching...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  await context.addCookies([
    { name: 'pingless.sid', value: SID, domain: HOST, path: '/', secure: true, httpOnly: true },
    { name: 'userId', value: USER_ID, domain: HOST, path: '/', secure: true }
  ]);
  log('[BROWSER] Ready');
  return { browser, context };
}

// --- AFK: open page, stay there forever ---
async function startAFK() {
  log('[AFK] Starting...');
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();

    log('[AFK] Opening /afk...');
    const resp = await page.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[AFK] Status: ${resp ? resp.status() : 'none'}`);
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    log(`[AFK] Title: "${title}"`);

    if (title.includes('Login')) {
      log('[AFK] ❌ NOT LOGGED IN - cookie expired');
      return;
    }

    log('[AFK] ✅ Connected, staying open 24/7');

    setInterval(async () => {
      try {
        await page.evaluate(() => {
          document.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.random() * 500, clientY: Math.random() * 500 }));
        });
      } catch (e) {
        log(`[AFK] Page died, reloading...`);
        try {
          await page.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
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
    setTimeout(startAFK, 5 * 60 * 1000);
  }
}

// --- Claim daily reward ---
async function claimReward() {
  log('[REWARD] Starting...');
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();

    const resp = await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[REWARD] Status: ${resp ? resp.status() : 'none'}`);
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    log(`[REWARD] Title: "${title}"`);

    if (title.includes('Login')) {
      log('[REWARD] ❌ NOT LOGGED IN');
      return;
    }

    const claimBtn = page.locator('button', { hasText: /claim/i }).first();
    const visible = await claimBtn.isVisible().catch(() => false);
    log(`[REWARD] Button visible: ${visible}`);

    if (visible) {
      await claimBtn.click();
      await page.waitForTimeout(3000);
      log('[REWARD] ✅ Claimed');
    } else {
      log('[REWARD] Not available right now');
    }
  } catch (e) {
    log(`[REWARD] ERROR: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- Renew server ---
async function renewServer() {
  log(`[RENEW] Starting (server: ${SERVER_ID})...`);
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();

    // Try the server page
    const url = `https://${HOST}/servers/${SERVER_ID}`;
    log(`[RENEW] Opening ${url}`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[RENEW] Status: ${resp ? resp.status() : 'none'}`);
    await page.waitForTimeout(5000);

    let title = await page.title().catch(() => 'unknown');
    log(`[RENEW] Title: "${title}"`);

    if (title.includes('Login')) {
      log('[RENEW] ❌ NOT LOGGED IN');
      return;
    }

    if (title.includes('404')) {
      // Try alternative URL formats
      const altUrls = [
        `https://${HOST}/server/${SERVER_ID}`,
        `https://${HOST}/panel/${SERVER_ID}`,
        `https://${HOST}/servers/${SERVER_ID}/panel`,
      ];
      for (const alt of altUrls) {
        log(`[RENEW] Trying ${alt}`);
        const r2 = await page.goto(alt, { waitUntil: 'domcontentloaded', timeout: 30000 });
        title = await page.title().catch(() => 'unknown');
        log(`[RENEW] Title: "${title}"`);
        if (!title.includes('404') && !title.includes('Login')) {
          log(`[RENEW] ✅ Found working URL: ${alt}`);
          break;
        }
      }
      if (title.includes('404') || title.includes('Login')) {
        log('[RENEW] ❌ Could not find server page - check SERVER_ID');
        return;
      }
    }

    // Look for renew button
    const renewBtn = page.locator('button, a', { hasText: /renew/i }).first();
    const visible = await renewBtn.isVisible().catch(() => false);
    log(`[RENEW] Button visible: ${visible}`);

    if (visible) {
      await renewBtn.click();
      await page.waitForTimeout(3000);
      // Check for confirm dialog
      const confirmBtn = page.locator('button', { hasText: /confirm|yes|renew/i }).last();
      const confVis = await confirmBtn.isVisible().catch(() => false);
      if (confVis) {
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }
      log('[RENEW] ✅ Done');
    } else {
      log('[RENEW] No renew button found - screenshot saved');
      await page.screenshot({ path: '/tmp/renew.png' }).catch(() => {});
    }
  } catch (e) {
    log(`[RENEW] ERROR: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- START ---
log('[START] Pingless bot v4');
log(`[START] Host: ${HOST}`);
log(`[START] Server: ${SERVER_ID}`);
log(`[START] SID: ${SID.slice(0, 15)}...`);

// Run everything immediately (server is already expired)
renewServer();
claimReward();
startAFK();

// Then on schedule
setInterval(claimReward, 24 * 60 * 60 * 1000);
setInterval(renewServer, 48 * 60 * 60 * 1000);

process.on('SIGTERM', () => {
  log('SIGTERM');
  server.close(() => process.exit(0));
});   

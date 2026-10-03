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

let browser, context;

async function initBrowser() {
  log('[BROWSER] Launching...');
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  await context.addCookies([
    { name: 'pingless.sid', value: SID, domain: HOST, path: '/', secure: true, httpOnly: true },
    { name: 'userId', value: USER_ID, domain: HOST, path: '/', secure: true }
  ]);
  log('[BROWSER] Ready');
}

async function blockAds(page) {
  await page.route('**/*', (route) => {
    if (route.request().url().includes('pingless.org')) route.continue();
    else route.abort();
  });
}

// --- AFK: persistent tab ---
let afkPage;

async function startAFK() {
  log('[AFK] Opening /afk...');
  afkPage = await context.newPage();
  await blockAds(afkPage);
  const resp = await afkPage.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  log(`[AFK] Status: ${resp ? resp.status() : 'none'}`);
  await afkPage.waitForTimeout(5000);

  const title = await afkPage.title().catch(() => 'unknown');
  log(`[AFK] Title: "${title}"`);

  if (title.includes('Login')) {
    log('[AFK] ❌ NOT LOGGED IN');
    return false;
  }

  log('[AFK] ✅ Running 24/7');

  setInterval(async () => {
    try {
      await afkPage.evaluate(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.random() * 500, clientY: Math.random() * 500 }));
      });
      if (!afkPage.url().includes('/afk')) {
        log('[AFK] Redirected, going back...');
        await afkPage.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await afkPage.waitForTimeout(3000);
      }
    } catch (e) {
      log(`[AFK] Page died, reloading...`);
      try {
        await afkPage.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await afkPage.waitForTimeout(5000);
        log('[AFK] ✅ Recovered');
      } catch (e2) {
        log(`[AFK] Reload failed: ${e2.message}`);
      }
    }
  }, 30000);
  return true;
}

// --- Claim reward (uses same browser, new tab) ---
async function claimReward() {
  log('[REWARD] Starting...');
  const page = await context.newPage();
  await blockAds(page);
  try {
    const resp = await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[REWARD] Status: ${resp ? resp.status() : 'none'}`);
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    log(`[REWARD] Title: "${title}"`);

    if (title.includes('Login')) {
      log('[REWARD] ❌ NOT LOGGED IN');
      return;
    }

    // Try multiple selectors
    const selectors = [
      'button:has-text("Claim")',
      'button:has-text("claim")',
      'button:has-text("Collect")',
      'button:has-text("collect")',
      '[class*="claim"]',
      '[class*="reward"] button',
      'button:has-text("150")',
    ];

    let clicked = false;
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        log(`[REWARD] Found button: "${sel}"`);
        await btn.click();
        await page.waitForTimeout(3000);
        log('[REWARD] ✅ Claimed');
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      log('[REWARD] No claim button found (already claimed?)');
      await page.screenshot({ path: '/tmp/reward.png' }).catch(() => {});
    }
  } catch (e) {
    log(`[REWARD] ERROR: ${e.message}`);
  } finally {
    await page.close();
  }
}

// --- Renew (uses same browser, new tab) ---
async function renewServer() {
  log(`[RENEW] Starting...`);
  const page = await context.newPage();
  await blockAds(page);
  try {
    const url = `https://${HOST}/panel/${SERVER_ID}`;
    log(`[RENEW] Opening ${url}`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[RENEW] Status: ${resp ? resp.status() : 'none'}`);
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    log(`[RENEW] Title: "${title}"`);

    if (title.includes('Login')) {
      log('[RENEW] ❌ NOT LOGGED IN');
      return;
    }
    if (title.includes('404')) {
      log('[RENEW] ❌ 404');
      return;
    }

    const selectors = [
      'button:has-text("Renew")',
      'button:has-text("renew")',
      'button:has-text("Restore")',
      'button:has-text("restore")',
      'button:has-text("Reactivate")',
      'a:has-text("Renew")',
      'a:has-text("renew")',
    ];

    let clicked = false;
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        log(`[RENEW] Found button: "${sel}"`);
        await btn.click();
        await page.waitForTimeout(3000);

        // Confirm dialog
        const confSelectors = ['button:has-text("Confirm")', 'button:has-text("Yes")', 'button:has-text("renew")', 'button:has-text("Confirm")'];
        for (const cs of confSelectors) {
          const cb = page.locator(cs).last();
          if (await cb.isVisible().catch(() => false)) {
            await cb.click();
            await page.waitForTimeout(3000);
            break;
          }
        }
        log('[RENEW] ✅ Done');
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      log('[RENEW] No renew button found');
      await page.screenshot({ path: '/tmp/renew.png' }).catch(() => {});
    }
  } catch (e) {
    log(`[RENEW] ERROR: ${e.message}`);
  } finally {
    await page.close();
  }
}

// --- START (sequential, like SkyCastle) ---
async function main() {
  log('[START] Pingless bot v6');
  await initBrowser();

  const afkOk = await startAFK();
  if (!afkOk) {
    log('[START] ❌ Failed to login, retrying in 5 min...');
    setTimeout(main, 5 * 60 * 1000);
    return;
  }

  await claimReward();
  await renewServer();

  log('[START] ✅ All tasks complete, running on schedule');

  setInterval(claimReward, 24 * 60 * 60 * 1000);
  setInterval(renewServer, 48 * 60 * 60 * 1000);
}

main();

process.on('SIGTERM', () => {
  log('SIGTERM');
  if (browser) browser.close().catch(() => {});
  server.close(() => process.exit(0));
});   

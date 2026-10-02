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
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  await context.addCookies([
    { name: 'pingless.session', value: SESSION, domain: 'dash.pingless.org', path: '/', secure: true, httpOnly: true },
    { name: 'userId', value: USER_ID, domain: 'dash.pingless.org', path: '/', secure: true }
  ]);
  return { browser, context };
}

async function afkTick() {
  log('[AFK] Pinging...');
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto('https://dash.pingless.org/afk', { waitUntil: 'networkidle', timeout: 30000 });
    const startBtn = page.locator('button', { hasText: /start|collect|afk/i }).first();
    if (await startBtn.isVisible().catch(() => false)) {
      await startBtn.click();
      log('[AFK] ✅ Started');
    } else {
      log('[AFK] Already running or button not found');
    }
  } catch (e) { log(`[AFK] ERROR: ${e.message}`); }
  finally { if (browser) await browser.close(); }
}

async function claimReward() {
  log('[REWARD] Claiming...');
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto('https://dash.pingless.org/dashboard', { waitUntil: 'networkidle', timeout: 30000 });
    const claimBtn = page.locator('button', { hasText: /claim/i }).first();
    if (await claimBtn.isVisible().catch(() => false)) {
      await claimBtn.click();
      await page.waitForTimeout(3000);
      log('[REWARD] ✅ Claimed');
    } else {
      log('[REWARD] Not claimable');
    }
  } catch (e) { log(`[REWARD] ERROR: ${e.message}`); }
  finally { if (browser) await browser.close(); }
}

async function renewServer() {
  log(`[RENEW] Renewing ${SERVER_ID} (500 credits)...`);
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(`https://dash.pingless.org/servers/${SERVER_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
    const renewBtn = page.locator('button', { hasText: /renew/i }).first();
    if (await renewBtn.isVisible().catch(() => false)) {
      await renewBtn.click();
      await page.waitForTimeout(3000);
      const confirmBtn = page.locator('button', { hasText: /confirm|yes/i }).last();
      if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
      log('[RENEW] ✅ Done');
    } else {
      log('[RENEW] No renew button (already renewed?)');
    }
  } catch (e) { log(`[RENEW] ERROR: ${e.message}`); }
  finally { if (browser) await browser.close(); }
}

log('[START] Pingless bot (Playwright)');
afkTick();
claimReward();
renewServer();

setInterval(afkTick, 60000);
setInterval(claimReward, 24 * 60 * 60 * 1000);
setInterval(renewServer, 48 * 60 * 60 * 1000);

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });   

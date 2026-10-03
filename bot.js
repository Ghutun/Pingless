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

let browser, context, afkPage;
let lastCredits = -1;

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

async function getPageState(page) {
  return await page.evaluate(() => {
    return {
      title: document.title,
      text: document.body.innerText.slice(0, 3000)
    };
  });
}

function parseCredits(text) {
  const match = text.match(/([\d.]+)\s*credits?/i);
  return match ? parseFloat(match[1]) : -1;
}

function logCoinChange(current) {
  if (lastCredits >= 0 && current >= 0) {
    const diff = current - lastCredits;
    if (Math.abs(diff) >= 50) {
      log(`[COINS] ${lastCredits.toFixed(2)} → ${current.toFixed(2)} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)})`);
    }
  }
  lastCredits = current;
}

function parseRewardCooldown(text) {
  const timerMatch = text.match(/(\d{1,2}:\d{2}:\d{2})/);
  const claimReady = /reward.*?:\s*\d+\s*credits?/i.test(text) && !timerMatch;
  return { ready: claimReady, timer: timerMatch ? timerMatch[1] : null };
}

function parseServerExpiry(text) {
  const expired = /expired/i.test(text);

  // Try "Xh Ym" or "Xh" or "Xm" or "XX:XX:XX"
  let minutesLeft = null;

  const hMinMatch = text.match(/expires?\s+in\s+(\d+)h\s*(\d+)?m?/i);
  if (hMinMatch) {
    const h = parseInt(hMinMatch[1]);
    const m = hMinMatch[2] ? parseInt(hMinMatch[2]) : 0;
    minutesLeft = h * 60 + m;
  }

  const minOnlyMatch = text.match(/expires?\s+in\s+(\d+)m/i);
  if (minOnlyMatch && minutesLeft === null) {
    minutesLeft = parseInt(minOnlyMatch[1]);
  }

  const timerMatch = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (timerMatch && minutesLeft === null) {
    const h = parseInt(timerMatch[1]);
    const m = parseInt(timerMatch[2]);
    minutesLeft = h * 60 + m;
  }

  return { expired, minutesLeft };
}

// --- AFK ---
async function startAFK() {
  log('[AFK] Starting...');
  afkPage = await context.newPage();
  await blockAds(afkPage);

  const resp = await afkPage.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  log(`[AFK] Status: ${resp ? resp.status() : 'none'}`);
  await afkPage.waitForTimeout(5000);

  const state = await getPageState(afkPage);
  log(`[AFK] Title: "${state.title}"`);

  if (state.title.includes('Login') || state.text.includes('Sign in')) {
    log('[AFK] ❌ NOT LOGGED IN');
    return false;
  }

  const credits = parseCredits(state.text);
  log(`[AFK] Credits: ${credits}`);
  lastCredits = credits;
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
        log('[AFK] ✅ Back');
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

// --- Smart reward ---
async function checkReward() {
  log('[REWARD] Checking...');
  const page = await context.newPage();
  await blockAds(page);
  try {
    await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const state = await getPageState(page);
    if (state.title.includes('Login')) {
      log('[REWARD] ❌ NOT LOGGED IN');
      return;
    }

    const credits = parseCredits(state.text);
    logCoinChange(credits);

    const { ready, timer } = parseRewardCooldown(state.text);
    log(`[REWARD] Ready: ${ready}, Timer: ${timer || 'none'}`);

    if (!ready) {
      log(`[REWARD] ⏳ Cooldown (${timer}), skipping`);
      return;
    }

    const selectors = [
      'button:has-text("Reward")',
      'button:has-text("Claim")',
      'button:has-text("Collect")',
      'button:has-text("150")',
    ];

    let clicked = false;
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        const btnText = await btn.textContent().catch(() => '');
        log(`[REWARD] Clicking: "${btnText.trim()}"`);
        await btn.click();
        await page.waitForTimeout(3000);

        // Log coins after claim
        const afterState = await getPageState(page);
        const afterCredits = parseCredits(afterState.text);
        if (afterCredits >= 0) {
          log(`[COINS] ${lastCredits.toFixed(2)} → ${afterCredits.toFixed(2)} (+${(afterCredits - lastCredits).toFixed(2)})`);
          lastCredits = afterCredits;
        }
        log('[REWARD] ✅ Claimed');
        clicked = true;
        break;
      }
    }
    if (!clicked) log('[REWARD] No button found');
  } catch (e) {
    log(`[REWARD] ERROR: ${e.message}`);
  } finally {
    await page.close();
  }
}

// --- Smart renewal (only when 30 min left or expired) ---
async function checkRenewal() {
  log('[RENEW] Checking...');
  const page = await context.newPage();
  await blockAds(page);
  try {
    // Check credits first
    await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const dashState = await getPageState(page);
    if (dashState.title.includes('Login')) {
      log('[RENEW] ❌ NOT LOGGED IN');
      return;
    }

    const credits = parseCredits(dashState.text);
    logCoinChange(credits);
    log(`[RENEW] Credits: ${credits}`);

    if (credits >= 0 && credits < 500) {
      log(`[RENEW] ⏳ Not enough credits (${credits} < 500), skipping`);
      return;
    }

    // Check server expiry
    const panelUrl = `https://${HOST}/panel/${SERVER_ID}`;
    await page.goto(panelUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const panelState = await getPageState(page);
    log(`[RENEW] Panel: "${panelState.title}"`);

    if (panelState.title.includes('404')) {
      log('[RENEW] ❌ 404');
      return;
    }

    const { expired, minutesLeft } = parseServerExpiry(panelState.text);
    log(`[RENEW] Expired: ${expired}, Minutes left: ${minutesLeft}`);

    // Only renew if expired OR 30 min or less remaining
    const shouldRenew = expired || (minutesLeft !== null && minutesLeft <= 30);

    if (!shouldRenew) {
      log(`[RENEW] ⏳ Server active (${minutesLeft}m left), skipping`);
      return;
    }

    log('[RENEW] ✅ Renewing now');

    const selectors = [
      'button:has-text("Renew")',
      'button:has-text("renew")',
      'button:has-text("Restore")',
      'button:has-text("Reactivate")',
      'a:has-text("Renew")',
    ];

    let clicked = false;
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        const btnText = await btn.textContent().catch(() => '');
        log(`[RENEW] Clicking: "${btnText.trim()}"`);
        await btn.click();
        await page.waitForTimeout(3000);

        const confSelectors = ['button:has-text("Confirm")', 'button:has-text("Yes")', 'button:has-text("OK")'];
        for (const cs of confSelectors) {
          const cb = page.locator(cs).last();
          if (await cb.isVisible().catch(() => false)) {
            await cb.click();
            await page.waitForTimeout(3000);
            break;
          }
        }

        // Log coins after renewal
        const afterState = await getPageState(page);
        const afterCredits = parseCredits(afterState.text);
        if (afterCredits >= 0) {
          log(`[COINS] ${lastCredits.toFixed(2)} → ${afterCredits.toFixed(2)} (${(afterCredits - lastCredits).toFixed(2)})`);
          lastCredits = afterCredits;
        }
        log('[RENEW] ✅ Done (-500)');
        clicked = true;
        break;
      }
    }
    if (!clicked) log('[RENEW] No renew button found');
  } catch (e) {
    log(`[RENEW] ERROR: ${e.message}`);
  } finally {
    await page.close();
  }
}

// --- Main loop ---
async function checkAll() {
  log('--- CHECK ---');
  try {
    await checkReward();
    await checkRenewal();
  } catch (e) {
    log(`[CHECK] Error: ${e.message}`);
  }
  log('--- END ---');
}

async function main() {
  log('[START] Pingless bot v8');
  await initBrowser();

  const afkOk = await startAFK();
  if (!afkOk) {
    log('[START] ❌ Login failed, retrying in 5 min...');
    setTimeout(main, 5 * 60 * 1000);
    return;
  }

  await checkAll();
  setInterval(checkAll, 30 * 60 * 1000);
}

main();

process.on('SIGTERM', () => {
  log('SIGTERM');
  if (browser) browser.close().catch(() => {});
  server.close(() => process.exit(0));
});   

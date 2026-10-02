const { chromium } = require('playwright');
const http = require('http');

const PORT = process.env.PORT || 10000;
const SERVER_ID = '1488944a';
const SID = 's%3AaQiZM6asrmiAcuxbtOaRTJA4WW7mU4R1.j6CRk%2B9fHfCXRCaZBqRz8dFMHrGG8TptVv%2FzM69xHP4';
const USER_ID = '342814841943228420';
const HOST = 'dash.pingless.org';
const RENEW_THRESHOLD_HOURS = 2; // renew when less than 2h left

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

// --- Check credits from dashboard ---
async function getCredits() {
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('pingless.org')) route.continue();
      else route.abort();
    });
    await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    if (title.includes('Login')) {
      log('[CREDITS] ❌ NOT LOGGED IN');
      return -1;
    }

    // Try to find credit balance on the page
    const pageText = await page.textContent('body').catch(() => '');
    const creditMatch = pageText.match(/(\d+\.?\d*)\s*(?:credits|₹|points)/i);
    if (creditMatch) {
      const credits = parseFloat(creditMatch[1]);
      log(`[CREDITS] Balance: ${credits}`);
      return credits;
    }

    // Fallback: look for any number near "credit" text
    const allText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const lines = allText.split('\n').filter(l => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (/credit/i.test(lines[i])) {
        const next = lines[i + 1] || lines[i];
        const num = next.match(/(\d+\.?\d*)/);
        if (num) {
          const credits = parseFloat(num[1]);
          log(`[CREDITS] Balance: ${credits} (from line: "${lines[i].trim()}")`);
          return credits;
        }
      }
    }

    log('[CREDITS] Could not parse balance, raw text snippet: ' + allText.slice(0, 200).replace(/\n/g, ' | '));
    return -1;
  } catch (e) {
    log(`[CREDITS] ERROR: ${e.message}`);
    return -1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- Check server remaining time ---
async function getServerTimeLeft() {
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('pingless.org')) route.continue();
      else route.abort();
    });

    const url = `https://${HOST}/panel/${SERVER_ID}`;
    log(`[RENEW-CHECK] Opening ${url}`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[RENEW-CHECK] Status: ${resp ? resp.status() : 'none'}`);
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    log(`[RENEW-CHECK] Title: "${title}"`);

    if (title.includes('Login')) {
      log('[RENEW-CHECK] ❌ NOT LOGGED IN');
      return -1;
    }
    if (title.includes('404')) {
      log('[RENEW-CHECK] ❌ 404 - server not found');
      return -1;
    }

    // Scrape remaining time from the page
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    log(`[RENEW-CHECK] Page text (first 300): ${pageText.slice(0, 300).replace(/\n/g, ' | ')}`);

    // Look for patterns like "Xh Ym left", "Expires in X hours", "X days Y hours"
    let hoursLeft = -1;

    // Pattern: "Xh" or "X hours"
    let m = pageText.match(/(\d+)\s*(?:h|hours?)(?:\s*(\d+)\s*(?:m|minutes?))?/i);
    if (m) {
      hoursLeft = parseInt(m[1]);
      if (m[2]) hoursLeft += parseInt(m[2]) / 60;
    }

    // Pattern: "X days Y hours"
    if (hoursLeft === -1) {
      m = pageText.match(/(\d+)\s*(?:d|days?)\s*(\d+)\s*(?:h|hours?)/i);
      if (m) {
        hoursLeft = parseInt(m[1]) * 24 + parseInt(m[2]);
      }
    }

    // Pattern: "Expires: [date]" - calculate diff
    if (hoursLeft === -1) {
      m = pageText.match(/(?:expires?|expiry|until)\s*:?\s*([\d/: \-]+)/i);
      if (m) {
        const expiryDate = new Date(m[1]);
        if (!isNaN(expiryDate.getTime())) {
          hoursLeft = (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60);
        }
      }
    }

    // Pattern: "Xm" (minutes only, server about to expire)
    if (hoursLeft === -1) {
      m = pageText.match(/(\d+)\s*(?:m|minutes?)\s*(?:left|remaining)/i);
      if (m) {
        hoursLeft = parseInt(m[1]) / 60;
      }
    }

    if (hoursLeft >= 0) {
      log(`[RENEW-CHECK] ⏰ Time remaining: ${hoursLeft.toFixed(1)} hours`);
    } else {
      log(`[RENEW-CHECK] ⚠️ Could not parse time remaining`);
    }

    return hoursLeft;
  } catch (e) {
    log(`[RENEW-CHECK] ERROR: ${e.message}`);
    return -1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- Smart renew: check time, renew if below threshold ---
async function smartRenew() {
  log('[RENEW] === Smart Renew Check ===');

  const hoursLeft = await getServerTimeLeft();

  if (hoursLeft === -1) {
    log('[RENEW] ⚠️ Could not determine time left. Attempting blind renew...');
    await doRenew();
    return;
  }

  if (hoursLeft <= RENEW_THRESHOLD_HOURS) {
    log(`[RENEW] ⚠️ Only ${hoursLeft.toFixed(1)}h left (threshold: ${RENEW_THRESHOLD_HOURS}h) → RENEWING NOW`);
    const creditsBefore = await getCredits();
    await doRenew();
    const creditsAfter = await getCredits();
    if (creditsBefore > 0 && creditsAfter > 0) {
      log(`[RENEW] 💰 Credits: ${creditsBefore} → ${creditsAfter} (spent: ${(creditsBefore - creditsAfter).toFixed(2)})`);
    }
    const newTime = await getServerTimeLeft();
    log(`[RENEW] ⏰ New time remaining: ${newTime >= 0 ? newTime.toFixed(1) + 'h' : 'unknown'}`);
  } else {
    log(`[RENEW] ✅ ${hoursLeft.toFixed(1)}h left - no renewal needed (threshold: ${RENEW_THRESHOLD_HOURS}h)`);
    log(`[RENEW] Next check in 1h`);
  }

  log('[RENEW] === End Smart Renew ===');
}

// --- Actual renew click ---
async function doRenew() {
  log('[RENEW] Clicking renew...');
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('pingless.org')) route.continue();
      else route.abort();
    });

    const url = `https://${HOST}/panel/${SERVER_ID}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const renewBtn = page.locator('button, a', { hasText: /renew|restore|reactivate|revive/i }).first();
    const visible = await renewBtn.isVisible().catch(() => false);
    log(`[RENEW] Button visible: ${visible}`);

    if (visible) {
      await renewBtn.click();
      await page.waitForTimeout(3000);
      const confirmBtn = page.locator('button', { hasText: /confirm|yes|renew|restore|pay/i }).last();
      const confVis = await confirmBtn.isVisible().catch(() => false);
      if (confVis) {
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }
      log('[RENEW] ✅ Renewal clicked');
    } else {
      log('[RENEW] ❌ No renew button found');
      await page.screenshot({ path: '/tmp/renew.png' }).catch(() => {});
    }
  } catch (e) {
    log(`[RENEW] ERROR: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- Claim daily reward ---
async function claimReward() {
  log('[REWARD] === Daily Reward Check ===');
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('pingless.org')) route.continue();
      else route.abort();
    });

    const resp = await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[REWARD] Status: ${resp ? resp.status() : 'none'}`);
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    log(`[REWARD] Title: "${title}"`);

    if (title.includes('Login')) {
      log('[REWARD] ❌ NOT LOGGED IN');
      return;
    }

    const creditsBefore = await getCredits();

    const claimBtn = page.locator('button', { hasText: /claim/i }).first();
    const visible = await claimBtn.isVisible().catch(() => false);
    log(`[REWARD] Button visible: ${visible}`);

    if (visible) {
      await claimBtn.click();
      await page.waitForTimeout(3000);
      log('[REWARD] ✅ Claimed!');
      const creditsAfter = await getCredits();
      if (creditsBefore > 0 && creditsAfter > 0) {
        log(`[REWARD] 💰 Credits: ${creditsBefore} → ${creditsAfter} (+${(creditsAfter - creditsBefore).toFixed(2)})`);
      }
    } else {
      log('[REWARD] Not available right now (already claimed?)');
    }
  } catch (e) {
    log(`[REWARD] ERROR: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- AFK: open page, block ads, stay forever ---
async function startAFK() {
  log('[AFK] Starting...');
  let browser;
  try {
    ({ browser } = await getBrowser());
    const context = browser.contexts()[0];
    const page = await context.newPage();

    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('pingless.org')) route.continue();
      else route.abort();
    });

    log('[AFK] Opening /afk...');
    const resp = await page.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log(`[AFK] Status: ${resp ? resp.status() : 'none'}`);
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => 'unknown');
    log(`[AFK] Title: "${title}"`);

    if (title.includes('Login')) {
      log('[AFK] ❌ NOT LOGGED IN - cookie expired');
      await browser.close();
      return;
    }

    log('[AFK] ✅ Connected, staying open 24/7');

    setInterval(async () => {
      try {
        await page.evaluate(() => {
          document.dispatchEvent(new MouseEvent('mousemove', { clientX: Math.random() * 500, clientY: Math.random() * 500 }));
        });
        const currentUrl = page.url();
        if (!currentUrl.includes('/afk')) {
          log(`[AFK] ⚠️ Redirected to ${currentUrl.slice(0, 60)}, going back...`);
          await page.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(3000);
          log('[AFK] ✅ Back on /afk');
        }
      } catch (e) {
        log(`[AFK] ⚠️ Page died, reloading...`);
        try {
          await page.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(5000);
          log('[AFK] ✅ Recovered');
        } catch (e2) {
          log(`[AFK] ❌ Reload failed: ${e2.message}`);
        }
      }
    }, 30000);

  } catch (e) {
    log(`[AFK] ❌ ERROR: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
    setTimeout(startAFK, 5 * 60 * 1000);
  }
}

// --- START ---
log('[START] ════════════════════════════════');
log('[START] Pingless bot v6');
log(`[START] Server: ${SERVER_ID}`);
log(`[START] Renew threshold: ${RENEW_THRESHOLD_HOURS}h`);
log('[START] ════════════════════════════════');

// Initial checks
const initialCredits = await getCredits();
log(`[START] Initial credits: ${initialCredits}`);

renewServer();
claimReward();
startAFK();

// Smart renew: check every 1 hour if we're close to expiry
setInterval(smartRenew, 60 * 60 * 1000); // every 1h

// Fallback: force renew every 48h regardless
setInterval(() => {
  log('[RENEW] 48h fallback timer hit - forcing renew');
  smartRenew();
}, 48 * 60 * 60 * 1000);

// Daily reward
setInterval(claimReward, 24 * 60 * 60 * 1000);

// Log credits every 6 hours for monitoring
setInterval(async () => {
  log('[MONITOR] === Periodic Credit Check ===');
  const c = await getCredits();
  log(`[MONITOR] Credits: ${c}`);
  log('[MONITOR] === End ===');
}, 6 * 60 * 60 * 1000);

process.on('SIGTERM', () => {
  log('SIGTERM');
  server.close(() => process.exit(0));
});   

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
let lastSessionEarned = 0;

// ==================== BROWSER ====================
async function initBrowser() {
  log('[BROWSER] Launching...');
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await context.addCookies([
    { name: 'pingless.sid', value: SID, domain: HOST, path: '/', secure: true, httpOnly: true },
    { name: 'userId', value: USER_ID, domain: HOST, path: '/', secure: true }
  ]);

  log('[BROWSER] Ready');
}

// ==================== SMART AD BLOCKER ====================
async function blockAds(page) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url().toLowerCase();
    const isNavigation = request.isNavigationRequest();
    const isMainFrame = request.frame() === page.mainFrame();

    if (url.includes('pingless.org')) return route.continue();

    if (
      url.includes('cloudflare.com') ||
      url.includes('cdn-cgi') ||
      url.includes('challenges.cloudflare.com') ||
      url.includes('cloudflareinsights.com')
    ) {
      return route.continue();
    }

    if (isNavigation && isMainFrame) {
      log(`[BLOCK] Blocked navigation → ${url}`);
      return route.abort();
    }

    return route.abort();
  });

  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url.includes('pingless.org')) {
      log(`[AFK] Left site → ${url}. Forcing back...`);
      try {
        await page.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        log(`[AFK] Force back failed: ${e.message}`);
      }
    }
  });
}

// ==================== HELPERS ====================
async function getPageState(page) {
  return await page.evaluate(() => ({
    title: document.title,
    text: document.body?.innerText?.slice(0, 9000) || '',
    url: location.href
  }));
}

function parseCredits(text) {
  const patterns = [
    /(?:balance|total|you have|credits?)[:\s]*([\d.]+)/i,
    /([\d.]+)\s*credits?/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const val = parseFloat(match[1]);
      if (!isNaN(val) && val >= 0) return val;
    }
  }
  return -1;
}

function logCoinChange(current) {
  if (lastCredits >= 0 && current >= 0) {
    const diff = current - lastCredits;
    if (Math.abs(diff) >= 0.4) {
      log(`[COINS] ${lastCredits.toFixed(2)} → ${current.toFixed(2)} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)})`);
    }
  }
  if (current >= 0) lastCredits = current;
}

function parseRewardInfo(text) {
  const available = /your daily reward is available/i.test(text) ||
                    /daily reward is available/i.test(text);

  // Specifically target "Next claim in"
  let timer = null;
  const match = text.match(/next claim in\s*(\d{1,2}:\d{2}:\d{2})/i);
  if (match) {
    timer = match[1];
  }

  return {
    available,
    timer,
    ready: available && !timer
  };
}

function parseServerExpiry(text) {
  const expired = /expired/i.test(text);
  let minutesLeft = null;

  const hMinMatch = text.match(/expires?\s+in\s+(\d+)h\s*(\d+)?m?/i);
  if (hMinMatch) {
    minutesLeft = parseInt(hMinMatch[1]) * 60 + (hMinMatch[2] ? parseInt(hMinMatch[2]) : 0);
  }

  const minOnlyMatch = text.match(/expires?\s+in\s+(\d+)m/i);
  if (minOnlyMatch && minutesLeft === null) {
    minutesLeft = parseInt(minOnlyMatch[1]);
  }

  const timerMatch = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (timerMatch && minutesLeft === null) {
    minutesLeft = parseInt(timerMatch[1]) * 60 + parseInt(timerMatch[2]);
  }

  return { expired, minutesLeft };
}

function parseAFKPage(text) {
  const connected = /connection status[\s\S]*?connected/i.test(text) || 
                    (/connected/i.test(text) && !/disconnected/i.test(text));

  // Active users
  let activeUsers = null;
  const usersMatch = text.match(/active users[\s\S]*?(\d+)/i) || 
                     text.match(/(\d+)\s*active users/i);
  if (usersMatch) activeUsers = parseInt(usersMatch[1]);

  // Current multiplier (x1.40)
  let multiplier = null;
  const multiMatch = text.match(/x(\d+\.\d+)/i);
  if (multiMatch) multiplier = multiMatch[1];

  // Earning rate
  let earningRate = null;
  const rateMatch = text.match(/([\d.]+)\s*credits?\/min/i);
  if (rateMatch) earningRate = parseFloat(rateMatch[1]);

  // Next reward seconds
  let nextRewardSec = null;
  const nextMatch = text.match(/next reward[\s\S]*?(\d+)\s*s/i) ||
                    text.match(/(\d+)\s*s/);
  if (nextMatch) nextRewardSec = parseInt(nextMatch[1]);

  // Session earned
  let sessionEarned = 0;
  const earnedMatch = text.match(/earned[\s\S]*?([+\-]?[\d.]+)\s*credits?/i);
  if (earnedMatch) {
    sessionEarned = parseFloat(earnedMatch[1]);
  }

  return { connected, activeUsers, multiplier, earningRate, nextRewardSec, sessionEarned };
}

// ==================== AFK ====================
async function startAFK() {
  log('[AFK] Starting...');
  afkPage = await context.newPage();
  await blockAds(afkPage);

  const resp = await afkPage.goto(`https://${HOST}/afk`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });
  log(`[AFK] Status: ${resp ? resp.status() : 'none'}`);
  await afkPage.waitForTimeout(6000);

  const state = await getPageState(afkPage);
  log(`[AFK] Title: "${state.title}"`);

  if (state.title.toLowerCase().includes('login') || state.text.includes('Sign in')) {
    log('[AFK] ❌ NOT LOGGED IN');
    return false;
  }

  const info = parseAFKPage(state.text);
  log(`[AFK] Connected: ${info.connected} | ${info.activeUsers || '?'} users | x${info.multiplier || '?'} | ${info.earningRate} c/min`);
  log('[AFK] ✅ Running 24/7');

  setInterval(async () => {
    try {
      if (afkPage.isClosed()) {
        log('[AFK] Page closed → recreating...');
        await startAFK();
        return;
      }

      const currentUrl = afkPage.url();
      const title = await afkPage.title().catch(() => 'unknown');

      if (
        title.toLowerCase().includes('just a moment') ||
        title.toLowerCase().includes('verify') ||
        title.toLowerCase().includes('cloudflare') ||
        title.toLowerCase().includes('login') ||
        !currentUrl.includes('/afk')
      ) {
        log(`[AFK] Bad state → "${title}"`);
        await afkPage.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await afkPage.waitForTimeout(5000);
        return;
      }

      // Activity
      await afkPage.evaluate(() => {
        document.dispatchEvent(new MouseEvent('mousemove', {
          clientX: Math.random() * window.innerWidth,
          clientY: Math.random() * window.innerHeight,
          bubbles: true
        }));
        window.scrollBy(0, (Math.random() - 0.5) * 40);
      });

      const state = await getPageState(afkPage);
      const info = parseAFKPage(state.text);

      // Earned this round
      let earnedThisRound = 0;
      if (info.sessionEarned > lastSessionEarned) {
        earnedThisRound = +(info.sessionEarned - lastSessionEarned).toFixed(2);
      }
      lastSessionEarned = info.sessionEarned;

      // Clean log line
      let status = `[AFK] `;
      status += info.connected ? 'Connected' : '⚠ Disconnected';
      if (info.activeUsers) status += ` | ${info.activeUsers} users`;
      if (info.multiplier) status += ` | x${info.multiplier}`;
      if (info.earningRate) status += ` | ${info.earningRate} c/min`;
      if (info.nextRewardSec !== null) status += ` | Next: ${info.nextRewardSec}s`;
      status += ` | Session: +${info.sessionEarned.toFixed(2)}`;
      if (earnedThisRound > 0) status += ` | +${earnedThisRound}`;

      log(status);

      const credits = parseCredits(state.text);
      if (credits >= 0) logCoinChange(credits);

    } catch (e) {
      log(`[AFK] Error: ${e.message}`);
      try {
        await afkPage.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await afkPage.waitForTimeout(5000);
        log('[AFK] Recovered');
      } catch (e2) {
        log(`[AFK] Recovery failed: ${e2.message}`);
      }
    }
  }, 40 * 1000);

  return true;
}

// ==================== REWARD ====================
async function checkReward() {
  log('[REWARD] Checking...');
  const page = await context.newPage();
  await blockAds(page);

  try {
    await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const state = await getPageState(page);

    if (state.title.toLowerCase().includes('login')) {
      log('[REWARD] ❌ NOT LOGGED IN');
      return;
    }

    const credits = parseCredits(state.text);
    logCoinChange(credits);

    const rewardInfo = parseRewardInfo(state.text);
    log(`[REWARD] Available: ${rewardInfo.available} | Timer: ${rewardInfo.timer || 'none'} | Ready: ${rewardInfo.ready}`);

    if (!rewardInfo.ready) {
      log(`[REWARD] ⏳ Not ready (Timer: ${rewardInfo.timer}), skipping`);
      return;
    }

    const selectors = [
      'button:has-text("Claim")',
      'button:has-text("Reward")',
      'button:has-text("Collect")',
      'button:has-text("150")',
      'button:has-text("Daily")',
      'button:has-text("Get Reward")'
    ];

    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        const btnText = (await btn.textContent().catch(() => '')).trim();
        log(`[REWARD] Clicking: "${btnText}"`);
        await btn.click();
        await page.waitForTimeout(4000);

        const after = await getPageState(page);
        const afterCredits = parseCredits(after.text);
        if (afterCredits >= 0) logCoinChange(afterCredits);

        log('[REWARD] ✅ Claimed successfully');
        break;
      }
    }

  } catch (e) {
    log(`[REWARD] ERROR: ${e.message}`);
  } finally {
    await page.close();
  }
}

// ==================== RENEWAL ====================
async function checkRenewal() {
  log('[RENEW] Checking...');
  const page = await context.newPage();
  await blockAds(page);

  try {
    await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const dashState = await getPageState(page);
    if (dashState.title.toLowerCase().includes('login')) {
      log('[RENEW] ❌ NOT LOGGED IN');
      return;
    }

    const credits = parseCredits(dashState.text);
    logCoinChange(credits);
    log(`[RENEW] Credits: ${credits}`);

    if (credits >= 0 && credits < 500) {
      log(`[RENEW] ⏳ Not enough credits (${credits} < 500)`);
      return;
    }

    await page.goto(`https://${HOST}/panel/${SERVER_ID}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const panelState = await getPageState(page);
    if (panelState.title.includes('404')) {
      log('[RENEW] ❌ 404');
      return;
    }

    const { expired, minutesLeft } = parseServerExpiry(panelState.text);
    log(`[RENEW] Expired: ${expired} | Minutes left: ${minutesLeft}`);

    const shouldRenew = expired || (minutesLeft !== null && minutesLeft <= 30);
    if (!shouldRenew) {
      log(`[RENEW] ⏳ Still active (${minutesLeft}m left)`);
      return;
    }

    log('[RENEW] ✅ Renewing...');

    const selectors = [
      'button:has-text("Renew")',
      'button:has-text("renew")',
      'button:has-text("Restore")',
      'button:has-text("Reactivate")',
      'a:has-text("Renew")'
    ];

    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        const btnText = (await btn.textContent().catch(() => '')).trim();
        log(`[RENEW] Clicking: "${btnText}"`);
        await btn.click();
        await page.waitForTimeout(3000);

        for (const cs of ['button:has-text("Confirm")', 'button:has-text("Yes")', 'button:has-text("OK")']) {
          const cb = page.locator(cs).last();
          if (await cb.isVisible().catch(() => false)) {
            await cb.click();
            await page.waitForTimeout(3000);
            break;
          }
        }

        const after = await getPageState(page);
        const afterCredits = parseCredits(after.text);
        if (afterCredits >= 0) logCoinChange(afterCredits);

        log('[RENEW] ✅ Done');
        break;
      }
    }
  } catch (e) {
    log(`[RENEW] ERROR: ${e.message}`);
  } finally {
    await page.close();
  }
}

// ==================== MAIN ====================
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
  log('[START] Pingless bot v13');
  await initBrowser();

  const ok = await startAFK();
  if (!ok) {
    log('[START] Login failed → retry in 5 min');
    setTimeout(main, 5 * 60 * 1000);
    return;
  }

  await checkAll();
  setInterval(checkAll, 30 * 60 * 1000);
}

main();

process.on('SIGTERM', () => {
  log('SIGTERM received');
  if (browser) browser.close().catch(() => {});
  server.close(() => process.exit(0));
});

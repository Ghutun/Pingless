const http = require('http');

const PORT = process.env.PORT || 10000;
const SERVER_URL = process.env.PINGLESS_SERVER_URL || 'https://dash.pingless.org/server/manage?id=d3b24764&numeric=7703&mode=server';
const SID = process.env.PINGLESS_SID || 's%3AaQiZM6asrmiAcuxbtOaRTJA4WW7mU4R1.j6CRk%2B9fHfCXRCaZBqRz8dFMHrGG8TptVv%2FzM69xHP4';
const USER_ID = process.env.PINGLESS_USER_ID || '342814841943228420';
const HOST = 'dash.pingless.org';

const RENEW_THRESHOLD_MIN = 60;   // renew when <= 1h left
const RENEW_COST = 500;
// If the timer can't be read but a ENABLED renew button exists, renew anyway? (risk: wasting credits)
const RENEW_IF_UNKNOWN = process.env.RENEW_IF_UNKNOWN === 'true';

const BROWSER_RESTART_INTERVAL = 2.5 * 60 * 60 * 1000;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

let browser = null;
let context = null;
let afkPage = null;
let lastCredits = -1;
let lastSessionEarned = 0;
let browserStartTime = Date.now();
let checking = false;
let server = null;

// ==================== BROWSER ====================
async function initBrowser() {
  const { chromium } = require('playwright');
  log('[BROWSER] Launching...');

  if (browser) {
    try { await browser.close(); } catch (e) {}
  }

  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await context.addCookies([
    { name: 'pingless.sid', value: SID, domain: HOST, path: '/', secure: true, httpOnly: true },
    { name: 'userId', value: USER_ID, domain: HOST, path: '/', secure: true }
  ]);

  browserStartTime = Date.now();
  log('[BROWSER] Ready');
}

// ==================== AD BLOCKER ====================
// strict = true  -> AFK page: abort everything that isn't pingless/cloudflare, and force back to /afk if it leaves
// strict = false -> dashboard/panel: let scripts/styles load (so timers render), only block leaving the site
async function blockAds(page, strict = true) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    let host = '';
    try { host = new URL(request.url()).hostname.toLowerCase(); } catch (e) {}

    if (host === 'pingless.org' || host.endsWith('.pingless.org')) return route.continue();

    if (
      host.endsWith('cloudflare.com') ||
      host.endsWith('cloudflareinsights.com') ||
      request.url().toLowerCase().includes('cdn-cgi')
    ) {
      return route.continue();
    }

    if (!strict) {
      const isMainNav = request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (isMainNav) {
        log(`[BLOCK] Blocked navigation → ${request.url()}`);
        return route.abort();
      }
      return route.continue();
    }

    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      log(`[BLOCK] Blocked navigation → ${request.url()}`);
    }
    return route.abort();
  });

  if (strict) {
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
}

// ==================== HELPERS ====================
async function getPageState(page) {
  return await page.evaluate(() => ({
    title: document.title,
    text: document.body?.innerText?.slice(0, 40000) || '',
    url: location.href
  }));
}

// Wait until the page text contains something matching `regex` (JS-rendered content)
async function waitForText(page, regex, timeout = 20000) {
  try {
    await page.waitForFunction(
      ([src, flags]) => new RegExp(src, flags).test(document.body?.innerText || ''),
      [regex.source, regex.flags],
      { timeout }
    );
    return true;
  } catch (e) {
    return false;
  }
}

function parseCredits(text) {
  const num = '([\\d,]+(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`${num}\\s*credits?\\b`, 'i'),
    new RegExp(`(?:balance|total credits?|your credits?|credits? balance|you have)[:\\s]*${num}`, 'i'),
    new RegExp(`\\bcredits?[:\\s]+${num}\\b`, 'i'),
    new RegExp(`${num}\\s*credits?\\b`, 'i')
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(val) && val >= 0 && val < 10000000) return val;
    }
  }
  return -1;
}

function logCoinChange(current) {
  if (lastCredits >= 0 && current >= 0) {
    const diff = current - lastCredits;
    if (Math.abs(diff) >= 0.5 && Math.abs(diff) < 1000) {
      log(`[COINS] ${lastCredits.toFixed(2)} → ${current.toFixed(2)} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)})`);
    }
  }
  if (current >= 0) lastCredits = current;
}

function parseRewardInfo(text) {
  const available = /daily reward is available/i.test(text);
  let timer = null;
  const match = text.match(/next claim in\s*(\d{1,2}:\d{2}:\d{2})/i);
  if (match) timer = match[1];
  return { available, timer, ready: available && !timer };
}

// "1d 2h 3m", "23 hours 15 minutes", "2h", "45m", "23:15:42"  -> minutes (or null)
function parseDuration(str) {
  const clock = str.match(/\b(\d{1,3}):(\d{2}):(\d{2})\b/);
  if (clock) {
    return parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10) + parseInt(clock[3], 10) / 60;
  }

  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  let total = 0;
  let found = false;
  let m;
  while ((m = re.exec(str)) !== null) {
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    found = true;
    if (u.startsWith('d')) total += n * 1440;
    else if (u.startsWith('h')) total += n * 60;
    else if (u.startsWith('m')) total += n;
    else total += n / 60;
  }
  return found ? total : null;
}

// Looks ONLY at lines related to expiry (and the line right after, since label/value are often split)
function parseServerExpiry(text) {
  text = text.replace(/\bO(?=\s*h\b)/g, '0');
  const direct = text.match(/((?:\d+\s*(?:d|h|m|s)\b\s*)+)\s*remaining/i);
  const directMins = direct ? parseDuration(direct[1]) : null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const durKey = /(expir|remaining|time left|valid for|valid until|ends?\s+(?:in|at)|renews?\s+in)/i;
  const skip = /(daily|claim|reward|afk)/i;

  let expired = false;
  let minutesLeft = null;
  let source = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (skip.test(line)) continue;

    if (line.length <= 80 && /\b(expired|suspended)\b/i.test(line) && !/\b(if|when|will|after)\b/i.test(line)) {
      expired = true;
      source = source || line;
    }

    if (!durKey.test(line)) continue;
    const ctx = line + ' ' + (lines[i + 1] && !skip.test(lines[i + 1]) ? lines[i + 1] : '');

    // absolute date: "Expires on Nov 2, 2026 14:00" / "Valid until 2026-11-02 14:00"
    const abs = ctx.match(/(?:expires?\s*(?:on|at)?|valid until|until|ends at)[:\s]+(.{6,40})$/i);
    if (abs && /\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2}\b|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(abs[1])) {
      const t = Date.parse(abs[1]);
      if (!isNaN(t)) {
        minutesLeft = (t - Date.now()) / 60000;
        source = line;
        break;
      }
    }

    const dur = parseDuration(ctx);
    if (dur !== null) {
      minutesLeft = dur;
      source = ctx;
      break;
    }
  }

  if (directMins !== null) {
    minutesLeft = directMins;
    source = direct[0].replace(/\s+/g, ' ');
  }

  return { expired, minutesLeft, source };
}

function parseAFKPage(text) {
  const connected =
    /connection\s*status[\s\S]{0,120}?connected/i.test(text) ||
    (/\bconnected\b/i.test(text) && !/disconnected|not\s+connected|offline/i.test(text));

  let activeUsers = null;
  const usersMatch = text.match(/active\s*users[\s\S]{0,50}?(\d+)/i) ||
                     text.match(/(\d+)\s*active\s*users/i);
  if (usersMatch) activeUsers = parseInt(usersMatch[1]);

  let multiplier = null;
  const multiMatch = text.match(/x\s*(\d+\.\d+)/i);
  if (multiMatch) multiplier = multiMatch[1];

  let earningRate = null;
  const rateMatch = text.match(/([\d.]+)\s*credits?\s*\/\s*min/i);
  if (rateMatch) earningRate = parseFloat(rateMatch[1]);

  let nextRewardSec = null;
  const nextMatch = text.match(/next\s*reward[\s\S]{0,80}?(\d+)\s*s/i);
  if (nextMatch) nextRewardSec = parseInt(nextMatch[1]);

  let sessionEarned = 0;
  const earnedMatch = text.match(/earned[\s\S]{0,40}?([+\-]?\d+\.?\d*)\s*credits?/i);
  if (earnedMatch) sessionEarned = parseFloat(earnedMatch[1]);

  return { connected, activeUsers, multiplier, earningRate, nextRewardSec, sessionEarned };
}

// ==================== AFK ====================
async function startAFK() {
  log('[AFK] Starting...');

  if (afkPage) {
    try { await afkPage.close(); } catch (e) {}
  }

  afkPage = await context.newPage();
  await blockAds(afkPage, true);

  const resp = await afkPage.goto(`https://${HOST}/afk`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });
  log(`[AFK] Status: ${resp ? resp.status() : 'none'}`);
  await afkPage.waitForTimeout(7000);

  const state = await getPageState(afkPage);
  log(`[AFK] Title: "${state.title}"`);

  if (state.title.toLowerCase().includes('login') || state.text.includes('Sign in')) {
    log('[AFK] ❌ NOT LOGGED IN');
    return false;
  }

  const info = parseAFKPage(state.text);
  log(`[AFK] Connected: ${info.connected} | ${info.activeUsers || '?'} users | x${info.multiplier || '?'} | ${info.earningRate || '?'} c/min`);
  log('[AFK] ✅ Running 24/7');
  return true;
}

async function afkTick() {
  try {
    if (!context) return;

    if (Date.now() - browserStartTime > BROWSER_RESTART_INTERVAL) {
      if (checking) return; // don't restart mid-renewal
      log('[BROWSER] Scheduled restart to prevent memory issues...');
      await initBrowser();
      await startAFK();
      return;
    }

    if (!afkPage || afkPage.isClosed()) {
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
      await afkPage.waitForTimeout(6000);
      return;
    }

    await afkPage.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: Math.random() * window.innerWidth,
        clientY: Math.random() * window.innerHeight,
        bubbles: true
      }));
      window.scrollBy(0, (Math.random() - 0.5) * 30);
    });

    const state = await getPageState(afkPage);
    const info = parseAFKPage(state.text);

    if (!info.connected) {
      log('[AFK] Detected Disconnected → forcing reload...');
      await afkPage.goto(`https://${HOST}/afk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await afkPage.waitForTimeout(7000);
      return;
    }

    let earnedThisRound = 0;
    if (info.sessionEarned > lastSessionEarned) {
      earnedThisRound = +(info.sessionEarned - lastSessionEarned).toFixed(2);
    }
    lastSessionEarned = info.sessionEarned;

    let status = `[AFK] Connected`;
    if (info.activeUsers) status += ` | ${info.activeUsers} users`;
    if (info.multiplier) status += ` | x${info.multiplier}`;
    if (info.earningRate) status += ` | ${info.earningRate} c/min`;
    if (info.nextRewardSec !== null) status += ` | Next: ${info.nextRewardSec}s`;
    status += ` | Session: +${info.sessionEarned.toFixed(2)}`;
    if (earnedThisRound > 0) status += ` | +${earnedThisRound}`;
    log(status);
  } catch (e) {
    log(`[AFK] Error: ${e.message}`);
    try {
      await startAFK();
    } catch (e2) {
      log(`[AFK] Recovery failed: ${e2.message}`);
    }
  }
}

// ==================== REWARD ====================
async function checkReward() {
  log('[REWARD] Checking...');
  const page = await context.newPage();
  await blockAds(page, false);

  try {
    await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForText(page, /credits?|balance|reward/i, 15000);
    await page.waitForTimeout(2000);

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
      'button:has-text("Daily")'
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

        log('[REWARD] ✅ Claimed');
        break;
      }
    }
  } catch (e) {
    log(`[REWARD] ERROR: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

// ==================== RENEWAL ====================
const RENEW_SELECTORS = [
  'button:has-text("Renew Now")',
  '[role="button"]:has-text("Renew Now")',
  'text="Renew Now"',
  'button:has-text("Renew")',
  'a:has-text("Renew Now")',
  'a:has-text("Renew")',
  'button:has-text("Restore")',
  'button:has-text("Reactivate")'
];

async function findRenewButton(page) {
  for (const sel of RENEW_SELECTORS) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) return btn;
  }
  return null;
}

async function readPanelExpiry(page) {
  await waitForText(page, /expir|renew|remaining|time left/i, 20000);
  await page.waitForTimeout(2500); // let countdown widgets render
  const state = await getPageState(page);
  const section = await page.evaluate(() => {
    let best = '';
    for (const el of document.querySelectorAll('div,section,aside,main')) {
      const t = el.innerText || '';
      if (/server renewal/i.test(t) && /remaining/i.test(t) && (!best || t.length < best.length)) best = t;
    }
    return best;
  }).catch(() => '');
  return { state, ...parseServerExpiry(section ? section + '\n' + state.text : state.text) };
}

async function checkRenewal() {
  log('[RENEW] Checking...');
  const page = await context.newPage();
  await blockAds(page, false);

  try {
    // 1. Credits
    await page.goto(`https://${HOST}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForText(page, /credits?|balance/i, 15000);
    await page.waitForTimeout(2000);

    const dashState = await getPageState(page);
    if (dashState.title.toLowerCase().includes('login')) {
      log('[RENEW] ❌ NOT LOGGED IN');
      return;
    }

    const credits = parseCredits(dashState.text);
    logCoinChange(credits);
    log(`[RENEW] Credits: ${credits}`);

    if (credits >= 0 && credits < RENEW_COST) {
      log(`[RENEW] ⏳ Not enough credits (${credits} < ${RENEW_COST})`);
      return;
    }

    // 2. Server panel
    await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const { state: panelState, expired, minutesLeft, source } = await readPanelExpiry(page);

    if (panelState.title.includes('404')) {
      log('[RENEW] ❌ 404');
      return;
    }

    if (minutesLeft !== null) {
      log(`[RENEW] Expired: ${expired} | Time left: ${Math.floor(minutesLeft / 60)}h ${Math.round(minutesLeft % 60)}m | from: "${source}"`);
    } else {
      log(`[RENEW] Expired: ${expired} | Time left: UNKNOWN`);
      const dbg = panelState.text.split('\n').map(l => l.trim()).filter(l => /expir|renew|remain|left|valid|status|time/i.test(l)).slice(0, 15);
      log(`[RENEW] Debug lines from panel:\n  ${dbg.join('\n  ') || '(none found — page may not have rendered)'}`);
    }

    const btn = await findRenewButton(page);
    const btnEnabled = btn ? await btn.isEnabled().catch(() => false) : false;

    let shouldRenew = false;
    if (expired) {
      shouldRenew = true;
    } else if (minutesLeft !== null) {
      shouldRenew = minutesLeft <= RENEW_THRESHOLD_MIN;
      if (!shouldRenew) {
        log(`[RENEW] ⏳ ${(minutesLeft / 60).toFixed(1)}h left (need ≤ ${RENEW_THRESHOLD_MIN / 60}h). Skipping.`);
        return;
      }
    } else if (RENEW_IF_UNKNOWN && btnEnabled) {
      log('[RENEW] ⚠ Timer unreadable but renew button is enabled → renewing (RENEW_IF_UNKNOWN=true)');
      shouldRenew = true;
    } else {
      log('[RENEW] ⚠ Could not read expiry time → skipping (send me the debug lines above)');
      return;
    }

    if (!shouldRenew) return;

    if (!btn) {
      log('[RENEW] ⚠ No renew button found');
      return;
    }
    if (!btnEnabled) {
      log('[RENEW] ⚠ Renew button is disabled → site not allowing renewal yet');
      return;
    }

    log('[RENEW] ✅ Time to renew');
    const btnText = (await btn.textContent().catch(() => '')).trim();
    log(`[RENEW] Clicking: "${btnText}"`);
    await btn.click();
    await page.waitForTimeout(3000);

    for (const cs of ['button:has-text("Confirm Renew")', 'button:has-text("Confirm")', 'button:has-text("Yes")', 'button:has-text("OK")']) {
      const cb = page.locator(cs).last();
      if (await cb.isVisible().catch(() => false)) {
        log(`[RENEW] Confirming via ${cs}`);
        await cb.click();
        await page.waitForTimeout(3000);
        break;
      }
    }

    // 3. Verify
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    const after = await readPanelExpiry(page);
    const afterCredits = parseCredits(after.state.text);
    if (afterCredits >= 0) logCoinChange(afterCredits);

    if (after.minutesLeft !== null && !after.expired && (minutesLeft === null || after.minutesLeft > minutesLeft + 30)) {
      log(`[RENEW] ✅ Renewed — now ${(after.minutesLeft / 60).toFixed(1)}h left`);
    } else {
      log(`[RENEW] ⚠ Clicked, but could not confirm renewal (time left now: ${after.minutesLeft === null ? 'unknown' : (after.minutesLeft / 60).toFixed(1) + 'h'})`);
    }
  } catch (e) {
    log(`[RENEW] ERROR: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

// ==================== MAIN ====================
async function checkAll() {
  if (checking) return log('[CHECK] Previous check still running, skipping');
  checking = true;
  log('--- CHECK ---');
  try {
    await checkReward();
    await checkRenewal();
  } catch (e) {
    log(`[CHECK] Error: ${e.message}`);
  } finally {
    checking = false;
  }
  log('--- END ---');
}

async function main() {
  log('[START] Pingless bot v17 (renew ≤ 1h)');
  await initBrowser();

  const ok = await startAFK();
  if (!ok) {
    log('[START] Login failed → retry in 5 min');
    setTimeout(main, 5 * 60 * 1000);
    return;
  }

  await checkAll();
  setInterval(checkAll, 15 * 60 * 1000);
}

if (require.main === module) {
  server = http.createServer((q, s) => s.end('alive'));
  server.listen(PORT, () => log(`[SERVER] listening on ${PORT}`));
  setInterval(afkTick, 40 * 1000);
  main();

  process.on('SIGTERM', async () => {
    log('SIGTERM received');
    if (browser) await browser.close().catch(() => {});
    server.close(() => process.exit(0));
  });
}

module.exports = { parseServerExpiry, parseDuration, parseCredits };

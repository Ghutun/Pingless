const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 10000;
const SERVER_ID = '1488944a';
const COOKIE = `cf_clearance=ur_6KUKzK0ia0eX5np5xBjU.qKDw22kD4EQlaR7RumQ-1790928021-1.2.1.1-GBpxrOsNiyNRU3ooSMKajuVWQTcW09QtkNBvDKZrGsSjQVAmydlH.O1Ay.zcuSo7h6EimNvrjVC8g6IWLW01aEhNEHEhC2.bKSCyXwDQnBPXKlMnfxg0yTukS22YMCA2.WTyXZRktSSLjVujU3k7zDJLiZNMrTSsPmhVeXrLeepR8Kiu7uH3oaCezTFyfWqf8toBhR6kpOABNtYNxglnf9ppmxBV2pdRqdIDqFLUFnv3hWrnUzCcjdlCFjgy0pJ1IU_CA2jkAS.tmB5Zwpvk4WCkn0EN0R0mHFEZ4rUcO9F3a.wdvW_xlqdH9vcG.mjtl1DcTf322zILkxrk2f6IYBdAmmqea.jSXql_wRE7ubU; pingless.session=s%3AaQiZM6asrmiAcuxbtOaRTJA4WW7mU4R1.j6CRk%2B9fHfCXRCaZBqRz8dFMHrGG8TptVv%2FzM69xHP4; userId=342814841943228420`;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function api(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'dash.pingless.org',
      path,
      method,
      headers: {
        'Cookie': COOKIE,
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- AFK (every 60s) ---
async function afkTick() {
  try {
    const res = await api('/api/user/afk/work', 'POST');
    log(`[AFK] ${JSON.stringify(res).slice(0, 150)}`);
  } catch (e) { log(`[AFK] ERROR: ${e.message}`); }
}

// --- Daily reward (every 24h) ---
async function claimReward() {
  log('[REWARD] Checking...');
  try {
    const res = await api('/api/user/dailystatus');
    log(`[REWARD] ${JSON.stringify(res).slice(0, 200)}`);
    if (res.success && res.data?.claimable) {
      const claim = await api('/api/user/daily/claim', 'POST');
      log(`[REWARD] ✅ ${JSON.stringify(claim).slice(0, 100)}`);
    }
  } catch (e) { log(`[REWARD] ERROR: ${e.message}`); }
}

// --- Renew (every 48h, 500 credits) ---
async function renewServer() {
  log(`[RENEW] Renewing ${SERVER_ID}...`);
  try {
    const res = await api(`/api/servers/${SERVER_ID}/renew`, 'POST');
    log(`[RENEW] ${JSON.stringify(res).slice(0, 200)}`);
  } catch (e) { log(`[RENEW] ERROR: ${e.message}`); }
}

// --- Start ---
log('[START] Pingless bot');
const server = http.createServer((q, s) => s.end('alive'));
server.listen(PORT, () => log(`[SERVER] listening on ${PORT}`));

afkTick();
claimReward();
renewServer();

setInterval(afkTick, 60000);
setInterval(claimReward, 24 * 60 * 60 * 1000);
setInterval(renewServer, 48 * 60 * 60 * 1000);

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });   

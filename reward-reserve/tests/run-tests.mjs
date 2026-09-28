// ============================================================================
// Render / safety tests for the Reward Reserve V2 page (Playwright, headless).
// Usage:  node tests/run-tests.mjs            (from the reward-reserve folder)
// Nothing here is used by the production page. All chain state is synthetic
// (mocked RPC + wallet — no real network or funds involved). Scenarios:
//   no-wallet        no injected wallet, no epoch source configured
//   epoch-unavail     wallet connects, but epoch JSON source not configured
//   claim-ready       full path: connect, see a claimable epoch, claim it
//   claim-not-mine    a claimable epoch exists but the connected wallet
//                     is a different address -> claim button stays disabled
//   claim-claimed     epoch already claimed on chain -> shown as claimed
// Safety assertions (every scenario): no eth_sign/personal_sign/eth_accounts
// write calls except the explicit connect click, no approve() selector ever
// sent, no console errors, no horizontal overflow.
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
import { execSync } from 'node:child_process';
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out');
fs.mkdirSync(OUT, { recursive: true });

const R = '0xc05ddfbd4f9a46ae297b286d4d6998a0c0ea27fe';
const TEN = '0xc4f021c73a5b6ffae6c43515f0a4bbf615b31c7b';
const SNET = '0xb773ec2c326b7f98a5a83fc098825492f020a4c7';
const PRICE_READER = '0x383a3da5f0df829e68893d1c5cff728657ed6510';
const NET_USDG_POOL = '0x59f95461e68e0c77605299791e1449f175165b54';
const HOLDER = '0x784a7839a555773a57eee471b9cf9e076f2287e4'; // matches the fixture epoch JSON below
const OTHER = '0x000000000000000000000000000000000000be01';

// ---------------------------------------------------------------- static server (page + fixture epoch JSON)
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
const EPOCH_1 = {
  epochId: 1, snapshotTime: 1790622928, chainId: 4663, token: '0xC4F021c73A5b6fFae6C43515f0a4BbF615B31c7b', reserve: '0xC05ddFbd4f9a46ae297b286D4D6998a0c0Ea27FE',
  budget: { units: 'sNET', committedTotal: '250000000000' },
  eligibility: { minDays: 30 },
  totals: { eligibleHolders: '1', totalEligibleBalance: '990000000000000000000000' },
  holders: {
    '0x784a7839A555773A57eEe471B9Cf9E076f2287E4': {
      balance: '990000000000000000000000', eligibleBalance: '990000000000000000000000', allocation: '250000000000',
      leaf: '0x' + '5c'.repeat(32), proof: [], shareBps: '10000',
      lots: [{ amount: '990000000000000000000000', since: 1787000000, days: 45, eligible: true }]
    }
  },
  ineligible: {}, tree: { root: '0x' + '5c'.repeat(32) }
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/epochs/1.json') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify(EPOCH_1)); }
  let p = decodeURIComponent(u.pathname).replace(/^\/reward-reserve\/?/, '/');
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(8767, r));
const URL0 = 'http://127.0.0.1:8767/reward-reserve/';
const EPOCHS_BASE = 'http://127.0.0.1:8767/epochs';

// ---------------------------------------------------------------- mock read-RPC (rpc.mainnet.chain.robinhood.com)
const w = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
function makeRpc(opts) {
  return function handle(req) {
    const { method, params } = req;
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_getTransactionReceipt') return opts.receipt ? opts.receipt(params[0]) : null;
    if (method === 'eth_getLogs') return opts.logs || []; // never fabricated: default is "no events yet"
    if (method === 'eth_call') {
      const to = params[0].to.toLowerCase(), data = params[0].data.toLowerCase(), sel = data.slice(0, 10);
      if (to === R) {
        if (sel === '0x7da68d34') return w(1000); // principalValue
        if (sel === '0xc0380529') return w(500);  // holderSideValue
        if (sel === '0x7c3d5f47') return w(250000000000); // outstandingLiabilityValue
        if (sel === '0x5ce23950') return w(1); // isSolvent
        if (sel === '0x73e2144f') return w(opts.latestEpochId ?? 1); // latestEpochId
        if (sel === '0xfef08fa4') return w(opts.claimed ? 1 : 0); // claimedBy
        if (sel === '0x1848f6ec') return w(opts.verify === false ? 0 : 1); // verifyAllocation
        if (sel === '0xb53fdc08') return w(opts.lastCrystallization ?? 0); // lastCrystallization() — 0 = "not funded yet" by default
        if (sel === '0xf6257825') return w(opts.crystallizationPeriod ?? 604800); // CRYSTALLIZATION_PERIOD() — default 7 days
      }
      if (to === TEN && sel === '0x70a08231') return w(opts.tenBalance ?? '990000000000000000000000'); // balanceOf
      if (to === SNET && sel === '0x70a08231') return w(opts.snetBalance ?? '250000000000'); // balanceOf
      if (to === PRICE_READER && sel === '0x55a4ef5f') { // getSpotPriceWad()
        if (opts.priceFail) throw { code: -32000, message: 'execution reverted (mocked price read failure)' };
        return w(opts.netPerTenWad ?? '353000000000'); // default matches Matteo's worked example
      }
      if (to === NET_USDG_POOL && sel === '0x0902f1ac') { // getReserves()
        if (opts.priceFail) throw { code: -32000, message: 'execution reverted (mocked price read failure)' };
        // defaults reproduce Matteo's worked example: ~448.7 USDG per NET, giving ~$0.0001584 per TEN
        return w(opts.usdgReserve ?? '448700000') + w(opts.netReserve ?? '1000000000').slice(2) + w(0).slice(2);
      }
      throw { code: -32000, message: 'execution reverted (no fixture for ' + sel + ')' };
    }
    throw { code: -32601, message: 'method not allowed in test: ' + method };
  };
}
function rpcRoute(handle, log) {
  return async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    const one = r => { log.push(r.method); try { return { jsonrpc: '2.0', id: r.id, result: handle(r) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: e }; } };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
  };
}

// ---------------------------------------------------------------- mock EIP-1193 wallet, injected before load
function walletInitScript(account) {
  return `(() => {
    const acct = ${JSON.stringify(account)};
    const listeners = {};
    window.__rrWalletLog = [];
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        window.__rrWalletLog.push(method);
        if (method === 'eth_requestAccounts') return [acct];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'wallet_switchEthereumChain') return null;
        if (method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction') { window.__rrLastTx = params[0]; return '0x' + '11'.repeat(32); }
        if (method === 'eth_sign' || method === 'personal_sign' || method === 'eth_signTypedData_v4') throw new Error('should never be called');
        throw new Error('unexpected wallet method ' + method);
      },
      on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeListener: () => {}
    };
  })();`;
}

// ---------------------------------------------------------------- run
const browser = await chromium.launch();
const results = [];
async function scenario(name, { rpc, wallet, epochsBaseUrl, autoConnect = true, addr = HOLDER, wait = 2000 }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [], rpcLog = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  if (wallet) await page.addInitScript(walletInitScript(wallet));
  await page.route('**/*', async route => {
    const u = route.request().url();
    if (u.startsWith(URL0) || u.startsWith(EPOCHS_BASE)) {
      if (u.includes('assets/rr-config.js') && epochsBaseUrl !== undefined) {
        let body = fs.readFileSync(path.join(ROOT, 'assets/rr-config.js'), 'utf8');
        body = body.replace('epochsBaseUrl: null,', `epochsBaseUrl: ${epochsBaseUrl ? JSON.stringify(epochsBaseUrl) : 'null'},`);
        return route.fulfill({ status: 200, contentType: 'text/javascript', body });
      }
      return route.continue();
    }
    if (u.startsWith('https://rpc.mainnet.chain.robinhood.com') && rpc) return rpcRoute(rpc, rpcLog)(route);
    if (u.includes('/api/v2/smart-contracts/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.abort('connectionrefused');
  });
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  if (wallet && autoConnect) { await page.click('#connectBtn'); await page.waitForTimeout(2500); }
  if (!wallet && addr) { await page.fill('#addr', addr); await page.click('#lookup button'); await page.waitForTimeout(2500); }

  const probe = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    badge: document.querySelector('[data-l="badge"]').textContent,
    netchip: document.querySelector('[data-l="netchipText"]').textContent,
    connectLabel: document.querySelector('#connectBtn').textContent,
    toClaim: document.querySelector('[data-l="m_toClaim"]') ? document.querySelector('[data-l="m_toClaim"]').textContent : null,
    claimed: document.querySelector('[data-l="m_claimed"]') ? document.querySelector('[data-l="m_claimed"]').textContent : null,
    elig: document.querySelector('[data-l="m_elig"]') ? document.querySelector('[data-l="m_elig"]').textContent : null,
    epochRows: document.querySelector('#epochRows') ? document.querySelector('#epochRows').innerText : null,
    claimAlert: document.querySelector('[data-l-alert="claim"]') ? document.querySelector('[data-l-alert="claim"]').textContent : null,
    claimBtnDisabled: document.querySelector('#claimBtn') ? document.querySelector('#claimBtn').disabled : null,
    walletLog: window.__rrWalletLog || [],
    monSnet: document.querySelector('[data-l="mon_snet"]').textContent,
    monTen: document.querySelector('[data-l="mon_ten"]').textContent,
    monCountdown: document.querySelector('[data-l="mon_countdown"]').textContent,
    gTotal: document.querySelector('[data-l="gTotal"]').textContent,
    gNote: document.querySelector('[data-l="gNote"]').textContent,
    ovHolders: document.querySelector('[data-l="ov_holders"]').textContent,
    ovEligTotal: document.querySelector('[data-l="ov_eligTotal"]').textContent,
    eligYn: document.querySelector('[data-l="m_eligYn"]') ? document.querySelector('[data-l="m_eligYn"]').textContent : null,
    share: document.querySelector('[data-l="m_share"]') ? document.querySelector('[data-l="m_share"]').textContent : null,
    lotList: document.querySelector('#lotList') ? document.querySelector('#lotList').innerText : null,
    donateAddr: document.querySelector('#donateBox code') ? document.querySelector('#donateBox code').textContent : null,
    monSnetUsd: document.querySelector('[data-l="mon_snet_usd"]').textContent,
    monTenUsd: document.querySelector('[data-l="mon_ten_usd"]').textContent,
    ovPrincipalUsd: document.querySelector('[data-l="ov_principal_usd"]').textContent,
    mBalUsd: document.querySelector('[data-l="m_bal_usd"]') ? document.querySelector('[data-l="m_bal_usd"]').textContent : null,
    mToClaimUsd: document.querySelector('[data-l="m_toClaim_usd"]') ? document.querySelector('[data-l="m_toClaim_usd"]').textContent : null
  }));
  const shot = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  results.push({ name, errors, rpcMethods: [...new Set(rpcLog)], ...probe });
  return { ctx, page };
}

await scenario('no-wallet', { rpc: makeRpc({ latestEpochId: 0 }), wallet: null });
await scenario('epoch-unavail', { rpc: makeRpc({}), wallet: null, epochsBaseUrl: null });

{
  // stateful: once the (mocked) transaction receipt is fetched, flip claimedBy() true from then on,
  // so the page's own post-claim refresh sees the epoch as claimed, same as a real confirmation would
  const claimOpts = { verify: true, claimed: false };
  claimOpts.receipt = () => { claimOpts.claimed = true; return { status: '0x1' }; };
  const { page } = await scenario('claim-ready', { rpc: makeRpc(claimOpts), wallet: HOLDER, epochsBaseUrl: EPOCHS_BASE });
  // drive the claim itself and confirm the tx + receipt path
  const before = await page.evaluate(() => document.querySelector('#claimBtn').disabled);
  if (!before) {
    await page.click('#claimBtn');
    await page.waitForFunction(() => /claimed/i.test(document.querySelector('#epochRows').innerText), { timeout: 8000 }).catch(() => {});
  }
  const after = await page.evaluate(() => ({
    tx: window.__rrLastTx, status: document.querySelector('#claimStatus').textContent,
    walletLog: window.__rrWalletLog, epochRows: document.querySelector('#epochRows').innerText
  }));
  results[results.length - 1].claimBtnWasEnabled = !before;
  results[results.length - 1].sentTx = after.tx;
  results[results.length - 1].walletLogFinal = after.walletLog;
  results[results.length - 1].epochRows = after.epochRows; // post-claim state, not the pre-claim one scenario() captured
}

await scenario('claim-not-mine', { rpc: makeRpc({ verify: true, claimed: false }), wallet: OTHER, epochsBaseUrl: EPOCHS_BASE, addr: HOLDER });
await scenario('claim-claimed', { rpc: makeRpc({ verify: true, claimed: true }), wallet: HOLDER, epochsBaseUrl: EPOCHS_BASE });

// countdown target already in the past (lastCrystallization + period < now) -> must clamp to
// "Ready", never show a negative duration
await scenario('countdown-overdue', { rpc: makeRpc({ latestEpochId: 0, lastCrystallization: 1000, crystallizationPeriod: 1 }), wallet: null, addr: null });

// growth chart with a handful of real events on the wire: must count/report them without
// inventing the actual principal/reward/unclaimed numbers (event ABI not yet confirmed)
{
  const T = ['0xf4165e6a03db2f59ebd929ce3b1189f8f17451c4e5a5e95f0a0d8fa2163f208c', '0x4b06ca08b73c7994c0673265cf727603b6487d8f60834d83b60d11a2e61b103f', '0xee89b274de26d8ff2f7a29873f93a4aeb474c4aba006584d53c8a39e71f41d2a'];
  const logs = [{ topics: [T[0]], data: '0x' }, { topics: [T[1]], data: '0x' }, { topics: [T[2]], data: '0x' }, { topics: [T[2]], data: '0x' }];
  await scenario('growth-events', { rpc: makeRpc({ latestEpochId: 0, logs }), wallet: null, addr: null });
}

// $ estimates: one of the two on-chain price reads reverts -> must show nothing ($ labels
// stay blank), never a guessed or partial number
await scenario('price-fail', { rpc: makeRpc({ latestEpochId: 0, priceFail: true }), wallet: null, addr: null });

await browser.close(); server.close();
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
for (const r of results) console.log(`${r.name.padEnd(16)} badge=${(r.badge||'').padEnd(8)} netchip=${(r.netchip||'').padEnd(28)} toClaim=${r.toClaim} claimed=${r.claimed} overflowX=${r.overflowX} errors=${r.errors.length}`);

// ---------------------------------------------------------------- assertions
const bad = [];
for (const r of results) {
  if (r.overflowX > 0) bad.push(r.name + ': horizontal overflow');
  // "Failed to load resource" is Chrome's own console notice for a non-2xx/aborted network
  // request (here: the best-effort explorer-verification fetch, mocked as 404/refused on
  // purpose) — not a JS error, so it's excluded the same way the old suite excluded
  // ERR_CONNECTION_REFUSED for its offline scenario.
  const real = r.errors.filter(e => !/Failed to load resource/.test(e));
  if (real.length) bad.push(r.name + ': console/page errors: ' + real.join(' | '));
  if (r.walletLog && r.walletLog.some(m => /sign/i.test(m))) bad.push(r.name + ': called a signing method without a real claim');
}
const ready = results.find(r => r.name === 'claim-ready');
if (!ready.claimBtnWasEnabled) bad.push('claim-ready: claim button was not enabled for the address that owns the allocation');
if (!ready.sentTx) bad.push('claim-ready: claim did not send a transaction');
else {
  if (ready.sentTx.data.toLowerCase().startsWith('0x095ea7b3')) bad.push('claim-ready: sent an approve() call — claim() never needs an allowance');
  if (!ready.sentTx.data.toLowerCase().startsWith('0xae0b51df')) bad.push('claim-ready: transaction was not a claim() call');
}
if (!/claimed/i.test(ready.epochRows || '')) bad.push('claim-ready: epoch row did not flip to claimed after confirmation');

const notMine = results.find(r => r.name === 'claim-not-mine');
if (notMine.claimBtnDisabled !== true) bad.push('claim-not-mine: claim button must stay disabled for a non-owner address');

const claimed = results.find(r => r.name === 'claim-claimed');
if (!/claimed/i.test(claimed.epochRows || '')) bad.push('claim-claimed: an already-claimed epoch must show as claimed, not claimable');
if (claimed.claimBtnDisabled !== true) bad.push('claim-claimed: claim button must be disabled once nothing is left to claim');

const unavail = results.find(r => r.name === 'epoch-unavail');
if (!/not configured/i.test(unavail.epochRows || '')) bad.push('epoch-unavail: must show an explicit "not configured" state, never fabricate epoch data');

// ---- countdown: never negative, and the reserve+monitor boxes must always resolve
for (const r of results) {
  if (/^-/.test((r.monCountdown || '').trim())) bad.push(r.name + ': countdown showed a negative value: ' + r.monCountdown);
  if (r.monSnet === '--' || r.monTen === '--') bad.push(r.name + ': monitor boxes never resolved (sNET/TEN reserve balances)');
  if (!r.donateAddr) bad.push(r.name + ': donation box did not render an address');
}
const overdue = results.find(r => r.name === 'countdown-overdue');
if (overdue.monCountdown.trim() !== 'Ready') bad.push('countdown-overdue: a past target must clamp to "Ready", got: ' + overdue.monCountdown);

// ---- growth chart: no events -> explicit empty state, never a fabricated trend; with
// events -> counts them but must not claim to show exact principal/reward/unclaimed values
for (const r of results.filter(r => r.name !== 'growth-events')) {
  if (!/^0 events/i.test(r.gTotal) || !/no on-chain history/i.test(r.gNote)) bad.push(r.name + ': growth chart with no on-chain events must say so explicitly, not show a fabricated series (gTotal=' + r.gTotal + ')');
}
const growth = results.find(r => r.name === 'growth-events');
if (!/^4 /.test(growth.gTotal)) bad.push('growth-events: expected the mocked 4 events to be counted, got: ' + growth.gTotal);
if (!/pending confirmation/i.test(growth.gNote)) bad.push('growth-events: must flag that exact values are pending event-ABI confirmation rather than plotting guessed numbers');

// ---- personal dashboard extras: eligibility/lots/share render from the epoch JSON already fetched for the claim flow
const withLots = results.find(r => r.name === 'claim-ready');
if (!/yes/i.test(withLots.eligYn || '')) bad.push('claim-ready: eligibility should read Yes for the fully-eligible fixture holder');
if (withLots.share !== '100.00%') bad.push('claim-ready: share should read 100.00% for the fixture\'s shareBps of 10000, got: ' + withLots.share);
if (!/lot 1/i.test(withLots.lotList || '')) bad.push('claim-ready: lot list did not render the fixture\'s single TEN lot');
if (withLots.ovHolders === '—' || withLots.ovEligTotal === '—') bad.push('claim-ready: overview general stats (eligible holders/TEN) should populate from the latest epoch\'s totals');

// ---- $ estimates: render from the two mocked on-chain price reads by default, and show
// nothing at all (never a guessed/partial number) when either read fails
for (const r of results.filter(r => r.name !== 'price-fail')) {
  if (!/^≈/.test(r.monSnetUsd) || !/^≈/.test(r.monTenUsd)) bad.push(r.name + ': $ estimate did not render for the reserve monitor boxes (monSnetUsd=' + r.monSnetUsd + ', monTenUsd=' + r.monTenUsd + ')');
}
if (!/^≈/.test(withLots.mBalUsd || '')) bad.push('claim-ready: $ estimate did not render for the TEN balance box');
if (!/^≈/.test(withLots.mToClaimUsd || '')) bad.push('claim-ready: $ estimate did not render for the claimable amount box');
const priceFail = results.find(r => r.name === 'price-fail');
if (priceFail.monSnetUsd || priceFail.monTenUsd || priceFail.ovPrincipalUsd) bad.push('price-fail: a failed price read must leave $ labels blank, not show a partial/guessed number');

if (bad.length) { console.log('\nISSUES:'); bad.forEach(x => console.log(' -', x)); process.exitCode = 1; }
else console.log('\nAll checks passed.');

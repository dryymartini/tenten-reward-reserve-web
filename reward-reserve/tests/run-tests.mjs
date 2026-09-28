// ============================================================================
// Render / safety tests for the Reward Reserve page (Playwright, headless).
// Usage:  node tests/run-tests.mjs            (from the reward-reserve folder)
// Nothing here is used by the production page. Scenarios:
//   offline     all network refused            -> error/unavailable states
//   mainnet     RPC replayed from a RECORDED mainnet snapshot (fixtures/)
//   stale       same snapshot, original head timestamp -> STALE labels
//   claim-*     SYNTHETIC epoch + artifact (clearly fake values) to exercise
//               READY / PENDING / FAILED paths of the Claim Center
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
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/mainnet-recorded.json'), 'utf8'));
const R = '0x313dfcb9e091d33482e75eefa00e0156b42119b5';
const HOLDER = '0x000000000000000000000000000000000000c1a1'; // synthetic test holder

// ---------------------------------------------------------------- static server
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/reward-reserve\/?/, '/');
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(8765, r));
const URL0 = 'http://127.0.0.1:8765/reward-reserve/';

// Blockscout verification status as RECORDED on 2026-09-28 (test replay only)
const VERIFIED = {
  '0x313dfcb9e091d33482e75eefa00e0156b42119b5': { name: 'TenRewardReserveV1', is_verified: true, is_fully_verified: false },
  '0x383a3da5f0df829e68893d1c5cff728657ed6510': { name: 'TenNetSpotReader', is_verified: true, is_fully_verified: false },
  '0xc4f021c73a5b6ffae6c43515f0a4bbf615b31c7b': { name: 'PairPadLauncherToken', is_verified: true, is_fully_verified: false },
  '0xca9c78dd337a67f6e0077f65f5e9218719d30edf': { name: 'NET', is_verified: true, is_fully_verified: true },
  '0xb773ec2c326b7f98a5a83fc098825492f020a4c7': { name: 'StakedNET', is_verified: true, is_fully_verified: true },
  '0xb078cc304a0b264c5f3680dc0488954accd02e87': { name: 'Staking', is_verified: true, is_fully_verified: true }
};
// ---------------------------------------------------------------- mock RPC
const w = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
function makeRpc(opts) {
  const calls = { ...FX.calls, ...(opts.overrides || {}) };
  const now = Math.floor(Date.now() / 1000);
  const head = { number: FX.head.number, timestamp: opts.stale ? FX.head.timestamp : '0x' + (now - 3).toString(16) };
  return function handle(req) {
    const { method, params } = req;
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'latest') return { number: head.number, timestamp: head.timestamp };
      return { number: params[0], timestamp: FX.blocks[params[0]] || head.timestamp };
    }
    if (method === 'eth_blockNumber') return head.number;
    if (method === 'eth_getCode') return FX.codes[params[0].toLowerCase()] || '0x';
    if (method === 'eth_getLogs') {
      const f = params[0]; let logs = (opts.logs || FX.logs).filter(l => l.address.toLowerCase() === f.address.toLowerCase());
      if (f.topics) logs = logs.filter(l => f.topics.every((t, i) => t == null || (l.topics[i] || '').toLowerCase() === t.toLowerCase()));
      return logs;
    }
    if (method === 'eth_call') {
      const k = params[0].to.toLowerCase() + params[0].data.toLowerCase();
      if (calls[k] != null) return calls[k];
      const sel = params[0].data.slice(0, 10);
      if (opts.dynamic) { const v = opts.dynamic(sel, params[0].data); if (v != null) return v; }
      if (sel === '0x70a08231') return w(0); // unknown holder balance
      throw { code: -32000, message: 'execution reverted (no fixture for ' + sel + ')' };
    }
    throw { code: -32601, message: 'method not allowed in test: ' + method };
  };
}
function rpcRoute(handle, log) {
  return async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    const one = r => { log.push(r.method); if (/send|sign|accounts/i.test(r.method)) log.push('!!WRITE ' + r.method); try { return { jsonrpc: '2.0', id: r.id, result: handle(r) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: e }; } };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
  };
}

// ---------------------------------------------------------------- synthetic claim scenario (FAKE VALUES)
const FAKE_ROOT = '0x' + 'ab'.repeat(32), FAKE_REF = '0x' + 'cd'.repeat(32), GPF = 10n ** 9n;
const FAKE_PROOF = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32), '0x' + '44'.repeat(32), '0x' + '55'.repeat(32)];
function claimOverrides() {
  const o = {};
  o[R + '0x295a5212'] = w(1);             // mode = Reward
  o[R + '0x73e2144f'] = w(1);             // latestEpochId = 1
  o[R + '0x70779b15'] = w(123000);        // pot
  o[R + '0x7c3d5f47'] = w(12000);         // liabilities
  o[R + '0xc6b61e4c' + w(1).slice(2)] = '0x' + [FAKE_ROOT, w(12000), w(0), w(GPF), w(13500), w(Math.floor(Date.now() / 1000) - 7200), FAKE_REF].map(x => x.slice(2)).join('');
  return o;
}
function claimDynamic(sel, data, revertClaim) {
  if (sel === '0xfef08fa4') return w(0);          // claimedBy -> false
  if (sel === '0xae0b51df') { if (revertClaim) throw { code: 3, message: 'execution reverted: synthetic revert' }; return w(9007); } // claim() eth_call dry-run
  if (sel === '0x1848f6ec') return w(1);          // verifyAllocation -> true
  if (sel === '0x7965d56d') return w(BigInt('0x' + data.slice(10)) / GPF + 7n); // balanceForGons (+ growth)
  return null;
}
function artifactConfig(variant) {
  const src = fs.readFileSync(path.join(ROOT, 'assets/rr-config.js'), 'utf8');
  const art = {
    schema: 'rr-epoch/1', epochId: 1, root: variant === 'failed' ? '0x' + 'ee'.repeat(32) : FAKE_ROOT, committedTotal: '12000', dataRef: FAKE_REF,
    allocations: [{ holder: HOLDER, amount: '9000', proof: FAKE_PROOF }, { holder: '0x000000000000000000000000000000000000beef', amount: '3000', proof: FAKE_PROOF.slice(0, 2) }]
  };
  const adapter = `{ getEpochArtifact: function(id){ return Promise.resolve(id===1 ? ${JSON.stringify(art)} : null); },
    verifyDataRef: function(){ return Promise.resolve(${JSON.stringify(variant === 'pending' ? 'unknown' : 'match')}); } }`;
  return src.replace('artifacts: null', 'artifacts: /* TEST ONLY: synthetic */ ' + adapter);
}

// ---------------------------------------------------------------- run
const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined });
const results = [];
async function scenario(name, { rpc, config, lookup, interact, sizes = ['desktop', 'mobile'], wait = 2500 }) {
  for (const size of sizes) {
    const ctx = await browser.newContext(size === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [], rpcLog = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await page.route('**/*', async route => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1:8765/')) {
        if (config && u.includes('assets/rr-config.js')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: config });
        return route.continue();
      }
      if (u.startsWith('https://rpc.mainnet.chain.robinhood.com') && rpc) return rpcRoute(rpc, rpcLog)(route);
      const m = /\/api\/v2\/smart-contracts\/(0x[0-9a-fA-F]{40})/.exec(u);
      if (m && rpc) { const v = VERIFIED[m[1].toLowerCase()]; return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(v || {}) }); }
      return route.abort('connectionrefused');
    });
    await page.goto(URL0 + (lookup ? '#me=' + lookup : ''), { waitUntil: 'load' });
    await page.waitForTimeout(wait);
    const probe = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      badge: document.querySelector('[data-l="badge"]').textContent,
      mode: document.querySelector('[data-l="modeBig"]').textContent,
      ppv: document.querySelector('[data-l="ppv"]').textContent,
      yield: document.querySelector('[data-l="yield"]').textContent,
      claim: document.querySelector('#claimOut').innerText.slice(0, 300),
      proofs: [...document.querySelectorAll('#claimOut code')].map(c => c.textContent).join(' '),
      wallet: ['ethereum', 'web3', 'WalletConnect'].filter(k => k in window && k !== 'ethereum' ? true : false),
      // any actionable control offering a wallet / signing flow (explanatory "never" copy is fine)
      connectText: [...document.querySelectorAll('button, a, input[type=submit]')].some(el => /connect|sign|approve|send|wallet/i.test(el.textContent + ' ' + (el.value || '') + ' ' + (el.getAttribute('aria-label') || '')))
    }));
    if (interact) probe.interact = await interact(page, ctx);
    const shot = path.join(OUT, `${name}-${size}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    results.push({ name, size, errors, writes: rpcLog.filter(x => x.startsWith('!!')), rpcMethods: [...new Set(rpcLog)], ...probe });
    await ctx.close();
  }
}

await scenario('offline', { rpc: null, wait: 1500 });
// Input validation, copy button and a lookup typed by hand (after the hash lookup finished).
async function interactLookup(page, ctx) {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const out = {};
  const msg = async v => { await page.fill('#addr', v); await page.click('#lookup button'); await page.waitForTimeout(150); return page.textContent('#lookupMsg'); };
  out.tooLong = /40 hex/.test(await msg('0x' + 'a'.repeat(41)));
  out.seed = /seed phrase/.test(await msg('apple banana cherry dragon eagle falcon grape'));
  const copy = page.locator('#clist .copy').first(); await copy.click(); await page.waitForTimeout(100);
  out.copy = (await copy.textContent()) === 'Copied';
  const typed = '0x' + 'AbCd'.repeat(10);
  await msg(typed); await page.waitForTimeout(1500);
  out.typedLookup = (await page.textContent('#lookupMsg')).includes(typed) && (await page.textContent('[data-l="h_bal"]')).trim() === '0 TEN';
  return out;
}
await scenario('mainnet', { rpc: makeRpc({}), lookup: '0x6ED716b1C351C355b736494704bD297Ec73e72F1', interact: interactLookup });
await scenario('stale', { rpc: makeRpc({ stale: true }), sizes: ['desktop'] });
const claimRpc = (revertClaim) => makeRpc({ overrides: claimOverrides(), dynamic: (s, d) => claimDynamic(s, d, revertClaim) });
await scenario('claim-ready', { rpc: claimRpc(), config: artifactConfig('ready'), lookup: HOLDER });
await scenario('claim-pending', { rpc: claimRpc(), config: artifactConfig('pending'), lookup: HOLDER, sizes: ['desktop'] });
await scenario('claim-failed', { rpc: claimRpc(), config: artifactConfig('failed'), lookup: HOLDER, sizes: ['desktop'] });
await scenario('claim-reverts', { rpc: claimRpc(true), config: artifactConfig('ready'), lookup: HOLDER, sizes: ['desktop'] });
await scenario('claim-noartifact', { rpc: claimRpc(), lookup: HOLDER, sizes: ['desktop'] });

await browser.close(); server.close();
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
for (const r of results) console.log(`${r.name.padEnd(17)} ${r.size.padEnd(7)} badge=${r.badge.padEnd(8)} mode=${r.mode.padEnd(9)} overflowX=${r.overflowX} errors=${r.errors.length} writes=${r.writes.length} connectUI=${r.connectText} | claim: ${r.claim.split('\n')[0]}${r.interact ? ' | ' + JSON.stringify(r.interact) : ''}`);
// Claim Center must land in the expected safety state; params only in claim-ready.
const EXPECT = { offline: 'CHECK AN ADDRESS', mainnet: 'NOTHING TO CLAIM', stale: 'CHECK AN ADDRESS', 'claim-ready': 'EPOCH #1', 'claim-pending': 'VERIFICATION PENDING', 'claim-failed': 'VERIFICATION FAILED', 'claim-reverts': 'VERIFICATION FAILED', 'claim-noartifact': 'CLAIM DATA UNAVAILABLE' };
for (const r of results) {
  const first = r.claim.split('\n')[0].toUpperCase();
  if (r.interact) r.claimOk = Object.values(r.interact).every(Boolean);
  r.claimOk = (r.claimOk !== false) && first.startsWith(EXPECT[r.name]) && (r.name === 'claim-ready') === /0x(11){32}/.test(r.claim + r.proofs);
}
const bad = results.filter(r => !r.claimOk || (r.name === 'offline' ? r.errors.filter(e => !/ERR_CONNECTION_REFUSED/.test(e)).length : r.errors.length) || r.writes.length || r.overflowX > 0 || r.connectText);
if (bad.length) { console.log('\nISSUES:'); bad.forEach(r => console.log(r.name, r.size, 'claimOk', r.claimOk, r.errors, r.writes, 'overflow', r.overflowX)); process.exitCode = 1; }

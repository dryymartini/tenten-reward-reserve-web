/* ============================================================================
   rr-app.js — Reward Reserve V1 page controller (read-only)
   Live on-chain reads: RR.chain. Off-chain data boundary: RR.providers.
   Accounting bindings are the frozen ones from the spec (§5, §11.1):
     Permanent Principal          = principalValueAtCheckpoint
     Uncrystallized sNET Yield    = principalValue() - principalValueAtCheckpoint
     Reward Pot                   = rewardPotValue()
     Allocated / Unclaimed        = outstandingLiabilityValue()
     Total sNET Held (reference)  = sNET.balanceOf(Reward Reserve)
   All values of one refresh are read at the SAME block.
   ========================================================================== */
(function () {
  'use strict';
  var C = window.RR_CONFIG, CH = window.RR.chain, P = window.RR.providers, A = C.addresses;
  var R = A.rewardReserve, EXPL = C.explorer;
  var BLOCKSCOUT_WRITE = EXPL + '/address/' + R + '?tab=write_contract';

  // ------------------------------------------------------------------ utils
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function S(k, v) { $$('[data-l="' + k + '"]').forEach(function (e) { e.textContent = v; }); }
  function H(k, html) { $$('[data-l="' + k + '"]').forEach(function (e) { e.innerHTML = html; }); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hhmmss(d) { d = d || new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (x) { return (x < 10 ? '0' : '') + x; }).join(':'); }
  function ago(t) { var s = Math.max(0, Math.floor(Date.now() / 1000 - t)); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm ago'; return Math.floor(s / 86400) + 'd ago'; }
  function utc(t) { var d = new Date(t * 1000); return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' + ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ' UTC'; }
  function num(n) { return Number(n).toLocaleString('en-US'); }
  var DEC = { ten: 18, net: 9, snet: 9 };
  function sn(v) { return CH.amt(v, DEC.snet, 'sNET'); }
  function nt(v) { return CH.amt(v, DEC.net, 'NET'); }
  function tn(v) { return CH.amt(v, DEC.ten, 'TEN'); }
  function tnShort(v) { var n = Number(BigInt(v) / 10n ** 14n) / 1e4; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B TEN'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M TEN'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K TEN'; return tn(v); }
  function pctWad(w) { var bp = BigInt(w) * 10000n / 10n ** 16n; return CH.units(bp, 2, 2) + '%'; } // WAD 1e18 = 100%
  function pctOf(v, total) { var bp = (v < 0n ? -v : v) * 1000000n / total; return (v < 0n ? '−' : '') + CH.units(bp, 4, 2) + '%'; }
  function lc(a) { return String(a).toLowerCase(); }
  function link(path, label) { return '<a href="' + EXPL + path + '" target="_blank" rel="noopener">' + esc(label) + '</a>'; }

  function badge(keys, text, bad) {
    keys.forEach(function (k) { $$('[data-l="' + k + '"]').forEach(function (e) { e.textContent = text; e.classList.toggle('bad', !!bad); }); });
  }
  function modState(name, live) { $$('[data-mod="' + name + '"]').forEach(function (e) { e.classList.toggle('is-stale', !live); }); }
  function alertBox(k, html, info) { $$('[data-l-alert="' + k + '"]').forEach(function (e) { e.hidden = !html; e.innerHTML = html || ''; e.classList.toggle('info', !!info); }); }

  // ------------------------------------------------------------ chrome (same behavior as /reserve/)
  var nav = $('#nav'), hb = $('#hb'), scrim = $('#mscrim');
  function openMenu(o) { nav.classList.toggle('open', o); hb.setAttribute('aria-expanded', o); hb.textContent = o ? '× CLOSE' : '≡ MENU'; document.body.classList.toggle('menu-open', o); scrim.hidden = !o; }
  scrim.addEventListener('click', function () { openMenu(false); });
  hb.addEventListener('click', function () { openMenu(!nav.classList.contains('open')); });
  $$('.links-row a', nav).forEach(function (a) { a.addEventListener('click', function () { openMenu(false); }); });
  addEventListener('keydown', function (e) { if (e.key === 'Escape') openMenu(false); });
  $$('[data-min]').forEach(function (b) { b.addEventListener('click', function () { b.closest('.win').classList.toggle('min'); }); });
  var menu = $$('.menu .links-row a').filter(function (a) { return a.getAttribute('href').charAt(0) === '#'; });
  var ids = menu.map(function (a) { return a.getAttribute('href').slice(1); }), row = $('.menu .links-row'), curIdx = -1;
  function spy() {
    var y = scrollY + 80, idx = 0; ids.forEach(function (id, i) { var t = document.getElementById(id); if (t && t.offsetTop <= y) idx = i; });
    if (idx === curIdx) return; curIdx = idx; menu.forEach(function (a, i) { a.classList.toggle('on', i === idx); });
    var a = menu[idx]; if (a && row && !nav.classList.contains('open') && row.scrollWidth > row.clientWidth + 4) { row.scrollTo({ left: Math.max(0, a.offsetLeft - (row.clientWidth - a.offsetWidth) / 2), behavior: 'smooth' }); }
  }
  addEventListener('scroll', spy, { passive: true }); spy();
  // copy buttons (delegated: many are rendered later)
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('.copy'); if (!b) return;
    var val = b.getAttribute('data-copy'), orig = b.getAttribute('data-label') || b.textContent; b.setAttribute('data-label', orig);
    function ok() { b.textContent = 'Copied'; setTimeout(function () { b.textContent = orig; }, 1600); }
    function fb() { var t = document.createElement('textarea'); t.value = val; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); ok(); } catch (e) { } document.body.removeChild(t); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(val).then(ok, fb); else fb();
  });
  $$('[data-href="logs"]').forEach(function (a) { a.href = EXPL + '/address/' + R + '?tab=logs'; });

  // ------------------------------------------------------------ live chain state
  var ST = { ok: false, lastOkAt: 0, head: null, r: null, logs: null };
  var SLOT_CALLS = [0, 1, 2, 3, 4, 5, 6];

  function coreCalls() {
    var e = function (to, sel, args) { return [to, CH.callData(sel, args)]; }, pR = [CH.encAddr(R)];
    var list = [
      e(R, CH.SEL.mode), e(R, CH.SEL.paused), e(R, CH.SEL.latestEpochId), e(R, CH.SEL.lastEpochTime),       // 0-3
      e(R, CH.SEL.lastModeTransitionAt), e(R, CH.SEL.principalValue), e(R, CH.SEL.principalValueAtCheckpoint), // 4-6
      e(R, CH.SEL.rewardPotValue), e(R, CH.SEL.outstandingLiabilityValue), e(R, CH.SEL.isSolvent),           // 7-9
      e(R, CH.SEL.annualizedOrganicRewardRateWad), e(R, CH.SEL.operator),                                     // 10-11
      e(R, CH.SEL.TEN), e(R, CH.SEL.NET), e(R, CH.SEL.sNET), e(R, CH.SEL.staking), e(R, CH.SEL.priceReader), // 12-16
      e(R, CH.SEL.MIN_DWELL), e(R, CH.SEL.ORGANIC_RATE_THRESHOLD_BPS),                                         // 17-18
      e(A.snet, CH.SEL.balanceOf, pR), e(A.ten, CH.SEL.balanceOf, pR), e(A.net, CH.SEL.balanceOf, pR),        // 19-21
      e(A.spotReader, CH.SEL.getSpotPriceWad),                                                               // 22
      e(A.ten, CH.SEL.decimals), e(A.net, CH.SEL.decimals), e(A.snet, CH.SEL.decimals)                        // 23-25
    ];
    SLOT_CALLS.forEach(function (i) { list.push(e(R, CH.SEL.dailyTenExposure, [CH.encUint(i)])); });        // 26-32
    return list;
  }

  function refreshChain() {
    return CH.one(['eth_getBlockByNumber', ['latest', false]]).then(function (blk) {
      var head = { number: Number(BigInt(blk.number)), ts: Number(BigInt(blk.timestamp)) };
      var tag = CH.hexN(head.number);
      var calls = coreCalls().map(function (c) { return CH.ethCall(c[0], c[1], tag); });
      return CH.rpcSettled(calls).then(function (res) {
        var CORE = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 19, 20, 21];
        var failed = CORE.filter(function (i) { return !res[i].ok; });
        if (failed.length) throw new Error('core reads failed (' + failed.length + ')');
        var v = function (i) { return res[i].ok ? BigInt(res[i].result) : null; };
        var r = {
          mode: Number(v(0)), paused: v(1) === 1n, latestEpochId: Number(v(2)), lastEpochTime: v(3) == null ? null : Number(v(3)),
          lastModeTransitionAt: Number(v(4)), pv: v(5), ppv: v(6), pot: v(7), liab: v(8), solvent: v(9) === 1n,
          rateWad: v(10), operator: '0x' + res[11].result.slice(-40),
          wiring: { ten: CH.addrAt(res[12].result, 0), net: CH.addrAt(res[13].result, 0), snet: CH.addrAt(res[14].result, 0), staking: CH.addrAt(res[15].result, 0), priceReader: CH.addrAt(res[16].result, 0) },
          minDwell: Number(v(17)), thrBps: v(18), held: v(19), tenLocked: v(20), pendingNet: v(21), spot: v(22),
          dec: { ten: v(23), net: v(24), snet: v(25) }, exposure: []
        };
        SLOT_CALLS.forEach(function (i) { var x = res[26 + i]; if (x.ok) r.exposure.push({ day: Number(CH.u(x.result, 0)), value: CH.u(x.result, 1), written: CH.u(x.result, 2) === 1n }); });
        if (r.dec.ten != null) DEC.ten = Number(r.dec.ten); if (r.dec.net != null) DEC.net = Number(r.dec.net); if (r.dec.snet != null) DEC.snet = Number(r.dec.snet);
        var more = r.latestEpochId > 0 ? CH.rpc([CH.ethCall(R, CH.callData(CH.SEL.epochs, [CH.encUint(r.latestEpochId)]), tag)]).then(function (x) { r.latestEpoch = decodeEpoch(x[0]); }, function () { }) : Promise.resolve();
        return more.then(function () { ST.head = head; ST.r = r; ST.ok = true; ST.lastOkAt = Date.now(); ST.err = null; renderChain(); });
      });
    }).catch(function (e) { ST.ok = false; ST.err = e; renderChainError(e); });
  }

  function decodeEpoch(d) {
    return { root: CH.word(d, 0), committedTotal: CH.u(d, 1), claimed: CH.u(d, 2), gonsPerFragmentAtPublish: CH.u(d, 3), budget: CH.u(d, 4), publishedAt: Number(CH.u(d, 5)), dataRef: CH.word(d, 6) };
  }

  function freshness() {
    if (!ST.head) return { live: false, label: 'LOADING' };
    var headAge = Math.floor(Date.now() / 1000) - ST.head.ts, sinceOk = (Date.now() - ST.lastOkAt) / 1000;
    if (!ST.ok) return { live: false, label: 'OFFLINE', bad: true };
    if (headAge > C.staleAfterSec) return { live: false, label: 'STALE', bad: true, why: 'chain head is ' + ago(ST.head.ts).replace(' ago', '') + ' old' };
    if (sinceOk > (C.pollMs * 2 + 20000) / 1000) return { live: false, label: 'STALE', bad: true, why: 'no successful read for ' + Math.round(sinceOk) + 's' };
    return { live: true, label: 'LIVE' };
  }

  function exposureInfo(r) {
    var today = Math.floor(ST.head.ts / 86400), n = 0;
    r.exposure.forEach(function (s) { if (s.written && today >= s.day && today - s.day < 7) n++; });
    return n;
  }

  function renderChain() {
    var r = ST.r, f = freshness();
    var yieldV = r.pv - r.ppv;
    var modeName = r.mode === 1 ? 'REWARD' : r.mode === 0 ? 'COMPOUND' : 'UNKNOWN';
    var expN = exposureInfo(r);

    // accounting guards (§13): never force numbers that do not reconcile
    var warns = [];
    if (yieldV < 0n) warns.push('principalValue() is below principalValueAtCheckpoint: uncrystallized yield cannot be negative. Values withheld.');
    var accounted = r.pv + r.pot + r.liab, surplus = r.held - accounted;
    if ((surplus >= 0n) !== r.solvent) warns.push('isSolvent() disagrees with the bucket sum read at the same block. Showing contract values only.');
    if (!r.solvent) warns.push('isSolvent() is FALSE: sNET held is below principal + pot + allocated.');
    var wiringOk = lc(r.wiring.ten) === lc(A.ten) && lc(r.wiring.net) === lc(A.net) && lc(r.wiring.snet) === lc(A.snet) && lc(r.wiring.staking) === lc(A.staking) && lc(r.wiring.priceReader) === lc(A.spotReader);
    if (!wiringOk) warns.push('Contract wiring does not match the published addresses (TEN/NET/sNET/staking/priceReader).');
    var acctBad = warns.length > 0;

    // hero
    S('modeBig', modeName);
    S('modeSub', r.lastModeTransitionAt ? 'since ' + utc(r.lastModeTransitionAt).slice(0, -10) + ' · status only' : 'no change since deployment · status only');
    S('potBig', sn(r.pot));
    var rateTxt = pctWad(r.rateWad); // contract value as-is (spec §6): no frontend reinterpretation
    S('rateBig', rateTxt);

    // overview
    S('modeFull', modeName + ' MODE');
    S('modeWhy', r.mode === 1 ? 'the realized organic rate fell below 10%: holders receive allocations from the Reward Pot' : 'organic rewards are strong enough: the principal compounds, nothing is allocated');
    var bar = Math.max(0, Math.min(100, Number(BigInt(r.rateWad) * 10000n / (2n * 10n ** 17n)) / 100));
    ['rateBar', 'rateBar2'].forEach(function (id) { var e = document.getElementById(id); if (e) e.style.width = bar + '%'; });
    S('rateLbl', 'rate ' + rateTxt);
    S('tenLocked', tn(r.tenLocked));
    S('ppv', acctBad && yieldV < 0n ? '--' : sn(r.ppv));
    S('yield', yieldV < 0n ? '--' : sn(yieldV));
    S('pot', sn(r.pot)); S('liab', sn(r.liab)); S('pendingNet', nt(r.pendingNet)); S('snetHeld', sn(r.held));
    S('solvent', r.solvent ? 'SOLVENT' : 'NOT SOLVENT');
    S('latestEpoch', r.latestEpochId === 0 ? 'none published yet' : '#' + r.latestEpochId + (r.latestEpoch ? ' · ' + ago(r.latestEpoch.publishedAt) : ''));
    S('paused', r.paused ? 'PAUSED (claims still open)' : 'active');
    S('block', num(ST.head.number) + ' · ' + utc(ST.head.ts));
    alertBox('acct', acctBad ? '<b>ACCOUNTING WARNING</b><br>' + warns.map(esc).join('<br>') : '');

    // engine (balance sheet: each row's share of total sNET held)
    S('e_ppv', yieldV < 0n ? '--' : sn(r.ppv)); S('e_yield', yieldV < 0n ? '--' : sn(yieldV)); S('e_pot', sn(r.pot)); S('e_liab', sn(r.liab));
    S('e_pending', nt(r.pendingNet)); S('e_held', sn(r.held));
    S('r_held', sn(r.held)); S('r_pv', sn(r.pv)); S('r_pot', sn(r.pot)); S('r_liab', sn(r.liab)); S('r_surplus', surplus >= 0n ? sn(surplus) : '−' + sn(-surplus));
    function shareOf(v) { return r.held > 0n ? pctOf(v, r.held) : '--'; }
    S('e_ppv_pct', yieldV < 0n ? '--' : shareOf(r.ppv)); S('e_yield_pct', yieldV < 0n ? '--' : shareOf(yieldV));
    S('e_pot_pct', shareOf(r.pot)); S('e_liab_pct', shareOf(r.liab));
    S('e_surplus_pct', r.held > 0n ? (surplus >= 0n ? shareOf(surplus) : '−' + pctOf(-surplus, r.held)) : '--');
    S('solvencyLine', r.solvent ? 'isSolvent() = true · held ≥ principal + pot + allocated' : 'isSolvent() = FALSE');
    S('engineStatus', 'BLOCK ' + num(ST.head.number));
    alertBox('engine', acctBad ? '<b>ACCOUNTING WARNING</b><br>' + warns.map(esc).join('<br>') : '');

    // rate
    S('rateFull', pctWad(r.rateWad));
    S('rateNote', BigInt(r.rateWad) === 0n ? 'no organic PAR reward observed in the 7-day window: 0% is the contract reading, not an estimate' + (expN === 0 ? ' · no TEN exposure checkpoint in the window yet' : '') : 'annualizedOrganicRewardRateWad() · read at block ' + num(ST.head.number));
    S('rateMode', modeName);
    S('lastChange', r.lastModeTransitionAt ? utc(r.lastModeTransitionAt) : 'none since deployment');
    var next = r.lastModeTransitionAt + r.minDwell;
    S('nextChange', r.lastModeTransitionAt === 0 ? 'no dwell pending' : (next * 1000 > Date.now() ? utc(next) : 'dwell satisfied'));
    S('expDays', expN + ' / 7 days');
    S('spot', r.spot == null ? 'unavailable' : '1 TEN = ' + CH.units(r.spot, 18, 12).replace(/0+$/, '').replace(/\.$/, '') + ' NET');

    // contracts
    H('operator', link('/address/' + r.operator, CH.short(r.operator) + ' ↗'));
    S('wiring', wiringOk ? 'OK · TEN/NET/sNET/staking/reader match' : 'MISMATCH');

    badge(['badge', 'badge2', 'badge3', 'badge6'], f.label, f.bad);
    S('updated', 'block ' + num(ST.head.number) + ' · read ' + hhmmss() + ' · reads again every minute' + (f.why ? ' · ' + f.why : ''));
    S('updated2', 'block ' + num(ST.head.number) + ' · ' + hhmmss());
    modState('chain', f.live && !acctBad);
    ST.acctBad = acctBad;
    if (acctBad) badge(['badge', 'badge2'], 'CHECK', true);
  }

  function renderChainError(e) {
    var had = !!ST.r;
    badge(['badge', 'badge2', 'badge3', 'badge6'], 'OFFLINE', true);
    S('updated', had ? 'could not reach Robinhood Chain RPC · values below are from block ' + num(ST.head.number) + ' and may be outdated · retrying' : 'could not reach Robinhood Chain RPC · retrying every minute');
    S('updated2', 'RPC unreachable · retrying');
    S('engineStatus', had ? 'LAST GOOD BLOCK ' + num(ST.head.number) : 'NO DATA');
    if (!had) {
      ['modeBig', 'rateBig', 'potBig', 'modeFull', 'tenLocked', 'ppv', 'yield', 'pot', 'liab', 'pendingNet', 'snetHeld', 'solvent', 'latestEpoch', 'paused', 'block',
        'e_ppv', 'e_yield', 'e_pot', 'e_liab', 'e_pending', 'e_held', 'e_ppv_pct', 'e_yield_pct', 'e_pot_pct', 'e_liab_pct', 'e_surplus_pct',
        'r_held', 'r_pv', 'r_pot', 'r_liab', 'r_surplus', 'rateFull', 'rateMode', 'lastChange', 'nextChange', 'expDays', 'spot', 'operator', 'wiring'].forEach(function (k) { S(k, 'unavailable'); });
      S('modeWhy', 'Robinhood Chain RPC unreachable: no value is shown instead of a guessed one');
      S('rateNote', 'unavailable'); S('rateLbl', 'rate unavailable');
    }
    modState('chain', false);
    console.warn('[reward-reserve] chain read failed:', e && e.message);
  }

  // ------------------------------------------------------------ event log: activity, since launch, transitions
  var EV = {};
  EV[CH.TOPIC.AllocationClaimed] = 'AllocationClaimed'; EV[CH.TOPIC.EpochCancelled] = 'EpochCancelled'; EV[CH.TOPIC.EpochPublished] = 'EpochPublished';
  EV[CH.TOPIC.ModeChanged] = 'ModeChanged'; EV[CH.TOPIC.NetProcessed] = 'NetProcessed'; EV[CH.TOPIC.OrganicInflowReported] = 'OrganicInflowReported';
  EV[CH.TOPIC.PausedSet] = 'PausedSet'; EV[CH.TOPIC.PrincipalFunded] = 'PrincipalFunded'; EV[CH.TOPIC.TenDonated] = 'TenDonated'; EV[CH.TOPIC.OperatorAccepted] = 'OperatorAccepted';

  function decodeLog(l) {
    var name = EV[l.topics[0]]; if (!name) return null;
    var d = l.data, t = l.topics, x = { name: name, block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, idx: Number(BigInt(l.logIndex || '0x0')) };
    switch (name) {
      case 'AllocationClaimed': x.epochId = Number(BigInt(t[1])); x.holder = '0x' + t[2].slice(-40); x.amount = CH.u(d, 0); x.payout = CH.u(d, 1); break;
      case 'EpochCancelled': x.epochId = Number(BigInt(t[1])); x.returned = CH.u(d, 0); break;
      case 'EpochPublished': x.epochId = Number(BigInt(t[1])); x.root = t[2]; x.committedTotal = CH.u(d, 0); x.budget = CH.u(d, 1); x.dataRef = CH.word(d, 2); break;
      case 'ModeChanged': x.mode = Number(BigInt(t[1])); x.rateWad = CH.u(d, 0); x.growth = CH.u(d, 1); break;
      case 'NetProcessed': x.net = CH.u(d, 0); x.credited = CH.u(d, 1); x.newPv = CH.u(d, 2); break;
      case 'OrganicInflowReported': x.ten = CH.u(d, 0); x.net = CH.u(d, 1); x.priceWad = CH.u(d, 2); break;
      case 'PausedSet': x.paused = CH.u(d, 0) === 1n; break;
      case 'PrincipalFunded': x.from = '0x' + t[1].slice(-40); x.amount = CH.u(d, 0); x.newPv = CH.u(d, 1); break;
      case 'TenDonated': x.from = '0x' + t[1].slice(-40); x.amount = CH.u(d, 0); x.newBal = CH.u(d, 1); break;
      case 'OperatorAccepted': x.prev = '0x' + t[1].slice(-40); x.cur = '0x' + t[2].slice(-40); break;
    }
    return x;
  }
  function describe(e) {
    switch (e.name) {
      case 'OrganicInflowReported': return ['PAR reward reported', '+' + tn(e.ten) + ' · +' + nt(e.net)];
      case 'NetProcessed': return ['NET processed → sNET', nt(e.net) + ' → ' + sn(e.credited) + ' principal'];
      case 'PrincipalFunded': return ['principal funded', sn(e.amount) + ' · from ' + CH.short(e.from)];
      case 'ModeChanged': return ['mode → ' + (e.mode === 1 ? 'REWARD' : 'COMPOUND'), 'rate ' + pctWad(e.rateWad) + (e.growth > 0n ? ' · crystallized ' + sn(e.growth) : '')];
      case 'EpochPublished': return ['epoch #' + e.epochId + ' published', sn(e.committedTotal) + ' allocated'];
      case 'EpochCancelled': return ['epoch #' + e.epochId + ' cancelled', sn(e.returned) + ' back to pot'];
      case 'AllocationClaimed': return ['claim · epoch #' + e.epochId, sn(e.payout) + ' to ' + CH.short(e.holder)];
      case 'TenDonated': return ['TEN locked', '+' + tn(e.amount) + ' · from ' + CH.short(e.from)];
      case 'PausedSet': return [e.paused ? 'paused' : 'unpaused', 'claims never paused'];
      case 'OperatorAccepted': return ['operator changed', CH.short(e.prev) + ' → ' + CH.short(e.cur)];
    }
    return [e.name, ''];
  }

  function refreshLogs() {
    if (!ST.head) return Promise.resolve();
    var headNo = ST.head.number;
    return CH.getAllLogs(R, null, C.deployBlock, headNo).then(function (res) {
      var evs = res.logs.map(decodeLog).filter(Boolean).sort(function (a, b) { return b.block - a.block || b.idx - a.idx; });
      var blocks = []; evs.forEach(function (e) { if (blocks.indexOf(e.block) < 0) blocks.push(e.block); });
      var need = blocks.slice(0, 120); if (need.indexOf(C.deployBlock) < 0) need.push(C.deployBlock); // deployment anchors the growth chart at 0
      return CH.timestamps(need).then(function (ts) {
        evs.forEach(function (e) { e.ts = ts[e.block]; });
        ST.deployTs = ts[C.deployBlock] || ST.deployTs;
        ST.logs = { evs: evs, head: headNo, at: Date.now() };
        renderLogs();
      });
    }).catch(function (e) {
      badge(['badge4', 'badge5'], 'UNAVAILABLE', true);
      S('actStatus', 'LOG UNAVAILABLE');
      S('launchNote', 'event log could not be read in full (' + e.message + '). Cumulative totals are withheld rather than shown partially.');
      if (!ST.logs) {
        $('#actList').innerHTML = '<li>event log unavailable right now: nothing is shown instead of a partial history</li>';
        $$('#launchKv b').forEach(function (b) { b.textContent = 'unavailable'; });
        $('#modeList').innerHTML = '<li>unavailable</li>'; S('org7d', 'unavailable');
      }
      modState('logs', false);
    });
  }

  function renderLogs() {
    var L = ST.logs, evs = L.evs;
    // activity
    var ol = $('#actList');
    ol.innerHTML = evs.length ? evs.slice(0, 40).map(function (e) {
      var d = describe(e);
      return '<li><span>' + esc(e.ts ? ago(e.ts) : 'block ' + num(e.block)) + '</span><span class="d"></span><span>' + esc(d[0]) + '</span><span class="r">' + esc(d[1]) + ' · <a href="' + EXPL + '/tx/' + e.tx + '" target="_blank" rel="noopener">tx ↗</a></span></li>';
    }).join('') : '<li>no events yet</li>';
    S('actStatus', num(evs.length) + ' EVENTS · BLOCKS ' + num(C.deployBlock) + '–' + num(L.head) + ' · ' + hhmmss(new Date(L.at)));

    // since launch (flows) — complete log only
    var sum = function (name, k) { return evs.filter(function (e) { return e.name === name; }).reduce(function (s, e) { return s + e[k]; }, 0n); };
    // An EpochPublished is net of cancellation when a later EpochCancelled for that id exists.
    var alloc = 0n; evs.forEach(function (p) {
      if (p.name !== 'EpochPublished') return;
      var c = evs.some(function (x) { return x.name === 'EpochCancelled' && x.epochId === p.epochId && (x.block > p.block || (x.block === p.block && x.idx > p.idx)) && !evs.some(function (y) { return y.name === 'EpochPublished' && y.epochId === p.epochId && (y.block > p.block || (y.block === p.block && y.idx > p.idx)) && (y.block < x.block || (y.block === x.block && y.idx < x.idx)); }); });
      if (!c) alloc += p.committedTotal;
    });
    var growth = 0n; evs.forEach(function (e) { if (e.name === 'ModeChanged' && e.growth > 0n) growth += e.growth; });
    var n = function (name) { return evs.filter(function (e) { return e.name === name; }).length; };
    if (ST.r) S('L_ten', tn(ST.r.tenLocked));
    S('L_parNet', nt(sum('OrganicInflowReported', 'net')));
    S('L_parTen', tn(sum('OrganicInflowReported', 'ten')));
    S('L_netProc', nt(sum('NetProcessed', 'net')));
    S('L_princNet', sn(sum('NetProcessed', 'credited')));
    S('L_princFund', sn(sum('PrincipalFunded', 'amount')));
    // split to principal / pot is not emitted on chain: Indexer V1 data only (spec §10), never re-derived here
    S('L_growth', sn(growth)); S('L_toPrinc', 'awaiting Indexer V1'); S('L_toPot', 'awaiting Indexer V1');
    S('L_alloc', sn(alloc));
    S('L_claimed', sn(sum('AllocationClaimed', 'amount')) + ' / ' + sn(sum('AllocationClaimed', 'payout')));
    S('L_counts', n('ModeChanged') + ' · ' + n('EpochPublished') + ' · ' + n('AllocationClaimed'));
    S('launchNote', 'complete event log, blocks ' + num(C.deployBlock) + '–' + num(L.head) + ' · read ' + hhmmss(new Date(L.at)));
    badge(['badge4', 'badge5'], 'LIVE', false);
    modState('logs', true);

    // mode transitions
    var mc = evs.filter(function (e) { return e.name === 'ModeChanged'; });
    $('#modeList').innerHTML = mc.length ? mc.slice(0, 20).map(function (e) {
      return '<li><span>' + esc(e.ts ? utc(e.ts) : 'block ' + num(e.block)) + '</span><span class="d"></span><span>' + (e.mode === 1 ? 'REWARD' : 'COMPOUND') + ' @ ' + pctWad(e.rateWad) + '</span><span class="r">' + (e.growth > 0n ? 'crystallized ' + esc(sn(e.growth)) + ' · ' : '') + '<a href="' + EXPL + '/tx/' + e.tx + '" target="_blank" rel="noopener">tx ↗</a></span></li>';
    }).join('') : '<li>no mode change since deployment: the reserve started in COMPOUND</li>';

    // organic rewards reported in the last 7 days (events; units kept separate)
    var since = Math.floor(Date.now() / 1000) - 7 * 86400, oTen = 0n, oNet = 0n, oN = 0, unknownTs = false;
    evs.forEach(function (e) { if (e.name !== 'OrganicInflowReported') return; if (!e.ts) { unknownTs = true; return; } if (e.ts >= since) { oTen += e.ten; oNet += e.net; oN++; } });
    S('org7d', oN === 0 ? (unknownTs ? 'unavailable' : 'none observed') : tn(oTen) + ' + ' + nt(oNet));

    drawPG(evs);
  }

  // ------------------------------------------------------------ principal / reward pot growth chart
  // Every point but the last comes straight from an on-chain event: PrincipalFunded/NetProcessed
  // report their own new checkpoint value, so those points are exact. A ModeChanged crystallization
  // does not emit separate principal/pot legs, so its growth is split 50/50 per the frozen rule
  // (spec §4) — never a frontend-invented ratio. The last point is read live from the contract.
  function computePGSeries(evs) {
    var chrono = evs.slice().sort(function (a, b) { return a.block - b.block || a.idx - b.idx; });
    var principal = 0n, pot = 0n, pts = [], dropped = 0;
    // A freshly deployed reserve holds nothing: (0, 0) at the deployment block is a real fact,
    // not an estimate, and anchors the line even before the first PrincipalFunded/NetProcessed.
    if (ST.deployTs) pts.push({ t: ST.deployTs, p: 0n, r: 0n });
    function push(e) { if (e.ts) pts.push({ t: e.ts, p: principal, r: pot }); else dropped++; }
    chrono.forEach(function (e) {
      if (e.name === 'PrincipalFunded' || e.name === 'NetProcessed') { principal = e.newPv; push(e); }
      else if (e.name === 'ModeChanged' && e.growth > 0n) { var toPot = e.growth / 2n; principal += e.growth - toPot; pot += toPot; push(e); }
      else if (e.name === 'EpochPublished') { pot -= e.committedTotal; push(e); }
      else if (e.name === 'EpochCancelled') { pot += e.returned; push(e); }
    });
    if (ST.r && ST.head) pts.push({ t: ST.head.ts, p: ST.r.ppv, r: ST.r.pot });
    return { pts: pts, dropped: dropped };
  }

  function drawPG(evs) {
    var svg = $('#pgChart svg'); if (!svg) return;
    var series = computePGSeries(evs), pts = series.pts;
    if (pts.length < 2) {
      svg.innerHTML = '<line class="grid" x1="40" x2="990" y1="150" y2="150"/><text class="msg" x="500" y="138" text-anchor="middle">NOT ENOUGH HISTORY YET</text><text class="msg2" x="500" y="176" text-anchor="middle">plots once principal or the reward pot changes on chain</text>';
      S('pgTotal', 'no change yet'); S('pgNote', 'This line only plots real on-chain checkpoints. Nothing is estimated between them.');
      return;
    }
    var W = 1000, Hh = 300, L = 62, Rr = 10, T = 14, B = 30;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t; if (t1 === t0) t1 = t0 + 3600;
    var maxV = 1n; pts.forEach(function (pt) { if (pt.p > maxV) maxV = pt.p; if (pt.r > maxV) maxV = pt.r; });
    // headroom above the highest value so a flat line never sits exactly on the top gridline
    // (indistinguishable from the grid itself, which is what made an unchanged principal read as "no line")
    var topV = maxV + maxV / 4n + 1n;
    var X = function (t) { return L + (t - t0) / (t1 - t0) * (W - L - Rr); };
    var Y = function (v) { return T + (1 - Number(v * 10000n / topV) / 10000) * (Hh - T - B); };
    var o = '';
    for (var i = 0; i <= 4; i++) { var v = topV * BigInt(Math.round(i / 4 * 10000)) / 10000n; o += '<line class="grid" x1="' + L + '" x2="' + (W - Rr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="ax" x="' + (L - 6) + '" y="' + (Y(v) + 5) + '" text-anchor="end">' + sn(v).replace(' sNET', '') + '</text>'; }
    for (var j = 0; j <= 4; j++) { var t = t0 + (t1 - t0) * j / 4, d = new Date(t * 1000); o += '<text class="ax" x="' + X(t) + '" y="' + (Hh - 8) + '" text-anchor="' + (j === 0 ? 'start' : j === 4 ? 'end' : 'middle') + '">' + d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + '</text>'; }
    function line(cls, key) { return '<path class="' + cls + '" d="' + pts.map(function (pt, k) { return (k ? 'L' : 'M') + X(pt.t).toFixed(1) + ' ' + Y(pt[key]).toFixed(1); }).join(' ') + '"/>'; }
    // explicit dots at each real checkpoint: a flat 2-point line is easy to mistake for an empty
    // chart otherwise, especially when it lands near a gridline
    function dots(cls, key) { return pts.map(function (pt) { return '<circle class="' + cls + '" cx="' + X(pt.t).toFixed(1) + '" cy="' + Y(pt[key]).toFixed(1) + '" r="4.5"/>'; }).join(''); }
    o += line('pline', 'p') + line('rline', 'r') + dots('pdot', 'p') + dots('rdot', 'r');
    svg.innerHTML = o;
    var last = pts[pts.length - 1];
    S('pgTotal', 'principal ' + sn(last.p) + ' · pot ' + sn(last.r) + (ST.head ? ' · block ' + num(ST.head.number) : ''));
    S('pgNote', 'Principal points come from each PrincipalFunded/NetProcessed event’s own new checkpoint value, plus the frozen 50/50 crystallization split applied to each ModeChanged event’s reported growth. The reward pot also subtracts epochs published and adds back cancellations. The last point is read live from the contract.' + (series.dropped ? ' ' + series.dropped + ' older event(s) have no timestamp yet and are not plotted.' : ''));
    PG = { pts: pts, t0: t0, t1: t1, L: L, Rr: Rr, W: W, Hh: Hh, T: T, B: B, topV: topV };
    bindPGHover();
  }

  // ------------------------------------------------------------ growth chart hover (crosshair + tooltip)
  var PG = null, pgBound = false;
  function pgX(t) { return PG.L + (t - PG.t0) / (PG.t1 - PG.t0) * (PG.W - PG.L - PG.Rr); }
  function pgY(v) { return PG.T + (1 - Number(v * 10000n / PG.topV) / 10000) * (PG.Hh - PG.T - PG.B); }
  function bindPGHover() {
    var wrap = $('#pgChart'); if (!wrap || pgBound) return;
    pgBound = true;
    wrap.addEventListener('mousemove', pgMove);
    wrap.addEventListener('mouseleave', function () { pgShowTip(null); });
    wrap.addEventListener('touchstart', pgTouch, { passive: true });
    wrap.addEventListener('touchmove', pgTouch, { passive: true });
    wrap.addEventListener('touchend', function () { pgShowTip(null); });
  }
  function pgTouch(ev) { var t = ev.touches[0]; if (t) pgMove({ clientX: t.clientX }); }
  function pgMove(ev) {
    if (!PG || !PG.pts.length) return;
    var wrap = $('#pgChart'); if (!wrap) return;
    var rect = wrap.getBoundingClientRect();
    var px = (ev.clientX - rect.left) / rect.width * PG.W;
    var t = PG.t0 + (px - PG.L) / (PG.W - PG.L - PG.Rr) * (PG.t1 - PG.t0);
    var nearest = PG.pts[0], best = Infinity;
    PG.pts.forEach(function (pt) { var d = Math.abs(pt.t - t); if (d < best) { best = d; nearest = pt; } });
    pgShowTip(nearest);
  }
  function pgShowTip(pt) {
    var svg = $('#pgChart svg'), wrap = $('#pgChart'); if (!svg || !wrap) return;
    var tip = $('#pgTip');
    if (!pt) { var g0 = svg.querySelector('#pgHoverG'); if (g0) g0.style.display = 'none'; if (tip) tip.style.display = 'none'; return; }
    var g = svg.querySelector('#pgHoverG');
    if (!g) {
      g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.id = 'pgHoverG';
      g.innerHTML = '<line class="xline"/><circle class="hp" r="5"/><circle class="hr" r="5"/>';
      svg.appendChild(g);
    }
    g.style.display = '';
    var x = pgX(pt.t), line = g.querySelector('line'), circles = g.querySelectorAll('circle');
    line.setAttribute('x1', x); line.setAttribute('x2', x); line.setAttribute('y1', PG.T); line.setAttribute('y2', PG.Hh - PG.B);
    circles[0].setAttribute('cx', x); circles[0].setAttribute('cy', pgY(pt.p));
    circles[1].setAttribute('cx', x); circles[1].setAttribute('cy', pgY(pt.r));
    if (!tip) { tip = document.createElement('div'); tip.id = 'pgTip'; tip.className = 'gtip'; wrap.appendChild(tip); }
    var d = new Date(pt.t * 1000);
    var dateStr = d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ', ' + ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ' UTC';
    tip.innerHTML = esc(dateStr) + '<br>permanent principal ' + esc(sn(pt.p)) + '<br>reward pot ' + esc(sn(pt.r));
    var leftPct = x / PG.W * 100;
    if (leftPct > 55) { tip.style.right = (100 - leftPct + 2) + '%'; tip.style.left = 'auto'; }
    else { tip.style.left = (leftPct + 2) + '%'; tip.style.right = 'auto'; }
    tip.style.display = 'block';
  }

  // ------------------------------------------------------------ organic rate history chart (indexer)
  function drawRate() {
    var svg = $('#rateChart svg');
    P.indexer.getRateHistory().then(function (h) {
      var W = 1000, Hh = 300;
      if (h.status !== 'ok' || !h.data.points.length) {
        S('histSrc', h.status === 'error' ? 'INDEXER ERROR' : 'INDEXER NOT CONNECTED');
        S('histNote', h.status === 'ok' ? 'No history points yet.' : 'Historical line: ' + (h.reason || 'unavailable') + '. The current rate above is read live from the contract. No line is drawn rather than an estimated one.');
        svg.innerHTML = '<line class="grid" x1="40" x2="990" y1="150" y2="150"/><text class="msg" x="500" y="138" text-anchor="middle">HISTORY UNAVAILABLE</text><text class="msg2" x="500" y="176" text-anchor="middle">' + esc(h.status === 'error' ? 'indexer data failed validation' : 'waiting for the production indexer') + '</text>';
        return;
      }
      var pts = h.data.points.slice().sort(function (a, b) { return a.t - b.t; });
      var L = 46, Rr = 10, T = 14, B = 30, t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 3600);
      var ys = pts.map(function (p) { return Number(BigInt(p.rateWad) * 10000n / 10n ** 16n) / 100; });
      var top = Math.max(20, Math.ceil(Math.max.apply(null, ys) / 5) * 5);
      var X = function (t) { return L + (t - t0) / (t1 - t0) * (W - L - Rr); }, Y = function (v) { return T + (1 - v / top) * (Hh - T - B); };
      var o = '';
      for (var i = 0; i <= 4; i++) { var v = top * i / 4; o += '<line class="grid" x1="' + L + '" x2="' + (W - Rr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="ax" x="' + (L - 6) + '" y="' + (Y(v) + 5) + '" text-anchor="end">' + v + '%</text>'; }
      for (var j = 0; j <= 4; j++) { var t = t0 + (t1 - t0) * j / 4, d = new Date(t * 1000); o += '<text class="ax" x="' + X(t) + '" y="' + (Hh - 8) + '" text-anchor="' + (j === 0 ? 'start' : j === 4 ? 'end' : 'middle') + '">' + d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + '</text>'; }
      o += '<line class="thr" x1="' + L + '" x2="' + (W - Rr) + '" y1="' + Y(10) + '" y2="' + Y(10) + '"/><text class="thrt" x="' + (W - Rr) + '" y="' + (Y(10) - 6) + '" text-anchor="end">10% THRESHOLD</text>';
      o += '<path class="ln" d="' + pts.map(function (p, k) { return (k ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(ys[k]).toFixed(1); }).join(' ') + '"/>';
      svg.innerHTML = o;
      S('histSrc', 'INDEXER · AS OF BLOCK ' + num(h.data.asOf.block));
      S('histNote', 'Realized rolling 7-day annualized organic rate from the production indexer. Below the dashed line = Reward Mode territory (subject to the 24h dwell).');
    });
  }

  // ------------------------------------------------------------ holder lookup
  var form = $('#lookup'), input = $('#addr'), msg = $('#lookupMsg'), lookupSeq = 0;
  form.addEventListener('submit', function (ev) { ev.preventDefault(); lookup(input.value.trim()); });

  function lookup(addr) {
    var my = ++lookupSeq;
    if (!CH.isAddress(addr)) {
      msg.textContent = /^[a-z]+( [a-z]+){5,}$/i.test(addr) ? 'That looks like a seed phrase. Never paste it anywhere. Clear it and use a public 0x address.' : 'Enter a public address: 0x followed by 40 hex characters.';
      return;
    }
    if (!ST.r) { msg.textContent = 'Waiting for the first successful read of the reserve. Try again in a moment.'; return; }
    try { history.replaceState(null, '', '#me=' + addr); } catch (e) { }
    msg.textContent = 'Reading public data for ' + addr + ' …';
    $('#meOut').hidden = false;
    S('h_title', 'HOLDER ' + CH.short(addr)); S('h_status', 'READING…'); S('h_bal', '…'); S('h_elig', '…'); S('h_claimable', '…');
    badge(['h_badge'], 'READING', false);
    $('#claimOut').innerHTML = '<div class="claimstate"><b>READING…</b><span>Loading on-chain epochs and claim data for ' + esc(addr) + '.</span></div>';

    var latest = ST.r.latestEpochId, pA = [CH.encAddr(addr)];
    var span = []; for (var i = latest; i >= 1 && span.length < 200; i--) span.push(i);
    var chainP = CH.rpc([
      CH.ethCall(A.ten, CH.callData(CH.SEL.balanceOf, pA)),
      ['eth_getCode', [addr, 'latest']]
    ].concat(span.map(function (id) { return CH.ethCall(R, CH.callData(CH.SEL.claimedBy, [CH.encUint(id), CH.encAddr(addr)])); }))
      .concat(span.map(function (id) { return CH.ethCall(R, CH.callData(CH.SEL.epochs, [CH.encUint(id)])); })));
    var claimsP = CH.getAllLogs(R, [CH.TOPIC.AllocationClaimed, null, '0x' + CH.encAddr(addr)], C.deployBlock, ST.head.number)
      .then(function (r) { return r.logs.map(decodeLog).filter(Boolean); });
    var idxP = P.indexer.getHolder(addr);

    Promise.allSettled([chainP, claimsP, idxP]).then(function (rs) {
      if (my !== lookupSeq) return;
      if (rs[0].status !== 'fulfilled') { msg.textContent = 'Could not read Robinhood Chain for this address (' + rs[0].reason.message + '). Nothing is shown instead of a guess. Try again.'; S('h_status', 'RPC ERROR'); badge(['h_badge'], 'OFFLINE', true); $('#claimOut').innerHTML = claimState('CLAIM DATA UNAVAILABLE', 'Robinhood Chain RPC could not be reached. No claim parameters are shown.', null, true); return; }
      var c = rs[0].value, bal = BigInt(c[0]), code = c[1], isContract = code && code !== '0x';
      var claimed = {}, epochs = {};
      span.forEach(function (id, k) { claimed[id] = BigInt(c[2 + k]) === 1n; epochs[id] = decodeEpoch(c[2 + span.length + k]); });
      var claimEvs = rs[1].status === 'fulfilled' ? rs[1].value : null;
      var idx = rs[2].status === 'fulfilled' ? rs[2].value : { status: 'error', reason: 'indexer call failed' };

      renderHolderBase(addr, bal, isContract, idx, claimEvs);
      msg.textContent = 'Public data for ' + addr + ' · read at block ~' + num(ST.head.number) + '. Nothing was signed or stored.';

      // claim reconciliation per epoch
      P.holderEpochs(addr, latest).then(function (list) {
        list = list.filter(function (id) { return epochs[id]; });
        return Promise.all(list.map(function (id) {
          if (claimed[id]) return { epochId: id, state: 'CLAIMED', checks: [], reasons: [] };
          return P.reconcileEpoch(id, addr, epochs[id]);
        }));
      }).then(function (results) {
        if (my !== lookupSeq) return;
        renderClaims(addr, latest, results, claimEvs, idx);
      });
    });
  }

  function renderHolderBase(addr, bal, isContract, idx, claimEvs) {
    S('h_bal', tnShort(bal));
    var sys = C.knownSystem[lc(addr)];
    if (idx.status === 'ok') {
      var h = idx.data;
      S('h_elig', tnShort(h.eligibleTen)); S('h_eligSub', 'indexer · as of block ' + num(h.asOf.block));
      var rows = h.lots.map(function (l) {
        var m = l.multiplierBps ? (l.multiplierBps / 10000).toFixed(2) + '×' : '—';
        var until = l.ageDays < 30 ? 'eligible in ' + (30 - Math.floor(l.ageDays)) + 'd' : (l.multiplierBps >= 20000 ? 'max' : 'ageing');
        return '<tr><td>' + esc(l.id) + '</td><td>' + esc(l.acquiredAt ? utc(l.acquiredAt).slice(0, -10) : 'block ' + l.acquiredBlock) + '</td><td class="num">' + esc(tnShort(l.remaining)) + '</td><td class="num">' + Math.floor(l.ageDays) + 'd</td><td class="num">' + m + '</td><td>' + (l.eligible ? 'eligible · ' + until : until) + '</td></tr>';
      });
      $('#lots tbody').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="6">no TEN purchase lots held</td></tr>';
      $('#weights').innerHTML = '<div><span>eligible TEN</span><span class="d"></span><span>' + esc(tn(h.eligibleTen)) + '</span></div><div><span>weighted TEN (Σ lot × multiplier)</span><span class="d"></span><span>' + esc(tn(h.weightedTen)) + '</span></div>' +
        (BigInt(h.tenBalance) !== bal ? '<div><span>indexer balance (as of its block)</span><span class="d"></span><span>' + esc(tn(h.tenBalance)) + '</span></div>' : '');
      S('h_status', 'INDEXER BLOCK ' + num(h.asOf.block));
    } else {
      S('h_elig', 'N/A'); S('h_eligSub', idx.status === 'error' ? 'indexer error' : 'indexer not connected');
      $('#lots tbody').innerHTML = '<tr><td colspan="6">' + esc(idx.status === 'error' ? 'LOT DATA ERROR · ' + idx.reason : 'LOT DATA UNAVAILABLE · purchase lots, FIFO ages and multipliers come from Indexer V1, which is not connected to this page yet') + '</td></tr>';
      $('#weights').innerHTML = '';
      S('h_status', 'ON-CHAIN ONLY');
    }
    var ch = $('#claimHist');
    if (!claimEvs) ch.innerHTML = '<li>claim history unavailable (event log could not be read)</li>';
    else ch.innerHTML = claimEvs.length ? claimEvs.sort(function (a, b) { return b.block - a.block; }).map(function (e) {
      return '<li><span>epoch #' + e.epochId + '</span><span class="d"></span><span>' + esc(sn(e.payout)) + '</span><span class="r">face ' + esc(sn(e.amount)) + ' · block ' + num(e.block) + ' · <a href="' + EXPL + '/tx/' + e.tx + '" target="_blank" rel="noopener">tx ↗</a></span></li>';
    }).join('') : '<li>no claims by this address</li>';
    badge(['h_badge'], idx.status === 'ok' ? 'LIVE' : 'PARTIAL', idx.status !== 'ok');
    ST.holderCtx = { addr: addr, bal: bal, isContract: isContract, sys: sys, idx: idx };
  }

  var STATE_TXT = {
    READY: ['VERIFIED', 'ok'], CLAIMED: ['CLAIMED', 'ok'], NONE: ['NO ALLOCATION', ''],
    UNAVAILABLE: ['CLAIM DATA UNAVAILABLE', 'bad'], PENDING: ['VERIFICATION PENDING', 'bad'], FAILED: ['VERIFICATION FAILED', 'bad']
  };

  function claimState(title, text, list, bad) {
    return '<div class="claimstate' + (bad ? ' bad' : '') + '"><b>' + esc(title) + '</b><span>' + text + '</span>' + (list && list.length ? '<ul>' + list.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
  }

  function renderClaims(addr, latest, results, claimEvs, idx) {
    var ready = results.filter(function (x) { return x.state === 'READY'; });
    var totalFace = ready.reduce(function (s, x) { return s + BigInt(x.entry.amount); }, 0n), totalNow = ready.reduce(function (s, x) { return s + x.payoutNow; }, 0n);
    var blocked = results.filter(function (x) { return x.state === 'UNAVAILABLE' || x.state === 'PENDING' || x.state === 'FAILED'; });

    S('h_claimable', latest === 0 ? '0 sNET' : (ready.length ? sn(totalNow) : (blocked.length ? 'N/A' : '0 sNET')));
    S('h_claimableSub', ready.length ? 'face value ' + sn(totalFace) + ' · ' + ready.length + ' epoch(s)' : (latest === 0 ? 'no epoch published yet' : blocked.length ? 'claim data not verifiable yet' : 'nothing to claim'));

    // allocations by epoch
    var al = $('#allocList');
    if (latest === 0) al.innerHTML = '<li>no epoch has been published yet</li>';
    else al.innerHTML = results.length ? results.map(function (x) {
      var t = STATE_TXT[x.state] || [x.state, ''];
      var amtTxt = x.state === 'READY' ? sn(x.payoutNow) : x.state === 'CLAIMED' ? (function () { var e = (claimEvs || []).filter(function (c) { return c.epochId === x.epochId; })[0]; return e ? sn(e.payout) + ' paid' : 'claimed'; })() : '—';
      return '<li><span>epoch #' + x.epochId + '</span><span class="d"></span><span>' + esc(amtTxt) + '</span><span class="r"><span class="tag ' + t[1] + '">' + t[0] + '</span></span></li>';
    }).join('') : '<li>no epochs to check</li>';

    // why box
    var why = [], ctx = ST.holderCtx || {};
    if (ctx.sys) why.push(ctx.sys + ': system address, never receives loyalty allocations.');
    if (ctx.idx && ctx.idx.status === 'ok' && ctx.idx.data.excluded) why.push('Excluded by the production exclusion set' + (ctx.idx.data.exclusionReason ? ': ' + ctx.idx.data.exclusionReason : '') + '.');
    if (ctx.isContract && !ctx.sys) why.push('This address is a contract. LP/system contracts are in the exclusion set; the indexer decides.');
    if (ctx.bal === 0n) why.push('It holds no TEN right now. Rewards already allocated stay claimable even after selling.');
    if (ctx.idx && ctx.idx.status === 'ok') {
      var lots = ctx.idx.data.lots; if (lots.length && lots.every(function (l) { return l.ageDays < 30; })) why.push('No lot has 30 full days yet. The first lot becomes eligible in ' + (30 - Math.floor(Math.max.apply(null, lots.map(function (l) { return l.ageDays; })))) + ' days.');
    } else why.push('Eligibility and lot ages need Indexer V1, which is not connected to this page yet.');
    if (latest === 0) why.push('No epoch has been published yet: the reserve has not allocated rewards to anyone' + (ST.r.mode === 0 ? ' (it is in Compound Mode).' : '.'));
    else if (ST.r.mode === 0) why.push('The reserve is in Compound Mode: no new allocations until the organic rate falls below 10%.');
    if (blocked.some(function (x) { return x.state === 'UNAVAILABLE'; })) why.push('Epoch artifacts are not available here, so claim parameters cannot be shown.');
    if (blocked.some(function (x) { return x.state === 'PENDING'; })) why.push('An artifact is not fully verified against its on-chain dataRef yet.');
    if (blocked.some(function (x) { return x.state === 'FAILED'; })) why.push('An artifact failed verification against the chain: its data is not shown.');
    $('#why').innerHTML = '<b>Why this result</b><ul>' + why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';

    // claim center
    var out = $('#claimOut'), html = '';
    if (latest === 0) html = claimState('NOTHING TO CLAIM', 'No epoch has been published on chain yet, so no address has claimable rewards. No claim parameters exist.');
    else {
      if (ready.length) html += ready.map(claimCard.bind(null, addr)).join('');
      var un = blocked.filter(function (x) { return x.state === 'UNAVAILABLE'; }), pe = blocked.filter(function (x) { return x.state === 'PENDING'; }), fa = blocked.filter(function (x) { return x.state === 'FAILED'; });
      if (un.length) html += claimState('CLAIM DATA UNAVAILABLE', 'Epoch(s) ' + un.map(function (x) { return '#' + x.epochId; }).join(', ') + ': the authoritative epoch artifact could not be loaded, so no transaction parameters are shown.', uniq(un));
      if (pe.length) html += claimState('VERIFICATION PENDING', 'Epoch(s) ' + pe.map(function (x) { return '#' + x.epochId; }).join(', ') + ': artifact found but not fully bound to the on-chain epoch. No parameters are shown until it is.', uniq(pe), true);
      if (fa.length) html += claimState('VERIFICATION FAILED', 'Epoch(s) ' + fa.map(function (x) { return '#' + x.epochId; }).join(', ') + ': the artifact does not match the chain. Do not claim with any values from other sources.', uniq(fa), true);
      if (!html) html = claimState('NOTHING TO CLAIM', results.some(function (x) { return x.state === 'CLAIMED'; }) ? 'Every verified allocation for this address is already claimed.' : 'No allocation for this address in the published epochs.');
    }
    out.innerHTML = html;
  }
  function uniq(list) { var s = {}; list.forEach(function (x) { x.reasons.forEach(function (r) { s[r] = 1; }); }); return Object.keys(s); }

  function claimCard(addr, x) {
    var proof = x.entry.proof;
    var proofRows = proof.length ? proof.map(function (p, i) {
      return '<div class="pv"><code><span class="n">[' + i + ']</span>' + p + '</code><button class="b copy" type="button" data-copy="' + p + '">Copy</button></div>';
    }).join('') : '<div class="pv"><code>empty array: leave the proof field empty</code></div>';
    return '<div class="lcd in claimcard">' +
      '<div class="top"><span class="k">Epoch #' + x.epochId + ' · claimable</span><span class="k">VERIFIED</span></div>' +
      '<div class="amt">' + esc(sn(x.payoutNow)) + '</div>' +
      '<div class="checks">' + x.checks.map(function (c) { return '<span><i>' + (c.ok ? '✓' : '·') + '</i> ' + esc(c.label) + '</span>'; }).join('') + '</div>' +
      '<div class="param"><div class="pk">epochId (uint256)</div><div class="pv"><code>' + x.epochId + '</code><button class="b copy" type="button" data-copy="' + x.epochId + '">Copy</button></div></div>' +
      '<div class="param"><div class="pk">amount (uint256) · raw integer, do not scale</div><div class="pv"><code>' + x.entry.amount + '</code><button class="b copy" type="button" data-copy="' + x.entry.amount + '">Copy</button></div></div>' +
      '<div class="param"><div class="pk">proof (bytes32[]) · ' + proof.length + ' item' + (proof.length === 1 ? '' : 's') + ', in order</div><div class="proof">' + proofRows + '</div>' +
      (proof.length ? '<div class="pv"><code>[' + proof.join(',') + ']</code><button class="b copy" type="button" data-copy="[' + proof.join(',') + ']">Copy all</button></div>' : '') + '</div>' +
      '<div class="cta"><a class="b go" href="' + BLOCKSCOUT_WRITE + '" target="_blank" rel="noopener">CLAIM ON BLOCKSCOUT ↗</a><small>opens the verified contract · connect ' + esc(CH.short(addr)) + ' there, not here</small></div>' +
      '</div>';
  }

  // ------------------------------------------------------------ contracts list + Blockscout verification
  var CONTRACTS = [
    ['Reward Reserve V1', A.rewardReserve, '/address/' + A.rewardReserve + '?tab=contract'],
    ['TEN/NET Spot Reader', A.spotReader, '/address/' + A.spotReader + '?tab=contract'],
    ['TEN', A.ten, '/token/' + A.ten],
    ['NET', A.net, '/token/' + A.net],
    ['sNET', A.snet, '/token/' + A.snet],
    ['NetNet Staking', A.staking, '/address/' + A.staking + '?tab=contract']
  ];
  function renderContracts() {
    $('#clist').innerHTML = CONTRACTS.map(function (c, i) {
      return '<div class="crow"><div class="ch"><b>' + esc(c[0]) + '</b><small id="vf' + i + '">source status not confirmed</small></div><div class="ca2"><code>' + c[1] + '</code><button class="b copy" type="button" data-copy="' + c[1] + '">Copy</button><a class="b" href="' + EXPL + c[2] + '" target="_blank" rel="noopener">Blockscout ↗</a></div></div>';
    }).join('');
    CONTRACTS.forEach(function (c, i) {
      fetch(EXPL + '/api/v2/smart-contracts/' + c[1], { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
        var el = document.getElementById('vf' + i); if (!el || !j) return;
        if (j.is_verified === true) { el.textContent = 'verified on Blockscout · ' + (j.is_fully_verified ? 'full match' : 'partial match') + (j.name ? ' · ' + j.name : ''); el.classList.add('ok'); }
      }).catch(function () { });
    });
  }

  // ------------------------------------------------------------ boot
  renderContracts();
  drawRate();
  refreshChain().then(function () { return refreshLogs(); }).then(function () {
    var m = /#me=(0x[0-9a-fA-F]{40})/.exec(location.hash); if (m) { input.value = m[1]; lookup(m[1]); }
  });
  setInterval(function () { refreshChain(); }, C.pollMs);
  setInterval(function () { refreshLogs(); }, C.pollMs * 2);
  setInterval(function () { if (ST.r) { var f = freshness(); badge(['badge', 'badge2', 'badge3', 'badge6'], f.label, f.bad); modState('chain', f.live && !ST.acctBad); if (ST.logs && !f.live) { badge(['badge4', 'badge5'], f.label, true); modState('logs', false); } } }, 15000);

  window.RR.app = { state: ST, refreshChain: refreshChain, refreshLogs: refreshLogs, lookup: lookup };
})();

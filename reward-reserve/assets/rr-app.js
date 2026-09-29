/* ============================================================================
   rr-app.js — Reward Reserve V2 page controller
   Public chain reads: RR.chain (read-only RPC). Wallet + signing: RR.wallet
   (talks only to the connected EIP-1193 provider). Epoch data: RR.providers
   (fetches + validates the Indexer's epochs/<id>.json, never trusted blindly
   for the claim itself — every allocation is re-checked on chain via
   verifyAllocation() before the claim button is enabled).
   ========================================================================== */
(function () {
  'use strict';
  var C = window.RR_CONFIG, CH = window.RR.chain, W = window.RR.wallet, P = window.RR.providers, A = C.addresses;
  var R = A.rewardReserve, EXPL = C.explorer;

  // ------------------------------------------------------------------ utils
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function S(k, v) { $$('[data-l="' + k + '"]').forEach(function (e) { e.textContent = v; }); }
  function H(k, html) { $$('[data-l="' + k + '"]').forEach(function (e) { e.innerHTML = html; }); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return Number(n).toLocaleString('en-US'); }
  function fmtDate(ts) {
    var d = new Date(Number(ts) * 1000);
    return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' + ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ' UTC';
  }
  var DEC = { ten: 18, snet: 9 };
  function sn(v) { return CH.amt(v, DEC.snet, 'sNET'); }
  function tn(v) { return CH.amt(v, DEC.ten, 'TEN'); }
  function nn(v) { return CH.amt(v, C.prices.netDecimals, 'NET'); } // NET decimals confirmed same as sNET (9)

  // $ estimates: spot prices from two on-chain reads (TenNetSpotReader + a Uniswap V2 pair),
  // combined in refreshPrices() below. PRICE stays null until both reads succeed, and every
  // usdLabel() call returns '' (never a guessed number) until then — matches the rest of the
  // site's "never fabricate, show nothing instead" rule.
  var PRICE = null; // { ten: usd per 1 TEN, net: usd per 1 NET (== per 1 sNET) } | null
  var LIVE = null;  // { principal, ts, block } set by refreshOverview; extends the Growth chart's
                     // sNET Principal line to "now" without a second read of the same values
  // Raw (unformatted) USD number, or null if the price isn't available — never a guess.
  // Used both by usdLabel() below and by the "Total Reward Reserve" sum, which must add
  // three different assets' $ values, never their raw token quantities (2026-09-29, per Matteo).
  function usdRaw(v, dec, key) {
    if (!PRICE || v == null) return null;
    var price = PRICE[key]; if (!(price > 0)) return null;
    return (Number(v) / Math.pow(10, dec)) * price;
  }
  function fmtUsd(usd) {
    if (usd > 0 && usd < 0.01) return '≈ <$0.01';
    var frac = usd < 1000 ? 2 : 0;
    return '≈ $' + usd.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
  }
  function usdLabel(v, dec, key) {
    var usd = usdRaw(v, dec, key);
    return usd == null ? '' : fmtUsd(usd);
  }
  function badge(keys, text, bad) { keys.forEach(function (k) { $$('[data-l="' + k + '"]').forEach(function (e) { e.textContent = text; e.classList.toggle('bad', !!bad); }); }); }
  function alertBox(k, html, info) { $$('[data-l-alert="' + k + '"]').forEach(function (e) { e.hidden = !html; e.innerHTML = html || ''; e.classList.toggle('info', !!info); }); }
  function link(path, label) { return EXPL ? '<a href="' + EXPL + path + '" target="_blank" rel="noopener">' + esc(label) + '</a>' : esc(label); }

  S('rAddr', 'REWARD RESERVE ' + R); S('rAddr2', R);

  // ------------------------------------------------------------ chrome (menu, scroll spy, minimize)
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

  // ------------------------------------------------------------ wallet bar
  var connectBtn = $('#connectBtn'), netchip = $('#netchip');
  function renderWallet(snap) {
    if (!W.hasWallet()) {
      S('netchipText', 'no wallet found'); netchip.classList.add('bad');
      connectBtn.textContent = 'Connect wallet'; connectBtn.disabled = false;
      return;
    }
    netchip.classList.remove('bad');
    if (!snap.address) {
      S('netchipText', 'not connected'); connectBtn.textContent = 'Connect wallet'; connectBtn.disabled = false;
      return;
    }
    connectBtn.textContent = 'Disconnect (' + CH.short(snap.address) + ')'; connectBtn.disabled = false;
    if (snap.wrongChain) { S('netchipText', 'wrong network — switch to ' + C.chainName); netchip.classList.add('bad'); }
    else { S('netchipText', CH.short(snap.address) + ' · ' + C.chainName); netchip.classList.remove('bad'); }
    var addrInput = $('#addr');
    if (addrInput && !addrInput.value) { addrInput.value = snap.address; runLookup(snap.address); }
  }
  W.onChange(renderWallet);
  renderWallet(W.snapshot());
  connectBtn.addEventListener('click', function () {
    if (W.snapshot().address) { W.disconnect(); return; }
    connectBtn.disabled = true;
    W.connect().catch(function (e) { alertBox('claim', esc(e.message || String(e))); }).then(function () { connectBtn.disabled = false; });
  });

  // ------------------------------------------------------------ overview (public, no wallet needed)
  // countdown to next distribution: fully anchored to chain time (lastCrystallization()+
  // CRYSTALLIZATION_PERIOD() vs the read block's own timestamp), never Date.now() — the
  // per-second tick below only counts down a number already computed from chain data.
  var countdownRemain = null, countdownNotFunded = false, countdownTimer = null;
  function fmtCountdown(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec <= 0) return 'Ready';
    var d = Math.floor(sec / 86400); sec -= d * 86400;
    var h = Math.floor(sec / 3600); sec -= h * 3600;
    var m = Math.floor(sec / 60); sec -= m * 60;
    return d + 'd ' + h + 'h ' + m + 'm ' + sec + 's';
  }
  function startCountdownTicker() {
    if (countdownTimer) return;
    countdownTimer = setInterval(function () {
      if (countdownNotFunded || countdownRemain == null) return;
      if (countdownRemain > 0) countdownRemain--;
      S('mon_countdown', fmtCountdown(countdownRemain));
    }, 1000);
  }

  function refreshOverview() {
    return CH.one(['eth_getBlockByNumber', ['latest', false]]).then(function (blk) {
      var head = { number: Number(BigInt(blk.number)), ts: Number(BigInt(blk.timestamp)) };
      var tag = CH.hexN(head.number);
      var calls = [
        CH.ethCall(R, CH.SEL.principalValue, tag), CH.ethCall(R, CH.SEL.holderSideValue, tag),
        CH.ethCall(R, CH.SEL.outstandingLiabilityValue, tag), CH.ethCall(R, CH.SEL.isSolvent, tag),
        CH.ethCall(R, CH.SEL.latestEpochId, tag),
        CH.ethCall(R, CH.SEL.lastCrystallization, tag), CH.ethCall(R, CH.SEL.crystallizationPeriod, tag),
        CH.ethCall(A.snet, CH.encBalanceOf(R), tag), CH.ethCall(A.ten, CH.encBalanceOf(R), tag),
        CH.ethCall(R, CH.SEL.principalCheckpoint, tag),
        CH.ethCall(A.net, CH.encBalanceOf(R), tag)
      ];
      // $ estimates fetched separately (rpcSettled, not the strict batch above): a revert or
      // missing contract on either price read must never take down the reserve's own numbers,
      // and settling independently means one failing read still lets PRICE stay null cleanly.
      var priceCalls = [CH.ethCall(C.prices.tenNetSpotReader, CH.SEL.getSpotPriceWad, tag), CH.ethCall(C.prices.netUsdgPool, CH.SEL.getReserves, tag)];
      var priceP = CH.rpcSettled(priceCalls).then(function (rs) {
        try {
          if (!rs[0].ok || !rs[1].ok) throw new Error('price read failed');
          var netPerTen = Number(CH.u(rs[0].result, 0)) / 1e18;
          var usdgReserve = CH.u(rs[1].result, 0), netReserve = CH.u(rs[1].result, 1);
          var usdgPerNet = (Number(usdgReserve) / Math.pow(10, C.prices.usdgDecimals)) / (Number(netReserve) / Math.pow(10, C.prices.netDecimals));
          PRICE = (netPerTen > 0 && usdgPerNet > 0) ? { ten: netPerTen * usdgPerNet, net: usdgPerNet } : null;
        } catch (e) { PRICE = null; }
      });
      return Promise.all([CH.rpc(calls), priceP]).then(function (results) {
        var r = results[0];
        var principal = CH.u(r[0], 0), holderside = CH.u(r[1], 0), liab = CH.u(r[2], 0);

        // Live preview of the next 50/50 crystallize split (2026-09-29, per Matteo): the real split
        // only happens on-chain at the next crystallize(), but principalCheckpoint() (the last
        // recorded checkpoint) lets us project it client-side from the yield accrued since then.
        // Computed as BigInt throughout so precision is never lost to a float. Clamped defensively —
        // should never go negative, but a fresh/just-crystallized checkpoint could momentarily equal
        // principalValue().
        var checkpoint = CH.u(r[9], 0);
        var growth = principal > checkpoint ? principal - checkpoint : 0n;
        var projectedNextRound = growth / 2n;
        var projectedPrincipal = principal - projectedNextRound;
        var netInReserve = CH.u(r[10], 0);

        S('ov_principal', sn(projectedPrincipal)); S('ov_holderside', sn(holderside)); S('ov_liab', sn(liab));
        S('ov_nextRound', sn(projectedNextRound)); S('ov_nextRound2', sn(projectedNextRound)); S('ov_nextRound3', sn(projectedNextRound));
        S('ov_growth', sn(growth));
        S('ov_net', nn(netInReserve));
        S('ov_solvent', CH.boolAt(r[3], 0) ? 'SOLVENT' : 'INSOLVENT');
        var latestId = Number(CH.u(r[4], 0));
        S('ov_latestEpoch', num(latestId));
        S('ov_block', num(head.number));
        var snetInReserve = CH.u(r[7], 0), tenInReserve = CH.u(r[8], 0);
        S('mon_snet', sn(snetInReserve)); S('mon_ten', tn(tenInReserve));

        // sNET is priced the same as NET (1:1 via unstake()), no separate read needed.
        S('mon_snet_usd', usdLabel(snetInReserve, DEC.snet, 'net')); S('mon_ten_usd', usdLabel(tenInReserve, DEC.ten, 'ten'));
        S('ov_principal_usd', usdLabel(projectedPrincipal, DEC.snet, 'net')); S('ov_holderside_usd', usdLabel(holderside, DEC.snet, 'net')); S('ov_liab_usd', usdLabel(liab, DEC.snet, 'net'));
        S('ov_nextRound_usd', usdLabel(projectedNextRound, DEC.snet, 'net')); S('ov_nextRound2_usd', usdLabel(projectedNextRound, DEC.snet, 'net')); S('ov_nextRound3_usd', usdLabel(projectedNextRound, DEC.snet, 'net'));
        S('ov_growth_usd', usdLabel(growth, DEC.snet, 'net'));
        S('ov_net_usd', usdLabel(netInReserve, C.prices.netDecimals, 'net'));

        // "Total sNET treasury" = principal + next round + unclaimed = exactly principalValue() +
        // outstandingLiabilityValue() by construction (projectedPrincipal + projectedNextRound ==
        // principal) — no extra on-chain read needed.
        var snetTotal = principal + liab;
        S('ov_snetTotal', sn(snetTotal)); S('ov_snetTotal_usd', usdLabel(snetTotal, DEC.snet, 'net'));

        // "Total Reward Reserve (sNET + NET + TEN)" — summed ONLY as $ equivalents, never as raw
        // token quantities (2026-09-29, explicit instruction from Matteo: three different assets,
        // three different prices, summing raw amounts would be meaningless). Blank/em-dash, never
        // a partial or guessed number, unless all three prices are available.
        var uSnet = usdRaw(snetTotal, DEC.snet, 'net'), uNet = usdRaw(netInReserve, C.prices.netDecimals, 'net'), uTen = usdRaw(tenInReserve, DEC.ten, 'ten');
        var totalReserveUsd = (uSnet != null && uNet != null && uTen != null) ? (uSnet + uNet + uTen) : null;
        var totalReserveText = totalReserveUsd == null ? '—' : fmtUsd(totalReserveUsd);
        S('ov_totalReserve', totalReserveText); S('ov_totalReserve2', totalReserveText);

        // Eligible wallets / Eligible TEN in Overview come from the eligibility.json feed (not the
        // on-chain epoch) per Matteo, 2026-09-29 — independent of latestEpochId, which now shows only
        // as "Past distributions".
        P.getEligibility().then(function (elig) {
          if (elig.status === 'ok' && elig.data.totals) { S('ov_holders', num(elig.data.totals.eligibleHolders)); S('ov_eligTotal', tn(elig.data.totals.totalEligibleBalance)); }
          else { S('ov_holders', '—'); S('ov_eligTotal', '—'); }
        });

        // Growth section's "live" point: the same values just read here (principal/next-round
        // already projected, unclaimed real from outstandingLiabilityValue()), shown independently
        // of the historical event-log fetch below — so it still appears and updates even when that
        // fetch fails (see refreshGrowth()).
        S('gLivePrincipal', sn(projectedPrincipal)); S('gLiveNextRound', sn(projectedNextRound)); S('gLiveLiab', sn(liab)); S('gLiveAsOf', 'as of block ' + num(head.number));
        LIVE = { principal: projectedPrincipal, nextRound: projectedNextRound, liab: liab, ts: head.ts, block: head.number };

        var lastCryst = CH.u(r[5], 0), period = CH.u(r[6], 0);
        if (lastCryst === 0n) {
          countdownNotFunded = true; countdownRemain = null;
          S('mon_countdown', 'Not funded yet'); S('mon_countdownSub', 'lastCrystallization() is still 0 — no round has run yet');
        } else {
          countdownNotFunded = false;
          countdownRemain = Number(lastCryst + period) - head.ts;
          S('mon_countdown', fmtCountdown(countdownRemain));
          S('mon_countdownSub', 'lastCrystallization() + CRYSTALLIZATION_PERIOD()');
        }
        startCountdownTicker();

        badge(['badge'], 'LIVE'); S('updated', 'block ' + num(head.number));
        alertBox('overview', '');
      });
    }).catch(function (e) {
      badge(['badge'], 'OFFLINE', true); S('updated', 'could not read the chain: ' + (e.message || e));
      alertBox('overview', '<b>Could not read the chain.</b> ' + esc(e.message || String(e)));
    });
  }
  refreshOverview();
  setInterval(refreshOverview, 60000);

  // ------------------------------------------------------------ growth chart (event log, since deploy)
  // Crystallized / EpochPublished / AllocationClaimed topic0 hashes were supplied as-given (only
  // syntactic 32-byte hex checked). Decoding their `data` into actual reward-pot/unclaimed values
  // needs their confirmed parameter layout, which isn't confirmed yet — so those two lines stay flat
  // at 0 for every historical point (a real fact: no crystallize/epoch has happened yet) and this
  // only counts/dates those three events, rather than guessing a field layout. Crystallized's own
  // newPrincipalCheckpoint field (2026-09-29, per Matteo) is NOT decoded yet either, even though he
  // named the field: he hasn't given its full event signature (param types / indexed flags), and
  // guessing the position of a non-indexed field inside `data` from a name alone is exactly the kind
  // of guess this codebase never makes — ask him for the full signature before wiring it in.
  // PrincipalFunded(address indexed from, uint256 amount, uint256 newPrincipalValue) and
  // NetProcessed(uint256 netAmount, uint256 sNetCredited, uint256 newPrincipalValue) are different:
  // Matteo gave their exact layouts, so their own reported newPrincipalValue is plotted directly as
  // the sNET Principal line for historical points — never estimated, just each event's own checkpoint,
  // merged and sorted chronologically since both mean the same thing (Principal right after that event).
  // The final ("live") point is different again: it's the projected 50/50 crystallize split (see
  // refreshOverview, which computes it every 60s from principalValue()/principalCheckpoint() and
  // stores it in LIVE) — a preview of what crystallize() would produce right now, not a real event
  // yet. A failure in this function never hides or blocks the "live" numbers above the chart, since
  // those are set independently in refreshOverview.
  var GC = null; // last-drawn chart's geometry + points, read by the hover/tap handlers below
  function drawGrowthChart(svg, pts) {
    var W = 1000, Hh = 300, L = 62, Rr = 10, T = 14, B = 30;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t; if (t1 === t0) t1 = t0 + 3600;
    var maxV = 1n;
    pts.forEach(function (pt) { if (pt.p > maxV) maxV = pt.p; if (pt.r > maxV) maxV = pt.r; if (pt.u > maxV) maxV = pt.u; });
    var topV = maxV + maxV / 4n + 1n; // headroom so a flat line never sits on the top gridline
    var floorV = -(topV / 3n); // virtual floor so the deploy anchor (0) renders above the bottom axis
    var domain = topV - floorV;
    var X = function (t) { return L + (t - t0) / (t1 - t0) * (W - L - Rr); };
    var Y = function (v) { return T + (1 - Number((v - floorV) * 10000n / domain) / 10000) * (Hh - T - B); };
    // invisible hit-area for hover/tap: transparent <svg> regions don't reliably receive pointer
    // events in every browser, so interaction binds to this instead
    var o = '<rect class="pghit" x="0" y="0" width="' + W + '" height="' + Hh + '" fill="transparent"/>';
    for (var i = 0; i <= 4; i++) {
      var v = topV * BigInt(Math.round(i / 4 * 10000)) / 10000n;
      o += '<line class="grid" x1="' + L + '" x2="' + (W - Rr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="ax" x="' + (L - 6) + '" y="' + (Y(v) + 5) + '" text-anchor="end">' + sn(v).replace(' sNET', '') + '</text>';
    }
    for (var j = 0; j <= 4; j++) {
      var t = t0 + (t1 - t0) * j / 4, d = new Date(t * 1000);
      o += '<text class="ax" x="' + X(t) + '" y="' + (Hh - 8) + '" text-anchor="' + (j === 0 ? 'start' : j === 4 ? 'end' : 'middle') + '">' + d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + '</text>';
    }
    function line(cls, key) { return '<path class="' + cls + '" d="' + pts.map(function (pt, k) { return (k ? 'L' : 'M') + X(pt.t).toFixed(1) + ' ' + Y(pt[key]).toFixed(1); }).join(' ') + '"/>'; }
    function dots(cls, key) { return pts.map(function (pt) { return '<circle class="' + cls + '" cx="' + X(pt.t).toFixed(1) + '" cy="' + Y(pt[key]).toFixed(1) + '" r="4.5"/>'; }).join(''); }
    o += line('pline', 'p') + line('rline', 'r') + line('uline', 'u') + dots('pdot', 'p') + dots('rdot', 'r') + dots('udot', 'u');
    svg.innerHTML = o;
    GC = { pts: pts, t0: t0, t1: t1, L: L, Rr: Rr, W: W, Hh: Hh, T: T, B: B, topV: topV, floorV: floorV, domain: domain };
    bindGCHover();
  }

  // ---- growth chart hover/tap: crosshair + a tooltip with all three series at that point -------
  function gcX(t) { return GC.L + (t - GC.t0) / (GC.t1 - GC.t0) * (GC.W - GC.L - GC.Rr); }
  function gcY(v) { return GC.T + (1 - Number((v - GC.floorV) * 10000n / GC.domain) / 10000) * (GC.Hh - GC.T - GC.B); }
  function bindGCHover() {
    // the hit-rect is a fresh DOM node every redraw (svg.innerHTML is replaced), so this rebinds
    // every time rather than once, or a periodic refresh would leave a dead hit-rect with no listeners
    var svg = $('#gChart svg'), hit = svg && svg.querySelector('.pghit'); if (!hit) return;
    hit.addEventListener('mousemove', gcMove);
    hit.addEventListener('mouseleave', function () { gcShowTip(null); });
    // touch: a tap shows the tooltip pinned at the nearest point; tapping again hides it — a
    // continuous hover doesn't exist on touch, so this is the mobile equivalent Matteo asked for
    var tapped = false;
    hit.addEventListener('touchstart', function (ev) {
      if (tapped) { gcShowTip(null); tapped = false; return; }
      var t = ev.touches[0]; if (t) { gcMove({ clientX: t.clientX }); tapped = true; }
    }, { passive: true });
  }
  function gcMove(ev) {
    if (!GC || !GC.pts.length) return;
    var svg = $('#gChart svg'); if (!svg) return;
    var rect = svg.getBoundingClientRect();
    var px = (ev.clientX - rect.left) / rect.width * GC.W;
    var t = GC.t0 + (px - GC.L) / (GC.W - GC.L - GC.Rr) * (GC.t1 - GC.t0);
    // Step function, not nearest-neighbor: historical values only change at a real event, so the
    // value "at" any hovered instant is whatever the last known point AT OR BEFORE it recorded — never
    // an interpolation, and never snapped forward to a later event just because it's closer in time
    // (2026-09-29, per Matteo). Only the live (projected) tail point can be "in the future" of the
    // last recorded event; hovering past it still shows the live point, since it's the current estimate.
    var chosen = GC.pts[0];
    GC.pts.forEach(function (pt) { if (pt.t <= t) chosen = pt; });
    gcShowTip(chosen);
  }
  function gcShowTip(pt) {
    var svg = $('#gChart svg'), wrap = $('#gChart'); if (!svg || !wrap) return;
    var tip = $('#gcTip');
    if (!pt) { var g0 = svg.querySelector('#gcHoverG'); if (g0) g0.style.display = 'none'; if (tip) tip.style.display = 'none'; return; }
    var g = svg.querySelector('#gcHoverG');
    if (!g) {
      g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.id = 'gcHoverG';
      g.innerHTML = '<line class="xline"/><circle class="hp" r="5"/><circle class="hr" r="5"/><circle class="hu" r="5"/>';
      svg.appendChild(g);
    }
    g.style.display = '';
    var x = gcX(pt.t), lineEl = g.querySelector('line'), circles = g.querySelectorAll('circle');
    lineEl.setAttribute('x1', x); lineEl.setAttribute('x2', x); lineEl.setAttribute('y1', GC.T); lineEl.setAttribute('y2', GC.Hh - GC.B);
    circles[0].setAttribute('cx', x); circles[0].setAttribute('cy', gcY(pt.p));
    circles[1].setAttribute('cx', x); circles[1].setAttribute('cy', gcY(pt.r));
    circles[2].setAttribute('cx', x); circles[2].setAttribute('cy', gcY(pt.u));
    if (!tip) { tip = document.createElement('div'); tip.id = 'gcTip'; tip.className = 'gtip'; wrap.appendChild(tip); }
    var d = new Date(pt.t * 1000);
    var dateStr = d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ', ' + ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ' UTC';
    tip.innerHTML = esc(dateStr) + (pt.projected ? ' · projected' : ' · recorded') + '<br>sNET principal ' + esc(sn(pt.p)) + '<br>next round rewards ' + esc(sn(pt.r)) + '<br>unclaimed rewards ' + esc(sn(pt.u));
    var leftPct = x / GC.W * 100;
    if (leftPct > 55) { tip.style.right = (100 - leftPct + 2) + '%'; tip.style.left = 'auto'; }
    else { tip.style.left = (leftPct + 2) + '%'; tip.style.right = 'auto'; }
    tip.style.display = 'block';
  }

  function refreshGrowth() {
    var svg = $('#gChart svg'); if (!svg) return;
    function showMsg(l1, l2) {
      svg.innerHTML = '<text class="msg" x="500" y="140" text-anchor="middle">' + esc(l1) + '</text>' +
        (l2 ? '<text class="msg2" x="500" y="168" text-anchor="middle">' + esc(l2) + '</text>' : '');
    }
    if (C.deployBlock == null) {
      S('gTotal', 'UNAVAILABLE'); S('gNote', "The contract's deploy block isn't configured yet, so the event-log range can't be scanned safely.");
      showMsg('DEPLOY BLOCK NOT SET'); return;
    }
    showMsg('READING EVENT LOG…');
    CH.getLogsPaged(R, [[CH.TOPICS.Crystallized, CH.TOPICS.EpochPublished, CH.TOPICS.AllocationClaimed, CH.TOPICS.PrincipalFunded, CH.TOPICS.NetProcessed]], C.deployBlock).then(function (logs) {
      var funded = logs.filter(function (l) { return l.topics && l.topics[0] === CH.TOPICS.PrincipalFunded; })
        .map(function (l) { return { block: Number(BigInt(l.blockNumber)), value: CH.u(l.data, 1) }; }); // data = [amount, newPrincipalValue]; `from` is indexed, not in data
      var processed = logs.filter(function (l) { return l.topics && l.topics[0] === CH.TOPICS.NetProcessed; })
        .map(function (l) { return { block: Number(BigInt(l.blockNumber)), value: CH.u(l.data, 2) }; }); // data = [netAmount, sNetCredited, newPrincipalValue], no indexed params
      // Two different real-world events, same meaning (Principal right after that event) — merged and
      // sorted chronologically into one series, exactly as Matteo specified.
      var principalEvents = funded.concat(processed).sort(function (a, b) { return a.block - b.block; });

      var byTopic = { c: 0, e: 0, a: 0 };
      logs.forEach(function (l) {
        var t = l.topics && l.topics[0];
        if (t === CH.TOPICS.Crystallized) byTopic.c++; else if (t === CH.TOPICS.EpochPublished) byTopic.e++; else if (t === CH.TOPICS.AllocationClaimed) byTopic.a++;
      });
      var otherNote = byTopic.c + ' crystallization(s) · ' + byTopic.e + ' epoch(s) published · ' + byTopic.a + ' claim(s) — reward-pot/unclaimed history needs the confirmed event layout before it can be plotted without guessing.';
      var totalLabel = logs.length + ' EVENT' + (logs.length === 1 ? '' : 'S') + ' SINCE DEPLOY';

      if (!principalEvents.length) {
        S('gTotal', totalLabel);
        S('gNote', 'No PrincipalFunded/NetProcessed event yet, so the sNET Principal line has nothing before the live point above. ' + otherNote);
        showMsg('NO PRINCIPAL FUNDING YET', 'chart fills in once the reserve is funded');
        return;
      }

      // Block timestamps for the deploy anchor (0) and each principal-changing block, batched in one
      // request — never guessed, and the RPC's own timestamps are the only source used for the x-axis.
      var blocks = [C.deployBlock].concat(principalEvents.map(function (f) { return f.block; }));
      var uniqBlocks = blocks.filter(function (b, i) { return blocks.indexOf(b) === i; });
      CH.rpc(uniqBlocks.map(function (b) { return ['eth_getBlockByNumber', [CH.hexN(b), false]]; })).then(function (blks) {
        var tsByBlock = {};
        uniqBlocks.forEach(function (b, i) { tsByBlock[b] = Number(BigInt(blks[i].timestamp)); });
        // Historical points: real recorded values only. next round rewards / unclaimed stay at 0 —
        // no crystallize/epoch has happened yet, so 0 is a fact here, not an estimate.
        var pts = [{ t: tsByBlock[C.deployBlock], p: 0n, r: 0n, u: 0n }];
        principalEvents.forEach(function (f) { pts.push({ t: tsByBlock[f.block], p: f.value, r: 0n, u: 0n }); });
        // Live point: the projected 50/50 split from refreshOverview (updates every 60s) — the only
        // point on this chart that's a preview rather than a recorded fact, flagged for the tooltip.
        if (LIVE) pts.push({ t: LIVE.ts, p: LIVE.principal, r: LIVE.nextRound, u: LIVE.liab, projected: true });
        drawGrowthChart(svg, pts);
        S('gTotal', totalLabel);
        S('gNote', principalEvents.length + ' principal-funding event(s) plotted (PrincipalFunded/NetProcessed), each shown at its own reported value. The live point previews the next 50/50 crystallize() split from principalValue()/principalCheckpoint() and updates every 60s — becomes final at the real crystallize(). ' + otherNote);
      }).catch(function (e) {
        S('gTotal', 'UNAVAILABLE'); S('gNote', 'Could not read block times for the funding events: ' + esc(e.message || String(e)));
        showMsg('COULD NOT READ EVENT LOG');
      });
    }).catch(function (e) {
      S('gTotal', 'UNAVAILABLE'); S('gNote', 'Could not read the event log: ' + esc(e.message || String(e)));
      showMsg('COULD NOT READ EVENT LOG');
    });
  }
  refreshGrowth();

  // ------------------------------------------------------------ community donations
  (function () {
    var box = $('#donateBox'); if (!box) return;
    var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=2&data=' + encodeURIComponent(R);
    box.innerHTML =
      '<div class="donaterow">' +
        '<div class="crow"><div class="ch"><b>Reward Reserve address</b></div><div class="ca2"><code>' + R + '</code>' +
          '<button class="b copy" type="button" data-copy="' + R + '">Copy</button>' +
          '<a class="b" href="' + EXPL + '/address/' + R + '" target="_blank" rel="noopener">Explorer ↗</a></div></div>' +
        '<div class="donateqr"><img src="' + qrUrl + '" alt="QR code for the Reward Reserve address" width="132" height="132" loading="lazy"><span>Scan to donate</span></div>' +
      '</div>' +
      '<p class="warn" style="margin-top:10px">This is the same address as the contract, not a new one. Sending here needs no approval — it is a plain token transfer, and there is no way to withdraw a donation once sent, so double-check the address first.</p>';
  })();

  // copy buttons (delegated: rendered into the contracts list below)
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('.copy'); if (!b) return;
    var val = b.getAttribute('data-copy'), orig = b.getAttribute('data-label') || b.textContent; b.setAttribute('data-label', orig);
    function ok() { b.textContent = 'Copied'; setTimeout(function () { b.textContent = orig; }, 1600); }
    function fb() { var t = document.createElement('textarea'); t.value = val; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); ok(); } catch (e) { } document.body.removeChild(t); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(val).then(ok, fb); else fb();
  });

  // ------------------------------------------------------------ contracts list + explorer verification (best-effort)
  var CONTRACTS = [
    ['Reward Reserve V2', A.rewardReserve, '/address/' + A.rewardReserve + '?tab=contract'],
    ['TEN', A.ten, '/token/' + A.ten],
    ['NET', A.net, '/token/' + A.net],
    ['sNET', A.snet, '/token/' + A.snet]
  ];
  $('#clist').innerHTML = CONTRACTS.map(function (c, i) {
    return '<div class="crow"><div class="ch"><b>' + esc(c[0]) + '</b><small id="vf' + i + '">source status not confirmed</small></div><div class="ca2"><code>' + c[1] + '</code><button class="b copy" type="button" data-copy="' + c[1] + '">Copy</button><a class="b" href="' + EXPL + c[2] + '" target="_blank" rel="noopener">Explorer ↗</a></div></div>';
  }).join('');
  CONTRACTS.forEach(function (c, i) {
    fetch(EXPL + '/api/v2/smart-contracts/' + c[1], { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      var el = document.getElementById('vf' + i); if (!el || !j) return;
      if (j.is_verified === true) { el.textContent = 'verified · ' + (j.is_fully_verified ? 'full match' : 'partial match') + (j.name ? ' · ' + j.name : ''); el.classList.add('ok'); }
    }).catch(function () { });
  });
  badge(['badge2'], C.network === 'mainnet' ? 'MAINNET' : 'TESTNET');

  // ------------------------------------------------------------ address lookup + epoch reconciliation
  var addrInput = $('#addr'), lookupForm = $('#lookup'), lookupMsg = $('#lookupMsg'), meOut = $('#meOut');
  var epochRows = $('#epochRows'), claimBtn = $('#claimBtn'), claimStatus = $('#claimStatus');
  var LAST = null; // { address, ready: [{epochId, amount, proof}] }

  function msg(t) { lookupMsg.textContent = t || ''; }

  lookupForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = addrInput.value.trim();
    if (v.length > 42) { msg('That is too long for an address (40 hex characters after 0x).'); meOut.hidden = true; return; }
    if (/^[a-z]+(\s[a-z]+){5,}$/i.test(v) && !/^0x/i.test(v)) { msg('That looks like a seed phrase, not an address. Never paste a seed phrase anywhere — this site only needs a public 0x… address.'); meOut.hidden = true; return; }
    if (!CH.isAddress(v)) { msg('Not a valid public address. Expected 0x followed by 40 hex characters.'); meOut.hidden = true; return; }
    msg(''); runLookup(v);
  });

  function runLookup(address) {
    meOut.hidden = false; claimBtn.disabled = true; claimStatus.textContent = ''; alertBox('claim', '');
    epochRows.innerHTML = '<tr><td colspan="4">reading…</td></tr>';
    S('m_bal', '…'); S('m_elig', '…'); S('m_toClaim', '…'); S('m_claimed', '…');
    S('m_eligYn', '…'); S('m_age', '…'); S('m_daysToElig', '…'); S('m_share', '…'); H('lotList', ''); S('m_eligAsOf', '');

    var latestP = CH.one(CH.ethCall(R, CH.SEL.latestEpochId));
    var balP = CH.one(CH.ethCall(A.ten, CH.encBalanceOf(address)));

    Promise.all([latestP, balP]).then(function (r) {
      var latest = Number(BigInt(r[0])), bal = CH.u(r[1], 0);
      S('m_bal', tn(bal)); S('m_bal_usd', usdLabel(bal, DEC.ten, 'ten'));
      if (!latest) {
        S('m_elig', '0 TEN'); S('m_toClaim', '0 sNET'); S('m_claimed', '0 sNET');
        S('m_elig_usd', ''); S('m_toClaim_usd', ''); S('m_claimed_usd', '');
        S('m_eligSub', 'no published epoch yet — eligibility below is from a separate pre-distribution snapshot');
        epochRows.innerHTML = '<tr><td colspan="4">no epoch published yet</td></tr>';
        LAST = { address: address, ready: [] };
        // No epoch exists yet to answer "am I eligible / how many days left", so fall back to the
        // separate, independent eligibility.json feed (real holding history, updated periodically,
        // available well before the first crystallize()/publishEpoch()). This never touches claims
        // or allocation amounts — those still come only from a real published epoch.
        return P.getEligibility().then(function (elig) {
          if (elig.status === 'ok') renderEligibilityFromFeed(elig.data, address);
          else { S('m_eligYn', '—'); S('m_age', '—'); S('m_daysToElig', '—'); S('m_share', '—'); H('lotList', ''); S('m_eligAsOf', elig.reason || ''); }
        });
      }
      var ids = []; for (var i = latest; i >= 1; i--) ids.push(i);
      return Promise.all(ids.map(function (id) { return P.getEpoch(id); })).then(function (epochs) {
        return reconcile(address, ids, epochs);
      });
    }).catch(function (e) {
      alertBox('claim', '<b>Could not read this address.</b> ' + esc(e.message || String(e)));
      epochRows.innerHTML = '<tr><td colspan="4">unavailable</td></tr>';
    });
  }

  // Pre-distribution eligibility, from the separate eligibility.json feed (real holding history,
  // no epoch/claim data involved) — used only while no epoch has ever been published (see
  // runLookup). A wallet is in at most one of holders/ineligible; absent from both means no
  // tracked TEN holding, shown as such rather than guessed.
  function renderEligibilityFromFeed(elig, address) {
    S('m_eligAsOf', elig.snapshotTime ? 'eligibility snapshot · ' + fmtDate(elig.snapshotTime) : '');
    var entry = P.findAddr(elig.holders, address);
    if (entry) {
      S('m_eligYn', 'Yes'); S('m_daysToElig', 'all lots eligible'); S('m_share', '—');
      var lots = Array.isArray(entry.lots) ? entry.lots : null;
      if (lots && lots.length) {
        var oldest = lots.reduce(function (a, b) { return a.days >= b.days ? a : b; });
        S('m_age', oldest.days + ' day' + (oldest.days === 1 ? '' : 's') + ' (oldest lot)');
        H('lotList', '<div class="rk">Your TEN lots</div><ol>' + lots.map(function (l, i) {
          return '<li><span>Lot ' + (i + 1) + '</span><span>' + tn(l.amount) + '</span><span>' + l.days + 'd held</span><span class="tag ' + (l.eligible ? 'ok">eligible' : 'bad">not yet') + '</span></li>';
        }).join('') + '</ol>');
      } else {
        S('m_age', 'no lot data'); H('lotList', '');
      }
      return;
    }
    var inelig = P.findAddr(elig.ineligible, address);
    if (inelig) {
      var days = inelig.daysUntilEligible != null ? Number(inelig.daysUntilEligible) : null;
      S('m_eligYn', days != null ? 'Not yet — ' + days + ' day' + (days === 1 ? '' : 's') + ' left' : 'No');
      // "Age" here is how long the oldest lot has been held, derived from the countdown the feed
      // already gives us (minDays - daysUntilEligible) — the countdown to eligibility is anchored to
      // the OLDEST lot, so the age shown must match, not the youngest lot's age (2026-09-29 bug fix,
      // per Matteo: the static label already said "oldest lot", the value just didn't match it).
      var oldestDays = (elig.eligibility && Number(elig.eligibility.minDays) > 0 && days != null) ? Number(elig.eligibility.minDays) - days : null;
      S('m_age', oldestDays != null ? oldestDays + ' day' + (oldestDays === 1 ? '' : 's') + ' (oldest lot)' : '—');
      S('m_daysToElig', days != null ? days + ' day' + (days === 1 ? '' : 's') : '—');
      S('m_share', '—'); H('lotList', '');
      return;
    }
    S('m_eligYn', 'No TEN held (tracked)'); S('m_age', '—'); S('m_daysToElig', '—'); S('m_share', '—'); H('lotList', '');
  }

  // Personal dashboard extras: everything here comes from the already-fetched latest
  // epoch JSON (no new fetch) — lots[]/eligibility.minDays/shareBps are all optional
  // fields P.getEpoch's validator soft-checks, so a missing one shows "no data", never 0.
  function renderEligibilityDetail(latestOk, address) {
    if (!latestOk) { S('m_eligYn', '—'); S('m_age', '—'); S('m_daysToElig', '—'); S('m_share', '—'); H('lotList', ''); return; }
    var minDays = latestOk.eligibility && Number(latestOk.eligibility.minDays) > 0 ? Number(latestOk.eligibility.minDays) : null;
    var entry = P.findAddr(latestOk.holders, address);
    var lots = entry && Array.isArray(entry.lots) ? entry.lots : null;

    if (entry && lots && lots.length) {
      var allElig = lots.every(function (l) { return l.eligible; }), anyElig = lots.some(function (l) { return l.eligible; });
      S('m_eligYn', allElig ? 'Yes' : (anyElig ? 'Partial (' + lots.filter(function (l) { return l.eligible; }).length + '/' + lots.length + ' lots)' : 'No'));
      var oldest = lots.reduce(function (a, b) { return a.days >= b.days ? a : b; });
      S('m_age', oldest.days + ' day' + (oldest.days === 1 ? '' : 's') + ' (oldest lot)');
      var youngest = lots.reduce(function (a, b) { return a.days <= b.days ? a : b; });
      S('m_daysToElig', minDays == null ? '—' : (youngest.days >= minDays ? 'all lots eligible' : (minDays - youngest.days) + ' day' + ((minDays - youngest.days) === 1 ? '' : 's')));
      H('lotList', '<div class="rk">Your TEN lots</div><ol>' + lots.map(function (l, i) {
        return '<li><span>Lot ' + (i + 1) + '</span><span>' + tn(l.amount) + '</span><span>' + l.days + 'd held</span><span class="tag ' + (l.eligible ? 'ok">eligible' : 'bad">not yet') + '</span></li>';
      }).join('') + '</ol>');
    } else if (entry) {
      S('m_eligYn', BigInt(entry.eligibleBalance || 0) > 0n ? 'Yes' : 'No');
      S('m_age', 'no lot data for this epoch'); S('m_daysToElig', '—'); H('lotList', '');
    } else {
      var ineligEntry = P.findAddr(latestOk.ineligible, address);
      if (ineligEntry && ineligEntry.youngestLotDays != null) {
        var yd = Number(ineligEntry.youngestLotDays);
        S('m_eligYn', 'No');
        S('m_age', yd + ' day' + (yd === 1 ? '' : 's') + ' (youngest lot)');
        S('m_daysToElig', minDays == null ? '—' : Math.max(0, minDays - yd) + ' day' + (Math.max(0, minDays - yd) === 1 ? '' : 's'));
      } else {
        S('m_eligYn', 'No'); S('m_age', 'no data'); S('m_daysToElig', '—');
      }
      H('lotList', '');
    }
    S('m_share', entry && entry.shareBps != null ? (Number(entry.shareBps) / 100).toFixed(2) + '%' : '—');
  }

  function reconcile(address, ids, epochs) {
    var rows = ids.map(function (id, i) { return { id: id, epoch: epochs[i] }; });
    var latestOk = rows[0] && rows[0].epoch.status === 'ok' ? rows[0].epoch.data : null;
    var elig = latestOk ? (P.findAddr(latestOk.holders, address) || {}).eligibleBalance : null;
    S('m_elig', elig != null ? tn(elig) : '0 TEN'); S('m_elig_usd', elig != null ? usdLabel(elig, DEC.ten, 'ten') : '');
    S('m_eligSub', latestOk ? 'epoch ' + latestOk.epochId : 'no published epoch to read from');
    renderEligibilityDetail(latestOk, address);

    // entries with something to check on chain: only rows whose JSON loaded and lists this address
    var withEntry = rows.map(function (row) {
      if (row.epoch.status !== 'ok') return { row: row, entry: null };
      var entry = P.findAddr(row.epoch.data.holders, address);
      return { row: row, entry: entry };
    });
    var toVerify = withEntry.filter(function (x) { return x.entry; });
    var verifyP = toVerify.length ? Promise.all(toVerify.map(function (x) { return P.verifyClaimable(x.row.id, address, x.entry); })) : Promise.resolve([]);

    return verifyP.then(function (results) {
      var byId = {}; toVerify.forEach(function (x, i) { byId[x.row.id] = results[i]; });
      var toClaim = 0n, claimed = 0n, ready = [];
      var html = withEntry.map(function (x) {
        if (!x.entry) {
          var reason = x.row.epoch.status === 'ok' ? 'no allocation this epoch' : (x.row.epoch.reason || 'unavailable');
          return '<tr><td>Epoch ' + x.row.id + '</td><td class="num">--</td><td>' + esc(reason) + '</td><td></td></tr>';
        }
        var v = byId[x.row.id], amt = sn(x.entry.allocation);
        if (v.state === 'CLAIMED') { claimed += BigInt(x.entry.allocation); return '<tr><td>Epoch ' + x.row.id + '</td><td class="num">' + amt + '</td><td class="ok">claimed</td><td></td></tr>'; }
        if (v.state === 'READY') { toClaim += BigInt(x.entry.allocation); ready.push({ epochId: x.row.id, amount: x.entry.allocation, proof: x.entry.proof }); return '<tr><td>Epoch ' + x.row.id + '</td><td class="num">' + amt + '</td><td class="ok">ready to claim</td><td></td></tr>'; }
        return '<tr><td>Epoch ' + x.row.id + '</td><td class="num">' + amt + '</td><td class="bad">' + esc(v.reason || v.state) + '</td><td></td></tr>';
      }).join('');
      epochRows.innerHTML = html || '<tr><td colspan="4">no allocation found for this address</td></tr>';
      S('m_toClaim', sn(toClaim)); S('m_claimed', sn(claimed));
      S('m_toClaim_usd', usdLabel(toClaim, DEC.snet, 'net')); S('m_claimed_usd', usdLabel(claimed, DEC.snet, 'net'));
      LAST = { address: address, ready: ready };
      var mine = W.snapshot().address && W.snapshot().address.toLowerCase() === address.toLowerCase();
      claimBtn.disabled = !mine || !ready.length;
      if (!ready.length) claimStatus.textContent = '';
      else if (!mine) claimStatus.textContent = 'Connect the wallet that owns this address to claim.';
      else claimStatus.textContent = ready.length + ' epoch(s) ready · ' + sn(toClaim);
    });
  }

  W.onChange(function (snap) {
    if (LAST && LAST.address) {
      var mine = snap.address && snap.address.toLowerCase() === LAST.address.toLowerCase();
      claimBtn.disabled = !mine || !LAST.ready.length;
    }
  });

  claimBtn.addEventListener('click', function () {
    if (!LAST || !LAST.ready.length) return;
    claimBtn.disabled = true; alertBox('claim', '');
    var queue = LAST.ready.slice(), i = 0;
    function next() {
      if (i >= queue.length) { claimStatus.textContent = 'Done. Refreshing…'; runLookup(LAST.address); return; }
      var e = queue[i];
      claimStatus.textContent = 'Claiming epoch ' + e.epochId + ' (' + (i + 1) + ' of ' + queue.length + ')… confirm in your wallet.';
      W.sendClaim(e.epochId, e.amount, e.proof).then(function (hash) {
        claimStatus.textContent = 'Epoch ' + e.epochId + ': waiting for confirmation… ' + CH.short(hash);
        return waitReceipt(hash);
      }).then(function () { i++; next(); })
        .catch(function (err) {
          alertBox('claim', '<b>Epoch ' + e.epochId + ' claim failed.</b> ' + esc(err.message || String(err)));
          claimStatus.textContent = ''; claimBtn.disabled = false;
        });
    }
    next();
  });

  function waitReceipt(hash) {
    var tries = 0;
    function poll() {
      return CH.one(['eth_getTransactionReceipt', [hash]]).then(function (r) {
        if (!r) { if (++tries > 40) throw new Error('timed out waiting for confirmation'); return new Promise(function (res) { setTimeout(res, 3000); }).then(poll); }
        if (BigInt(r.status) !== 1n) throw new Error('transaction reverted');
        return r;
      });
    }
    return poll();
  }
})();

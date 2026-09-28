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
  var DEC = { ten: 18, snet: 9 };
  function sn(v) { return CH.amt(v, DEC.snet, 'sNET'); }
  function tn(v) { return CH.amt(v, DEC.ten, 'TEN'); }

  // $ estimates: spot prices from two on-chain reads (TenNetSpotReader + a Uniswap V2 pair),
  // combined in refreshPrices() below. PRICE stays null until both reads succeed, and every
  // usdLabel() call returns '' (never a guessed number) until then — matches the rest of the
  // site's "never fabricate, show nothing instead" rule.
  var PRICE = null; // { ten: usd per 1 TEN, net: usd per 1 NET (== per 1 sNET) } | null
  function usdLabel(v, dec, key) {
    if (!PRICE || v == null) return '';
    var price = PRICE[key]; if (!(price > 0)) return '';
    var human = Number(v) / Math.pow(10, dec);
    var usd = human * price;
    if (usd > 0 && usd < 0.01) return '≈ <$0.01';
    var frac = usd < 1000 ? 2 : 0;
    return '≈ $' + usd.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
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
        CH.ethCall(A.snet, CH.encBalanceOf(R), tag), CH.ethCall(A.ten, CH.encBalanceOf(R), tag)
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
        S('ov_principal', sn(principal)); S('ov_holderside', sn(holderside)); S('ov_liab', sn(liab));
        S('ov_solvent', CH.boolAt(r[3], 0) ? 'SOLVENT' : 'INSOLVENT');
        var latestId = Number(CH.u(r[4], 0));
        S('ov_latestEpoch', num(latestId));
        S('ov_block', num(head.number));
        var snetInReserve = CH.u(r[7], 0), tenInReserve = CH.u(r[8], 0);
        S('mon_snet', sn(snetInReserve)); S('mon_ten', tn(tenInReserve));

        // sNET is priced the same as NET (1:1 via unstake()), no separate read needed.
        S('mon_snet_usd', usdLabel(snetInReserve, DEC.snet, 'net')); S('mon_ten_usd', usdLabel(tenInReserve, DEC.ten, 'ten'));
        S('ov_principal_usd', usdLabel(principal, DEC.snet, 'net')); S('ov_holderside_usd', usdLabel(holderside, DEC.snet, 'net')); S('ov_liab_usd', usdLabel(liab, DEC.snet, 'net'));

        // Growth section's "live" point: the same principal/liability values just read here,
        // shown independently of the historical event-log fetch below — so it still appears
        // and updates even when that fetch fails (see refreshGrowth()).
        S('gLivePrincipal', sn(principal)); S('gLiveLiab', sn(liab)); S('gLiveAsOf', 'as of block ' + num(head.number));

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

        if (latestId) {
          P.getEpoch(latestId).then(function (ep) {
            if (ep.status === 'ok' && ep.data.totals) { S('ov_holders', num(ep.data.totals.eligibleHolders)); S('ov_eligTotal', tn(ep.data.totals.totalEligibleBalance)); }
            else { S('ov_holders', '—'); S('ov_eligTotal', '—'); }
          });
        } else { S('ov_holders', '—'); S('ov_eligTotal', '—'); }

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
  // Event topic0 hashes were supplied as-given (only syntactic 32-byte hex checked, not
  // independently recomputed — that needs the exact event signature). Decoding each log's
  // `data` into the actual sNET principal / reward-pot / unclaimed values needs the confirmed
  // parameter types and indexed/non-indexed layout for Crystallized / EpochPublished /
  // AllocationClaimed, which is not yet confirmed — so this only counts and dates events
  // rather than guessing a field layout and risking a fabricated number.
  // This is entirely independent of the "live" point above (populated in refreshOverview from
  // values already read every 60s): a failure here never hides or blocks that live point.
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
    CH.getLogsPaged(R, [[CH.TOPICS.Crystallized, CH.TOPICS.EpochPublished, CH.TOPICS.AllocationClaimed]], C.deployBlock).then(function (logs) {
      if (!logs.length) {
        S('gTotal', '0 EVENTS'); S('gNote', 'No history before this point yet — this fills in as Crystallized / EpochPublished / AllocationClaimed events happen. Nothing is shown rather than an invented trend.');
        showMsg('NO HISTORY BEFORE THIS POINT', 'chart fills in once the reserve crystallizes'); return;
      }
      var byTopic = { c: 0, e: 0, a: 0 };
      logs.forEach(function (l) {
        var t = l.topics && l.topics[0];
        if (t === CH.TOPICS.Crystallized) byTopic.c++; else if (t === CH.TOPICS.EpochPublished) byTopic.e++; else if (t === CH.TOPICS.AllocationClaimed) byTopic.a++;
      });
      S('gTotal', logs.length + ' EVENT' + (logs.length === 1 ? '' : 'S') + ' SINCE DEPLOY');
      S('gNote', byTopic.c + ' crystallization(s) · ' + byTopic.e + ' epoch(s) published · ' + byTopic.a + ' claim(s). Exact values need the confirmed event parameter layout before they can be plotted without guessing — pending confirmation.');
      showMsg('EVENT COUNTS ONLY', 'awaiting confirmed event ABI to plot exact values');
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
    S('m_eligYn', '…'); S('m_age', '…'); S('m_daysToElig', '…'); S('m_share', '…'); H('lotList', '');

    var latestP = CH.one(CH.ethCall(R, CH.SEL.latestEpochId));
    var balP = CH.one(CH.ethCall(A.ten, CH.encBalanceOf(address)));

    Promise.all([latestP, balP]).then(function (r) {
      var latest = Number(BigInt(r[0])), bal = CH.u(r[1], 0);
      S('m_bal', tn(bal)); S('m_bal_usd', usdLabel(bal, DEC.ten, 'ten'));
      if (!latest) {
        S('m_elig', '0 TEN'); S('m_toClaim', '0 sNET'); S('m_claimed', '0 sNET');
        S('m_elig_usd', ''); S('m_toClaim_usd', ''); S('m_claimed_usd', '');
        S('m_eligYn', '—'); S('m_age', '—'); S('m_daysToElig', '—'); S('m_share', '—');
        epochRows.innerHTML = '<tr><td colspan="4">no epoch published yet</td></tr>';
        LAST = { address: address, ready: [] };
        return;
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

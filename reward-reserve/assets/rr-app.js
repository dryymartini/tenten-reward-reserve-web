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
      connectBtn.textContent = 'Install a wallet'; connectBtn.disabled = true;
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
  function refreshOverview() {
    return CH.one(['eth_getBlockByNumber', ['latest', false]]).then(function (blk) {
      var head = { number: Number(BigInt(blk.number)), ts: Number(BigInt(blk.timestamp)) };
      var tag = CH.hexN(head.number);
      var calls = [
        CH.ethCall(R, CH.SEL.principalValue, tag), CH.ethCall(R, CH.SEL.holderSideValue, tag),
        CH.ethCall(R, CH.SEL.outstandingLiabilityValue, tag), CH.ethCall(R, CH.SEL.isSolvent, tag),
        CH.ethCall(R, CH.SEL.latestEpochId, tag)
      ];
      return CH.rpc(calls).then(function (r) {
        S('ov_principal', sn(CH.u(r[0], 0))); S('ov_holderside', sn(CH.u(r[1], 0))); S('ov_liab', sn(CH.u(r[2], 0)));
        S('ov_solvent', CH.boolAt(r[3], 0) ? 'SOLVENT' : 'INSOLVENT'); S('ov_latestEpoch', num(CH.u(r[4], 0)));
        S('ov_block', num(head.number));
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
  badge(['badge2'], 'TESTNET');

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

    var latestP = CH.one(CH.ethCall(R, CH.SEL.latestEpochId));
    var balP = CH.one(CH.ethCall(A.ten, CH.encBalanceOf(address)));

    Promise.all([latestP, balP]).then(function (r) {
      var latest = Number(BigInt(r[0])), bal = CH.u(r[1], 0);
      S('m_bal', tn(bal));
      if (!latest) {
        S('m_elig', '0 TEN'); S('m_toClaim', '0 sNET'); S('m_claimed', '0 sNET');
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

  function reconcile(address, ids, epochs) {
    var rows = ids.map(function (id, i) { return { id: id, epoch: epochs[i] }; });
    var latestOk = rows[0] && rows[0].epoch.status === 'ok' ? rows[0].epoch.data : null;
    var elig = latestOk ? (P.findAddr(latestOk.holders, address) || {}).eligibleBalance : null;
    S('m_elig', elig != null ? tn(elig) : '0 TEN');
    S('m_eligSub', latestOk ? 'epoch ' + latestOk.epochId : 'no published epoch to read from');

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

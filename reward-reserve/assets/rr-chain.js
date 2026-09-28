/* ============================================================================
   rr-chain.js — read-only JSON-RPC client + ABI helpers (public RPC only)
   No wallet, no signer here: eth_sendTransaction / signing lives entirely in
   rr-wallet.js, which talks to the connected wallet's own EIP-1193 provider,
   never to this module. The only RPC methods this module ever sends are:
     eth_call, eth_blockNumber, eth_getBlockByNumber, eth_getTransactionReceipt, eth_getLogs
   Selectors below are keccak256(signature) computed and cross-checked offline
   against the TenRewardReserveV1 selectors already verified on Blockscout
   (function signatures — and therefore selectors — are unchanged in V2 for
   every function reused here); holderSideValue(), leaf(...), lastCrystallization()
   and CRYSTALLIZATION_PERIOD() are new to V2. Event topics (TOPICS below) were
   supplied directly and are used as given — this module has no way to recompute
   a topic0 without the exact event parameter types, only to check a selector,
   which has none of that ambiguity.
   ========================================================================== */
(function () {
  'use strict';
  var C = window.RR_CONFIG;

  // ---- read-only method allow-list (defence in depth) ---------------------
  var ALLOWED = { eth_call: 1, eth_blockNumber: 1, eth_getBlockByNumber: 1, eth_getTransactionReceipt: 1, eth_getLogs: 1 };

  // ---- selectors -----------------------------------------------------------
  var SEL = {
    // TenRewardReserveV2
    principalValue: '0x7da68d34', holderSideValue: '0xc0380529', outstandingLiabilityValue: '0x7c3d5f47',
    isSolvent: '0x5ce23950', latestEpochId: '0x73e2144f',
    epochs: '0xc6b61e4c', claimedBy: '0xfef08fa4', verifyAllocation: '0x1848f6ec', leaf: '0x78bb02dd',
    claim: '0xae0b51df', // claim(uint256,uint256,bytes32[]) — encoded only for the read-only eth_call
                         // dry-run before showing the button as ready, and for the wallet to sign; this
                         // module itself never sends it
    lastCrystallization: '0xb53fdc08',   // lastCrystallization() -> uint256 timestamp
    crystallizationPeriod: '0xf6257825', // CRYSTALLIZATION_PERIOD() -> uint256 seconds (verified: the
                                          // solidity identifier is the all-caps constant name; the hash
                                          // Matteo gave matches CRYSTALLIZATION_PERIOD(), not a
                                          // camelCase crystallizationPeriod())
    // ERC-20 (TEN / sNET)
    balanceOf: '0x70a08231'
  };

  var TOPICS = {
    Crystallized:       '0xf4165e6a03db2f59ebd929ce3b1189f8f17451c4e5a5e95f0a0d8fa2163f208c',
    EpochPublished:      '0x4b06ca08b73c7994c0673265cf727603b6487d8f60834d83b60d11a2e61b103f',
    AllocationClaimed:   '0xee89b274de26d8ff2f7a29873f93a4aeb474c4aba006584d53c8a39e71f41d2a'
  };

  // ---- ABI encode/decode ---------------------------------------------------
  function strip(h) { return h.slice(0, 2) === '0x' ? h.slice(2) : h; }
  function pad64(h) { h = strip(h).toLowerCase(); if (h.length > 64) throw new Error('word overflow'); return '0'.repeat(64 - h.length) + h; }
  function encUint(n) { n = BigInt(n); if (n < 0n) throw new Error('negative'); return pad64(n.toString(16)); }
  function encAddr(a) { if (!isAddress(a)) throw new Error('bad address'); return pad64(a); }
  function encBytes32(b) { if (!/^0x[0-9a-fA-F]{64}$/.test(b)) throw new Error('bad bytes32'); return strip(b).toLowerCase(); }
  function word(data, i) { return '0x' + strip(data).slice(64 * i, 64 * (i + 1)); }
  function u(data, i) { var w = word(data, i); return w.length > 2 ? BigInt(w) : 0n; }
  function boolAt(data, i) { return u(data, i) !== 0n; }
  function bytes32At(data, i) { return word(data, i); }
  function addrAt(data, i) { return '0x' + strip(data).slice(64 * i + 24, 64 * (i + 1)); }
  function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }

  // verifyAllocation(uint256,address,uint256,bytes32[])
  function encVerifyAllocation(epochId, holder, amount, proof) {
    var head = encUint(epochId) + encAddr(holder) + encUint(amount) + encUint(128);
    var tail = encUint(proof.length) + proof.map(encBytes32).join('');
    return SEL.verifyAllocation + head + tail;
  }
  // claim(uint256,uint256,bytes32[])
  function encClaim(epochId, amount, proof) {
    var head = encUint(epochId) + encUint(amount) + encUint(96);
    var tail = encUint(proof.length) + proof.map(encBytes32).join('');
    return SEL.claim + head + tail;
  }
  function encBalanceOf(addr) { return SEL.balanceOf + encAddr(addr); }
  function encEpochs(epochId) { return SEL.epochs + encUint(epochId); }
  function encClaimedBy(epochId, holder) { return SEL.claimedBy + encUint(epochId) + encAddr(holder); }

  // ---- transport -----------------------------------------------------------
  var batchOk = true, idSeq = 1;
  function post(body) {
    var ctl = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(C.requestTimeoutMs) : undefined;
    return fetch(C.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('RPC HTTP ' + r.status); return r.json(); });
  }
  function check(method) { if (!ALLOWED[method]) throw new Error('blocked non-read RPC method: ' + method); }
  function one(c) {
    check(c[0]);
    return post({ jsonrpc: '2.0', id: idSeq++, method: c[0], params: c[1] }).then(function (x) {
      if (x.error) { var e = new Error(x.error.message || 'RPC error'); e.rpc = x.error; throw e; } return x.result;
    });
  }
  /** Batch of [method, params]. Resolves to results array; rejects on any error. */
  function rpc(calls) {
    calls.forEach(function (c) { check(c[0]); });
    if (!calls.length) return Promise.resolve([]);
    if (!batchOk) return Promise.all(calls.map(one));
    var base = idSeq; idSeq += calls.length;
    return post(calls.map(function (c, i) { return { jsonrpc: '2.0', id: base + i, method: c[0], params: c[1] }; }))
      .then(function (j) {
        if (!Array.isArray(j) || j.length !== calls.length) throw new Error('nobatch');
        j.sort(function (a, b) { return a.id - b.id; });
        return j.map(function (x) { if (x.error) { var e = new Error(x.error.message || 'RPC error'); e.rpc = x.error; throw e; } return x.result; });
      })
      .catch(function (e) { if (e.message === 'nobatch') { batchOk = false; return Promise.all(calls.map(one)); } throw e; });
  }
  /** Like rpc() but each call settles independently: [{ok,result|error}] */
  function rpcSettled(calls) {
    return rpc(calls).then(function (rs) { return rs.map(function (r) { return { ok: true, result: r }; }); })
      .catch(function () { return Promise.all(calls.map(function (c) { return one(c).then(function (r) { return { ok: true, result: r }; }, function (e) { return { ok: false, error: e }; }); })); });
  }
  function ethCall(to, data, tag) { return ['eth_call', [{ to: to, data: data }, tag || 'latest']]; }
  function hexN(n) { return '0x' + Number(n).toString(16); }

  /** One eth_getLogs call, fromBlock..latest. Volume here is a few dozen events a year at most. */
  function getLogs(address, topics, fromBlock) {
    var filt = { address: address, fromBlock: hexN(fromBlock), toBlock: 'latest' };
    if (topics) filt.topics = topics;
    return one(['eth_getLogs', [filt]]).then(function (r) { return r || []; });
  }

  // ---- units ----------------------------------------------------------------
  /** BigInt -> decimal string with `dec` decimals, trimmed to `maxFrac` (floor). */
  function units(v, dec, maxFrac) {
    v = BigInt(v); var neg = v < 0n; if (neg) v = -v;
    var s = v.toString().padStart(dec + 1, '0');
    var i = s.slice(0, s.length - dec), f = s.slice(s.length - dec);
    if (maxFrac != null) f = f.slice(0, maxFrac);
    i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '−' : '') + i + (f.length ? '.' + f : '');
  }
  /** Adaptive precision for small token amounts: keep ~5 significant digits. */
  function amt(v, dec, sym) {
    v = BigInt(v);
    if (v === 0n) return '0 ' + sym;
    var abs = v < 0n ? -v : v, one = 10n ** BigInt(dec), frac;
    if (abs >= one * 1000n) frac = 0; else if (abs >= one) frac = 4;
    else { var digits = abs.toString().length; frac = Math.min(dec, dec - digits + 5); }
    var s = units(v, dec, frac);
    if (abs > 0n && /^−?0(\.0*)?$/.test(s)) s = '<' + units(1n, dec, dec);
    return s + ' ' + sym;
  }
  function short(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '--'; }

  window.RR = window.RR || {};
  window.RR.chain = {
    SEL: SEL, TOPICS: TOPICS,
    encUint: encUint, encAddr: encAddr, word: word, u: u, boolAt: boolAt, bytes32At: bytes32At, addrAt: addrAt, isAddress: isAddress,
    encVerifyAllocation: encVerifyAllocation, encClaim: encClaim, encBalanceOf: encBalanceOf, encEpochs: encEpochs, encClaimedBy: encClaimedBy,
    ethCall: ethCall, hexN: hexN, getLogs: getLogs,
    rpc: rpc, rpcSettled: rpcSettled, one: one,
    units: units, amt: amt, short: short
  };
})();

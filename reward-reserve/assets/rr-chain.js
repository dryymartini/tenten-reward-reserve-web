/* ============================================================================
   rr-chain.js — minimal read-only JSON-RPC client + ABI helpers
   No wallet, no signer, no eth_sendTransaction / eth_sendRawTransaction /
   eth_sign / personal_sign anywhere. The only RPC methods used are:
     eth_call, eth_blockNumber, eth_getBlockByNumber, eth_getLogs, eth_getCode
   ABI: selectors/topics computed with keccak256 from the verified
   TenRewardReserveV1 source (Blockscout, compiler v0.8.26).
   ========================================================================== */
(function () {
  'use strict';
  var C = window.RR_CONFIG;

  // ---- read-only method allow-list (defence in depth) ---------------------
  var ALLOWED = { eth_call: 1, eth_blockNumber: 1, eth_getBlockByNumber: 1, eth_getLogs: 1, eth_getCode: 1 };

  // ---- selectors -----------------------------------------------------------
  var SEL = {
    // TenRewardReserveV1
    mode: '0x295a5212', paused: '0x5c975abb', latestEpochId: '0x73e2144f', lastEpochTime: '0x89c614b8',
    lastModeTransitionAt: '0x5092cf8a', principalValue: '0x7da68d34', principalValueAtCheckpoint: '0x022cf1ac',
    rewardPotValue: '0x70779b15', outstandingLiabilityValue: '0x7c3d5f47', isSolvent: '0x5ce23950',
    annualizedOrganicRewardRateWad: '0x01f5f785', operator: '0x570ca735',
    TEN: '0xee2f3a05', NET: '0x6f27c34a', sNET: '0xf1e08938', staking: '0x4cf088d9', priceReader: '0x49b5fdb4',
    MIN_DWELL: '0x3e33f998', ORGANIC_RATE_THRESHOLD_BPS: '0x6b056268',
    epochs: '0xc6b61e4c', claimedBy: '0xfef08fa4', verifyAllocation: '0x1848f6ec',
    dailyOrganicNetValue: '0x484830b4', dailyTenExposure: '0x6fcab424',
    claim: '0xae0b51df', // claim(uint256,uint256,bytes32[]): shown for Blockscout identification and
                         // dry-run with eth_call from the holder before params are shown; never sent
    // ERC-20 / sNET / Spot Reader
    balanceOf: '0x70a08231', decimals: '0x313ce567', balanceForGons: '0x7965d56d', getSpotPriceWad: '0x55a4ef5f'
  };

  var TOPIC = {
    AllocationClaimed:     '0x07f17ee45faba38696b281efb713bf15a97fafc94b29cf844d7a2ec53406e835',
    EpochCancelled:        '0x1f2eec8fd8839837f70ee3f106041605b55b5f57a58b53f73e7b10648788b64c',
    EpochPublished:        '0x879f4abc98a19d08349257fb8a9000c893c833a6413d516a9d06d0d19fd7ac57',
    ModeChanged:           '0x0a0c4d30be85e09af96238af54f74299f5d806685d046f316401cfe39169bc8f',
    NetProcessed:          '0x0accc2a95ca9ea7149fcf6511254cfc03f8b30b887e605e11da3d35cb5f6a733',
    OrganicInflowReported: '0xe0a495b0d26ea826dc6f76a15852fa61afc9827afe5c320de79d23972ff1f049',
    PausedSet:             '0x40db37ff5c0bdc2c427fbb2078c8f24afea940abac0e3c23bb4ea3bf2da2b212',
    PrincipalFunded:       '0x383d1a5e22a4e150ccf658d9728c2f801e02667e7cce8a4b2edac14e6a8f91b5',
    TenDonated:            '0xcbfbb755075344f891e9a5c1e7b1b015ff55862323fe4ee8437d8fc52febf42f',
    OperatorAccepted:      '0x31970484890c1f550e19f388d0f74a6aaa1b0d8f8a4884844db19daa45449265'
  };

  // ---- ABI encode/decode ---------------------------------------------------
  function strip(h) { return h.slice(0, 2) === '0x' ? h.slice(2) : h; }
  function pad64(h) { h = strip(h).toLowerCase(); if (h.length > 64) throw new Error('word overflow'); return '0'.repeat(64 - h.length) + h; }
  function encUint(n) { n = BigInt(n); if (n < 0n) throw new Error('negative'); return pad64(n.toString(16)); }
  function encAddr(a) { if (!isAddress(a)) throw new Error('bad address'); return pad64(a); }
  function encBytes32(b) { if (!/^0x[0-9a-fA-F]{64}$/.test(b)) throw new Error('bad bytes32'); return strip(b).toLowerCase(); }
  function word(data, i) { return '0x' + strip(data).slice(64 * i, 64 * (i + 1)); }
  function u(data, i) { var w = word(data, i); return w.length > 2 ? BigInt(w) : 0n; }
  function addrAt(data, i) { return '0x' + strip(data).slice(64 * i + 24, 64 * (i + 1)); }
  function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }

  function callData(sel, args) { return sel + (args || []).join(''); }
  // verifyAllocation(uint256,address,uint256,bytes32[])
  function encVerifyAllocation(epochId, holder, amount, proof) {
    var head = encUint(epochId) + encAddr(holder) + encUint(amount) + encUint(128);
    var tail = encUint(proof.length) + proof.map(encBytes32).join('');
    return SEL.verifyAllocation + head + tail;
  }

  // claim(uint256,uint256,bytes32[]) — encoded only for the read-only eth_call simulation
  function encClaim(epochId, amount, proof) {
    var head = encUint(epochId) + encUint(amount) + encUint(96);
    var tail = encUint(proof.length) + proof.map(encBytes32).join('');
    return SEL.claim + head + tail;
  }

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

  // ---- logs: one range first, chunked fallback, never partial totals -------
  function getAllLogs(address, topics, fromBlock, toBlock) {
    var filt = { address: address, fromBlock: hexN(fromBlock), toBlock: hexN(toBlock) };
    if (topics) filt.topics = topics;
    return one(['eth_getLogs', [filt]]).then(function (r) { return { logs: r || [], complete: true }; })
      .catch(function () {
        var chunks = [];
        for (var f = fromBlock; f <= toBlock; f += C.logChunk) chunks.push([f, Math.min(toBlock, f + C.logChunk - 1)]);
        if (chunks.length > C.maxLogChunks) throw new Error('log range too large for the public RPC (' + chunks.length + ' windows)');
        return rpc(chunks.map(function (c) {
          var x = { address: address, fromBlock: hexN(c[0]), toBlock: hexN(c[1]) }; if (topics) x.topics = topics; return ['eth_getLogs', [x]];
        })).then(function (rs) { var all = []; rs.forEach(function (x) { all = all.concat(x || []); }); return { logs: all, complete: true }; });
      });
  }

  var blockTs = {};
  function timestamps(blocks) {
    var need = blocks.filter(function (b) { return blockTs[b] == null; });
    if (!need.length) return Promise.resolve(blockTs);
    return rpc(need.map(function (b) { return ['eth_getBlockByNumber', [hexN(b), false]]; }))
      .then(function (r) { r.forEach(function (bl, i) { if (bl) blockTs[need[i]] = Number(BigInt(bl.timestamp)); }); return blockTs; })
      .catch(function () { return blockTs; });
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
    SEL: SEL, TOPIC: TOPIC,
    encUint: encUint, encAddr: encAddr, word: word, u: u, addrAt: addrAt, isAddress: isAddress,
    callData: callData, encVerifyAllocation: encVerifyAllocation, encClaim: encClaim, ethCall: ethCall, hexN: hexN,
    rpc: rpc, rpcSettled: rpcSettled, one: one, getAllLogs: getAllLogs, timestamps: timestamps, blockTs: blockTs,
    units: units, amt: amt, short: short
  };
})();

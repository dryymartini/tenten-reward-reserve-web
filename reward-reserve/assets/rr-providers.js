/* ============================================================================
   rr-providers.js — epoch JSON (Indexer output) fetch + validation
   ---------------------------------------------------------------------------
   The Indexer (built elsewhere, not part of this site) publishes one JSON
   file per epoch: epochs/<id>.json, schema per Matteo's 2026-09-28 spec. This
   module fetches, caches and validates those files, and never trusts them
   blindly for the claim itself — every allocation shown as claimable is
   re-checked against the on-chain verifyAllocation() before the claim button
   is enabled. The JSON is convenience display data; the contract is the
   source of truth.

   RR_CONFIG.epochsBaseUrl is not set yet (Indexer has no public host as of
   2026-09-28) — every call resolves to an explicit 'unavailable' status
   rather than fabricating epoch data.
   ========================================================================== */
(function () {
  'use strict';
  var CH = window.RR.chain;
  var C = window.RR_CONFIG;

  var B32 = /^0x[0-9a-fA-F]{64}$/, UINT = /^[0-9]+$/;
  var cache = {}; // epochId -> Promise<{status,...}>

  function validEpoch(d, expectId) {
    var e = [];
    if (!d || typeof d !== 'object') return ['not an object'];
    if (Number(d.epochId) !== Number(expectId)) e.push('epochId mismatch');
    if (C.chainId && Number(d.chainId) !== C.chainId) e.push('chainId mismatch');
    if (String(d.reserve || '').toLowerCase() !== C.addresses.rewardReserve.toLowerCase()) e.push('reserve address mismatch');
    if (!d.budget || !UINT.test(String(d.budget.committedTotal))) e.push('budget.committedTotal');
    if (!d.tree || !B32.test(d.tree.root)) e.push('tree.root');
    if (!d.holders || typeof d.holders !== 'object') e.push('holders');
    else {
      var sum = 0n, bad = false;
      Object.keys(d.holders).forEach(function (addr) {
        var h = d.holders[addr];
        if (!UINT.test(String(h.allocation)) || !UINT.test(String(h.eligibleBalance)) || !Array.isArray(h.proof) || !h.proof.every(function (p) { return B32.test(p); })) bad = true;
        else sum += BigInt(h.allocation);
      });
      if (bad) e.push('malformed holder entry');
      else if (d.budget && sum !== BigInt(d.budget.committedTotal)) e.push('sum(allocations) != budget.committedTotal');
    }
    return e;
  }

  /** Fetch + validate epochs/<id>.json. Cached. Never throws. */
  function getEpoch(epochId) {
    if (cache[epochId]) return cache[epochId];
    var url = C.epochFile(epochId);
    if (!url) return (cache[epochId] = Promise.resolve({ status: 'unavailable', reason: 'epoch data source is not configured yet (RR_CONFIG.epochsBaseUrl)' }));
    var ctl = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(C.requestTimeoutMs) : undefined;
    return (cache[epochId] = fetch(url, { signal: ctl, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var bad = validEpoch(d, epochId);
        if (bad.length) return { status: 'error', reason: 'epoch ' + epochId + ' failed validation: ' + bad.slice(0, 4).join(', ') };
        return { status: 'ok', data: d };
      }, function (e) { return { status: 'unavailable', reason: 'epoch ' + epochId + ' fetch failed: ' + (e && e.message || e) }; }));
  }

  /** Case-insensitive lookup of an address in an epoch's holders/ineligible maps. */
  function findAddr(map, address) {
    if (!map) return null;
    var a = address.toLowerCase();
    var key = Object.keys(map).filter(function (k) { return k.toLowerCase() === a; })[0];
    return key ? map[key] : null;
  }

  /**
   * Re-checks one holder's allocation for an epoch against the chain before
   * it is ever shown as claimable: claimedBy() first (already paid, nothing
   * to verify), then verifyAllocation() (proof actually matches the root the
   * contract has on file — the JSON alone is never trusted for this).
   */
  function verifyClaimable(epochId, address, entry) {
    var R = C.addresses.rewardReserve;
    var calls = [
      CH.ethCall(R, CH.encClaimedBy(epochId, address)),
      CH.ethCall(R, CH.encVerifyAllocation(epochId, address, entry.allocation, entry.proof))
    ];
    return CH.rpc(calls).then(function (r) {
      var claimed = CH.boolAt(r[0], 0), verified = CH.boolAt(r[1], 0);
      if (claimed) return { state: 'CLAIMED' };
      if (!verified) return { state: 'FAILED', reason: 'the contract does not accept this proof right now' };
      return { state: 'READY', amount: BigInt(entry.allocation), proof: entry.proof };
    }, function (e) { return { state: 'UNAVAILABLE', reason: 'RPC could not verify the proof: ' + (e && e.message || e) }; });
  }

  window.RR.providers = { getEpoch: getEpoch, findAddr: findAddr, verifyClaimable: verifyClaimable, _validate: validEpoch };
})();

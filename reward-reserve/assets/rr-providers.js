/* ============================================================================
   rr-providers.js — boundary for OFF-CHAIN production data
   ---------------------------------------------------------------------------
   The Reward Reserve page reads everything it can from the chain. Three data
   classes cannot come from the chain and are NOT available to this build:

     1. Indexer V1        purchase lots, FIFO age, eligibility, loyalty,
                          weighted entitlement, organic-rate history
     2. Epoch artifacts   the published Merkle allocation list per epoch
                          (holder, amount, proof) bound to root/dataRef
     3. dataRef binding   how the on-chain bytes32 dataRef commits to the
                          artifact content (e.g. CID digest, keccak of bytes)

   This file defines the normalized shapes the page accepts, validates every
   payload before use, and implements the claim reconciliation that must pass
   before ANY claim parameter is displayed. Nothing here fabricates data: with
   no adapter configured every call resolves to { status: 'unavailable' }.

   To connect production data, set RR_CONFIG.offchain.indexer / .artifacts to
   adapter objects implementing the interfaces below (see INTEGRATION.md).
   ========================================================================== */
(function () {
  'use strict';
  var CH = window.RR.chain;
  var C = window.RR_CONFIG;

  var B32 = /^0x[0-9a-fA-F]{64}$/, UINT = /^[0-9]+$/;

  /* --------------------------------------------------------------------------
   IndexerProvider (adapter contract)
     getHolder(address) -> Promise<HolderReport>
       HolderReport = {
         schema: 'rr-holder/1',
         asOf: { block: number, timestamp: number },     // indexer head used
         address: '0x…',
         excluded: boolean, exclusionReason: string|null, // frozen exclusion set
         tenBalance: '<uint, TEN wei>',
         eligibleTen: '<uint, TEN wei>',                  // lots aged >= 30 full days
         weightedTen: '<uint, TEN wei × multiplier>',     // Σ remaining × multiplier
         lots: [{ id: string, acquiredAt: number, acquiredBlock: number,
                  remaining: '<uint, TEN wei>', ageDays: number,
                  multiplierBps: number,                  // 0 if < 30 days, 10000..20000
                  eligible: boolean }]
       }
     getRateHistory() -> Promise<RateHistory>
       RateHistory = { schema: 'rr-rate/1', asOf: {block, timestamp},
                       points: [{ t: number, rateWad: '<uint>' }] }
   ------------------------------------------------------------------------ */
  function validHolder(h, address) {
    var e = [];
    if (!h || h.schema !== 'rr-holder/1') e.push('schema');
    else {
      if (!h.asOf || !(h.asOf.block > 0) || !(h.asOf.timestamp > 0)) e.push('asOf');
      if (String(h.address).toLowerCase() !== address.toLowerCase()) e.push('address');
      ['tenBalance', 'eligibleTen', 'weightedTen'].forEach(function (k) { if (!UINT.test(String(h[k]))) e.push(k); });
      if (!Array.isArray(h.lots)) e.push('lots');
      else h.lots.forEach(function (l, i) {
        if (!UINT.test(String(l.remaining)) || !(l.ageDays >= 0) || !(l.multiplierBps === 0 || (l.multiplierBps >= 10000 && l.multiplierBps <= 20000))) e.push('lot ' + i);
      });
    }
    return e;
  }
  function validRate(r) {
    return !!(r && r.schema === 'rr-rate/1' && Array.isArray(r.points) && r.asOf && r.points.every(function (p) { return p.t > 0 && UINT.test(String(p.rateWad)); }));
  }

  /* --------------------------------------------------------------------------
   ArtifactProvider (adapter contract)
     getEpochArtifact(epochId) -> Promise<EpochArtifact|null>
       EpochArtifact = {
         schema: 'rr-epoch/1',
         epochId: number,
         root: '0x…32 bytes', committedTotal: '<uint, face value>',
         dataRef: '0x…32 bytes',
         allocations: [{ holder: '0x…', amount: '<uint>', proof: ['0x…32 bytes', …] }]  // FULL list
       }
     verifyDataRef(artifact, onchainDataRef) -> Promise<'match'|'mismatch'|'unknown'>
       Must prove the artifact CONTENT is the one committed by the on-chain
       dataRef (not just compare the declared field). 'unknown' keeps the
       epoch in VERIFICATION PENDING.
     getHolderEpochs(address) -> Promise<number[]>   (optional)
       Epoch ids that contain the holder; lets the page avoid loading every
       artifact. Results are still fully reconciled per epoch.
   ------------------------------------------------------------------------ */
  function validArtifact(a) {
    var e = [];
    if (!a || a.schema !== 'rr-epoch/1') return ['schema'];
    if (!(a.epochId > 0)) e.push('epochId');
    if (!B32.test(a.root)) e.push('root');
    if (!B32.test(a.dataRef)) e.push('dataRef');
    if (!UINT.test(String(a.committedTotal))) e.push('committedTotal');
    if (!Array.isArray(a.allocations) || !a.allocations.length) e.push('allocations');
    else {
      var seen = {};
      a.allocations.forEach(function (x, i) {
        if (!CH.isAddress(x.holder)) e.push('holder ' + i);
        var k = String(x.holder).toLowerCase(); if (seen[k]) e.push('duplicate holder ' + i); seen[k] = 1;
        if (!UINT.test(String(x.amount)) || BigInt(x.amount) === 0n) e.push('amount ' + i);
        if (!Array.isArray(x.proof) || !x.proof.every(function (p) { return B32.test(p); })) e.push('proof ' + i);
      });
    }
    return e;
  }

  var UNAVAILABLE = function (why) { return { status: 'unavailable', reason: why }; };

  var indexer = {
    connected: function () { return !!(C.offchain && C.offchain.indexer); },
    getHolder: function (address) {
      var ad = C.offchain && C.offchain.indexer;
      if (!ad) return Promise.resolve(UNAVAILABLE('Indexer V1 is not connected to this page yet'));
      return Promise.resolve().then(function () { return ad.getHolder(address); }).then(function (h) {
        var bad = validHolder(h, address);
        if (bad.length) return { status: 'error', reason: 'indexer payload failed validation: ' + bad.slice(0, 4).join(', ') };
        return { status: 'ok', data: h };
      }, function (e) { return { status: 'error', reason: 'indexer request failed: ' + (e && e.message || e) }; });
    },
    getRateHistory: function () {
      var ad = C.offchain && C.offchain.indexer;
      if (!ad || !ad.getRateHistory) return Promise.resolve(UNAVAILABLE('rate history comes from the production Automation/Indexer, not connected yet'));
      return Promise.resolve().then(function () { return ad.getRateHistory(); }).then(function (r) {
        return validRate(r) ? { status: 'ok', data: r } : { status: 'error', reason: 'rate history failed validation' };
      }, function (e) { return { status: 'error', reason: 'rate history request failed: ' + (e && e.message || e) }; });
    }
  };

  /* --------------------------------------------------------------------------
   Claim reconciliation. Returns one of:
     READY        every check passed; params may be shown
     CLAIMED      claimedBy(epoch, holder) is true on chain
     NONE         verified artifact has no allocation for this holder
     UNAVAILABLE  artifact source missing / unreachable       (CLAIM DATA UNAVAILABLE)
     PENDING      artifact consistent but dataRef binding not proven (VERIFICATION PENDING)
     FAILED       artifact contradicts the chain or the contract rejects the proof
   Only READY carries `entry` (amount + proof).
   ------------------------------------------------------------------------ */
  function reconcileEpoch(epochId, holder, onchain) {
    var R = CH.rewardReserve || C.addresses.rewardReserve;
    var ad = C.offchain && C.offchain.artifacts;
    var out = { epochId: epochId, checks: [], state: 'UNAVAILABLE', reasons: [] };
    function ck(label, ok) { out.checks.push({ label: label, ok: ok }); return ok; }

    if (!onchain || !onchain.root || /^0x0+$/.test(onchain.root)) { out.state = 'FAILED'; out.reasons.push('epoch not found on chain'); return Promise.resolve(out); }
    if (!ad) { out.reasons.push('epoch artifact publication is not connected to this page yet'); return Promise.resolve(out); }

    return Promise.resolve().then(function () { return ad.getEpochArtifact(epochId); }).then(function (art) {
      if (!art) { out.reasons.push('no artifact published for epoch ' + epochId); return out; }
      var bad = validArtifact(art);
      if (bad.length) { out.state = 'FAILED'; out.reasons.push('artifact malformed: ' + bad.slice(0, 4).join(', ')); return out; }
      var ok = true;
      ok = ck('epoch id', Number(art.epochId) === Number(epochId)) && ok;
      ok = ck('root = on-chain root', art.root.toLowerCase() === onchain.root.toLowerCase()) && ok;
      ok = ck('committed total = on-chain', BigInt(art.committedTotal) === onchain.committedTotal) && ok;
      var sum = art.allocations.reduce(function (s, x) { return s + BigInt(x.amount); }, 0n);
      ok = ck('Σ allocations = committed total', sum === BigInt(art.committedTotal)) && ok;
      ok = ck('dataRef = on-chain dataRef', art.dataRef.toLowerCase() === onchain.dataRef.toLowerCase()) && ok;
      if (!ok) { out.state = 'FAILED'; out.reasons.push('artifact does not reconcile with the on-chain epoch'); return out; }

      return Promise.resolve().then(function () { return ad.verifyDataRef ? ad.verifyDataRef(art, onchain.dataRef) : 'unknown'; })
        .catch(function () { return 'unknown'; })
        .then(function (bind) {
          if (bind === 'mismatch') { ck('content bound to dataRef', false); out.state = 'FAILED'; out.reasons.push('artifact content does not match the on-chain dataRef'); return out; }
          if (bind !== 'match') { ck('content bound to dataRef', null); out.state = 'PENDING'; out.reasons.push('artifact content binding to dataRef not proven yet'); return out; }
          ck('content bound to dataRef', true);

          var h = holder.toLowerCase();
          var entry = art.allocations.filter(function (x) { return x.holder.toLowerCase() === h; })[0];
          if (!entry) { out.state = 'NONE'; return out; }

          var calls = [
            CH.ethCall(R, CH.callData(CH.SEL.claimedBy, [CH.encUint(epochId), CH.encAddr(holder)])),
            ['eth_call', [{ to: R, data: CH.encVerifyAllocation(epochId, holder, entry.amount, entry.proof) }, 'latest']],
            CH.ethCall(C.addresses.snet, CH.callData(CH.SEL.balanceForGons, [CH.encUint(BigInt(entry.amount) * onchain.gonsPerFragmentAtPublish)]))
          ];
          return CH.rpc(calls).then(function (r) {
            if (BigInt(r[0]) === 1n) { out.state = 'CLAIMED'; out.amount = BigInt(entry.amount); return out; }
            if (!ck('proof accepted by verifyAllocation()', BigInt(r[1]) === 1n)) { out.state = 'FAILED'; out.reasons.push('the contract rejects this proof'); return out; }
            // Last gate: dry-run the exact claim() the holder will send, as an eth_call from their
            // address. Read-only simulation (nothing is signed or broadcast). Any revert — cancelled
            // epoch, already claimed, any contract-side condition — keeps the parameters hidden.
            return CH.one(['eth_call', [{ from: holder, to: R, data: CH.encClaim(epochId, entry.amount, entry.proof) }, 'latest']]).then(function () {
              ck('claim() simulation succeeds for this address', true);
              out.state = 'READY';
              out.entry = { amount: String(BigInt(entry.amount)), proof: entry.proof.map(function (p) { return p.toLowerCase(); }) };
              out.payoutNow = BigInt(r[2]);
              return out;
            }, function (e) {
              if (e && e.rpc) { ck('claim() simulation succeeds for this address', false); out.state = 'FAILED'; out.reasons.push('the contract would reject this claim right now (' + (e.rpc.message || 'reverted') + ')'); }
              else { out.state = 'UNAVAILABLE'; out.reasons.push('RPC could not simulate the claim: ' + e.message); }
              return out;
            });
          }, function (e) { out.state = 'UNAVAILABLE'; out.reasons.push('RPC could not verify the proof: ' + e.message); return out; });
        });
    }, function (e) { out.reasons.push('artifact request failed: ' + (e && e.message || e)); return out; });
  }

  function holderEpochs(address, latest) {
    var ad = C.offchain && C.offchain.artifacts;
    var all = []; for (var i = latest; i >= 1; i--) all.push(i);
    if (!ad || !ad.getHolderEpochs) return Promise.resolve(all);
    return Promise.resolve().then(function () { return ad.getHolderEpochs(address); })
      .then(function (ids) { return Array.isArray(ids) ? ids.filter(function (x) { return x >= 1 && x <= latest; }) : all; }, function () { return all; });
  }

  window.RR.providers = {
    indexer: indexer,
    artifactsConnected: function () { return !!(C.offchain && C.offchain.artifacts); },
    reconcileEpoch: reconcileEpoch,
    holderEpochs: holderEpochs,
    _validate: { holder: validHolder, artifact: validArtifact, rate: validRate }
  };
})();

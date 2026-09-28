/* ============================================================================
   rr-wallet.js — wallet connection and transaction signing (EIP-1193)
   The ONLY module in this site that ever calls eth_sendTransaction, and it
   only ever sends to the injected wallet provider (window.ethereum), never to
   the public RPC in rr-chain.js. No private key ever touches this site: every
   signature happens inside the user's own wallet (MetaMask or any EIP-1193
   wallet). This module never calls approve() on any token — the claim()
   function pays the caller directly and needs no allowance.
   ========================================================================== */
(function () {
  'use strict';
  var C = window.RR_CONFIG;

  var state = { address: null, chainId: null, listeners: [] };

  function provider() { return window.ethereum || null; }
  function hasWallet() { return !!provider(); }

  function emit() { state.listeners.forEach(function (fn) { try { fn(snapshot()); } catch (e) { /* listener error, ignore */ } }); }
  function onChange(fn) { state.listeners.push(fn); }
  function snapshot() { return { address: state.address, chainId: state.chainId, wrongChain: state.chainId != null && state.chainId !== C.chainIdHex }; }

  function bindProviderEvents() {
    var p = provider(); if (!p || p.__rrBound) return; p.__rrBound = true;
    if (p.on) {
      p.on('accountsChanged', function (accs) { state.address = accs && accs[0] ? accs[0] : null; emit(); });
      p.on('chainChanged', function (cid) { state.chainId = cid; emit(); });
      p.on('disconnect', function () { state.address = null; state.chainId = null; emit(); });
    }
  }

  /** Connect (prompts the wallet's own account-selection UI). Never asks for a key. */
  function connect() {
    var p = provider();
    if (!p) return Promise.reject(new Error('No wallet found. Install MetaMask or another EIP-1193 wallet to connect.'));
    bindProviderEvents();
    return p.request({ method: 'eth_requestAccounts' }).then(function (accs) {
      state.address = accs && accs[0] ? accs[0] : null;
      return p.request({ method: 'eth_chainId' });
    }).then(function (cid) {
      state.chainId = cid; emit();
      return ensureChain();
    }).then(function () { return snapshot(); });
  }

  function disconnect() { state.address = null; emit(); }

  /** Switches (or adds) the wallet to the configured Robinhood Chain network. Never silently sends funds. */
  function ensureChain() {
    var p = provider(); if (!p) return Promise.resolve();
    if (state.chainId === C.chainIdHex) return Promise.resolve();
    return p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: C.chainIdHex }] })
      .catch(function (err) {
        if (err && (err.code === 4902 || /Unrecognized chain/i.test(err.message || ''))) {
          return p.request({ method: 'wallet_addEthereumChain', params: [{
            chainId: C.chainIdHex, chainName: C.chainName,
            nativeCurrency: C.nativeCurrency, rpcUrls: [C.rpcUrl],
            blockExplorerUrls: C.explorer ? [C.explorer] : []
          }] });
        }
        throw err;
      })
      .then(function () { return p.request({ method: 'eth_chainId' }); })
      .then(function (cid) { state.chainId = cid; emit(); });
  }

  /**
   * Sends claim(epochId, amount, proof) from the connected address. Caller is
   * expected to have already checked verifyAllocation() read-only. Resolves
   * with the transaction hash immediately (does not wait for the receipt —
   * callers poll rr-chain.one(['eth_getTransactionReceipt', ...]) themselves).
   */
  function sendClaim(epochId, amount, proof) {
    var p = provider();
    if (!p || !state.address) return Promise.reject(new Error('Connect a wallet first.'));
    if (state.chainId !== C.chainIdHex) return Promise.reject(new Error('Wrong network: switch to ' + C.chainName + ' first.'));
    var data = window.RR.chain.encClaim(epochId, amount, proof);
    return p.request({ method: 'eth_sendTransaction', params: [{ from: state.address, to: C.addresses.rewardReserve, data: data }] });
  }

  window.RR = window.RR || {};
  window.RR.wallet = { hasWallet: hasWallet, connect: connect, disconnect: disconnect, ensureChain: ensureChain, sendClaim: sendClaim, onChange: onChange, snapshot: snapshot };
})();

/* ============================================================================
   Reward Reserve V2 — configuration (Robinhood Chain TESTNET, fake funds)
   All contract addresses, the chain RPC/explorer and the epoch JSON data
   source live here so a future mainnet swap is a one-line change, never a
   rewrite. See Matteo's 2026-09-28 spec for the source of every address.
   ========================================================================== */
window.RR_CONFIG = Object.freeze({
  network: 'testnet',
  chainId: 46630,
  chainIdHex: '0xb626',
  chainName: 'Robinhood Chain Testnet',
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
  // Not yet confirmed whether the explorer has verified the contract; leave
  // requests to it best-effort (the page must still work if it 404s).
  explorer: 'https://robinhoodchain-testnet.blockscout.com',
  nativeCurrency: Object.freeze({ name: 'Robinhood Chain Testnet ETH', symbol: 'ETH', decimals: 18 }),

  addresses: Object.freeze({
    rewardReserve: '0x481a383663CF8fAAb689294E59877E9f58898Ed1',
    ten:           '0x6dFb394DbD23e6DF7b635E64a6eD1B98c629edC7',
    net:           '0x593f58861d62e72962D1cDDFD6173db6740e38e5',
    snet:          '0x138a749C3080E324c4F322c3C5FF1000721196D9',
    staking:       '0x33Ec38f9dC6d45dAbB4Ed1d9068cACDD4Abd3F3C' // not used by this site
  }),

  requestTimeoutMs: 9000,

  /* --------------------------------------------------------------------------
     Epoch data published by the off-chain Indexer (not part of this site).
     Not hosted anywhere public yet — set `epochsBaseUrl` to the real location
     once Matteo has it (e.g. an HTTPS URL serving epochs/<id>.json, or a path
     under this same site). Left as a clear placeholder until then: the page
     shows an explicit "epoch data source not configured" state rather than
     guessing or fabricating a URL.
     ------------------------------------------------------------------------ */
  epochsBaseUrl: null, // e.g. 'https://indexer.example.com/epochs' -> fetches `${epochsBaseUrl}/${id}.json`
  epochFile: function (id) { return this.epochsBaseUrl ? this.epochsBaseUrl.replace(/\/$/, '') + '/' + id + '.json' : null; }
});

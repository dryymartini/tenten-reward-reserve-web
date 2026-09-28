/* ============================================================================
   Reward Reserve V2 — configuration (Robinhood Chain MAINNET, real funds)
   All contract addresses, the chain RPC/explorer and the epoch JSON data
   source live here so a network swap is a one-line change, never a rewrite.
   Moved from testnet to mainnet 2026-09-28, per Matteo — network/addresses
   only, everything else (ABI, claim logic, Indexer validation) is unchanged.
   ========================================================================== */
window.RR_CONFIG = Object.freeze({
  network: 'mainnet',
  chainId: 4663,
  chainIdHex: '0x1237',
  chainName: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robin.etherscan.io',
  nativeCurrency: Object.freeze({ name: 'ETH', symbol: 'ETH', decimals: 18 }),

  addresses: Object.freeze({
    rewardReserve: '0xC05ddFbd4f9a46ae297b286D4D6998a0c0Ea27FE',
    ten:           '0xC4F021c73A5b6fFae6C43515f0a4BbF615B31c7b',
    net:           '0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf',
    snet:          '0xb773ec2C326B7f98a5a83fc098825492F020a4c7',
    staking:       '0xB078cc304A0B264C5F3680DC0488954ACcd02E87' // not used by this site
  }),

  requestTimeoutMs: 9000,

  /* --------------------------------------------------------------------------
     $ estimate sources (2026-09-28, per Matteo) — both on-chain, no external
     API. TEN/NET spot price from the existing TenNetSpotReader (reused as-is
     from V1); NET/USDG spot price from a standard Uniswap V2 pair's own
     reserves. sNET is priced the same as NET (1:1 via unstake()), no separate
     read. These are illiquid spot prices, shown as rough "≈ $" estimates only
     — never treated as precise, and never shown at all if either read fails.
     ------------------------------------------------------------------------ */
  prices: Object.freeze({
    tenNetSpotReader: '0x383a3da5f0df829e68893d1c5cff728657ed6510', // getSpotPriceWad() -> NET per TEN, 1e18 = 1.0
    netUsdgPool: '0x59F95461E68e0c77605299791E1449f175165B54',      // Uniswap V2 pair, getReserves()
    usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',            // pool token0, 6 decimals
    usdgDecimals: 6,
    netDecimals: 9 // pool token1 (NET) — order confirmed by Matteo, never inverted
  }),

  // Mainnet deploy block is not yet known (Matteo's 2026-09-28 mainnet config didn't
  // include one) — left unset rather than reusing the old testnet approximation, which
  // would be wrong here. Until this is filled in, the Growth chart's eth_getLogs will
  // fail cleanly (shows "could not read the event log") instead of scanning the wrong
  // range or fabricating a result.
  deployBlock: null,

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

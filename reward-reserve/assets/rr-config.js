/* ============================================================================
   Reward Reserve V1 — production configuration (read-only page)
   Addresses: TenTen Reward Reserve Website Spec (FINAL v2), section 3.
   Every address below is re-checked at runtime against the Reward Reserve's
   own immutables (TEN(), NET(), sNET(), staking(), priceReader()).
   ========================================================================== */
window.RR_CONFIG = Object.freeze({
  chainId: 4663,
  // Same public RPC and explorer the live /reserve/ page uses.
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',

  addresses: Object.freeze({
    rewardReserve: '0x313dfCB9E091D33482e75EEFa00E0156b42119b5',
    spotReader:    '0x383a3da5f0df829e68893d1C5Cff728657ed6510',
    ten:           '0xC4F021c73A5b6fFae6C43515f0a4BbF615B31c7b',
    net:           '0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf',
    snet:          '0xb773ec2C326B7f98a5a83fc098825492F020a4c7',
    staking:       '0xB078cc304A0B264C5F3680DC0488954ACcd02E87',
    operator:      '0x6ED716b1C351C355b736494704bD297Ec73e72F1'
  }),

  deployBlock: 73845148,          // Reward Reserve V1
  spotReaderDeployBlock: 73845057,

  pollMs: 60000,                  // same cadence as /reserve/
  requestTimeoutMs: 9000,
  staleAfterSec: 180,             // chain head older than this => STALE
  logChunk: 50000,                // fallback eth_getLogs window
  maxLogChunks: 40,               // beyond this the log is reported UNAVAILABLE, never partial totals

  // Known system addresses that never receive loyalty allocations (spec §7).
  // The authoritative exclusion set lives in Indexer V1; this list only lets the
  // page explain the obvious cases without the indexer.
  knownSystem: Object.freeze({
    '0x313dfcb9e091d33482e75eefa00e0156b42119b5': 'Reward Reserve V1 contract',
    '0x4fc94fd08ff44abde7452bb109f1c5ab937ed4e3': 'Permanent Reserve contract'
  }),

  /* --------------------------------------------------------------------------
     Off-chain production data. NOT CONNECTED in this build.
     These are filled in by the TenTen developer once the frozen Indexer V1 /
     Automation / epoch-artifact publication endpoints are live. See
     INTEGRATION.md → "Connecting production data". Leaving them null makes the
     page show explicit UNAVAILABLE / VERIFICATION PENDING states.
     ------------------------------------------------------------------------ */
  offchain: Object.freeze({
    indexer: null,     // adapter object implementing RR.providers.IndexerProvider
    artifacts: null    // adapter object implementing RR.providers.ArtifactProvider
  })
});

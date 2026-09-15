import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters, getAddress } from 'viem';

const TOKEN = '0x33a40e776534F1896E8f3E4592D5Baa7C7B21E18';
const NUMERAIRE = '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa';
const EXPECTED = '0xf6737ba471e0f185f61ca620e2b043fc6d3df1c5fb0a42ba24713b4669703a29';
const FEE = 8388608;
const TICK_SPACING = 8;
const HOOKS = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';

const a = getAddress(TOKEN);
const b = getAddress(NUMERAIRE);
const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];

const poolId = keccak256(
  encodeAbiParameters(
    parseAbiParameters('address, address, uint24, int24, address'),
    [currency0, currency1, FEE, TICK_SPACING, getAddress(HOOKS)]
  )
);

const match = poolId.toLowerCase() === EXPECTED.toLowerCase();
console.log(JSON.stringify({
  currency0,
  currency1,
  fee: FEE,
  tickSpacing: TICK_SPACING,
  hooks: getAddress(HOOKS),
  computedPoolId: poolId,
  expectedPoolId: EXPECTED,
  match,
}, null, 2));

const AIRLOCK = '0x77EbfBAE15AD200758E9E2E61597c0B07d731254'; // common Doppler/Airlock; may override via env
const RPC = 'https://rpc.mainnet.chain.robinhood.com';

async function tryAirlock() {
  const client = createPublicClient({ transport: http(RPC) });
  const abi = [{
    type: 'function',
    name: 'getAssetData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'numeraire', type: 'address' },
      { name: 'timelock', type: 'address' },
      { name: 'governance', type: 'address' },
      { name: 'liquidityMigrator', type: 'address' },
      { name: 'poolInitializer', type: 'address' },
      { name: 'pool', type: 'address' },
      { name: 'migrationPool', type: 'address' },
      { name: 'numTokensToSell', type: 'uint256' },
      { name: 'totalSupply', type: 'uint256' },
      { name: 'integrator', type: 'address' },
    ],
  }];

  // Try a few known Airlock addresses if needed
  const candidates = [
    process.env.AIRLOCK,
    '0x77EbfBAE15AD200758E9E2E61597c0B07d731254',
    '0x660eAaEdEBc968f8f3697944a266Daa2c3d034c4',
  ].filter(Boolean);

  for (const addr of candidates) {
    try {
      const data = await client.readContract({
        address: getAddress(addr),
        abi,
        functionName: 'getAssetData',
        args: [getAddress(TOKEN)],
      });
      console.log(JSON.stringify({ airlock: addr, getAssetData: data }, null, 2));
      return;
    } catch (e) {
      console.log(JSON.stringify({ airlock: addr, error: String(e?.shortMessage || e?.message || e) }));
    }
  }
}

await tryAirlock();

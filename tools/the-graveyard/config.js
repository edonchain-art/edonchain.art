// Site configuration. After deploying GraveyardRaffle on Base, put its address in RAFFLE.
// For local testing, override with query params: ?rpc=http://127.0.0.1:8546&raffle=0x...
export const CONFIG = {
  chainId: 8453,
  chainName: "Base",
  rpc: "https://mainnet.base.org",
  ethRpc: "https://ethereum-rpc.publicnode.com", // Ethereum mainnet, for ENS names only
  explorer: "https://basescan.org",
  RAFFLE_V3: "0xE6299d1Ca0c8eB2F51d1582F5075896685fA5d5e", // GraveyardRaffleV3 on Base, deployed 2026-11-07 (minimum holding); new giveaways start here
  RAFFLE: "0x908CE1511e021Fb3Fd4eaE350E57BaD8114724b8", // GraveyardRaffleV2 on Base, deployed 2026-10-24
  RAFFLE_V1: "0x5DBfB702cD34bCaf41f442A8123477556FFc1bFc", // GraveyardRaffle v1 (giveaway #0), read-only history
  ZOMBIES: "0xa2d33352e3e2b4fe1b8af7387c375828197bcd9b",
  opensea: "https://opensea.io/item/base/0xa2d33352e3e2b4fe1b8af7387c375828197bcd9b/",
};

const q = new URLSearchParams(location.search);
if (q.get("network") === "base-sepolia") {
  Object.assign(CONFIG, {
    chainId: 84532,
    chainName: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    RAFFLE: "",
    RAFFLE_V1: "",
    RAFFLE_V3: "",
    ZOMBIES: "",
    testnet: true,
  });
}
if (q.get("zombies")) CONFIG.ZOMBIES = q.get("zombies");
if (q.get("rpc")) CONFIG.rpc = q.get("rpc");
if (q.get("raffle")) CONFIG.RAFFLE = q.get("raffle");
if (q.get("raffle_v1")) CONFIG.RAFFLE_V1 = q.get("raffle_v1");
if (q.get("raffle_v3")) CONFIG.RAFFLE_V3 = q.get("raffle_v3");

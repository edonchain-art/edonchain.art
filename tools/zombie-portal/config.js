// The Zombie Portal configuration. Live on Base since 2026-11-15.
// Simulation on a local Base fork (no real wallet, impersonated accounts):
//   ?sim=1&rpc=http://127.0.0.1:8546&portal=0x...&renderer=0x...
export const CONFIG = {
  chainId: 8453,
  chainName: "Base",
  rpc: "https://mainnet.base.org",
  explorer: "https://basescan.org",
  ZOMBIES: "0xa2d33352e3e2b4fe1b8af7387c375828197bcd9b",
  PORTAL: "0x9a2774d4625016458002952a45a9535cc7cb3ebb", // ZombiePortal on Base, launched 2026-11-15 (verified)
  RENDERER: "0x4bb9d87664dda121d1094dfe400bb6f9284f70b8", // GlitchedZombieRenderer on Base (verified)
  ID_OFFSET: 1_000_000,
  ANIMATED: [88, 129, 159, 165, 248, 448, 521, 615, 622, 754, 915],
  originalImage: (id) =>
    `https://gateway.irys.xyz/Hh07W0gEceibisGo59fo-M_dW8gu0wPmxXNmQIbYdoI/${id}.${CONFIG.ANIMATED.includes(id) ? "gif" : "png"}`,
  opensea: "https://opensea.io/item/base/0xa2d33352e3e2b4fe1b8af7387c375828197bcd9b/",
  sim: false,
};

// Overrides are for local testing ONLY. On the live site a link like ?portal=0x... could otherwise make a holder
// approve a scammer's contract for their Zombie, so they are ignored unless the page runs on this computer.
const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
if (LOCAL) {
  const q = new URLSearchParams(location.search);
  if (q.get("rpc")) CONFIG.rpc = q.get("rpc");
  if (q.get("portal")) CONFIG.PORTAL = q.get("portal");
  if (q.get("renderer")) CONFIG.RENDERER = q.get("renderer");
  if (q.get("sim") === "1") CONFIG.sim = true;
  // wallet test on a local Base fork with its own chain id (e.g. ?chain=31337): MetaMask adds it as a separate
  // network, so nothing signed there can be replayed on Base.
  if (q.get("chain")) {
    CONFIG.chainId = Number(q.get("chain"));
    CONFIG.chainName = "Base Fork (test)";
  }
}

// Display names for wallet addresses, shared by the edonchain.art tools:
// ENS primary name (Ethereum) first, else Basename (Base), else null (show the short address).
// Both are only used when they resolve back to the same address, so nobody can fake a name.
import { createPublicClient, http, parseAbi, namehash, getAddress, mainnet, base } from "./vendor/viem-2.21.54.js"; // self-hosted: MetaMask's phone browser can't load esm.sh

const eth = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });
const baseClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

const BASENAME_REVERSE = "0x0000000000D8e504002cC26E3Ec46D81971C1664"; // Basenames L2ReverseRegistrar on Base
const BASENAME_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD"; // Basenames L2Resolver on Base
const abi = parseAbi([
  "function nameForAddr(address) view returns (string)",
  "function name(bytes32) view returns (string)",
  "function addr(bytes32) view returns (address)",
]);
const cache = new Map();

async function basenameOf(addr) {
  const read = (address, functionName, args) => baseClient.readContract({ address, abi, functionName, args }).catch(() => "");
  let name = await read(BASENAME_REVERSE, "nameForAddr", [addr]);
  if (!name) name = await read(BASENAME_RESOLVER, "name", [namehash(`${addr.slice(2).toLowerCase()}.80002105.reverse`)]);
  if (!name) return null;
  const back = await read(BASENAME_RESOLVER, "addr", [namehash(name)]);
  return back && back.toLowerCase() === addr.toLowerCase() ? name : null;
}

/** ENS name, else Basename, else null. Cached per address; never throws. */
export function displayName(address) {
  const addr = getAddress(address);
  if (!cache.has(addr)) {
    cache.set(addr, (async () => {
      const ens = await eth.getEnsName({ address: addr }).catch(() => null); // verified forward + reverse by viem
      return ens || (await basenameOf(addr).catch(() => null));
    })());
  }
  return cache.get(addr);
}

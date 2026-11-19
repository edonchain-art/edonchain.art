import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  parseEther,
  formatEther,
  encodeFunctionData,
  decodeEventLog,
  getAddress,
  isAddress,
} from "../../assets/vendor/viem-2.21.54.js";
import { CONFIG } from "./config.js?v=11";
import { createWallet, walletErrorText } from "../../assets/wallet.js";
import { displayName } from "../../assets/names.js?v=2";
import { renderSVG, hexToBytes, EFFECTS, packMix, validMix } from "./glitch.js?v=11";

// ------------------------------------------------------------------ chain
const zombiesAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function getApproved(uint256) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
  "function tokenURI(uint256) view returns (string)",
  "function getManagers() view returns (address[])",
  "function setManagers(address[] managers, bool enabled)",
]);
const portalAbi = parseAbi([
  "function owner() view returns (address)",
  "function isOpen() view returns (bool)",
  "function deadline() view returns (uint64)",
  "function paused() view returns (bool)",
  "function canReopen() view returns (bool)",
  "function glitchPrice() view returns (uint256)",
  "function animatePrice() view returns (uint256)",
  "function reopenFee() view returns (uint256)",
  "function migratedCount() view returns (uint256)",
  "function reopenCount() view returns (uint256)",
  "function migrate(uint256 originalId, bytes art, bytes traits, bytes32[] proof, uint64 mix, uint32 seed, bool animate, uint8 speed) payable returns (uint256)",
  "function reopenAndMigrate(uint256 originalId, bytes art, bytes traits, bytes32[] proof, uint64 mix, uint32 seed, bool animate, uint8 speed) payable returns (uint256)",
  "function reopen(uint256 heldId) payable",
  "function migrateBatch((uint256 originalId, bytes art, bytes traits, bytes32[] proof, uint64 mix, uint32 seed, bool animate, uint8 speed)[] items) payable returns (uint256[])",
  "function setDeadline(uint64 newDeadline)",
  "function setPaused(bool p_)",
  "function setPrice(uint256 price)",
  "function setAnimatePrice(uint256 price)",
  "function setReopenFee(uint256 fee)",
  "function withdraw(address to)",
  "event Migrated(address indexed holder, uint256 indexed originalId, uint256 indexed newId, uint64 mix, uint32 seed, bool animate, uint8 speed)",
  "event Reopened(address indexed holder, uint256 indexed heldId, uint64 deadline)",
  "error NotOwner()", "error Closed()", "error Paused()", "error AlreadyOpen()", "error BadId()", "error NotHolder()", "error BadProof()",
  "error BadGlitch()", "error WrongPayment()", "error EmptyBatch()", "error Reentrant()", "error TransferFailed()",
]);
const rendererAbi = parseAbi([
  "struct Token { address art; uint16 originalId; uint64 mix; uint32 seed; bool animate; uint8 speed; }",
  "function previewSVG(bytes art, uint64 mix, uint32 seed, bool animate, uint8 speed) pure returns (string)",
  "function tokenInfo(uint256 tokenId) view returns (Token t, bytes art, bytes traits)",
]);

const chain = {
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc] } },
  blockExplorers: { default: { name: "Basescan", url: CONFIG.explorer } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
};
const pub = createPublicClient({ chain, transport: http(CONFIG.rpc, { timeout: 60_000 }) }); // big batches take a while to simulate
const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtDate = (s) => new Date(Number(s) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const svgUrl = (svg) => "data:image/svg+xml;base64," + btoa(svg);
const DEFAULT_DEADLINE = 1798779599; // 2026-12-31 23:59:59 ET
const fmtId = (n) => Number(n).toLocaleString("en-US");
const DESC = ["Chunks copied out of place", "Rows sorted by brightness", "Pixels dragged sideways", "Bands slip sideways",
  "Red and blue drift apart", "Cyan and magenta echo", "Lines lost to the void", "Bands with flipped colors"];
const PRESETS = {
  vhs: [0, 0, 0, 55, 35, 0, 25, 0],
  corrupt: [60, 0, 0, 20, 0, 0, 0, 35],
  sorted: [0, 70, 25, 0, 0, 0, 0, 0],
  ghost: [0, 0, 0, 30, 0, 60, 0, 0],
  chaos: [70, 50, 40, 70, 50, 40, 30, 40],
};
const ZERO = () => [0, 0, 0, 0, 0, 0, 0, 0];
const LAST_ID = 1117; // #1-#999 Zombies and #1000-#1117 artifacts (villains, heroes, punks, ...)
/** Names and original images of the artifacts #1000-#1117 (data/artifacts.json, from their original metadata). */
let ARTIFACTS = {};
const nameOf = (id) => (id >= 1000 && ARTIFACTS[id] ? ARTIFACTS[id].name : `Zombie ${id}`);
const imageOf = (id) => (id >= 1000 ? ARTIFACTS[id]?.image || "" : CONFIG.originalImage(id));

// ------------------------------------------------------------------ state
const S = {
  account: null,
  owner: null,
  status: null, // { open, canReopen, paused, deadline, price, reopenFee, count }
  tokens: [], // [{ id, kind: "eligible" | "onchain" | "portaled" }]
  sel: null, // selected original id
  data: null, // { art, traits, proof, frames }
  choice: { levels: ZERO(), seed: 0, animate: false, speed: 4 },
  seedHistory: [],
  svg: "",
};

// ------------------------------------------------------------------ accounts: real wallet or simulation
const wallet = createWallet({
  chain: { id: CONFIG.chainId, name: CONFIG.chainName, rpc: CONFIG.rpc, explorer: CONFIG.explorer },
  onChange: (addr) => setAccount(addr),
});

async function setAccount(addr) {
  S.account = addr ? getAddress(addr) : null;
  // Ask in the background whether the wallet can approve + enter in one confirmation; never hold up connecting.
  S.bundle = false;
  const asked = S.account;
  canBundle().then((ok) => { if (S.account === asked) { S.bundle = ok; updateButtons(); } });
  const btn = $("connect");
  btn.textContent = S.account ? short(S.account) : CONFIG.sim ? "Simulation" : "Connect Wallet";
  btn.classList.toggle("connected", !!S.account);
  btn.title = S.account || "";
  if (S.account) {
    const mine = S.account; // ENS, else Basename, instead of the address (if the wallet has one)
    displayName(mine).then((n) => { if (n && S.account === mine) btn.textContent = n; });
  }
  S.sel = null;
  $("lab").hidden = true;
  await Promise.all([loadTokens(), refreshAdmin()]);
}

async function send({ to, data, value = 0n }) {
  if (!S.account) throw new Error("Connect a wallet first.");
  if (CONFIG.sim) {
    await pub.request({ method: "anvil_impersonateAccount", params: [S.account] });
    const hash = await pub.request({
      method: "eth_sendTransaction",
      params: [{ from: S.account, to, data, value: "0x" + value.toString(16) }],
    });
    return hash;
  }
  await wallet.ensureChain();
  const wc = createWalletClient({ chain, transport: custom(wallet.provider) });
  return wc.sendTransaction({ account: S.account, to, data, value });
}

/** EIP-5792: can the connected wallet run several calls atomically, in one confirmation, on this chain?
 *  (MetaMask smart accounts / EIP-7702 wallets can.) Only "supported", never "ready": that would ask the holder to
 *  upgrade their account in the middle of a migration. */
async function canBundle() {
  if (CONFIG.sim || !S.account || !wallet.provider) return false;
  try {
    const hex = "0x" + CONFIG.chainId.toString(16);
    // Some wallets (MetaMask's phone app) never answer this; give up after 2.5 s and use the normal two steps.
    const caps = await Promise.race([
      wallet.provider.request({ method: "wallet_getCapabilities", params: [S.account, [hex]] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no answer")), 2500)),
    ]);
    const c = caps?.[hex] || caps?.[CONFIG.chainId] || caps?.[String(CONFIG.chainId)];
    return c?.atomic?.status === "supported" || c?.atomicBatch?.supported === true;
  } catch {
    return false;
  }
}

/** Send several calls as one atomic bundle (wallet_sendCalls) and wait for the receipt of the transaction. */
async function sendBundleAndWait(calls, out, label) {
  await wallet.ensureChain();
  out.className = "note";
  out.textContent = `${label}: confirm in your wallet (one confirmation)…`;
  const res = await wallet.provider.request({
    method: "wallet_sendCalls",
    params: [{
      version: "2.0.0",
      chainId: "0x" + CONFIG.chainId.toString(16),
      from: S.account,
      atomicRequired: true,
      calls: calls.map(({ to, data, value = 0n }) => ({ to, data, value: "0x" + value.toString(16) })),
    }],
  });
  const id = typeof res === "string" ? res : res?.id;
  out.textContent = `${label}: waiting for Base…`;
  for (let k = 0; k < 400; k++) {
    const st = await wallet.provider.request({ method: "wallet_getCallsStatus", params: [id] });
    const code = st?.status;
    if (code === 200 || code === "CONFIRMED") {
      const r = st.receipts?.[st.receipts.length - 1];
      const hash = r?.transactionHash;
      if (!hash) throw new Error(`${label}: the wallet didn't return a transaction.`);
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`${label} failed onchain (${short(hash)}).`);
      return rc;
    }
    if (typeof code === "number" && code >= 400) throw new Error(`${label} failed or was cancelled in the wallet. Nothing happened to your Zombie.`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: still waiting for the wallet. Check your wallet's activity, then reload.`);
}

async function sendAndWait(args, out, label) {
  // Simulate first so a revert shows a readable reason instead of a failed transaction.
  await pub.call({ account: S.account, to: args.to, data: args.data, value: args.value || 0n });
  out.className = "note";
  out.textContent = `${label}: confirm in your wallet…`;
  const hash = await send(args);
  out.textContent = `${label}: waiting for Base… ${short(hash)}`;
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${label} failed onchain (${short(hash)}).`);
  return rc;
}

function errText(e) {
  const name = e?.cause?.data?.errorName || e?.data?.errorName || e?.cause?.cause?.data?.errorName;
  const map = {
    Closed: "The portal is closed right now.",
    Paused: "The artist paused the portal. It can't be reopened right now.",
    AlreadyOpen: "Someone just reopened the portal, so you don't need to pay the reopen fee. Try again.",
    NotHolder: "This wallet doesn't hold that Zombie anymore.",
    BadProof: "The art or traits don't match the onchain fingerprint. Reload the page and try again.",
    BadGlitch: "That glitch mix isn't available for this Zombie.",
    WrongPayment: "The payment amount changed. Reload the page and try again.",
    BadId: "Only Zombies #1–#1117 can go through the portal.",
    NotOwner: "Only the portal owner can do that.",
  };
  if (name && map[name]) return map[name];
  const msg = String(e?.shortMessage || e?.message || e);
  if (/ERC721InsufficientApproval|insufficient approval/i.test(msg)) return "Approve the portal for this Zombie first.";
  if (/ONLY_OWNER_OR_MANAGER/.test(msg)) return "The portal is paused right now. Nothing happened to your Zombie.";
  return walletErrorText(e);
}

// ------------------------------------------------------------------ status
async function loadStatus() {
  if (!CONFIG.PORTAL) {
    $("heroStats").innerHTML = `<div class="stat"><div class="num">Soon</div><div class="lbl">Portal opening</div></div>`;
    return;
  }
  const c = (functionName) => ({ address: CONFIG.PORTAL, abi: portalAbi, functionName });
  const [open, canReopen, paused, deadline, price, animatePrice, reopenFee, count, owner] = await pub.multicall({
    contracts: [c("isOpen"), c("canReopen"), c("paused"), c("deadline"), c("glitchPrice"), c("animatePrice"), c("reopenFee"), c("migratedCount"), c("owner")],
    allowFailure: false,
  });
  S.status = { open, canReopen, paused, deadline, price, animatePrice, reopenFee, count };
  S.owner = getAddress(owner);
  // the countdown follows chain time (on the live site that is just the clock; in the simulation the fork's time)
  const block = await pub.getBlock();
  S.clockOffset = Number(block.timestamp) - Date.now() / 1000;
  const state = paused ? "Paused" : open ? "Open" : "Closed";
  const second = paused ? [`<span class="num-sm">Paused</span>`, "by the artist"]
    : open ? [`<span id="countdown" class="countdown"></span>`, `Closes ${fmtShortDate(deadline)}`]
    : [`<span class="num-sm">${formatEther(reopenFee)} ETH</span>`, "Any holder reopens 24h"];
  $("heroStats").innerHTML = [
    [state, "Portal"],
    second,
    [fmtId(count), "Through the portal"],
    ["0.000 ETH", "0.0006 ETH+ for glitch trait"],
  ].map(([n, l]) => `<div class="stat"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join("");
  tickCountdown();
  $("contracts").innerHTML =
    `Portal <a href="${CONFIG.explorer}/address/${CONFIG.PORTAL}" target="_blank" rel="noopener">${short(CONFIG.PORTAL)}</a> · ` +
    `Renderer <a href="${CONFIG.explorer}/address/${CONFIG.RENDERER}" target="_blank" rel="noopener">${short(CONFIG.RENDERER)}</a> · ` +
    `Zombies <a href="${CONFIG.explorer}/address/${CONFIG.ZOMBIES}" target="_blank" rel="noopener">${short(CONFIG.ZOMBIES)}</a>`;
  updateReopenCard();
  updateBatchBar();
}

/** 12/31/2026 */
const fmtShortDate = (s) => new Date(Number(s) * 1000).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

/** "47d 03:12:08" until the deadline; reloads the status when it reaches zero (the portal closes by itself). */
let countdownTimer = 0;
function tickCountdown() {
  clearTimeout(countdownTimer);
  const el = $("countdown");
  if (!el || !S.status) return;
  const now = Date.now() / 1000 + (S.clockOffset || 0);
  const left = Math.max(0, Math.floor(Number(S.status.deadline) - now));
  const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), sec = left % 60;
  const p2 = (v) => String(v).padStart(2, "0");
  el.textContent = `${d > 0 ? d + "d " : ""}${p2(h)}:${p2(m)}:${p2(sec)}`;
  if (left === 0) { loadStatus().then(updateButtons); return; }
  countdownTimer = setTimeout(tickCountdown, 1000);
}

/** "Reopen for 24 hours" card: shown to holders of a Zombie #1-#1117 while the portal is closed (not paused). */
function updateReopenCard() {
  const elig = S.tokens.find((t) => t.kind === "eligible");
  const show = !!(S.status?.canReopen && S.account && elig);
  const wasShown = $("reopenCard").dataset.shown === "1";
  $("reopenCard").hidden = !show;
  $("reopenCard").dataset.shown = wasShown && show ? "1" : "0";
  if (show) {
    if ($("reopenCard").dataset.shown !== "1") $("reopenOut").textContent = ""; // drop messages from an earlier window
    $("reopenText").textContent = `Pay ${formatEther(S.status.reopenFee)} ETH to reopen it for everyone for 24 hours (your Zombie ${elig.id} proves you're a holder). Or reopen and go through in one click from the Portal Lab.`;
    $("btnReopen").textContent = `Reopen for 24 hours (${formatEther(S.status.reopenFee)} ETH)`;
    $("reopenCard").dataset.shown = "1";
  }
}

async function reopenOnly() {
  const out = $("reopenOut");
  const elig = S.tokens.find((t) => t.kind === "eligible");
  if (!elig) return;
  try {
    await sendAndWait({
      to: CONFIG.PORTAL,
      value: S.status.reopenFee,
      data: encodeFunctionData({ abi: portalAbi, functionName: "reopen", args: [BigInt(elig.id)] }),
    }, out, "Reopen");
    await loadStatus();
    out.className = "note ok";
    out.textContent = `The portal is open for everyone until ${fmtDate(S.status.deadline)}.`;
    updateButtons();
  } catch (e) {
    console.error(e);
    await loadStatus();
    out.className = "note err";
    out.textContent = errText(e);
  }
}

// ------------------------------------------------------------------ your zombies
async function loadTokens() {
  const body = $("yoursBody");
  $("promo").hidden = !!S.account;
  if (!S.account) {
    $("yoursSub").textContent = CONFIG.sim ? "Pick a holder in the simulation bar above." : "Connect your wallet to see the Zombies you hold.";
    body.innerHTML = "";
    startPromo();
    return;
  }
  stopPromo();
  $("yoursSub").textContent = "Loading your Zombies from Base…";
  const n = await pub.readContract({ address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "balanceOf", args: [S.account] });
  const ids = n === 0n ? [] : await pub.multicall({
    contracts: Array.from({ length: Number(n) }, (_, i) => ({
      address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "tokenOfOwnerByIndex", args: [S.account, BigInt(i)],
    })),
    allowFailure: false,
  });
  S.tokens = ids.map(Number).sort((a, b) => a - b).map((id) => ({
    id,
    // 1-1117: offchain art, can go through. 1118+: already onchain. 1,000,001+: through the portal.
    kind: id >= 1 && id <= LAST_ID ? "eligible" : id > CONFIG.ID_OFFSET ? "portaled" : "onchain",
  }));
  const elig = S.tokens.filter((t) => t.kind === "eligible").length;
  $("yoursSub").textContent = S.tokens.length === 0
    ? "This wallet doesn't hold any Zombies."
    : `${S.tokens.length} Zombie${S.tokens.length > 1 ? "s" : ""} in this wallet · ${elig} can go through the portal.`;
  body.innerHTML = S.tokens.map(({ id, kind }) => {
    const name = kind === "portaled" ? nameOf(id - CONFIG.ID_OFFSET) : kind === "eligible" ? nameOf(id) : `Zombie ${id}`;
    const tag = kind === "eligible" ? `<span class="ztag">Ready for the portal</span>`
      : kind === "portaled" ? `<span class="ztag ok">Through the portal · #${fmtId(id)}</span>`
      : `<span class="ztag acc">Already fully onchain</span>`;
    const img = kind === "eligible" ? imageOf(id) : "";
    const cls = id === S.sel ? " sel" : id === S.fresh ? " fresh" : "";
    return `<button class="ztile${cls}" data-id="${id}" data-kind="${kind}" ${kind === "eligible" ? "" : "disabled"}>
      <img ${img ? `src="${img}"` : ""} alt="" loading="lazy"><div class="zbody"><div class="zname">${name}</div>${tag}</div></button>`;
  }).join("");
  body.querySelectorAll(".ztile").forEach((b) => b.addEventListener("click", () => {
    const id = Number(b.dataset.id);
    if (S.batch) togglePick(id);
    else select(id);
  }));
  body.classList.toggle("picking", !!S.batch);
  S.picked = new Set([...(S.picked || [])].filter((id) => S.tokens.some((t) => t.id === id && t.kind === "eligible")));
  S.picked.forEach((id) => body.querySelector(`.ztile[data-id="${id}"]`)?.classList.add("pick"));
  updateBatchBar();
  updateReopenCard();
  // portaled / already-onchain thumbnails come from the contracts
  for (const t of S.tokens.filter((t) => t.kind === "portaled")) fillPortaled(t.id);
  fillFromMetadata(S.tokens.filter((t) => t.kind === "onchain").map((t) => t.id));
}

// ------------------------------------------------------------------ batch: several Zombies through clean
// One setApprovalForAll, then migrateBatch in groups that fit a transaction (a clean Zombie is ~1.2M gas, a big
// animated artifact up to ~12M). Clean only: free, and every item goes through the same checks as migrate().
const GROUP_GAS = 11_500_000;
const GROUP_MAX = 10; // at most 10 Zombies per transaction: quick to confirm, easy to follow
const estGas = (artHex) => 500_000 + 230 * ((artHex.length - 2) / 2);

function updateBatchBar() {
  const elig = S.tokens.filter((t) => t.kind === "eligible");
  const show = !!(S.account && CONFIG.PORTAL && elig.length >= 2);
  $("batchBar").hidden = !show;
  if (!show) return;
  const n = (S.picked || new Set()).size;
  $("batchMode").textContent = S.batch ? "Done selecting" : "Select several";
  $("batchAll").hidden = !S.batch;
  $("batchAll").textContent = n === elig.length ? "Clear all" : `Select all ${elig.length}`;
  $("batchGo").hidden = !S.batch;
  $("batchAckRow").hidden = !S.batch;
  $("batchGo").textContent = n ? `Send ${n} through clean (free)` : "Send through clean";
  $("batchGo").disabled = !n || !$("batchAck").checked || !S.status?.open;
  if (S.batch && S.status && !S.status.open) {
    $("batchOut").className = "note warn";
    $("batchOut").textContent = "The portal is closed right now. Reopen it first (the card above), then send your Zombies.";
  }
}

function togglePick(id) {
  if (!S.picked) S.picked = new Set();
  if (S.picked.has(id)) S.picked.delete(id);
  else S.picked.add(id);
  document.querySelector(`.ztile[data-id="${id}"]`)?.classList.toggle("pick", S.picked.has(id));
  updateBatchBar();
}

function setBatch(on) {
  S.batch = on;
  if (on) { S.sel = null; document.querySelectorAll(".ztile.sel").forEach((b) => b.classList.remove("sel")); $("lab").hidden = true; }
  $("yoursBody").classList.toggle("picking", on);
  if (!on) { S.picked = new Set(); document.querySelectorAll(".ztile.pick").forEach((b) => b.classList.remove("pick")); }
  updateBatchBar();
}

async function batchGo() {
  const out = $("batchOut");
  const ids = [...S.picked].sort((a, b) => a - b);
  try {
    await loadStatus();
    if (!S.status.open) throw new Error("The portal is closed right now. Reopen it first, then send your Zombies.");
    const all = await pub.readContract({ address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "isApprovedForAll", args: [S.account, CONFIG.PORTAL] });
    if (!all) {
      await sendAndWait({
        to: CONFIG.ZOMBIES,
        data: encodeFunctionData({ abi: zombiesAbi, functionName: "setApprovalForAll", args: [CONFIG.PORTAL, true] }),
      }, out, "Approve the portal for your Zombies");
    }
    out.className = "note";
    out.textContent = `Loading the art for ${ids.length} Zombies…`;
    const items = await Promise.all(ids.map(async (id) => {
      const d = await (await fetch(`data/${id}.json`)).json();
      return { originalId: BigInt(id), art: d.art, traits: d.traits, proof: d.proof, mix: 0n, seed: 0, animate: false, speed: 0 };
    }));
    const groups = [];
    let cur = [], gas = 0;
    for (const it of items) {
      const g = estGas(it.art);
      if (cur.length && (gas + g > GROUP_GAS || cur.length >= GROUP_MAX)) { groups.push(cur); cur = []; gas = 0; }
      cur.push(it); gas += g;
    }
    if (cur.length) groups.push(cur);
    let done = 0;
    for (let k = 0; k < groups.length; k++) {
      const nz = `${groups[k].length} Zombie${groups[k].length === 1 ? "" : "s"}`;
      const label = groups.length > 1 ? `Group ${k + 1} of ${groups.length} (${nz})` : nz;
      await sendAndWait({
        to: CONFIG.PORTAL,
        data: encodeFunctionData({ abi: portalAbi, functionName: "migrateBatch", args: [groups[k]] }),
      }, out, label);
      done += groups[k].length;
      groups[k].forEach((it) => S.picked.delete(Number(it.originalId)));
    }
    S.fresh = CONFIG.ID_OFFSET + ids[0];
    out.className = "note ok";
    out.innerHTML = `${done} Zombie${done === 1 ? "" : "s"} went through the portal, fully onchain. ` +
      `You can now remove the "all Zombies" approval you gave the portal (one more confirmation).`;
    $("batchRevoke").hidden = false;
    setBatch(false);
    await Promise.all([loadStatus(), loadTokens()]);
  } catch (e) {
    console.error(e);
    out.className = "note err";
    out.textContent = errText(e) + (S.picked?.size && S.picked.size < ids.length ? `\n${ids.length - S.picked.size} already went through; the rest are still selected.` : "");
    await loadTokens();
  }
}

async function batchRevoke() {
  const out = $("batchOut");
  try {
    await sendAndWait({
      to: CONFIG.ZOMBIES,
      data: encodeFunctionData({ abi: zombiesAbi, functionName: "setApprovalForAll", args: [CONFIG.PORTAL, false] }),
    }, out, "Remove approval");
    out.className = "note ok";
    out.textContent = "Done: the portal no longer has an approval for all your Zombies.";
    $("batchRevoke").hidden = true;
  } catch (e) {
    console.error(e);
    out.className = "note err";
    out.textContent = errText(e);
  }
}

// ------------------------------------------------------------------ promo: offchain link -> fully onchain
// Real Zombies (#1-#999) cycle through the scene: the left shows the original image from its Irys link, the right
// the exact onchain render with a light animated glitch, drawn by the same engine as the contract.
const PROMO_IDS = [988, 5, 331, 500, 797, 222, 615, 896, 1, 754];
let promoTimer = 0, promoIdx = 0;
async function showPromo() {
  const id = PROMO_IDS[promoIdx++ % PROMO_IDS.length];
  try {
    const d = await (await fetch(`data/${id}.json`)).json();
    const art = hexToBytes(d.art);
    const onchain = svgUrl(renderSVG(art, [0, 0, 0, 35, 25, 45, 0, 0], 4242 + id, d.frames === 1, 4));
    const off = CONFIG.originalImage(id);
    $("promoOff").src = off;
    $("promoTraveler").src = off;
    $("promoOn").src = onchain;
    $("promoUrl").textContent = off.replace("https://", "");
    $("promoChain").textContent = `Zombie ${id} · token #${fmtId(CONFIG.ID_OFFSET + id)} · Base`;
    const stage = document.querySelector(".promo-stage"); // restart the CSS animation for the new Zombie
    stage.classList.remove("run");
    void stage.offsetWidth;
    stage.classList.add("run");
  } catch (e) { console.warn("promo", e); }
}
function startPromo() {
  if (promoTimer) return;
  showPromo();
  promoTimer = setInterval(showPromo, 6000);
}
function stopPromo() { clearInterval(promoTimer); promoTimer = 0; }

/** Images for Zombies already onchain (#1118+): read each token's own metadata (offchain JSON or onchain via w3link). */
async function fillFromMetadata(ids) {
  await Promise.all(ids.map(async (id) => {
    try {
      const uri = await pub.readContract({ address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "tokenURI", args: [BigInt(id)] });
      const meta = await (await fetch(uri)).json();
      const img = document.querySelector(`.ztile[data-id="${id}"] img`);
      if (img && typeof meta.image === "string" && /^(https:|data:image\/)/.test(meta.image)) img.src = meta.image;
      const nm = document.querySelector(`.ztile[data-id="${id}"] .zname`);
      if (nm && typeof meta.name === "string" && meta.name) nm.textContent = meta.name;
    } catch (e) { console.warn("metadata", id, e); }
  }));
}

async function fillPortaled(id) {
  if (!CONFIG.RENDERER) return;
  try {
    const [t, art] = await pub.readContract({ address: CONFIG.RENDERER, abi: rendererAbi, functionName: "tokenInfo", args: [BigInt(id)] });
    const img = document.querySelector(`.ztile[data-id="${id}"] img`);
    if (img) img.src = svgUrl(renderSVG(hexToBytes(art), t.mix, t.seed, t.animate, t.speed || 4));
  } catch (e) { console.warn("tokenInfo", id, e); }
}

// ------------------------------------------------------------------ lab
async function select(id) {
  S.sel = id;
  document.querySelectorAll(".ztile").forEach((b) => b.classList.toggle("sel", Number(b.dataset.id) === id));
  const d = await (await fetch(`data/${id}.json`)).json();
  S.data = { art: hexToBytes(d.art), artHex: d.art, traitsHex: d.traits, proof: d.proof, frames: d.frames, ...decodeTraits(d.traits) };
  S.choice = { levels: ZERO(), seed: 0, animate: false, speed: 4 };
  $("speed").value = 4;
  $("animate").checked = false;
  S.seedHistory = [];
  $("lab").hidden = false;
  $("labSub").textContent = S.data.frames > 1
    ? `${S.data.name} is animated: it keeps every frame, and your glitches play as animation on top.`
    : `${S.data.name}: mix any of the eight glitches, or go through clean for free. The glitch is baked into the pixels.`;
  $("origImg").src = imageOf(id);
  $("newIdLabel").textContent = `#${fmtId(CONFIG.ID_OFFSET + id)}`;
  $("origCap").innerHTML = `Token ID <b>#${id}</b><br>art offchain today`;
  $("goOut").textContent = "";
  $("ack").checked = false;
  buildSliders();
  $("preset").value = "";
  update();
  await refreshApproval();
  $("lab").scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Traits blob: name, description, then (trait_type, value) pairs, each as u8 length + UTF-8 bytes. */
function decodeTraits(hex) {
  const b = hexToBytes(hex), dec = new TextDecoder();
  let o = 0;
  const field = () => { const l = b[o]; const v = dec.decode(b.subarray(o + 1, o + 1 + l)); o += 1 + l; return v; };
  const name = field(), desc = field(), traits = [];
  while (o < b.length) { const ty = field(); traits.push([ty, field()]); }
  return { name, desc, traits };
}

function buildSliders() {
  const animated = S.data.frames > 1;
  $("sliders").innerHTML = EFFECTS.map((name, e) => {
    const off = animated && e < 3;
    return `<div class="slider ${off ? "off" : ""}"><div class="sname">${name}<span id="sv${e}">off</span></div>
      <small>${off ? "Static Zombies only" : DESC[e] + (animated ? " · animated" : "")}</small>
      <input type="range" min="0" max="100" step="1" value="0" id="s${e}" ${off ? "disabled" : ""} aria-label="${name} strength"></div>`;
  }).join("");
  EFFECTS.forEach((_, e) => $("s" + e).addEventListener("input", (ev) => {
    const wasClean = S.choice.levels.every((v) => v === 0);
    S.choice.levels[e] = Number(ev.target.value);
    if (wasClean && S.choice.levels[e] > 0 && !S.choice.seed) newSeed();
    $("preset").value = "";
    schedule();
  }));
  $("animateRow").hidden = animated; // already animated Zombies get animated glitches anyway
  $("mixHint").textContent = animated
    ? "Block Corruption, Pixel Sort and Smear only work on static Zombies."
    : "Strength sets how much. Reroll moves the glitches around and keeps your strengths.";
}

function setLevels(levels) {
  const animated = S.data.frames > 1;
  S.choice.levels = levels.map((v, e) => (animated && e < 3 ? 0 : v));
  if (S.choice.levels.some((v) => v > 0) && !S.choice.seed) newSeed();
  update();
}

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; update(); });
}

function newSeed() {
  if (S.choice.seed) S.seedHistory.push(S.choice.seed);
  S.choice.seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
}

function params() {
  const clean = S.choice.levels.every((v) => v === 0);
  const animate = !clean && S.data.frames === 1 && S.choice.animate;
  // speed only exists when glitches actually animate (animated art, or Animate on) and one of effects 4-8 is on
  const moves = !clean && (S.data.frames > 1 || animate) && S.choice.levels.slice(3).some((v) => v > 0);
  const speed = moves ? S.choice.speed : 0;
  return clean
    ? { levels: ZERO(), mix: 0n, seed: 0, clean, animate: false, speed: 0 }
    : { levels: S.choice.levels.slice(), mix: packMix(S.choice.levels), seed: S.choice.seed, clean, animate, speed };
}

/** Animate needs at least one moving effect (Scan Tear, RGB Split, Ghost Signal, Line Dropout, Corrupt Band). */
const nothingMoves = () => S.choice.levels.slice(3).every((v) => v === 0);

/** Mix used by the animated teaser: the holder's own mix if something already moves, else a gentle sample. */
function teaserLevels() {
  const L = S.choice.levels.slice();
  if (L.slice(3).every((v) => v === 0)) { L[3] = 40; L[4] = 35; }
  return L;
}

let teaserKey = "";
function updateTeaser() {
  const show = S.data.frames === 1 && !S.choice.animate;
  $("teaser").hidden = !show;
  if (!show) return;
  const L = teaserLevels();
  const seed = S.choice.seed || 777;
  const key = `${S.sel}|${L}|${seed}|${S.choice.speed}`;
  if (key !== teaserKey) {
    teaserKey = key;
    $("teaserImg").src = svgUrl(renderSVG(S.data.art, L, seed, true, S.choice.speed));
  }
  const ap = formatEther(S.status?.animatePrice ?? parseEther("0.0025"));
  $("teaserText").innerHTML = `Your Zombie can also be <b>animated</b> for ${ap} ETH. Its <i>Animated</i> trait becomes <b>Yes</b>.`;
}

/** The recipe as written into the token's description by the renderer. */
function recipeText(levels, speed, seed) {
  const parts = EFFECTS.map((nm, e) => (levels[e] ? `${nm} ${levels[e]}` : "")).filter(Boolean);
  return `${parts.join(", ")}${speed ? ` · Speed ${speed}` : ""} · Placement #${seed}`;
}

/** The full description the renderer writes: the original one, plus the glitch recipe when there is one. */
function descriptionText(desc, levels, speed, seed, clean) {
  if (clean) return desc;
  const sep = !desc ? "Glitch:" : desc.endsWith(".") ? " Glitch:" : ". Glitch:";
  return `${desc}${sep} ${recipeText(levels, speed, seed)}`;
}
const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function priceOf(p) {
  const st = S.status;
  if (p.clean) return 0n;
  return p.animate ? (st?.animatePrice ?? parseEther("0.0025")) : (st?.price ?? parseEther("0.0006"));
}

function update() {
  const P = params();
  const { levels, seed, clean, animate, speed } = P;
  $("speedRow").hidden = speed === 0;
  $("speed").value = S.choice.speed;
  $("speedVal").textContent = S.choice.speed + (S.choice.speed === 4 ? " (default)" : "");
  const isStatic = S.data.frames === 1;
  $("animateRow").classList.toggle("on", S.choice.animate);
  $("animatePriceLabel").textContent = `+ makes it ${formatEther(S.status?.animatePrice ?? parseEther("0.0025"))} ETH instead of ${formatEther(S.status?.price ?? parseEther("0.0006"))}`;
  $("animateHint").innerHTML = S.choice.animate && nothingMoves()
    ? "<b>Turn up Scan Tear, RGB Split, Ghost Signal, Line Dropout or Corrupt Band:</b> those are the effects that move."
    : "Scan Tear, RGB Split, Ghost Signal, Line Dropout and Corrupt Band play as animation. Your <i>Animated</i> trait changes from <b>No</b> to <b>Yes</b>.";
  EFFECTS.forEach((name, e) => {
    const small = $("s" + e).closest(".slider").querySelector("small");
    if (isStatic) small.textContent = DESC[e] + (S.choice.animate ? (e < 3 ? " · baked in" : " · animated") : "");
  });
  EFFECTS.forEach((_, e) => {
    $("s" + e).value = S.choice.levels[e];
    $("sv" + e).textContent = S.choice.levels[e] ? S.choice.levels[e] : "off";
    $("sv" + e).classList.toggle("on", S.choice.levels[e] > 0);
  });
  $("seedRow").hidden = clean;
  $("seedLabel").textContent = `#${seed}`;
  $("prevSeed").disabled = S.seedHistory.length === 0;

  S.svg = renderSVG(S.data.art, levels, seed, animate, speed || 4);
  updateTeaser();
  $("preview").src = svgUrl(S.svg);
  $("previewTag").textContent = "Exact onchain render";
  $("previewTag").className = "chip live";
  $("previewInfo").textContent = `${(S.svg.length / 1024).toFixed(1)} KB SVG${S.data.frames > 1 ? ` · ${S.data.frames} frames` : ""}${animate || S.data.frames > 1 ? " · animated" : ""}`;

  const id = S.sel;
  const name = S.data.name; // the name never changes; only the token ID does
  $("resName").textContent = name;
  let added = 0;
  const traits = S.data.traits.map(([k, v]) => {
    if (animate && k === "Animated") { added++; return `<li class="new">${k}: <b>Yes</b> <span class="muted">(was No)</span></li>`; }
    return `<li>${k}: <b>${v}</b></li>`;
  });
  if (!clean) { traits.push(`<li class="new">Glitch: <b>Yes</b></li>`); added++; }
  $("resTraits").innerHTML = traits.join("") + (clean ? "" : `<li class="recipe">Recipe (in the description): ${recipeText(levels, speed, seed)}</li>`);
  $("newTraitCount").textContent = added ? `· ${added} new or changed` : "· same as today";
  const cost = priceOf(P);
  $("resCost").textContent = cost === 0n ? "Free (plus gas)" : `${formatEther(cost)} ETH (plus gas)${animate ? " · animated" : ""}`;
  const newId = `#${fmtId(CONFIG.ID_OFFSET + id)}`;
  $("newCap").innerHTML = `New token ID, still named <b>${esc(name)}</b><br>fully onchain`;
  // final product card: exactly what gets minted
  $("finalImg").src = $("preview").src;
  $("finalName").textContent = name;
  $("finalId").innerHTML = `Token ID <b>${newId}</b> <span class="muted">(was #${id})</span>`;
  const isAnimated = animate || S.data.frames > 1;
  $("finalChips").innerHTML = [
    ["Fully onchain", "ok"], ["Base", ""], [isAnimated ? "Animated" : "Static", isAnimated ? "warn" : ""],
    ...(clean ? [["No glitch", ""]] : [["Glitched", "acc"]]),
  ].map(([t, c]) => `<span class="fchip ${c}">${t}</span>`).join("");
  const finalCost = priceOf(P) + (S.status && !S.status.open ? S.status.reopenFee : 0n);
  $("finalPrice").textContent = finalCost === 0n ? "Free (plus gas)" : `${formatEther(finalCost)} ETH (plus gas)`;
  const cells = S.data.traits.map(([k, v]) => {
    const changed = animate && k === "Animated";
    return [k, changed ? "Yes" : v, changed];
  });
  if (!clean) cells.push(["Glitch", "Yes", true]);
  $("finalTraitCount").textContent = `· ${cells.length}`;
  $("finalTraits").innerHTML = cells.map(([k, v, isNew]) =>
    `<div class="ftrait ${isNew ? "new" : ""}"><span>${k}</span><b>${v}</b></div>`).join("");
  $("finalRecipe").hidden = false;
  $("finalRecipe").innerHTML = `<span>Description</span>${esc(descriptionText(S.data.desc, levels, speed, seed, clean))}`;

  const traitLine = clean
    ? "Its traits stay the same (with the collection's cleaned-up spelling)."
    : `Its traits stay (with the cleaned-up spelling). It gets one new trait, <b>Glitch: Yes</b>${animate ? ", and <b>Animated</b> changes to <b>Yes</b>" : ""}. The glitch recipe is saved in its description and locked forever.`;
  $("ackText").innerHTML = `I understand that:` +
    `<span class="ack-line">• The name stays <b>${esc(name)}</b>. Only the <b>token ID</b> changes: <b>#${id} → ${newId}</b>.</span>` +
    `<span class="ack-line">• ${traitLine}</span>` +
    `<span class="ack-line">• Token #${id} is burned in the same transaction. This can't be undone.</span>`;
  updateButtons();
}

let approved = false;
async function refreshApproval() {
  approved = false;
  if (S.sel && S.account && CONFIG.PORTAL) {
    const [single, all] = await pub.multicall({
      contracts: [
        { address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "getApproved", args: [BigInt(S.sel)] },
        { address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "isApprovedForAll", args: [S.account, CONFIG.PORTAL] },
      ],
      allowFailure: false,
    });
    approved = all || getAddress(single) === getAddress(CONFIG.PORTAL);
  }
  updateButtons();
}

function updateButtons() {
  const st = S.status;
  const usable = !!(st && (st.open || st.canReopen));
  const ready = !!(S.account && CONFIG.PORTAL && usable && S.sel);
  $("btnApprove").textContent = approved ? `${S.sel ? nameOf(S.sel) : "Zombie"} approved` : `1. Approve ${S.sel ? nameOf(S.sel) : "Zombie"}`;
  $("btnApprove").classList.toggle("done", approved);
  $("btnApprove").disabled = !ready || approved;
  // wallets that can bundle (EIP-5792) approve and go through in one confirmation
  const oneClick = !!(S.bundle && !approved);
  $("btnApprove").hidden = oneClick;
  const P = params();
  const total = priceOf(P) + (st && !st.open ? st.reopenFee : 0n);
  const label = oneClick
    ? (st && !st.open ? "Approve, Reopen & Enter" : "Approve & Enter the Portal")
    : (st && !st.open ? "2. Reopen & Enter the Portal" : "2. Enter the Portal");
  $("btnGo").textContent = `${label} (${total === 0n ? "free" : formatEther(total) + " ETH"})`;
  const blockedAnimate = S.data && S.data.frames === 1 && S.choice.animate && nothingMoves();
  $("btnGo").disabled = !ready || !(approved || oneClick) || !$("ack").checked || blockedAnimate;
  if (!CONFIG.PORTAL) $("goOut").textContent = "The portal isn't deployed yet. You can still play in the lab.";
  else if (st?.paused) $("goOut").textContent = "The artist paused the portal. It can't be used or reopened right now.";
  else if (st && !st.open) $("goOut").textContent = `The portal is closed. This button reopens it for everyone for 24 hours (${formatEther(st.reopenFee)} ETH) and takes your Zombie through.`;
}

async function approve() {
  const out = $("goOut");
  if (!S.sel) { out.className = "note warn"; out.textContent = "Pick a Zombie from Your Zombies first."; return; }
  try {
    await sendAndWait({
      to: CONFIG.ZOMBIES,
      data: encodeFunctionData({ abi: zombiesAbi, functionName: "approve", args: [CONFIG.PORTAL, BigInt(S.sel)] }),
    }, out, "Approve");
    out.className = "note ok";
    out.textContent = `${nameOf(S.sel)} approved for the portal. Now enter the portal.`;
    await refreshApproval();
  } catch (e) {
    console.error(e);
    out.className = "note err";
    out.textContent = errText(e);
  }
}

async function go() {
  const out = $("goOut");
  if (!S.sel) { out.className = "note warn"; out.textContent = "Pick a Zombie from Your Zombies first."; return; }
  const P = params();
  const { levels, mix, seed, clean, animate } = P;
  if (animate && nothingMoves()) { out.className = "note err"; out.textContent = "Turn up at least one effect that moves to make it animated."; return; }
  if (!validMix(S.data.frames, levels)) { out.className = "note err"; out.textContent = "That glitch mix isn't available for this Zombie."; return; }
  await loadStatus(); // the window may have closed (or been reopened) since the page loaded
  const reopening = !S.status.open;
  const value = priceOf(P) + (reopening ? S.status.reopenFee : 0n);
  const id = S.sel;
  try {
    const goCall = {
      to: CONFIG.PORTAL,
      value,
      data: encodeFunctionData({
        abi: portalAbi, functionName: reopening ? "reopenAndMigrate" : "migrate",
        args: [BigInt(id), S.data.artHex, S.data.traitsHex, S.data.proof, mix, seed, animate, P.speed],
      }),
    };
    const approveCall = {
      to: CONFIG.ZOMBIES,
      data: encodeFunctionData({ abi: zombiesAbi, functionName: "approve", args: [CONFIG.PORTAL, BigInt(id)] }),
    };
    // one confirmation when the wallet can bundle and this Zombie isn't approved yet; otherwise the usual way
    const rc = !approved && S.bundle
      ? await sendBundleAndWait([approveCall, goCall], out, "Approve & enter the portal")
      : await sendAndWait(goCall, out, "Portal");
    const ev = rc.logs.map((l) => { try { return decodeEventLog({ abi: portalAbi, ...l }); } catch { return null; } })
      .find((x) => x && x.eventName === "Migrated");
    const newId = ev ? ev.args.newId : BigInt(CONFIG.ID_OFFSET + id);
    S.fresh = Number(newId); // highlight the Zombie that just came through
    S.sel = null;
    approved = false; // this Zombie is done: lock the buttons until another one is picked
    $("ack").checked = false;
    $("btnGo").disabled = true;
    $("btnApprove").disabled = true;
    out.className = "note ok";
    out.innerHTML = `${esc(nameOf(id))} went through the portal. You now hold it as token <b>#${fmtId(newId)}</b>, fully onchain.\n` +
      `<a href="${CONFIG.explorer}/tx/${rc.transactionHash}" target="_blank" rel="noopener">Transaction</a> · ` +
      `<a href="${CONFIG.opensea}${newId}" target="_blank" rel="noopener">OpenSea</a> (it can take a few minutes to show up)
` +
      `Pick another Zombie in Your Zombies to keep going.`;
    await Promise.all([loadStatus(), loadTokens()]);
    $("lab").hidden = false;
  } catch (e) {
    console.error(e);
    out.className = "note err";
    out.textContent = errText(e);
  }
}

async function verify() {
  const out = $("goOut");
  if (!CONFIG.RENDERER) { out.className = "note warn"; out.textContent = "The renderer isn't deployed yet."; return; }
  const { mix, seed, animate, speed } = params();
  out.className = "note";
  out.textContent = "Asking the contract to draw it…";
  try {
    const onchain = await pub.readContract({
      address: CONFIG.RENDERER, abi: rendererAbi, functionName: "previewSVG", args: [S.data.artHex, mix, seed, animate, speed],
    });
    const same = onchain === S.svg;
    out.className = same ? "note ok" : "note err";
    out.textContent = same
      ? `Match: the contract draws exactly this image (${onchain.length.toLocaleString()} bytes, identical).`
      : "The contract's drawing differs from this preview. Please don't continue, and tell @EdOnChain.";
    $("previewTag").textContent = same ? "Verified by the contract" : "Mismatch";
    $("previewTag").className = same ? "chip done" : "chip warn";
  } catch (e) {
    console.error(e);
    out.className = "note warn";
    out.textContent = "Couldn't reach the contract to double-check. The preview uses the same code, so it's still accurate.";
  }
}

// ------------------------------------------------------------------ admin
async function refreshAdmin() {
  const isOwner = !!(S.account && S.owner && S.account === S.owner);
  $("admin").hidden = !isOwner;
  $("navAdmin").hidden = !isOwner;
  if (!isOwner || !S.status) return;
  const bal = await pub.getBalance({ address: CONFIG.PORTAL });
  const st = S.status;
  $("aWindow").innerHTML = `${st.paused ? "<b>Paused</b>" : st.open ? "<b>Open</b>" : "<b>Closed</b> (holders can reopen)"} · deadline ${fmtDate(st.deadline)}`;
  $("aPause").textContent = st.paused ? "Unpause" : "Pause";
  $("aPause").className = st.paused ? "btn" : "btn danger";
  const dl = new Date(Number(st.deadline) * 1000);
  $("aDeadline").value = new Date(dl.getTime() - dl.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("aFunds").textContent = `Balance ${formatEther(bal)} ETH · price ${formatEther(st.price)} ETH · ${st.count} through the portal`;
  $("aPrice").value = formatEther(st.price);
  $("aReopenFee").value = formatEther(st.reopenFee);
  $("aAnimatePrice").value = formatEther(st.animatePrice);
  try {
    const managers = await pub.readContract({ account: S.account, address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "getManagers" });
    const has = managers.some((m) => getAddress(m) === getAddress(CONFIG.PORTAL));
    $("aManager").innerHTML = has ? "The portal <b>can mint</b> (manager role on Zombies)." : "The portal <b>can't mint</b>: manager role removed.";
    $("aRevoke").disabled = !has;
    $("aGrant").disabled = has;
  } catch (e) {
    $("aManager").textContent = "Couldn't read the Zombies managers.";
  }
}

async function adminTx(outId, label, to, abi, functionName, args = [], doneHtml = "") {
  const out = $(outId);
  try {
    await sendAndWait({ to, data: encodeFunctionData({ abi, functionName, args }) }, out, label);
    out.className = "note ok";
    out.innerHTML = `${label}: done.${doneHtml ? " " + doneHtml : ""}`;
    await loadStatus();
    await refreshAdmin();
    if (S.sel) update();
  } catch (e) {
    console.error(e);
    out.className = "note err";
    out.textContent = errText(e);
  }
}

function wireAdmin() {
  const P = () => [CONFIG.PORTAL, portalAbi];
  $("aSetDeadline").onclick = () => {
    const ts = Math.floor(new Date($("aDeadline").value).getTime() / 1000);
    if (!ts) return;
    adminTx("aWindowOut", "Set deadline", ...P(), "setDeadline", [BigInt(ts)]);
  };
  $("aReopen").onclick = () => adminTx("aWindowOut", "Reopen", ...P(), "setDeadline", [BigInt(DEFAULT_DEADLINE)]);
  $("aCloseNow").onclick = async () => {
    const now = (await pub.getBlock()).timestamp; // chain time, not this computer's clock
    adminTx("aWindowOut", "Close now", ...P(), "setDeadline", [now - 1n], `Holders now see a <a href="#reopenCard">Reopen for 24 hours</a> card at the top of Your Zombies (you too, as a holder).`);
  };
  $("aPause").onclick = () => {
    const pausing = !S.status.paused;
    if (pausing && !confirm("Pause the portal? It closes right away and holders can't reopen it until you unpause.")) return;
    adminTx("aWindowOut", pausing ? "Pause" : "Unpause", ...P(), "setPaused", [pausing]);
  };
  $("aSetAnimatePrice").onclick = () => adminTx("aFundsOut", "Set animated price", ...P(), "setAnimatePrice", [parseEther($("aAnimatePrice").value.trim() || "0")]);
  $("aSetReopenFee").onclick = () => adminTx("aFundsOut", "Set reopen fee", ...P(), "setReopenFee", [parseEther($("aReopenFee").value.trim() || "0")]);
  $("aSetPrice").onclick = () => adminTx("aFundsOut", "Set price", ...P(), "setPrice", [parseEther($("aPrice").value.trim() || "0")]);
  $("aWithdraw").onclick = () => adminTx("aFundsOut", "Withdraw", ...P(), "withdraw", [S.account]);
  $("aRevoke").onclick = () => {
    if (!confirm("Remove the portal's permission to mint Zombies? Holders won't be able to use the portal until you give it back.")) return;
    adminTx("aManagerOut", "Remove mint permission", CONFIG.ZOMBIES, zombiesAbi, "setManagers", [[CONFIG.PORTAL], false]);
  };
  $("aGrant").onclick = () => adminTx("aManagerOut", "Give mint permission", CONFIG.ZOMBIES, zombiesAbi, "setManagers", [[CONFIG.PORTAL], true]);
}

// ------------------------------------------------------------------ simulation bar
function setupSim() {
  if (!CONFIG.sim) return;
  const bar = $("simBar");
  bar.hidden = false;
  bar.innerHTML = `SIMULATION on a local Base fork · no real funds · act as
    <input id="simAddr" placeholder="holder address 0x…" spellcheck="false">
    <button id="simUse">Use</button> <button id="simOwner">Owner</button> <button id="simRandom">Random holder</button>
    <button id="simTime">+30 days</button> <span id="simClock"></span>`;
  const use = async (a) => {
    if (!isAddress(a)) return alert("Not an address");
    await pub.request({ method: "anvil_setBalance", params: [a, "0x" + parseEther("1").toString(16)] });
    $("simAddr").value = a;
    await setAccount(a);
  };
  $("simUse").onclick = () => use($("simAddr").value.trim());
  $("simOwner").onclick = () => S.owner && use(S.owner);
  $("simRandom").onclick = async () => {
    for (let k = 0; k < 40; k++) {
      const id = 1 + Math.floor(Math.random() * LAST_ID);
      try {
        const o = await pub.readContract({ address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "ownerOf", args: [BigInt(id)] });
        if (o !== S.owner) return use(o);
      } catch {}
    }
  };
  const clock = async () => {
    const b = await pub.getBlock();
    $("simClock").textContent = `· chain time ${fmtDate(b.timestamp)}`;
  };
  $("simTime").onclick = async () => {
    await pub.request({ method: "evm_increaseTime", params: [30 * 86400] });
    await pub.request({ method: "evm_mine", params: [] });
    await clock();
    await loadStatus();
    await refreshAdmin();
    updateButtons();
  };
  clock();
}

// ------------------------------------------------------------------ boot
$("connect").addEventListener("click", (e) => {
  if (CONFIG.sim) return $("simAddr")?.focus();
  wallet.open(e.currentTarget);
});
$("reroll").onclick = () => { newSeed(); update(); };
$("speed").addEventListener("input", (e) => { S.choice.speed = Number(e.target.value); schedule(); });
$("promoConnect").onclick = (e) => {
  if (CONFIG.sim) return $("simAddr")?.focus();
  wallet.open(e.currentTarget);
};
$("teaserBtn").onclick = () => {
  S.choice.levels = teaserLevels();
  if (!S.choice.seed) newSeed();
  S.choice.animate = true;
  $("animate").checked = true;
  $("preset").value = "";
  update();
  $("animateRow").scrollIntoView({ behavior: "smooth", block: "center" });
};
$("animate").onchange = (e) => {
  S.choice.animate = e.target.checked;
  // turning animation on with nothing that moves: start a gentle Scan Tear so there is something to see
  if (S.choice.animate && nothingMoves()) { S.choice.levels[3] = 40; if (!S.choice.seed) newSeed(); }
  update();
};
$("clearMix").onclick = () => { $("preset").value = ""; setLevels(ZERO()); };
$("preset").onchange = (e) => { if (PRESETS[e.target.value]) setLevels(PRESETS[e.target.value].slice()); };
$("prevSeed").onclick = () => { if (S.seedHistory.length) { S.choice.seed = S.seedHistory.pop(); update(); } };
$("ack").onchange = updateButtons;
$("btnApprove").onclick = approve;
$("btnGo").onclick = go;
$("btnVerify").onclick = verify;
$("btnReopen").onclick = reopenOnly;
$("batchMode").onclick = () => setBatch(!S.batch);
$("batchAll").onclick = () => {
  const elig = S.tokens.filter((t) => t.kind === "eligible").map((t) => t.id);
  const allOn = S.picked && S.picked.size === elig.length;
  S.picked = new Set(allOn ? [] : elig);
  document.querySelectorAll(".ztile").forEach((b) => b.classList.toggle("pick", S.picked.has(Number(b.dataset.id))));
  updateBatchBar();
};
$("batchAck").onchange = updateBatchBar;
$("batchGo").onclick = batchGo;
$("batchRevoke").onclick = batchRevoke;
wireAdmin();
setupSim();
$("connect").textContent = CONFIG.sim ? "Simulation" : "Connect Wallet";
window.__portalBooted = true; // see the startup check in index.html

(async () => {
  try {
    await loadStatus();
  } catch (e) {
    console.error(e);
    $("heroStats").innerHTML = `<div class="stat"><div class="num">–</div><div class="lbl">Couldn't reach Base</div></div>`;
  }
  try { ARTIFACTS = await (await fetch("data/artifacts.json")).json(); } catch (e) { console.warn("artifacts", e); }
  await loadTokens();
})();

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  parseEther,
  encodeFunctionData,
  decodeFunctionResult,
  formatEther,
  getAddress,
  isAddress,
  namehash,
} from "https://esm.sh/viem@2.21.54";
import { mainnet } from "https://esm.sh/viem@2.21.54/chains";
import { StandardMerkleTree } from "https://esm.sh/@openzeppelin/merkle-tree@1.0.8";
import { CONFIG } from "./config.js";
import { createWallet, walletErrorText } from "../../assets/wallet.js";

// v1 (giveaway #0, snapshot + Merkle proof) and v2 (onchain draw, prepaid fee) raffles.
const V1_STATUS = ["none", "open", "committed", "drawing", "drawn", "completed", "cancelled"];
const V2_STATUS = ["none", "open", "drawing", "drawn", "completed", "cancelled"];

const v1Abi = parseAbi([
  "struct Giveaway { uint256 prizeTokenId; uint64 openedAt; uint64 closesAt; uint64 requestedAt; uint64 completedAt; uint8 status; uint32 entrantCount; bytes32 entrantsRoot; string entrantsURI; uint256 requestId; uint256 randomWord; address winner; uint256 winningTokenId; uint32 winningIndex; }",
  "function giveawayCount() view returns (uint256)",
  "function getGiveaway(uint256 id) view returns (Giveaway)",
]);
const v2Abi = parseAbi([
  "struct Giveaway { uint256 prizeTokenId; uint64 openedAt; uint64 closesAt; uint64 requestedAt; uint64 completedAt; uint8 status; uint32 ticketCount; uint32 attempts; uint256 feeDeposit; uint256 feePaid; uint256 requestId; uint256 randomWord; address winner; uint256 winningTokenId; }",
  "function owner() view returns (address)",
  "function giveawayCount() view returns (uint256)",
  "function getGiveaway(uint256 id) view returns (Giveaway)",
  "function drawPrice() view returns (uint256)",
  "function startGiveaway(uint256 prizeTokenId, uint64 closesAt) payable returns (uint256)",
  "function draw(uint256 id) payable returns (uint256)",
  "function continuePayout(uint256 id)",
  "function cancel(uint256 id)",
]);
// V3 = V2 plus a minimum holding per giveaway.
const v3Abi = parseAbi([
  "struct Giveaway { uint256 prizeTokenId; uint64 openedAt; uint64 closesAt; uint64 requestedAt; uint64 completedAt; uint8 status; uint32 ticketCount; uint32 attempts; uint32 minHolding; uint256 feeDeposit; uint256 feePaid; uint256 requestId; uint256 randomWord; address winner; uint256 winningTokenId; }",
  "function owner() view returns (address)",
  "function giveawayCount() view returns (uint256)",
  "function getGiveaway(uint256 id) view returns (Giveaway)",
  "function drawPrice() view returns (uint256)",
  "function startGiveaway(uint256 prizeTokenId, uint64 closesAt, uint32 minHolding) payable returns (uint256)",
  "function draw(uint256 id) payable returns (uint256)",
  "function continuePayout(uint256 id)",
  "function cancel(uint256 id)",
]);
const abiOf = (g) => (g.v === 3 ? v3Abi : v2Abi);
// New giveaways start on V3 once it's deployed; V2 stays readable for history.
const START = CONFIG.RAFFLE_V3 ? { address: CONFIG.RAFFLE_V3, abi: v3Abi, v: 3 } : { address: CONFIG.RAFFLE, abi: v2Abi, v: 2 };
const zombiesAbi = parseAbi([
  "function tokenURI(uint256) view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
]);

const chain = {
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc] } },
  blockExplorers: { default: { name: "Basescan", url: CONFIG.explorer } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
};
const pub = createPublicClient({ chain, transport: http(CONFIG.rpc) });
const eth = createPublicClient({ chain: mainnet, transport: http(CONFIG.ethRpc) });
const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// Wallet links show the short address first; applyNames() swaps in an ENS name or Basename when one is set.
const addrLink = (a) => `<a class="addr" data-addr="${a}" href="${CONFIG.explorer}/address/${a}" target="_blank" rel="noopener" title="${a}">${short(a)}</a>`;
const plainLink = (a) => `<a href="${CONFIG.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>`;
const txLink = (h) => `<a href="${CONFIG.explorer}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>`;
const fmtDate = (s) => new Date(Number(s) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let account = null;
let wallet = null;
let raffleOwner = null;
let giveaways = []; // normalized, oldest first; .no is the public giveaway number
const metaCache = new Map();
const snapCache = new Map();

function say(el, msg, cls = "") {
  el.className = "note " + cls;
  el.innerHTML = msg;
}
function errText(e) {
  const code = e?.code ?? e?.cause?.code;
  if (code === 4001 || code === -32002 || /rejected/i.test(e?.shortMessage || "")) return esc(walletErrorText({ code: code ?? 4001, ...e }));
  return esc(e?.shortMessage || e?.details || e?.message || String(e));
}

// ---------------------------------------------------------------- data

async function tokenMeta(tokenId) {
  const key = String(tokenId);
  if (metaCache.has(key)) return metaCache.get(key);
  const p = (async () => {
    try {
      const uri = await pub.readContract({ address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "tokenURI", args: [BigInt(tokenId)] });
      const json = uri.startsWith("data:application/json")
        ? JSON.parse(uri.startsWith("data:application/json;base64,") ? atob(uri.split(",")[1]) : decodeURIComponent(uri.split(",")[1]))
        : await fetch(uri).then((r) => r.json());
      return { name: json.name || `Zombie ${tokenId}`, image: json.image || "", onchain: String(json.image || "").startsWith("data:") };
    } catch {
      return { name: `Zombie ${tokenId}`, image: "", onchain: false };
    }
  })();
  metaCache.set(key, p);
  return p;
}

/** Snapshot links must be https or a path on this site (never javascript:, data:, etc). */
function snapshotUrl(uri) {
  let u;
  try {
    u = new URL(uri, location.href);
  } catch {
    return null;
  }
  return u.protocol === "https:" || u.origin === location.origin ? u : null;
}

async function loadSnapshot(uri) {
  if (!uri) return null;
  if (snapCache.has(uri)) return snapCache.get(uri);
  const url = snapshotUrl(uri);
  if (!url) throw new Error("Snapshot link is not an https URL.");
  const p = fetch(url, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`Snapshot not found (${r.status})`);
    return r.json();
  });
  snapCache.set(uri, p);
  return p;
}

async function readAll(address, abi, statuses, v) {
  if (!address) return [];
  const n = Number(await pub.readContract({ address, abi, functionName: "giveawayCount" }));
  const list = await Promise.all(
    Array.from({ length: n }, (_, i) => pub.readContract({ address, abi, functionName: "getGiveaway", args: [BigInt(i)] })),
  );
  return list.map((g, id) => ({
    v, id, raffle: address,
    status: statuses[g.status],
    prizeTokenId: g.prizeTokenId,
    openedAt: g.openedAt, closesAt: g.closesAt, requestedAt: g.requestedAt, completedAt: g.completedAt,
    tickets: Number(v === 1 ? g.entrantCount : g.ticketCount),
    winner: g.winner, winningTokenId: g.winningTokenId,
    requestId: g.requestId, randomWord: g.randomWord,
    entrantsURI: g.entrantsURI, entrantsRoot: g.entrantsRoot, winningIndex: g.winningIndex,
    feeDeposit: g.feeDeposit, feePaid: g.feePaid, attempts: g.attempts,
    minHolding: Number(g.minHolding ?? 1),
  }));
}

async function loadGiveaways() {
  const [a, b, c] = await Promise.all([
    readAll(CONFIG.RAFFLE_V1, v1Abi, V1_STATUS, 1),
    readAll(CONFIG.RAFFLE, v2Abi, V2_STATUS, 2),
    readAll(CONFIG.RAFFLE_V3, v3Abi, V2_STATUS, 3),
  ]);
  giveaways = [...a, ...b, ...c].map((g, i) => ({ ...g, no: i }));
}

// ---------------------------------------------------------------- names (ENS + Basenames)

const BASENAME_REVERSE = "0x0000000000D8e504002cC26E3Ec46D81971C1664"; // Basenames L2ReverseRegistrar on Base
const BASENAME_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD"; // Basenames L2Resolver on Base
const basenameAbi = parseAbi([
  "function nameForAddr(address) view returns (string)",
  "function name(bytes32) view returns (string)",
  "function addr(bytes32) view returns (address)",
]);
const nameCache = new Map();

/** Basename for an address, only if it resolves back to the same address. */
async function basenameOf(addr) {
  let name = await pub.readContract({ address: BASENAME_REVERSE, abi: basenameAbi, functionName: "nameForAddr", args: [addr] }).catch(() => "");
  if (!name) {
    const node = namehash(`${addr.slice(2).toLowerCase()}.80002105.reverse`);
    name = await pub.readContract({ address: BASENAME_RESOLVER, abi: basenameAbi, functionName: "name", args: [node] }).catch(() => "");
  }
  if (!name) return null;
  const back = await basenameAddress(name);
  return back && back.toLowerCase() === addr.toLowerCase() ? name : null;
}
const basenameAddress = (name) =>
  pub.readContract({ address: BASENAME_RESOLVER, abi: basenameAbi, functionName: "addr", args: [namehash(name)] }).catch(() => null);

/** ENS primary name (Ethereum), else Basename (Base), else null. Cached per address. */
function nameOf(addr) {
  const key = addr.toLowerCase();
  if (!nameCache.has(key)) {
    nameCache.set(key, (async () => {
      const ens = await eth.getEnsName({ address: getAddress(addr) }).catch(() => null);
      if (ens) return ens;
      return CONFIG.testnet ? null : basenameOf(getAddress(addr));
    })());
  }
  return nameCache.get(key);
}

/** Name → address: Basenames on Base, any other name through ENS. */
async function addressOf(name) {
  const n = name.toLowerCase();
  const a = n.endsWith(".base.eth") ? await basenameAddress(n) : await eth.getEnsAddress({ name: n }).catch(() => null);
  return a && a !== "0x0000000000000000000000000000000000000000" ? getAddress(a) : null;
}

function applyNames(root = document) {
  for (const el of root.querySelectorAll("a.addr[data-addr]")) {
    nameOf(el.dataset.addr).then((n) => {
      if (n && el.isConnected) el.textContent = n;
    });
  }
}

// ---------------------------------------------------------------- render

const isClosed = (g) => Date.now() / 1000 >= Number(g.closesAt);

function statusChip(g) {
  if (g.status === "open" && !isClosed(g)) return `<span class="chip live">Open</span>`;
  if (g.status === "open") return `<span class="chip warn">Closed · ready to draw</span>`;
  if (g.status === "committed") return `<span class="chip warn">Snapshot committed</span>`;
  if (g.status === "drawing") return `<span class="chip warn">Waiting for Chainlink VRF</span>`;
  if (g.status === "drawn") return `<span class="chip warn">${g.v >= 2 ? "Winner picked · payout pending" : "Random number in · ready to settle"}</span>`;
  if (g.status === "completed") return `<span class="chip done">Completed</span>`;
  return `<span class="chip">Cancelled</span>`;
}

function timeline(g) {
  const done = (s) => ["drawing", "drawn", "completed"].indexOf(g.status) >= ["drawing", "drawn", "completed"].indexOf(s);
  const step = (label, ok, now, when = "") =>
    `<li class="${ok ? "done" : now ? "now" : ""}">${label}${when ? `<span class="when">${when}</span>` : ""}</li>`;
  const closed = g.status !== "open" || isClosed(g);
  const drawn = g.status !== "open" && g.status !== "committed" && g.status !== "cancelled";
  if (g.v === 1) {
    return `<ol class="timeline">
      ${step("Prize locked in the raffle contract", true, false, fmtDate(g.openedAt))}
      ${step("Entries close · snapshot taken", closed, !closed, fmtDate(g.closesAt))}
      ${step("Snapshot committed onchain", g.status !== "open" && g.status !== "cancelled", closed && g.status === "open", g.tickets ? `${g.tickets} tickets` : "")}
      ${step("Chainlink VRF random number", ["drawn", "completed"].includes(g.status), ["committed", "drawing"].includes(g.status), drawn ? `Requested ${fmtDate(g.requestedAt)}` : "")}
      ${step("Prize sent to the winner", g.status === "completed", g.status === "drawn", g.status === "completed" ? fmtDate(g.completedAt) : "")}
    </ol>`;
  }
  return `<ol class="timeline">
    ${step("Prize and Chainlink fee locked in the contract", true, false, fmtDate(g.openedAt))}
    ${step("Entries close", closed, !closed, fmtDate(g.closesAt))}
    ${step("Draw requested from Chainlink VRF", drawn && done("drawing"), closed && g.status === "open", drawn ? `${fmtDate(g.requestedAt)} · ${g.minHolding > 1 ? `wallets with ${g.minHolding}+ Zombies` : `${g.tickets} tickets`}` : "")}
    ${step("Random Zombie picked · prize sent to its holder", g.status === "completed", g.status === "drawing" || g.status === "drawn", g.status === "completed" ? fmtDate(g.completedAt) : "")}
  </ol>`;
}

// One timer drives every countdown on the page (one per open giveaway).
let countdownTimer = null;
function startCountdowns() {
  clearInterval(countdownTimer);
  const els = [...document.querySelectorAll(".countdown[data-closes]")];
  if (els.length === 0) return;
  const tick = () => {
    let closedNow = false;
    for (const el of els) {
      if (el.dataset.done) continue;
      const left = Number(el.dataset.closes) - Math.floor(Date.now() / 1000);
      if (left <= 0) {
        el.textContent = "Entries closed";
        el.dataset.done = "1";
        closedNow = true;
        continue;
      }
      const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
      el.textContent = `${d ? d + "d " : ""}${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
    }
    if (closedNow) refresh();
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

const isActive = (g) => ["open", "committed", "drawing", "drawn"].includes(g.status);

/** Every giveaway still running (soonest close first); otherwise the latest finished one. */
function currentGiveaways() {
  const active = giveaways.filter(isActive).sort((a, b) => Number(a.closesAt) - Number(b.closesAt) || a.no - b.no);
  if (active.length) return active;
  const last = [...giveaways].reverse().find((g) => g.status !== "cancelled") || giveaways[giveaways.length - 1];
  return last ? [last] : [];
}

async function renderCurrent() {
  const body = $("currentBody");
  if (!CONFIG.RAFFLE && !CONFIG.RAFFLE_V1 && !CONFIG.RAFFLE_V3) {
    body.innerHTML = `<div class="card"><p class="pixel small">The Graveyard is waking up…</p><p class="muted">The raffle contract hasn't been deployed yet. Check back soon.</p></div>`;
    return;
  }
  const list = currentGiveaways();
  const running = list.some(isActive);
  $("currentTitle").textContent = !running ? "Last giveaway" : list.length > 1 ? `Current giveaways · ${list.length}` : "Current giveaway";
  if (list.length === 0) {
    $("currentTitle").textContent = "Current giveaway";
    body.innerHTML = `<div class="card"><p class="pixel small">No giveaway yet</p><p class="muted">The next fully onchain Zombie is coming. Hold your Zombies.</p></div>`;
    return;
  }
  const html = await Promise.all(list.map(giveawayHtml));
  body.innerHTML = (running ? "" : `<p class="muted">No giveaway is running right now. The next fully onchain Zombie is coming: hold your Zombies.</p>`) + html.join("");
  for (const live of list) {
    const card = body.querySelector(`[data-no="${live.no}"]`);
    const out = card.querySelector(".action-out");
    card.querySelector(".draw-btn")?.addEventListener("click", () => drawWinner(live, out));
    card.querySelector(".finish-btn")?.addEventListener("click", () => finishPayout(live, out));
    if (live.status === "drawing") pollUntilChanged(live);
  }
  startCountdowns();
}

async function giveawayHtml(live) {
  const meta = await tokenMeta(live.prizeTokenId);
  const snap = live.v === 1 && live.entrantsURI ? await loadSnapshot(live.entrantsURI).catch(() => null) : null;
  const rootOk = snap && snap.merkleRoot?.toLowerCase() === String(live.entrantsRoot).toLowerCase();

  let winnerHtml = "";
  if (live.status === "completed") {
    winnerHtml = `<div class="winner"><div class="pixel">Winner</div>
      <div>${addrLink(live.winner)} won with Zombie #${live.winningTokenId}${live.v === 1 ? ` (ticket #${live.winningIndex} of ${live.tickets})` : live.minHolding > 1 ? ` (drawn from Zombies in wallets holding ${live.minHolding}+)` : ` (1 of ${live.tickets} Zombies)`}.</div></div>`;
  }
  const canDraw = live.v >= 2 && live.status === "open" && isClosed(live);
  const canFinish = live.v >= 2 && live.status === "drawn";

  const kv = [];
  if (live.v === 1 && live.tickets) {
    kv.push(`<dt>Tickets</dt><dd>${live.tickets}${snap ? ` from ${snap.stats.eligibleWallets} wallets` : ""}</dd>`);
    if (snap) kv.push(`<dt>Snapshot</dt><dd>block ${snap.snapshot.block} · <a href="${esc(snapshotUrl(live.entrantsURI))}" target="_blank" rel="noopener">full list</a></dd>`);
    kv.push(`<dt>Merkle root</dt><dd><code>${live.entrantsRoot}</code> ${snap ? (rootOk ? "✓ matches the published list" : "⚠ does not match the published list") : ""}</dd>`);
  }
  if (live.v >= 2) {
    const min = live.minHolding;
    if (min > 1) kv.push(`<dt>Who can win</dt><dd>Wallets holding ${min} or more Zombies at the draw. Every Zombie they hold is a ticket.</dd>`);
    kv.push(`<dt>Tickets</dt><dd>${min > 1 ? `Every Zombie in a wallet holding ${min}+` : live.tickets ? `${live.tickets} Zombies at the draw` : "Every Zombie held at the draw"} · the owner's Zombies and the prize don't count</dd>`);
    kv.push(`<dt>Chainlink fee</dt><dd>${live.feePaid ? `${formatEther(live.feePaid)} ETH paid from the deposit` : `${formatEther(live.feeDeposit)} ETH deposited`}</dd>`);
  }
  if (["drawing", "drawn", "completed"].includes(live.status)) kv.push(`<dt>VRF request</dt><dd><code>${String(live.requestId).slice(0, 18)}…</code></dd>`);
  if (["drawn", "completed"].includes(live.status)) kv.push(`<dt>Random word</dt><dd><code>${String(live.randomWord).slice(0, 24)}…</code></dd>`);

  return `<div class="current" data-no="${live.no}">
    <div class="prize">
      ${meta.image ? `<img src="${esc(meta.image)}" alt="${esc(meta.name)}">` : `<div class="card">No image</div>`}
      ${meta.onchain ? `<span class="badge">Fully onchain</span>` : ""}
      <div class="prize-name">${esc(meta.name)}</div>
      ${CONFIG.testnet ? "" : `<a class="small" href="${CONFIG.opensea}${live.prizeTokenId}" target="_blank" rel="noopener">View on OpenSea</a>`}
    </div>
    <div>
      <div class="status-head"><h3>Giveaway #${live.no}</h3>${statusChip(live)}</div>
      ${live.minHolding > 1 ? `<p class="rule">Hold <b>${live.minHolding}+ Zombies</b> at the draw to win</p>` : ""}
      ${live.status === "open" && !isClosed(live) ? `<div class="countdown" data-closes="${live.closesAt}"></div>` : ""}
      ${winnerHtml}
      ${timeline(live)}
      <dl class="kv">${kv.join("")}</dl>
      <div class="actions">
        ${canDraw ? `<button class="btn big draw-btn">Draw the winner</button>` : ""}
        ${canFinish ? `<button class="btn big finish-btn">Finish payout</button>` : ""}
      </div>
      ${canDraw ? `<p class="muted small">The Graveyard keeper draws automatically within a few minutes of the close. If it hasn't yet, anyone can press this: the Chainlink fee is prepaid, you only pay gas (a cent or less).</p>` : ""}
      ${live.status === "drawing" ? `<p class="muted small">Waiting for Chainlink. This page updates by itself.</p>` : ""}
      <div class="note action-out"></div>
    </div>
  </div>`;
}

async function renderLog() {
  const el = $("logBody");
  const done = [...giveaways].filter((g) => g.status !== "none").reverse();
  if (done.length === 0) {
    el.innerHTML = `<p class="muted">No Zombies have risen from the Graveyard yet.</p>`;
    return;
  }
  const cards = await Promise.all(done.map(async (g) => {
    const meta = await tokenMeta(g.prizeTokenId);
    const result = g.status === "completed"
      ? `<div class="line"><span>Winner</span><b>${addrLink(g.winner)}</b></div>
         <div class="line"><span>Winning ticket</span><b>Zombie #${g.winningTokenId}</b></div>
         <div class="line"><span>Date</span><b>${new Date(Number(g.completedAt) * 1000).toLocaleDateString()}</b></div>`
      : `<div class="line"><span>Status</span><b>${g.status}</b></div>`;
    return `<div class="grave">
      ${meta.image ? `<img src="${esc(meta.image)}" alt="${esc(meta.name)}" loading="lazy">` : ""}
      <div class="body">
        <div class="title">#${g.no} · ${esc(meta.name)}</div>
        ${result}
        ${g.minHolding > 1 ? `<div class="line"><span>Open to</span><b>${g.minHolding}+ Zombies</b></div>` : g.tickets ? `<div class="line"><span>Tickets</span><b>${g.tickets}</b></div>` : ""}
      </div></div>`;
  }));
  el.innerHTML = cards.join("");
}

function renderHeroStats() {
  const completed = giveaways.filter((g) => g.status === "completed");
  const tickets = completed.reduce((a, g) => a + g.tickets, 0);
  const stat = (num, lbl) => `<div class="stat"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;
  $("heroStats").innerHTML =
    stat(completed.length, "Zombies given back") +
    stat(tickets, "Tickets drawn from") +
    stat("VRF v2.5", "Chainlink") +
    stat(CONFIG.chainName, "Network");
  const parts = [];
  if (CONFIG.RAFFLE_V3) parts.push(`Raffle v3: ${plainLink(CONFIG.RAFFLE_V3)}`);
  if (CONFIG.RAFFLE) parts.push(`Raffle v2: ${plainLink(CONFIG.RAFFLE)}`);
  if (CONFIG.RAFFLE_V1) parts.push(`Raffle v1 (giveaway #0): ${plainLink(CONFIG.RAFFLE_V1)}`);
  parts.push(`Zombies On Base: ${plainLink(CONFIG.ZOMBIES)}`);
  $("contracts").innerHTML = parts.join(" · ");
}

async function refresh() {
  try {
    await loadGiveaways();
    if (START.address) raffleOwner = await pub.readContract({ address: START.address, abi: START.abi, functionName: "owner" });
    renderHeroStats();
    await Promise.all([renderCurrent(), renderLog()]);
    applyNames();
    const isOwner = !!(account && raffleOwner && account.toLowerCase() === raffleOwner.toLowerCase());
    $("admin").hidden = !isOwner;
    if (isOwner) renderCancelChoices();
    $("navAdmin").hidden = !isOwner;
  } catch (e) {
    $("currentBody").innerHTML = `<div class="card"><p class="note err">Could not read from Base: ${errText(e)}</p></div>`;
  }
}

// ---------------------------------------------------------------- wallet

// Wallet picker shared with the other edonchain.art tools (EIP-6963 + mobile wallet links).
const walletConn = createWallet({
  chain: { id: CONFIG.chainId, name: CONFIG.chainName, rpc: CONFIG.rpc, explorer: CONFIG.explorer },
  onChange: (address, { wrongChain } = {}) => {
    account = address ? getAddress(address) : null;
    wallet = address ? createWalletClient({ account, chain, transport: custom(walletConn.provider) }) : null;
    const btn = $("connect");
    btn.textContent = account ? `${short(account)}${wrongChain ? " · wrong network" : ""}` : "Connect Wallet";
    btn.classList.toggle("connected", !!account);
    if (account) {
      const mine = account;
      nameOf(mine).then((n) => {
        if (n && account === mine) btn.textContent = `${n}${wrongChain ? " · wrong network" : ""}`;
      });
    }
    refresh();
  },
});

async function send(out, request) {
  if (!wallet) {
    walletConn.open($("connect"));
    say(out, "Connect your wallet first, then press the button again.", "warn");
    return null;
  }
  await walletConn.ensureChain();
  say(out, "Simulating…", "warn");
  const { result, request: req } = await pub.simulateContract({ account, ...request });
  say(out, "Confirm in your wallet…", "warn");
  const hash = await wallet.writeContract(req);
  say(out, `Sent ${txLink(hash)} · waiting for confirmation…`, "warn");
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  return { hash, result };
}

// ---------------------------------------------------------------- actions (v2)

/** VRF fee quoted at 2x today's gas price (the real fee depends on the draw transaction's gas price). */
async function quoteFee(address, abi) {
  const gasPrice = (await pub.getGasPrice()) * 2n;
  const raw = await pub.call({ to: address, data: encodeFunctionData({ abi, functionName: "drawPrice" }), gasPrice });
  return decodeFunctionResult({ abi, functionName: "drawPrice", data: raw.data });
}

async function drawWinner(g, out) {
  try {
    // Normally the prepaid deposit covers the fee; if gas spiked, top up the shortfall (excess refunded).
    const quote = await quoteFee(g.raffle, abiOf(g));
    const value = quote > g.feeDeposit ? (quote - g.feeDeposit) * 2n : 0n;
    const r = await send(out, { address: g.raffle, abi: abiOf(g), functionName: "draw", args: [BigInt(g.id)], value });
    if (r) say(out, `Draw requested ${txLink(r.hash)}. Chainlink usually answers within seconds…`, "ok");
    await refresh();
  } catch (e) {
    say(out, errText(e), "err");
  }
}

async function finishPayout(g, out) {
  try {
    const r = await send(out, { address: g.raffle, abi: abiOf(g), functionName: "continuePayout", args: [BigInt(g.id)] });
    if (r) say(out, `Payout sent ${txLink(r.hash)}`, "ok");
    await refresh();
  } catch (e) {
    say(out, errText(e), "err");
  }
}

const polling = new Set(); // giveaway numbers being watched
function pollUntilChanged(g) {
  if (polling.has(g.no)) return;
  polling.add(g.no);
  let n = 0;
  const t = setInterval(async () => {
    n++;
    const cur = await pub.readContract({ address: g.raffle, abi: abiOf(g), functionName: "getGiveaway", args: [BigInt(g.id)] }).catch(() => null);
    if ((cur && V2_STATUS[cur.status] !== "drawing") || n > 120) {
      clearInterval(t);
      polling.delete(g.no);
      refresh();
    }
  }, 4000);
}

// ---------------------------------------------------------------- eligibility check

$("checkForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const out = $("checkOut");
  const a = $("checkAddr").value.trim();
  let addr;
  if (isAddress(a)) addr = getAddress(a);
  else if (/^[^\s]+\.[a-z]+$/i.test(a)) {
    say(out, `Looking up ${esc(a)}…`, "warn");
    addr = await addressOf(a);
    if (!addr) return say(out, `${esc(a)} doesn't point to a wallet.`, "err");
  } else return say(out, "Enter a wallet address, an ENS name or a Basename.", "err");
  try {
    const who = isAddress(a) ? addrLink(addr) : `${esc(a.toLowerCase())} (${plainLink(addr)})`;
    const won = giveaways.filter((g) => g.status === "completed" && g.winner.toLowerCase() === addr.toLowerCase());
    if (won.length) {
      say(out, `🧟 ${who} won ${won.map((g) => `giveaway #${g.no} with Zombie #${g.winningTokenId}`).join(" and ")}.`, "ok");
      return applyNames(out);
    }
    if (raffleOwner && addr.toLowerCase() === raffleOwner.toLowerCase()) {
      say(out, `${who} is the collection owner wallet. Its Zombies never count as tickets.`, "err");
      return applyNames(out);
    }
    const bal = await pub.readContract({ address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "balanceOf", args: [addr] });
    const openList = giveaways.filter((g) => g.v >= 2 && g.status === "open");
    const ok = openList.filter((g) => bal >= BigInt(g.minHolding));
    const below = openList.filter((g) => bal < BigInt(g.minHolding));
    const holds = `${who} holds ${bal} Zombie${bal === 1n ? "" : "s"} right now`;
    const nums = (list) => list.map((g) => `#${g.no}`).join(", ");
    if (bal === 0n) {
      say(out, `No Zombies in ${who} right now, so no tickets.`, "err");
    } else if (openList.length === 0) {
      say(out, `${holds} = ${bal} ticket${bal > 1n ? "s" : ""} in the next giveaway, if it's open to wallets this size.`, "ok");
    } else {
      const parts = [];
      if (ok.length) {
        parts.push(`${bal} ticket${bal > 1n ? "s" : ""} in ${ok.length > 1 ? `each of giveaways ${nums(ok)}` : `giveaway ${nums(ok)}`}, as long as they're still in this wallet at the draw`);
      }
      for (const g of below) parts.push(`giveaway #${g.no} needs ${g.minHolding}+ Zombies at the draw, so this wallet needs ${BigInt(g.minHolding) - bal} more to qualify`);
      say(out, `${holds}: ${parts.join("; ")}.`, ok.length ? "ok" : "err");
    }
    applyNames(out);
  } catch (e) {
    say(out, errText(e), "err");
  }
};

// ---------------------------------------------------------------- admin (v2)

$("aStart").onclick = async () => {
  const out = $("aStartOut");
  try {
    const prize = BigInt($("aPrize").value.trim());
    const closes = Math.floor(new Date($("aCloses").value).getTime() / 1000);
    if (!closes || closes <= Date.now() / 1000) throw new Error("Pick a close time in the future.");
    const deposit = parseEther($("aFee").value.trim() || "0");
    if (deposit <= 0n) throw new Error("Add a small ETH deposit for the Chainlink fee.");
    const minHolding = Number($("aMin").value.trim() || "1");
    if (!Number.isInteger(minHolding) || minHolding < 1) throw new Error("Minimum Zombies to win must be 1 or more.");
    if (START.v === 2 && minHolding > 1) throw new Error("A minimum above 1 needs GraveyardRaffleV3, which isn't set up on this page yet.");
    const quote = await quoteFee(START.address, START.abi).catch(() => 0n);
    if (quote && deposit < quote) throw new Error(`Deposit at least ${formatEther(quote)} ETH (today's fee at 2x gas). Unused ETH is refunded at the draw.`);
    const open = minHolding > 1 ? `wallets holding ${minHolding}+ Zombies` : "every holder";
    if (!confirm(`Lock Zombie #${prize} in the raffle until ${new Date(closes * 1000).toLocaleString()} with a ${formatEther(deposit)} ETH fee deposit? Open to ${open}.`)) return;

    if (!wallet) return void (await send(out, {}));
    const approved = await pub.readContract({ address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "isApprovedForAll", args: [account, START.address] });
    if (!approved) {
      say(out, "One-time step: allow the raffle contract to move the Zombie you choose as a prize…", "warn");
      const a = await send(out, { address: CONFIG.ZOMBIES, abi: zombiesAbi, functionName: "setApprovalForAll", args: [START.address, true] });
      if (!a) return;
    }
    const r = await send(out, {
      address: START.address, abi: START.abi, functionName: "startGiveaway",
      args: START.v === 3 ? [prize, BigInt(closes), minHolding] : [prize, BigInt(closes)], value: deposit,
    });
    if (r) say(out, `Giveaway started ${txLink(r.hash)}`, "ok");
    await refresh();
  } catch (e) {
    say(out, errText(e), "err");
  }
};

function renderCancelChoices() {
  const sel = $("aCancelNo");
  const keep = sel.value;
  const open = giveaways.filter((g) => g.v >= 2 && g.status === "open");
  sel.innerHTML = open.length
    ? open.map((g) => `<option value="${g.no}">#${g.no} · Zombie #${g.prizeTokenId} · closes ${esc(fmtDate(g.closesAt))}</option>`).join("")
    : `<option value="">No open giveaway</option>`;
  if (open.some((g) => String(g.no) === keep)) sel.value = keep;
  sel.disabled = $("aCancel").disabled = open.length === 0;
}

$("aCancel").onclick = async () => {
  const out = $("aCancelOut");
  const g = giveaways.find((x) => x.v >= 2 && x.status === "open" && String(x.no) === $("aCancelNo").value);
  if (!g) return say(out, "There's no open giveaway to cancel.", "err");
  if (!confirm(`Cancel giveaway #${g.no} and return Zombie #${g.prizeTokenId} and the fee deposit to your wallet?`)) return;
  try {
    const r = await send(out, { address: g.raffle, abi: abiOf(g), functionName: "cancel", args: [BigInt(g.id)] });
    if (r) say(out, `Cancelled ${txLink(r.hash)}`, "ok");
    await refresh();
  } catch (e) {
    say(out, errText(e), "err");
  }
};

// ---------------------------------------------------------------- boot

if (CONFIG.testnet) {
  const bar = document.createElement("div");
  bar.className = "testnet-bar";
  bar.textContent = `Test mode · ${CONFIG.chainName} · not real Zombies`;
  document.querySelector(".content").prepend(bar);
}

$("connect").onclick = (e) => walletConn.open(e.currentTarget);
// Admin default: close 24 hours from now (local time, minutes precision).
{
  const t = new Date(Date.now() + 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  if (!$("aCloses").value) $("aCloses").value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
refresh();
setInterval(refresh, 60_000);

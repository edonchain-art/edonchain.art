// Shared wallet connection for edonchain.art tools, ported from onchainusers.art.
//
// - EIP-6963 discovery: lists every installed wallet (MetaMask, Rabby, Coinbase, Phantom, …)
//   instead of trusting window.ethereum, which another extension may have taken over.
// - Phones: a normal mobile browser has no wallet, so the picker offers links that open
//   this page inside the MetaMask, Coinbase Wallet, Trust Wallet or Phantom app.
// - wallet_requestPermissions (account chooser) on desktop only; some mobile wallets never
//   answer it and the connection would hang.
// - Switches to the page's chain, adding it to the wallet first if needed.
// - Optional sign-in: a free EIP-4361-style signature proving the wallet belongs to the user.
//
// Usage:
//   const w = createWallet({ chain, signIn: false, verify, onChange });
//   button.onclick = (e) => w.open(e.currentTarget);
//   w.provider / w.address once connected; onChange(address|null) on connect/disconnect.

const discovered = []; // { info: { uuid, name, icon, rdns }, provider }
window.addEventListener("eip6963:announceProvider", (event) => {
  const { info, provider } = event.detail || {};
  if (info && provider && !discovered.some((w) => w.info.uuid === info.uuid)) discovered.push({ info, provider });
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

export const IS_MOBILE =
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function availableProviders() {
  if (discovered.length > 0) return discovered;
  // Wallets that don't support EIP-6963 yet (and most in-app wallet browsers)
  if (window.ethereum) return [{ info: { name: "Browser Wallet", icon: "" }, provider: window.ethereum }];
  return [];
}

/** Links that open the current page inside each wallet app's built-in browser. */
function mobileWalletLinks() {
  const url = location.href.split("#")[0];
  const noProtocol = url.replace(/^https?:\/\//, "");
  const enc = encodeURIComponent(url);
  return [
    { name: "MetaMask", href: "https://metamask.app.link/dapp/" + noProtocol },
    { name: "Coinbase Wallet", href: "https://go.cb-w.com/dapp?cb_url=" + enc },
    { name: "Trust Wallet", href: "https://link.trustwallet.com/open_url?coin_id=60&url=" + enc },
    { name: "Phantom", href: "https://phantom.app/ul/browse/" + enc + "?ref=" + encodeURIComponent(location.origin) },
  ];
}

function signInMessage(address, chainId) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    `${location.host} wants you to sign in with your Ethereum account:\n${address}\n\n` +
    `Sign to confirm this wallet belongs to you. This is free: it does not send a transaction or cost gas.\n\n` +
    `URI: ${location.origin}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`
  );
}

const toHex = (s) => "0x" + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

/** Friendly text for common wallet errors. */
export function walletErrorText(err) {
  const code = err && (err.code ?? err.cause?.code ?? err.info?.error?.code);
  if (code === 4001 || code === "ACTION_REJECTED") return "Cancelled in the wallet.";
  if (code === -32002) return "Your wallet already has a request open. Open the wallet to finish or close it, then try again.";
  return (err && (err.shortMessage || err.message)) || "Couldn't connect the wallet. Please try again.";
}

export function createWallet({ chain, signIn = false, verify, onChange = () => {} }) {
  const chainHex = "0x" + chain.id.toString(16);
  const state = { provider: null, address: null, info: null };

  async function ensureChain(provider) {
    const current = await provider.request({ method: "eth_chainId" });
    if (parseInt(current, 16) === chain.id) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
    } catch (e) {
      const code = e && (e.code ?? e.data?.originalError?.code);
      if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e && e.message))) throw e;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chainHex,
          chainName: chain.name,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [chain.rpc],
          blockExplorerUrls: [chain.explorer],
        }],
      });
    }
  }

  async function connectWith({ provider, info }) {
    if (!IS_MOBILE) {
      try {
        await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      } catch (e) {
        if ((e && e.code) === 4001) throw e; // user closed the account chooser
      }
    }
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) throw new Error("The wallet didn't share an account.");
    const address = accounts[0];
    await ensureChain(provider);

    if (signIn) {
      const message = signInMessage(address, chain.id);
      let signature;
      try {
        signature = await provider.request({ method: "personal_sign", params: [toHex(message), address] });
      } catch (e) {
        if ((e && e.code) === 4001) throw new Error("Signature declined. Sign the message to confirm this wallet is yours.");
        throw e;
      }
      if (!verify || !(await verify({ address, message, signature }))) {
        throw new Error("The signature doesn't match this wallet. Please try again.");
      }
    }

    state.provider = provider;
    state.address = address;
    state.info = info;
    if (provider.on && !provider.__edWatching) {
      provider.__edWatching = true;
      provider.on("accountsChanged", (accs) => {
        if (state.provider !== provider) return;
        if (!accs || !accs.length || accs[0].toLowerCase() !== String(state.address).toLowerCase()) disconnect();
      });
      provider.on("chainChanged", (id) => {
        if (state.provider === provider && parseInt(id, 16) !== chain.id) onChange(state.address, { wrongChain: true });
      });
    }
    onChange(state.address, {});
  }

  function disconnect() {
    // Clears this page's session. Wallets don't let a site revoke its own access;
    // to remove the site completely, disconnect it inside the wallet too.
    state.provider = null;
    state.address = null;
    state.info = null;
    onChange(null, {});
  }

  function closePicker() {
    document.querySelectorAll(".wallet-picker-menu").forEach((el) => el.remove());
  }

  async function connectAndReport(entry) {
    try {
      await connectWith(entry);
    } catch (err) {
      console.error(err);
      alert(walletErrorText(err));
    }
  }

  function item(tag, label, icon) {
    const el = document.createElement(tag);
    el.className = "wallet-picker-item";
    if (tag === "button") el.type = "button";
    if (typeof icon === "string" && icon.startsWith("data:image/")) {
      const img = document.createElement("img");
      img.src = icon;
      img.alt = "";
      el.appendChild(img);
    }
    const span = document.createElement("span");
    span.textContent = String(label);
    el.appendChild(span);
    return el;
  }

  /** Open the wallet picker next to a button (or connect straight away if there's one wallet). */
  function open(anchor) {
    closePicker();
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const providers = availableProviders();

    if (!state.address) {
      if (providers.length === 0 && !IS_MOBILE) {
        alert("No wallet found. Install MetaMask, Rabby, Coinbase Wallet, Phantom or another Ethereum wallet to connect.");
        return;
      }
      if (providers.length === 1) {
        connectAndReport(providers[0]);
        return;
      }
    }

    const menu = document.createElement("div");
    menu.className = "wallet-picker-menu";
    const note = (text) => {
      const n = document.createElement("div");
      n.className = "wallet-picker-note";
      n.textContent = text;
      menu.appendChild(n);
    };

    if (state.address) {
      note(`Connected${state.info?.name ? " with " + state.info.name : ""}: ${state.address.slice(0, 6)}…${state.address.slice(-4)}`);
      const d = item("button", "Disconnect");
      d.addEventListener("click", () => { closePicker(); disconnect(); });
      menu.appendChild(d);
      if (providers.length > 1) note("Or switch wallet:");
    } else if (providers.length === 0) {
      note("Open this page in your wallet app to connect:");
      mobileWalletLinks().forEach(({ name, href }) => {
        const a = item("a", name);
        a.href = href;
        a.rel = "noopener";
        menu.appendChild(a);
      });
    } else {
      note("Choose a wallet:");
    }

    providers.forEach((entry) => {
      if (state.provider === entry.provider) return;
      const b = item("button", entry.info.name || "Wallet", entry.info.icon);
      b.addEventListener("click", () => { closePicker(); connectAndReport(entry); });
      menu.appendChild(b);
    });

    const parent = anchor.parentElement;
    parent.style.position = "relative";
    // Near the bottom of the screen (e.g. a sidebar footer) the menu opens upwards.
    if (anchor.getBoundingClientRect().top > window.innerHeight / 2) menu.classList.add("up");
    parent.appendChild(menu);
    setTimeout(() => {
      document.addEventListener("click", function outside(e) {
        if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
          closePicker();
          document.removeEventListener("click", outside);
        }
      });
    }, 0);
  }

  return {
    open,
    disconnect,
    ensureChain: () => state.provider && ensureChain(state.provider),
    get provider() { return state.provider; },
    get address() { return state.address; },
  };
}

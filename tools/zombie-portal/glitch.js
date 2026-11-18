// The Zombie Portal glitch engine: decodes the onchain art blob and renders the SVG.
//
// This file is the reference for GlitchedZombieRenderer.sol: every byte of SVG it produces must match the
// contract's previewSVG(art, mix, seed) (checked by test/GlitchParity.t.sol). Integer math only.
//
// A glitch "mix" is 8 strengths, 0-100, one per effect, packed into a uint64 (byte i = effect i + 1):
//   1 Block Corruption, 2 Pixel Sort, 3 Smear, 4 Scan Tear, 5 RGB Split, 6 Ghost Signal, 7 Line Dropout,
//   8 Corrupt Band. mix = 0 means no glitch. The seed only moves things around (where bands land).
// Static art: every active effect is baked into the pixels, in that order.
// Animated art: effects 4-8 become animated layers; effects 1-3 must be 0.

export const EFFECTS = ["Block Corruption", "Pixel Sort", "Smear", "Scan Tear", "RGB Split", "Ghost Signal",
  "Line Dropout", "Corrupt Band"];
export const ANIMATED_EFFECTS = [3, 4, 5, 6, 7]; // indexes into EFFECTS usable on animated art

// ---------------------------------------------------------------- mix packing
export function packMix(levels) {
  let m = 0n;
  levels.forEach((v, i) => { m |= BigInt(v & 255) << BigInt(8 * i); });
  return m;
}
export function unpackMix(mix) {
  const m = BigInt(mix);
  return Array.from({ length: 8 }, (_, i) => Number((m >> BigInt(8 * i)) & 255n));
}
export function validMix(frames, levels) {
  if (levels.length !== 8 || levels.some((v) => !Number.isInteger(v) || v < 0 || v > 100)) return false;
  return frames === 1 || (levels[0] === 0 && levels[1] === 0 && levels[2] === 0);
}

// ---------------------------------------------------------------- blob
export function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function decodeArt(b) {
  if (b[0] !== 1) throw new Error("unknown art version");
  const n = b[1], frames = b[2];
  let o = 3;
  const durations = [];
  for (let k = 0; k < frames; k++) { durations.push((b[o] << 8) | b[o + 1]); o += 2; }
  const pc = (b[o] << 8) | b[o + 1]; o += 2;
  const palette = [];
  for (let i = 0; i < pc; i++) { palette.push((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]); o += 3; }
  const runs = [];
  for (let k = 0; k < frames; k++) {
    const rc = (b[o] << 8) | b[o + 1]; o += 2;
    runs.push(b.subarray(o, o + rc * 4)); o += rc * 4;
  }
  if (o !== b.length) throw new Error("bad art length");
  return { n, frames, durations, palette, runs };
}

export function framePixels(art) {
  const { n, palette, runs } = art;
  const px = new Array(n * n).fill(palette[0]);
  const r = runs[0];
  for (let i = 0; i < r.length; i += 4) {
    const c = palette[r[i + 3]];
    for (let x = r[i]; x < r[i] + r[i + 2]; x++) px[r[i + 1] * n + x] = c;
  }
  return px;
}

// ---------------------------------------------------------------- rng (xorshift32), one stream per effect
function rng(seed, effect) {
  let s = ((seed >>> 0) ^ Math.imul(effect + 1, 0x9E3779B9)) >>> 0;
  if (s === 0) s = 0x6D2B79F5;
  const next = () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s;
  };
  const ri = (a, b) => a + (next() % (b - a + 1));
  return { next, ri };
}

const lum = (c) => 299 * (c >>> 16) + 587 * ((c >>> 8) & 255) + 114 * (c & 255);
const sc = (a, k) => Math.floor((a * k) / 100); // scale a 0-100 strength

// ---------------------------------------------------------------- baked effects (static art)
function bakeEffect(px, n, bg, e, a, seed) {
  const { next, ri } = rng(seed, e);
  const cp = px.slice();
  if (e === 0) { // Block Corruption
    for (let k = 2 + sc(a, 14); k > 0; k--) {
      const w = ri(4, 6 + sc(a, 14)), h = ri(1, 3), sx = ri(0, n - w), sy = ri(0, n - h), dx = ri(0, n - w), dy = ri(0, n - h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[(dy + y) * n + dx + x] = cp[(sy + y) * n + sx + x];
    }
  } else if (e === 1) { // Pixel Sort
    for (let k = 3 + sc(a, 30); k > 0; k--) {
      const y = ri(0, n - 1), x0 = ri(0, n - 8), len = ri(6, 10 + sc(a, 40)), x1 = Math.min(n - 1, x0 + len);
      for (let i = x0 + 1; i <= x1; i++) {
        const c = px[y * n + i], lc = lum(c);
        let j = i;
        while (j > x0 && lum(px[y * n + j - 1]) > lc) { px[y * n + j] = px[y * n + j - 1]; j--; }
        px[y * n + j] = c;
      }
    }
  } else if (e === 2) { // Smear
    for (let k = 2 + sc(a, 16); k > 0; k--) {
      const y0 = ri(0, n - 1), h = ri(1, 1 + sc(a, 3)), x0 = ri(8, n - 12), len = ri(6, 10 + sc(a, 40));
      for (let y = y0; y < Math.min(n, y0 + h); y++) {
        const c = px[y * n + x0];
        for (let x = x0; x < Math.min(n, x0 + len); x++) px[y * n + x] = c;
      }
    }
  } else if (e === 3) { // Scan Tear
    for (let k = 2 + sc(a, 10); k > 0; k--) {
      const y0 = ri(0, n - 1), h = ri(1, 3 + sc(a, 7)), neg = next() & 1, mag = ri(2, 4 + sc(a, 16)), d = neg ? n - mag : mag;
      for (let y = y0; y < Math.min(n, y0 + h); y++) for (let x = 0; x < n; x++) px[y * n + x] = cp[y * n + (x + n - d) % n];
    }
  } else if (e === 4) { // RGB Split
    const d = 1 + sc(a, 2);
    const bands = [];
    if (a > 80) bands.push([0, n]);
    else for (let k = 1 + sc(a, 6); k > 0; k--) { const y = ri(0, n - 1), h = ri(2, 4 + sc(a, 10)); bands.push([y, Math.min(n, y + h)]); }
    for (const [y0, y1] of bands) for (let y = y0; y < y1; y++) for (let x = 0; x < n; x++) {
      const xr = Math.min(n - 1, x + d), xb = x >= d ? x - d : 0;
      px[y * n + x] = (cp[y * n + xr] & 0xff0000) | (cp[y * n + x] & 0x00ff00) | (cp[y * n + xb] & 0x0000ff);
    }
  } else if (e === 5) { // Ghost Signal
    const d = 1 + sc(a, 3), full = a > 70;
    const y0 = full ? 0 : ri(0, n >>> 1), y1 = full ? n : Math.min(n, y0 + 16 + sc(a, 40));
    for (let y = y0; y < y1; y++) for (let x = 0; x < n; x++) {
      if (cp[y * n + x] !== bg) continue;
      if (x + d < n && cp[y * n + x + d] !== bg) px[y * n + x] = 0xff2ea0;
      else if (x >= d && cp[y * n + x - d] !== bg) px[y * n + x] = 0x28f0ff;
    }
  } else if (e === 6) { // Line Dropout
    for (let k = 1 + sc(a, 10); k > 0; k--) {
      const y = ri(0, n - 1), h = ri(1, 1 + sc(a, 2)), step = (next() & 1) + 1;
      for (let j = 0; j < h; j++) { const yy = y + j * step; if (yy < n) for (let x = 0; x < n; x++) px[yy * n + x] = bg; }
    }
  } else if (e === 7) { // Corrupt Band
    for (let k = 1 + sc(a, 5); k > 0; k--) {
      const y0 = ri(0, n - 1), h = ri(2, 3 + sc(a, 9)), mode = ri(0, 2);
      for (let y = y0; y < Math.min(n, y0 + h); y++) for (let x = 0; x < n; x++) {
        const c = px[y * n + x], r = c >>> 16, g = (c >>> 8) & 255, b = c & 255;
        px[y * n + x] = mode === 0 ? c ^ 0xffffff : mode === 1 ? (b << 16) | (r << 8) | g : (g << 16) | (b << 8) | r;
      }
    }
  }
}

// ---------------------------------------------------------------- svg
const hex6 = (c) => c.toString(16).padStart(6, "0");
const rect = (x, y, w, c) => `<rect x="${x}" y="${y}" width="${w}" height="1" fill="#${hex6(c)}"/>`;
const pct2 = (v) => `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}`;
const HEAD = (n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`;

function pixelRuns(px, n, bg) {
  let s = "";
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      const c = px[y * n + x];
      let w = 1;
      while (x + w < n && px[y * n + x + w] === c) w++;
      if (c !== bg) s += rect(x, y, w, c);
      x += w;
    }
  }
  return s;
}

function blobRuns(r, palette) {
  let s = "";
  for (let i = 0; i < r.length; i += 4) s += rect(r[i], r[i + 1], r[i + 2], palette[r[i + 3]]);
  return s;
}

/**
 * @param mix     bigint|number|string (uint64) or an array of 8 strengths
 * @param animate static art only: bake effects 1-3 into the pixels and play effects 4-8 as animation
 *                (the token's "Animated" trait becomes "yes"). Ignored for art that is already animated.
 * @param speed   1-10, how often the animated glitches fire (4 = default pace, 10 = 2.5x faster, 1 = 4x slower)
 */
export function renderSVG(artBytes, mix = 0n, seed = 0, animate = false, speed = 4) {
  const levels = Array.isArray(mix) ? mix : unpackMix(mix);
  const art = decodeArt(artBytes);
  const { n, palette } = art, bg = palette[0];
  if (art.frames > 1) return animatedSVG(art, levels, seed, speed);
  if (animate) {
    const px = framePixels(art);
    for (let e = 0; e < 8; e++) if (levels[e]) bakeEffect(px, n, bg, e, levels[e], seed);
    return layeredSVG(n, bg, "", pixelRuns(px, n, bg), levels, seed, speed);
  }
  let body;
  if (levels.every((v) => v === 0)) body = blobRuns(art.runs[0], palette);
  else {
    const px = framePixels(art);
    for (let e = 0; e < 8; e++) if (levels[e]) bakeEffect(px, n, bg, e, levels[e], seed);
    body = pixelRuns(px, n, bg);
  }
  return `${HEAD(n)}<rect width="${n}" height="${n}" fill="#${hex6(bg)}"/>${body}</svg>`;
}

function animatedSVG(art, levels, seed, speed) {
  const { palette, durations, runs } = art;
  const T = durations.reduce((a, b) => a + b, 0);
  let style = "";
  const seen = [];
  for (let k = 1; k < art.frames; k++) {
    const d = durations[k];
    if (seen.includes(d)) continue;
    seen.push(d);
    style += `@keyframes f${d}{0%{visibility:visible}${pct2(Math.floor((d * 10000) / T))}%{visibility:hidden}}`;
  }
  let frames = blobRuns(runs[0], palette), start = durations[0];
  for (let k = 1; k < art.frames; k++) {
    frames += `<g style="visibility:hidden;animation:f${durations[k]} ${T}ms step-end ${start}ms infinite">${blobRuns(runs[k], palette)}</g>`;
    start += durations[k];
  }
  return layeredSVG(art.n, palette[0], style, frames, levels, seed, speed);
}

/** Art (frames or a single baked image) inside <g id="s">, with effects 4-8 as animated layers. */
function layeredSVG(n, bg, frameStyle, frames, levels, seed, speed) {
  const sp = (ms) => Math.floor((ms * 4) / (speed >= 1 && speed <= 10 ? speed : 4)); // period scaled by speed
  let defs = "", style = frameStyle, under = "", over = "";
  const a4 = levels[3], a5 = levels[4], a6 = levels[5], a7 = levels[6], a8 = levels[7];
  if (a4) { // Scan Tear
    const { ri } = rng(seed, 3);
    for (let k = 0; k < 1 + sc(a4, 4); k++) {
      const y = ri(0, n - 6), h = ri(2, 3 + sc(a4, 8)), per = sp(ri(1500, 4000)), p = ri(55, 85), A = ri(2, 3 + sc(a4, 10)), B = ri(2, 3 + sc(a4, 10));
      defs += `<clipPath id="c${k}"><rect y="${y}" width="${n}" height="${h}"/></clipPath>`;
      style += `.t${k}{animation:t${k} ${per}ms steps(1) infinite}@keyframes t${k}{0%,${p}%{transform:none}${p + 4}%{transform:translateX(${A}px)}${p + 8}%{transform:translateX(-${B}px)}${p + 12}%,100%{transform:none}}`;
      over += `<use href="#z" clip-path="url(#c${k})" class="t${k}"/>`;
    }
  }
  if (a5) { // RGB Split
    const { ri } = rng(seed, 4);
    const per = sp(ri(1200, 3000)), p = ri(50, 80), d = 1 + sc(a5, 2), len = 3 + sc(a5, 9);
    defs += `<filter id="r"><feColorMatrix values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"/></filter><filter id="c"><feColorMatrix values="0 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/></filter>`;
    style += `.r,.c{opacity:0;mix-blend-mode:screen}.r{animation:r ${per}ms steps(1) infinite}.c{animation:c ${per}ms steps(1) infinite}`
      + `@keyframes r{0%,${p}%{opacity:0;transform:none}${p + 1}%,${p + len}%{opacity:.55;transform:translateX(${d}px)}${p + len + 1}%,100%{opacity:0;transform:none}}`
      + `@keyframes c{0%,${p}%{opacity:0;transform:none}${p + 1}%,${p + len}%{opacity:.55;transform:translateX(-${d}px)}${p + len + 1}%,100%{opacity:0;transform:none}}`;
    over += `<use href="#s" class="r" filter="url(#r)"/><use href="#s" class="c" filter="url(#c)"/>`;
  }
  if (a6) { // Ghost Signal
    const { ri } = rng(seed, 5);
    const per = sp(ri(1500, 3500)), p = ri(40, 75), d = 1 + sc(a6, 3), len = 5 + sc(a6, 15);
    defs += `<filter id="m"><feColorMatrix values="0 0 0 0 1 0 0 0 0 0.18 0 0 0 0 0.63 0 0 0 1 0"/></filter><filter id="n"><feColorMatrix values="0 0 0 0 0.16 0 0 0 0 0.94 0 0 0 0 1 0 0 0 1 0"/></filter>`;
    style += `.g{opacity:0;animation:g ${per}ms steps(1) infinite}@keyframes g{0%,${p}%{opacity:0}${p + 1}%,${p + len}%{opacity:1}${p + len + 1}%,100%{opacity:0}}`;
    under += `<use href="#s" class="g" filter="url(#m)" transform="translate(${d})"/><use href="#s" class="g" filter="url(#n)" transform="translate(-${d})"/>`;
  }
  if (a7) { // Line Dropout
    const { ri } = rng(seed, 6);
    for (let k = 0; k < 1 + sc(a7, 9); k++) {
      const y = ri(0, n - 1), h = ri(1, 1 + sc(a7, 2)), per = sp(ri(700, 2500)), p = ri(30, 90);
      style += `.d${k}{opacity:0;animation:d${k} ${per}ms steps(1) infinite}@keyframes d${k}{0%,${p}%{opacity:0}${p + 1}%,${p + 8}%{opacity:1}${p + 9}%,100%{opacity:0}}`;
      over += `<rect class="d${k}" y="${y}" width="${n}" height="${h}" fill="#${hex6(bg)}"/>`;
    }
  }
  if (a8) { // Corrupt Band
    const { ri } = rng(seed, 7);
    defs += `<filter id="i"><feColorMatrix values="-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0"/></filter>`;
    for (let k = 0; k < 1 + sc(a8, 4); k++) {
      const y = ri(0, n - 4), h = ri(2, 3 + sc(a8, 9)), per = sp(ri(1500, 4000)), p = ri(50, 85);
      defs += `<clipPath id="k${k}"><rect y="${y}" width="${n}" height="${h}"/></clipPath>`;
      style += `.x${k}{opacity:0;animation:x${k} ${per}ms steps(1) infinite}@keyframes x${k}{0%,${p}%{opacity:0}${p + 1}%,${p + 10}%{opacity:1}${p + 11}%,100%{opacity:0}}`;
      over += `<use href="#z" clip-path="url(#k${k})" filter="url(#i)" class="x${k}"/>`;
    }
  }
  return `${HEAD(n)}<defs>${defs}</defs><style>${style}</style><g id="z"><rect width="${n}" height="${n}" fill="#${hex6(bg)}"/>${under}<g id="s">${frames}</g></g>${over}</svg>`;
}

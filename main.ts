// png-squeeze: a small lossless PNG re-encoder for 1280x720 RGBA screenshots.
//
// What it does, in plain steps:
//   1. Read each stored RGBA PNG from /input/<id>/image.png and inflate it.
//   2. Look at the pixels: are they all opaque? all grey? how many distinct
//      colours are there (up to 256)? Is there one transparent colour value
//      that could be keyed with tRNS instead of an alpha channel?
//   3. Try every exact representation that fits (palette, grey, grey+alpha,
//      RGB, RGBA, with a tRNS key where one exists) and, for each, several
//      ways of filtering the rows (one fixed filter for all rows, the
//      smallest-signed-sum filter per row, the fewest-distinct-pairs filter
//      per row, and a per-row brute force that really deflates each candidate
//      row against the 32 KiB written before it).
//   4. Weigh every candidate by actually deflating it (zlib level 6), keep
//      the smallest, and write that winner out with zlib level 9.
//   5. Emit a PNG holding only IHDR, PLTE, tRNS, IDAT and IEND, with correct
//      CRCs, bit depth 8, no interlace.
//
// Everything is a fixed amount of work per image: no clock, no environment,
// no randomness, so two runs write identical bytes.

import { deflateSync, inflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/* ------------------------------------------------------------------ */
/* CRC-32 (the one PNG uses) and PNG file assembly.                    */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function assemblePng(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrBytes(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  return d;
}

/* ------------------------------------------------------------------ */
/* PNG decoding (colour type 6 input, all five filters understood).    */
/* ------------------------------------------------------------------ */

function paethPredict(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idatParts = [];
  let seenIend = false;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (at + 12 + len > bytes.length) throw new Error('truncated chunk ' + type);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error('bad CRC on ' + type);
    }
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      seenIend = true;
      break;
    }
  }
  if (!seenIend || idatParts.length === 0) throw new Error('no IDAT/IEND');
  if (colourType !== 6 || bitDepth !== 8 || interlace !== 0) {
    throw new Error('unexpected input format: colour ' + colourType + ' depth ' + bitDepth);
  }
  const channels = 4;
  const stride = width * channels;
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts));
  if (raw.length !== height * (stride + 1)) throw new Error('inflated size mismatch');
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      rgba.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (i >= channels ? rgba[o + i - channels] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (y > 0 ? rgba[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        rgba[o + i] = raw[src + i] + (((i >= channels ? rgba[o + i - channels] : 0) + (y > 0 ? rgba[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? rgba[o + i - channels] : 0;
        const b = y > 0 ? rgba[p + i] : 0;
        const c = y > 0 && i >= channels ? rgba[p + i - channels] : 0;
        rgba[o + i] = raw[src + i] + paethPredict(a, b, c);
      }
    } else {
      throw new Error('bad filter type ' + ft + ' on row ' + y);
    }
  }
  return { width, height, rgba };
}

/* ------------------------------------------------------------------ */
/* Row filtering and its cheap cost estimates.                         */
/* ------------------------------------------------------------------ */

function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredict(a, b, c);
    }
  }
}

/** Sum of |filtered byte| reading each byte as signed (-128..127). */
function signedAbsSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** How many distinct neighbouring byte pairs a row holds. */
function distinctPairs(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;

/**
 * Filter every row of `samples` (height rows of width*bpp samples) by
 * `choice`: a fixed filter 0..4 for all rows, or 'minsum' (per row, the
 * filter with the smallest signed absolute sum), 'pairs' (per row, the
 * filter with the fewest distinct byte pairs), or 'brute' (per row, really
 * deflate each of the five filtered rows against the 32 KiB written just
 * before it and keep the shortest). Ties go to the lower filter type.
 * Returns the raw scanline data (filter byte + filtered bytes per row).
 */
function filterSamples(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRowInto(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedAbsSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = distinctPairs(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: 4, memLevel: 9 }
            : { level: 4, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* Image analysis: opacity, greyness, distinct colours, tRNS key.     */
/* ------------------------------------------------------------------ */

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let tooMany = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!tooMany) {
      const w = words[i];
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size === 256) tooMany = true;
        else counts.set(w, 1);
      } else counts.set(w, k + 1);
    }
  }
  const colours = tooMany
    ? null
    : [...counts.keys()].map((w) => {
        const b = new Uint8Array(Uint32Array.of(w).buffer);
        return { word: w, rgba: [b[0], b[1], b[2], b[3]], count: counts.get(w) };
      });
  return { opaque, grey, colours };
}

/**
 * The single fully-transparent colour value the image could key by tRNS:
 * every non-opaque pixel is alpha 0 with that one value, and no opaque
 * pixel uses the same value. Null when there is no such value.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The samples of the image in colour type ct (0, 2, 4 or 6). */
function samplesFor(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Palette forms.                                                      */
/* ------------------------------------------------------------------ */

/** Palette entries ordered for a trial: transparent entries first (by alpha), then by `order`. */
function orderPalette(colours, order) {
  const luminance = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const tx = x.rgba[3] === 255 ? 1 : 0;
    const ty = y.rgba[3] === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return luminance(x) - luminance(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function buildPalette(rgba, colours, order) {
  const entries = orderPalette(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i]);
  return { plte, trns, indices };
}

/* ------------------------------------------------------------------ */
/* Screening: weigh every exact form by deflating it, keep the best.   */
/* ------------------------------------------------------------------ */

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

function screenForm(form, width, height, best) {
  const bpp = CHANNELS[form.colourType];
  for (const choice of form.filters) {
    const data = filterSamples(form.samples, width, height, bpp, choice);
    const zlib = deflateSync(data, SCREEN);
    const bytes = zlib.length + chunkOverhead(form);
    if (best === null || bytes < best.bytes) {
      best = { form, data, bytes };
    }
  }
  return best;
}

function encodeImage(rgba, width, height) {
  const { opaque, grey, colours } = analyse(rgba);
  let best = null;
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = buildPalette(rgba, colours, order);
      const form = {
        colourType: 3,
        samples: p.indices,
        plte: p.plte,
        trns: p.trns,
        filters: order === 'count' ? [0] : [0, 'minsum', 'brute'],
      };
      best = screenForm(form, width, height, best);
    }
    if (!grey) return finish(best, width, height);
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let colourType;
  let trns = null;
  if (grey) {
    colourType = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const form = {
    colourType,
    samples: samplesFor(rgba, colourType),
    plte: null,
    trns,
    filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'],
  };
  best = screenForm(form, width, height, best);
  return finish(best, width, height);
}

/**
 * Write the winning form's filtered data out. The custom optimal-parse
 * deflate below usually beats zlib level 9 by a few percent; zlib level 9
 * stays as a safety net, and the smaller stream wins.
 */
function finish(best, width, height) {
  const bpp = CHANNELS[best.form.colourType];
  const stride = width * bpp + 1;
  const mine = deflateBetter(best.data, 500000, 2, 256, stride);
  const zlib = deflateSync(best.data, { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY });
  const idat = mine.length <= zlib.length ? mine : zlib;
  const chunks = [['IHDR', ihdrBytes(width, height, best.form.colourType)]];
  if (best.form.plte !== null) chunks.push(['PLTE', best.form.plte]);
  if (best.form.trns !== null) chunks.push(['tRNS', best.form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemblePng(chunks);
}

// ---- DEFLATE tables -------------------------------------------------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_CODE = new Uint16Array(259); // length -> length symbol (257..285)
{
  // Length code 284 covers 227-257 (its 5 extra bits never spell 258: that
  // length is code 285 alone), so the top of its range is 257, not 258.
  let c = 0;
  for (let len = 3; len <= 258; len++) {
    for (;;) {
      const top = c === 28 ? 258 : Math.min(LEN_BASE[c] + (1 << LEN_EXTRA[c]) - 1, 257);
      if (len <= top) break;
      c++;
    }
    LEN_CODE[len] = 257 + c;
  }
}
const DIST_CODE = new Uint8Array(32769); // distance -> distance symbol
{
  let c = 0;
  for (let d = 1; d <= 32768; d++) {
    while (d > DIST_BASE[c] + (1 << DIST_EXTRA[c]) - 1) c++;
    DIST_CODE[d] = c;
  }
}
// Candidate match lengths per longest-match length: the largest length of each
// length code at or below it, plus the longest length itself. Flattened for
// the DP inner loop: CAND_OFF[m] is where length m's list starts in CAND_FLAT.
const CANDIDATES = [];
for (let m = 0; m <= 258; m++) {
  const list = [];
  if (m >= 3) {
    for (let c = 0; c < 29; c++) {
      const top = Math.min(c === 28 ? 258 : Math.min(LEN_BASE[c] + (1 << LEN_EXTRA[c]) - 1, 257), m);
      if (top >= LEN_BASE[c] && (list.length === 0 || list[list.length - 1] !== top)) list.push(top);
    }
    if (list[list.length - 1] !== m) list.push(m);
  }
  CANDIDATES.push(list);
}
const CAND_OFF = new Int32Array(260);
const CAND_FLAT = (() => {
  const flat = [];
  for (let m = 0; m <= 258; m++) {
    CAND_OFF[m] = flat.length;
    for (const l of CANDIDATES[m]) flat.push(l);
  }
  CAND_OFF[259] = flat.length;
  return Int32Array.from(flat);
})();

// Fixed Huffman lengths (RFC 1951).
const FIXED_LIT = new Uint8Array(288);
for (let s = 0; s < 288; s++) FIXED_LIT[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
const FIXED_DIST = new Uint8Array(30).fill(5);

// ---- Huffman: length-limited code lengths from frequencies ----------------
// Build a Huffman tree, then limit lengths to maxBits the way zlib's
// gen_bitlen does: depths past maxBits are clamped and counted as overflow
// (over every node of the tree, leaves and internal alike); the overflow is
// then worked off by moving leaves down, which keeps the Kraft sum exactly
// 1, so the lengths always form a complete prefix code. Lengths are finally
// handed to the most frequent symbols first.
function buildLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) syms.push(s);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  // Binary-heap Huffman tree (ties broken by symbol order, deterministic).
  const heap = syms.map((s) => ({ freq: freq[s], sym: s, left: null, right: null, minSym: s }));
  const less = (a, b) => a.freq - b.freq || a.minSym - b.minSym;
  heap.sort(less);
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m]) < 0) m = l;
        if (r < heap.length && less(heap[r], heap[m]) < 0) m = r;
        if (m === i) break;
        const t = heap[i]; heap[i] = heap[m]; heap[m] = t;
        i = m;
      }
    }
    return top;
  };
  const push = (node) => {
    let i = heap.length;
    heap.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(heap[i], heap[p]) < 0) {
        const t = heap[i]; heap[i] = heap[p]; heap[p] = t;
        i = p;
      } else break;
    }
  };
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    push({ freq: a.freq + b.freq, sym: -1, left: a, right: b, minSym: Math.min(a.minSym, b.minSym) });
  }
  const root = heap[0];
  // Depth of every node; overflow counts every non-root node too deep,
  // leaves and internal alike (zlib's gen_bitlen counts the same way).
  const blCount = new Int32Array(maxBits + 1);
  let overflow = 0;
  const walk = (node, d) => {
    if (node.sym >= 0) {
      if (d > maxBits) overflow++;
      blCount[Math.min(d, maxBits)]++;
      return;
    }
    if (d > maxBits) overflow++;
    walk(node.left, d + 1);
    walk(node.right, d + 1);
  };
  walk(root, 0);
  if (overflow > 0) {
    do {
      let bits = maxBits - 1;
      while (blCount[bits] === 0) bits--;
      blCount[bits]--; // move one leaf down the tree
      blCount[bits + 1] += 2; // move one overflow item as its brother
      blCount[maxBits]--;
      overflow -= 2;
    } while (overflow > 0);
  }
  // Hand the shortest lengths to the most frequent symbols.
  const ordered = [...syms].sort((a, b) => freq[b] - freq[a] || a - b);
  let idx = 0;
  for (let b = 1; b <= maxBits; b++) {
    for (let k = 0; k < blCount[b]; k++) lengths[ordered[idx++]] = b;
  }
  return lengths;
}

/** Canonical Huffman codes from lengths: returns {codes, } indexed by symbol. */
function canonicalCodes(lengths) {
  const n = lengths.length;
  const codes = new Uint32Array(n);
  const blCount = new Int32Array(16);
  for (let s = 0; s < n; s++) if (lengths[s] > 0) blCount[lengths[s]]++;
  const next = new Int32Array(16);
  let code = 0;
  for (let b = 1; b <= 15; b++) {
    code = (code + blCount[b - 1]) << 1;
    next[b] = code;
  }
  for (let s = 0; s < n; s++) {
    const len = lengths[s];
    if (len > 0) codes[s] = next[len]++;
  }
  return codes;
}

// ---- Bit writer ------------------------------------------------------------
class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
  }
  writeBits(value, count) {
    // LSB-first.
    this.acc |= (value & ((1 << count) - 1)) << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  writeCode(code, len) {
    // Huffman codes go out most-significant bit first.
    for (let i = len - 1; i >= 0; i--) this.writeBits((code >> i) & 1, 1);
  }
  align() {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
  }
  result() {
    return Uint8Array.from(this.bytes);
  }
}

// ---- Match finding ----------------------------------------------------------
const HASH_BITS = 17;
const HASH_SIZE = 1 << HASH_BITS;
const DEFAULT_MAX_CHAIN = 4096;

function findMatches(data, start, end, maxChain = DEFAULT_MAX_CHAIN, stride = 0) {
  const n = end - start;
  const mlen = new Uint16Array(n);
  const mdist = new Uint16Array(n);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const winStart = Math.max(0, start - 32768);
  const prev = new Int32Array(end - winStart).fill(-1);
  const hashAt = (p) => {
    const v = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
    // Exact 32-bit multiply (Math.imul): a float64 product of these would
    // pass 2^53 and lose the low bits this hash relies on.
    return ((Math.imul(v, 2654435761) >>> (32 - HASH_BITS)) & (HASH_SIZE - 1));
  };
  // Insert the window prefix without searching.
  for (let p = winStart; p < start; p++) {
    if (p + 2 >= end) break;
    const h = hashAt(p);
    prev[p - winStart] = head[h];
    head[h] = p;
  }
  for (let p = start; p < end; p++) {
    if (p + 3 > end) break;
    const h = hashAt(p);
    let bestLen = 0;
    let bestDist = 0;
    let chain = maxChain;
    let q = head[h];
    const maxLen = Math.min(258, end - p);
    while (q >= 0 && chain-- > 0) {
      const dist = p - q;
      if (dist > 32768) break;
      // A candidate can only improve on the best match if it still matches
      // at the best length; most candidates fail this one-byte check.
      if (data[q + bestLen] !== data[p + bestLen]) {
        q = prev[q - winStart];
        continue;
      }
      let len = 0;
      // Compare, allowing overlap (decoder copies byte by byte).
      while (len < maxLen && data[q + len] === data[p + len]) len++;
      if (len > bestLen || (len === bestLen && len > 0 && dist < bestDist)) {
        bestLen = len;
        bestDist = dist;
        if (len === maxLen) break;
        // A good match shortens the search, but not so much that a far
        // row-repeat (a common win in screenshot data) falls out of reach.
        if (len >= 32) chain = Math.min(chain, 1024);
      }
      q = prev[q - winStart];
    }
    // Row repeats: the same column in earlier rows. A hash chain often
    // cannot reach these (its recent entries crowd them out), yet they are
    // the longest matches in screenshot data, so test them directly.
    if (stride > 0 && bestLen < maxLen) {
      for (let d = stride; d <= 32768 && d <= p - winStart; d += stride) {
        if (data[p - d + bestLen] !== data[p + bestLen]) continue;
        let len = 0;
        while (len < maxLen && data[p - d + len] === data[p + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = d;
          if (len === maxLen) break;
        }
      }
    }
    if (bestLen >= 3) {
      mlen[p - start] = bestLen;
      mdist[p - start] = bestDist;
    }
    prev[p - winStart] = head[h];
    head[h] = p;
  }
  return { mlen, mdist };
}

// ---- Optimal parse (shortest path) ------------------------------------------
function optimalParse(data, start, end, mlen, mdist, litCost, distCost) {
  const n = end - start;
  const INF = 0x7fffffff;
  const cost = new Int32Array(n + 1).fill(INF);
  const backLen = new Uint16Array(n + 1); // 0 = literal, else match length
  const backDist = new Uint16Array(n + 1);
  const backSym = new Uint8Array(n + 1); // literal byte when backLen == 0
  cost[0] = 0;
  // Precompute per-length symbol cost (length symbol + extra bits).
  const lenCost = new Int32Array(259);
  for (let l = 3; l <= 258; l++) {
    const c = LEN_CODE[l] - 257;
    lenCost[l] = litCost[257 + c] + LEN_EXTRA[c];
  }
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci === INF) continue;
    // Literal.
    const sym = data[start + i];
    const nc = ci + litCost[sym];
    if (nc < cost[i + 1]) {
      cost[i + 1] = nc;
      backLen[i + 1] = 0;
      backSym[i + 1] = sym;
    }
    // Matches.
    const ml = mlen[i];
    if (ml >= 3) {
      const dc = distCost[DIST_CODE[mdist[i]]];
      for (let k = CAND_OFF[ml]; k < CAND_OFF[ml + 1]; k++) {
        const L = CAND_FLAT[k];
        const j = i + L;
        const nc2 = ci + lenCost[L] + dc;
        if (nc2 < cost[j]) {
          cost[j] = nc2;
          backLen[j] = L;
          backDist[j] = mdist[i];
        }
      }
    }
  }
  // Walk back, collecting symbols.
  const syms = [];
  const dists = [];
  const lens = [];
  let i = n;
  while (i > 0) {
    const L = backLen[i];
    if (L === 0) {
      syms.push(backSym[i]);
      dists.push(-1);
      lens.push(0);
      i -= 1;
    } else {
      syms.push(LEN_CODE[L]);
      dists.push(backDist[i]);
      lens.push(L);
      i -= L;
    }
  }
  syms.reverse();
  dists.reverse();
  lens.reverse();
  return { syms, dists, lens, bits: cost[n] };
}

// ---- One block: parse, build tables, emit ------------------------------------
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitBlock(w, data, start, end, mlen, mdist, isLast, iterations) {
  const n = end - start;
  // Iteration 0 uses fixed lengths as the cost model.
  let litLen = FIXED_LIT;
  let distLen = FIXED_DIST;
  let best = null;
  for (let it = 0; it < iterations; it++) {
    const litCost = litLen;
    const distCost = new Int32Array(30);
    for (let d = 0; d < 30; d++) distCost[d] = distLen[d] + DIST_EXTRA[d];
    const parsed = optimalParse(data, start, end, mlen, mdist, litCost, distCost);
    // Frequencies from this parse.
    const litFreq = new Int32Array(288);
    const distFreq = new Int32Array(30);
    for (let k = 0; k < parsed.syms.length; k++) {
      litFreq[parsed.syms[k]]++;
      if (parsed.dists[k] >= 0) distFreq[DIST_CODE[parsed.dists[k]]]++;
    }
    litFreq[256]++; // end of block
    if (distFreq.every((f) => f === 0)) distFreq[0] = 1;
    const newLitLen = buildLengths(litFreq, 15);
    const newDistLen = buildLengths(distFreq, 15);
    // Score this parse under the new tables (plus header estimate).
    const dynBits = scoreDynamic(parsed, newLitLen, newDistLen);
    const fixBits = scoreFixed(parsed);
    const totalBits = Math.min(dynBits, fixBits);
    if (best === null || totalBits < best.totalBits) {
      best = { parsed, litLen: newLitLen, distLen: newDistLen, totalBits, dynBits, fixBits };
    }
    // Stop when the tables stop changing.
    if (sameLengths(newLitLen, litLen) && sameLengths(newDistLen, distLen)) break;
    litLen = newLitLen;
    distLen = newDistLen;
  }
  // Emit the best parse.
  const { parsed, litLen: ll, distLen: dl, dynBits, fixBits } = best;
  w.writeBits(isLast ? 1 : 0, 1);
  if (dynBits <= fixBits) {
    emitDynamic(w, parsed, ll, dl);
  } else {
    w.writeBits(1, 2); // BTYPE = 01 fixed
    emitSymbols(w, parsed, FIXED_LIT, canonicalCodes(FIXED_LIT), FIXED_DIST, canonicalCodes(FIXED_DIST));
  }
}

function sameLengths(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function scoreFixed(parsed) {
  let bits = 3; // header
  for (let k = 0; k < parsed.syms.length; k++) {
    const s = parsed.syms[k];
    bits += FIXED_LIT[s];
    if (s >= 257) {
      const c = s - 257;
      bits += LEN_EXTRA[c];
      const d = parsed.dists[k];
      const dc = DIST_CODE[d];
      bits += 5 + DIST_EXTRA[dc];
    }
  }
  bits += FIXED_LIT[256];
  return bits;
}

function dynamicHeaderBits(litLen, distLen) {
  // Trim trailing zero lengths.
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(litLen.subarray(0, hlit), 0);
  all.set(distLen.subarray(0, hdist), hlit);
  // RLE of the length sequence with 16/17/18.
  const freq = new Int32Array(19);
  const seq = [];
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        seq.push([18, take]);
        freq[18]++;
        left -= take;
      }
      if (left >= 3) {
        seq.push([17, left]);
        freq[17]++;
        left = 0;
      }
      while (left-- > 0) {
        seq.push([0, 0]);
        freq[0]++;
      }
    } else {
      seq.push([v, 0]);
      freq[v]++;
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        seq.push([16, take]);
        freq[16]++;
        left -= take;
      }
      while (left-- > 0) {
        seq.push([v, 0]);
        freq[v]++;
      }
    }
    i += run;
  }
  const clenLen = buildLengths(freq, 7);
  // Header bits: 5+5+4 + HCLEN*3 + RLE symbols + data symbols (computed by caller).
  let hclen = 19;
  while (hclen > 4 && clenLen[CLEN_ORDER[hclen - 1]] === 0) hclen--;
  let bits = 3 + 5 + 5 + 4 + hclen * 3;
  const clenCodes = canonicalCodes(clenLen);
  for (const [s, extra] of seq) {
    bits += clenLen[s];
    if (s === 16) bits += 2;
    else if (s === 17) bits += 3;
    else if (s === 18) bits += 7;
  }
  return { bits, hlit, hdist, hclen, clenLen, clenCodes, seq };
}

function scoreDynamic(parsed, litLen, distLen) {
  const h = dynamicHeaderBits(litLen, distLen);
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  let bits = h.bits;
  for (let k = 0; k < parsed.syms.length; k++) {
    const s = parsed.syms[k];
    bits += litLen[s];
    if (s >= 257) {
      const c = s - 257;
      bits += LEN_EXTRA[c];
      const d = parsed.dists[k];
      const dc = DIST_CODE[d];
      bits += distLen[dc] + DIST_EXTRA[dc];
    }
  }
  bits += litLen[256];
  return bits;
}

function emitSymbols(w, parsed, litLen, litCodes, distLen, distCodes) {
  for (let k = 0; k < parsed.syms.length; k++) {
    const s = parsed.syms[k];
    w.writeCode(litCodes[s], litLen[s]);
    if (s >= 257) {
      const c = s - 257;
      if (LEN_EXTRA[c] > 0) w.writeBits(parsed.lens[k] - LEN_BASE[c], LEN_EXTRA[c]);
      const d = parsed.dists[k];
      const dc = DIST_CODE[d];
      w.writeCode(distCodes[dc], distLen[dc]);
      if (DIST_EXTRA[dc] > 0) w.writeBits(d - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  w.writeCode(litCodes[256], litLen[256]);
}

function emitDynamic(w, parsed, litLen, distLen) {
  w.writeBits(2, 2); // BTYPE = 10 dynamic
  const h = dynamicHeaderBits(litLen, distLen);
  w.writeBits(h.hlit - 257, 5);
  w.writeBits(h.hdist - 1, 5);
  w.writeBits(h.hclen - 4, 4);
  for (let i = 0; i < h.hclen; i++) w.writeBits(h.clenLen[CLEN_ORDER[i]], 3);
  for (const [s, extra] of h.seq) {
    w.writeCode(h.clenCodes[s], h.clenLen[s]);
    if (s === 16) w.writeBits(extra - 3, 2);
    else if (s === 17) w.writeBits(extra - 3, 3);
    else if (s === 18) w.writeBits(extra - 11, 7);
  }
  // Symbols: the parse must carry match lengths, so re-derive them from the
  // symbol stream using the stored lengths array (parsed.lens).
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  for (let k = 0; k < parsed.syms.length; k++) {
    const s = parsed.syms[k];
    w.writeCode(litCodes[s], litLen[s]);
    if (s >= 257) {
      const c = s - 257;
      const L = parsed.lens[k];
      if (LEN_EXTRA[c] > 0) w.writeBits(L - LEN_BASE[c], LEN_EXTRA[c]);
      const d = parsed.dists[k];
      const dc = DIST_CODE[d];
      w.writeCode(distCodes[dc], distLen[dc]);
      if (DIST_EXTRA[dc] > 0) w.writeBits(d - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  w.writeCode(litCodes[256], litLen[256]);
}


function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function deflateBetter(data, blockSize, iterations, maxChain, stride) {
  const w = new BitWriter();
  const n = data.length;
  for (let start = 0; start < n; start += blockSize) {
    const end = Math.min(n, start + blockSize);
    const isLast = end === n;
    const { mlen, mdist } = findMatches(data, start, end, maxChain, stride);
    emitBlock(w, data, start, end, mlen, mdist, isLast, iterations);
  }
  if (n === 0) {
    // One empty fixed block.
    w.writeBits(1, 1);
    w.writeBits(1, 2);
    w.writeCode(canonicalCodes(FIXED_LIT)[256], 7);
  }
  w.align();
  const body = w.result();
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(body, 2);
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 4, adler32(data));
  return out;
}

/* ------------------------------------------------------------------ */
/* Driver: every instance in /input, in sorted order.                  */
/* ------------------------------------------------------------------ */

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), encodeImage(image.rgba, image.width, image.height));
}

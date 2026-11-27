# Squeeze screenshots into the smallest PNG, 27 November 2026

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![make.fun · rank](https://make.fun/badge/png-squeeze-01-run-20261127/mitsukikun/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard)
[![make.fun · reward](https://make.fun/badge/png-squeeze-01-run-20261127/mitsukikun/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

One program, `main.ts` (Node 22, standard library only), that losslessly
re-encodes a set of eight 1280x720 RGBA screenshots as the smallest PNGs it
can, inside a 60-second wall budget.

## How it works

1. **Decode** each stored RGBA PNG with the built-in zlib inflate and
   unfilter its rows.
2. **Analyse** the pixels: all opaque? all grey? how many distinct colours
   (up to 256)? Is there a single transparent colour value that a tRNS key
   can stand in for, instead of an alpha channel?
3. **Try every exact representation** that fits — palette (by count and by
   luminance), grey, grey+alpha, RGB, RGBA, with a tRNS key where one
   exists — and, for each, several ways of filtering the rows: one fixed
   filter for all rows, the smallest-signed-sum filter per row, the
   fewest-distinct-pairs filter per row, and a per-row brute force that
   really deflates each candidate row against the 32 KiB written before it.
4. **Weigh every candidate** by actually deflating it (zlib level 6) and
   keep the smallest.
5. **Write the winner out with a from-scratch DEFLATE encoder**: hash-chain
   match finding (with row-repeat distances tested directly, since a hash
   chain often cannot reach the previous row), shortest-path optimal parsing
   against the current Huffman costs, iterated Huffman table building with
   length limiting, dynamic or fixed blocks, whichever is smaller. zlib
   level 9 stays as a safety net and the smaller stream wins.
6. **Emit a PNG** holding only IHDR, PLTE, tRNS, IDAT and IEND, with
   correct CRCs, bit depth 8, no interlace.

Everything is a fixed amount of work per image — no clock, no environment,
no randomness — so two runs write identical bytes.

## Practice-set result

On the kit's practice set the program scores **739,633** (baseline
fixed-paeth: 420,399), answering all 8 instances exactly, in ~38 seconds
for the set on one CPU.

## Licence

MIT — see `LICENSE`.

#!/usr/bin/env node

const seed0 = Number(process.argv[2] ?? 1);

function stateOf(text) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return [a, b];
}

const text1 = "video_generate\nmodel=veo-3.1-lite\nprompt=a calm lake at dawn, soft light ";
const text2 = "video_generate\nmodel=veo_3_1\nprompt=a calm lake at dawn, very soft light ";
if (text1.length !== text2.length) throw new Error("prefix lengths differ");
const [h1, g1] = stateOf(text1);
const [h2, g2] = stateOf(text2);
const idx = text1.length;
const BASE = 0x4e00;

let fh = 0;
let fg = 0;
let s1 = 0;
let s2 = 0;
function F(h0, g0) {
  const h = (h0 ^ s1) >>> 0;
  const g = (g0 ^ s2) >>> 0;
  const useB = g >>> 31;
  let a = useB ? h2 : h1;
  let b = useB ? g2 : g1;
  const d0 = h & 0x3fff;
  const d1 = ((h >>> 14) & 0x3fff) | 0;
  const d2 = ((h >>> 28) | ((g & 0x3ff) << 4)) & 0x3fff;
  const d3 = (g >>> 10) & 0x3fff;
  const d4 = (g >>> 24) & 0x7f;
  const digits = [d0, d1, d2, d3, d4];
  for (let k = 0; k < 5; k += 1) {
    const c = BASE + digits[k];
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + idx + k), 0x85ebca6b) >>> 0;
  }
  fh = a;
  fg = b;
}

function tailOf(h0, g0) {
  const h = (h0 ^ s1) >>> 0;
  const g = (g0 ^ s2) >>> 0;
  const digits = [h & 0x3fff, (h >>> 14) & 0x3fff, ((h >>> 28) | ((g & 0x3ff) << 4)) & 0x3fff, (g >>> 10) & 0x3fff, (g >>> 24) & 0x7f];
  return digits.map((d) => String.fromCharCode(BASE + d)).join("");
}
const branchOf = (h0, g0) => ((g0 ^ s2) >>> 31) & 1;

for (let seed = seed0; ; seed += 4) {
  s1 = Math.imul(seed, 0x2545f491) >>> 0;
  s2 = Math.imul(seed ^ 0x5bd1e995, 0x27d4eb2f) >>> 0;
  const x0h = Math.imul(seed, 0x9e3779b1) >>> 0;
  const x0g = Math.imul(seed ^ 0xabcdef, 0x85ebca77) >>> 0;
  F(x0h, x0g);
  let th = fh;
  let tg = fg;
  F(th, tg);
  let hh = fh;
  let hg = fg;
  let n = 0;
  const started = Date.now();
  while (!(th === hh && tg === hg)) {
    F(th, tg);
    th = fh;
    tg = fg;
    F(hh, hg);
    const ah = fh;
    const ag = fg;
    F(ah, ag);
    hh = fh;
    hg = fg;
    n += 1;
    if (n % 1_000_000_000 === 0) console.log(`seed ${seed}: ${n / 1e9}G steps, ${(Date.now() - started) / 1000}s`);
  }
  let ph = x0h;
  let pg = x0g;
  let qh = hh;
  let qg = hg;
  if (ph === qh && pg === qg) {
    console.log(`seed ${seed}: start is on the cycle, skip`);
    continue;
  }
  for (;;) {
    F(ph, pg);
    const nph = fh;
    const npg = fg;
    F(qh, qg);
    if (nph === fh && npg === fg) break;
    ph = nph;
    pg = npg;
    qh = fh;
    qg = fg;
  }
  const cross = branchOf(ph, pg) !== branchOf(qh, qg);
  console.log(`seed ${seed}: collision after ${n} steps (${(Date.now() - started) / 1000}s), cross-branch=${cross}`);
  if (cross) {
    const [a, b] = branchOf(ph, pg) === 0 ? [[ph, pg], [qh, qg]] : [[qh, qg], [ph, pg]];
    console.log("RESULT " + JSON.stringify({ tailLite: tailOf(a[0], a[1]), tailFull: tailOf(b[0], b[1]) }));
    process.exit(0);
  }
}

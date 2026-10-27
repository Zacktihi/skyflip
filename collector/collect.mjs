// ChudHouse price recorder.
// Runs on GitHub Actions every 30 minutes (see .github/workflows/collect.yml)
// and records the price of every item on the auction house and the bazaar,
// building ChudHouse's own price history in the repo's `data` branch.
//
//   node collector/collect.mjs <data folder>
//
// Files in the data folder:
//   meta.json                when recording started, last run, item counts
//   hourly/YYYY-MM-DD.json   one point per item per hour (UTC), kept 14 days
//                            ah: key -> [[hour, lowest BIN, listings], ...]
//                            bz: id  -> [[hour, buy price, sell price, weekly volume], ...]
//   daily/YYYY-MM.json       one point per item per day, kept forever
//                            ah: key -> [[day, median low, min low, max low, median listings], ...]
//                            bz: id  -> [[day, avg buy, avg sell, weekly volume], ...]
//   summary.json             last 30 days of daily points for every item (what the site reads)
//
// Auction items are keyed exactly like the site: the item id, plus |recomb,
// |stars:N, |skin:X for variants; pets as PET_<TIER>_<TYPE>|L<level bucket>;
// single enchanted books as ENCHANTMENT_<NAME>_<LEVEL>. Prices are per item
// (a stack of 64 counts as 64). Items with Kuudra attributes are skipped.

import { gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'data';
const API = 'https://api.hypixel.net/v2/skyblock';
const HOURLY_KEEP_DAYS = 14, SUMMARY_DAYS = 30;

// ---------- NBT (same decoder as the site) ----------
function readNBT(b) {
  let o = 0; const v = new DataView(b.buffer, b.byteOffset, b.byteLength); const td = new TextDecoder();
  const s = () => { const n = v.getUint16(o); o += 2; const r = td.decode(b.subarray(o, o + n)); o += n; return r; };
  function p(t) {
    switch (t) {
      case 1: return v.getInt8(o++);
      case 2: { const r = v.getInt16(o); o += 2; return r; }
      case 3: { const r = v.getInt32(o); o += 4; return r; }
      case 4: { const r = Number(v.getBigInt64(o)); o += 8; return r; }
      case 5: { const r = v.getFloat32(o); o += 4; return r; }
      case 6: { const r = v.getFloat64(o); o += 8; return r; }
      case 7: { const n = v.getInt32(o); o += 4; o += n; return null; }
      case 8: return s();
      case 9: { const tt = v.getInt8(o++); const n = v.getInt32(o); o += 4; const a = new Array(n); for (let k = 0; k < n; k++) a[k] = p(tt); return a; }
      case 10: { const ob = {}; for (;;) { const tt = v.getInt8(o++); if (tt === 0) return ob; const nm = s(); ob[nm] = p(tt); } }
      case 11: { const n = v.getInt32(o); o += 4; const a = []; for (let k = 0; k < n; k++) { a.push(v.getInt32(o)); o += 4; } return a; }
      case 12: { const n = v.getInt32(o); o += 4; const a = []; for (let k = 0; k < n; k++) { a.push(Number(v.getBigInt64(o))); o += 8; } return a; }
      default: throw new Error('tag ' + t);
    }
  }
  if (v.getInt8(o++) !== 10) throw new Error('root'); s(); return p(10);
}
function lvlBucket(name) {
  const m = /^\[Lvl (\d+)\]/.exec(name || ''); if (!m) return null; const l = +m[1];
  if (l === 1 || l === 100 || l === 200) return 'L' + l; if (l > 100) return 'L' + Math.floor(l / 10) * 10 + '+'; return 'L' + Math.floor(l / 10) * 10 + 's';
}
function describe(b64, name) {
  try {
    const nbt = readNBT(new Uint8Array(gunzipSync(Buffer.from(b64, 'base64'))));
    const it = nbt.i && nbt.i[0]; if (!it) return null;
    const x = (it.tag && it.tag.ExtraAttributes) || {}; const id = x.id; if (!id) return null;
    const count = it.Count || 1; let parts = [id];
    if (id === 'PET' && x.petInfo) {
      let pi = {}; try { pi = JSON.parse(x.petInfo); } catch {}
      const b = lvlBucket(name); if (!b) return null;
      parts = ['PET_' + pi.tier + '_' + pi.type, b];
      if (pi.heldItem) parts.push('held:' + pi.heldItem); if (pi.skin) parts.push('skin:' + pi.skin);
    } else if (id === 'ENCHANTED_BOOK' && x.enchantments) {
      const e = Object.entries(x.enchantments); if (e.length !== 1) return null;
      parts = ['ENCHANTMENT_' + e[0][0].toUpperCase() + '_' + e[0][1]];
    } else {
      if (x.attributes && typeof x.attributes === 'object' && Object.keys(x.attributes).length) return null; // too many combinations
      if (x.rarity_upgrades) parts.push('recomb');
      const st = x.upgrade_level != null ? x.upgrade_level : x.dungeon_item_level; if (st) parts.push('stars:' + st);
      if (x.skin) parts.push('skin:' + x.skin);
    }
    return { key: parts.join('|'), count };
  } catch { return null; }
}

// ---------- fetching ----------
async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'ChudHouse price recorder (github.com/Zacktihi/skyflip)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}
async function auctionHouse() {
  const first = await getJSON(`${API}/auctions?page=0`);
  const total = first.totalPages || 1, pages = [first];
  let next = 1, failed = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < total) {
      const p = next++;
      try { pages[p] = await getJSON(`${API}/auctions?page=${p}`); } catch { failed++; }
    }
  }));
  if (failed > total * 0.1) throw new Error(`${failed} of ${total} auction pages failed`);
  const groups = new Map(); // key -> { low, n }
  for (const pg of pages) for (const a of (pg && pg.auctions) || []) {
    if (!a.bin || a.claimed) continue;
    const d = describe(a.item_bytes, a.item_name); if (!d) continue;
    const unit = a.starting_bid / d.count;
    const g = groups.get(d.key);
    if (!g) groups.set(d.key, { low: unit, n: 1 }); else { g.n++; if (unit < g.low) g.low = unit; }
  }
  return { groups, total, failed, lastUpdated: first.lastUpdated };
}
async function bazaar() {
  const j = await getJSON(`${API}/bazaar`);
  const out = new Map();
  for (const p of Object.values(j.products || {})) {
    const ask = p.buy_summary && p.buy_summary[0], bid = p.sell_summary && p.sell_summary[0], q = p.quick_status || {};
    if (!ask && !bid) continue;
    out.set(p.product_id, { ask: ask ? ask.pricePerUnit : 0, bid: bid ? bid.pricePerUnit : 0, vol: (q.buyMovingWeek || 0) + (q.sellMovingWeek || 0) });
  }
  return out;
}

// ---------- storage ----------
const rnd = x => x >= 100 ? Math.round(x) : Math.round(x * 10) / 10;
const readJSON = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => writeFileSync(f, JSON.stringify(v));
const med = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayStr = t => new Date(t).toISOString().slice(0, 10);

async function main() {
  const now = Date.now(), day = dayStr(now), hour = new Date(now).getUTCHours();
  for (const d of ['hourly', 'daily']) mkdirSync(join(OUT, d), { recursive: true });

  const [ah, bz] = await Promise.allSettled([auctionHouse(), bazaar()]);
  if (ah.status === 'rejected') console.warn('Auction house skipped this run:', ah.reason.message);
  if (bz.status === 'rejected') console.warn('Bazaar skipped this run:', bz.reason.message);
  if (ah.status === 'rejected' && bz.status === 'rejected') process.exit(1);

  // 1. Hourly point for this hour (several runs in one hour: lowest low, latest count).
  const hf = join(OUT, 'hourly', day + '.json');
  const H = readJSON(hf, { day, ah: {}, bz: {} });
  const put = (map, key, point, merge) => {
    const arr = map[key] || (map[key] = []);
    const last = arr[arr.length - 1];
    if (last && last[0] === hour) arr[arr.length - 1] = merge(last, point); else arr.push(point);
  };
  if (ah.status === 'fulfilled') for (const [k, g] of ah.value.groups) put(H.ah, k, [hour, rnd(g.low), g.n], (a, b) => [hour, Math.min(a[1], b[1]), b[2]]);
  if (bz.status === 'fulfilled') for (const [k, g] of bz.value) put(H.bz, k, [hour, rnd(g.ask), rnd(g.bid), g.vol], (a, b) => b);
  writeJSON(hf, H);

  // 2. Today's daily point, rebuilt from today's hourly points.
  const month = day.slice(0, 7), dnum = +day.slice(8), df = join(OUT, 'daily', month + '.json');
  const D = readJSON(df, { month, ah: {}, bz: {} });
  const setDay = (map, key, point) => {
    const arr = map[key] || (map[key] = []);
    const i = arr.findIndex(p => p[0] === dnum);
    if (i >= 0) arr[i] = point; else { arr.push(point); arr.sort((a, b) => a[0] - b[0]); }
  };
  for (const [k, pts] of Object.entries(H.ah)) {
    const lows = pts.map(p => p[1]);
    setDay(D.ah, k, [dnum, rnd(med(lows)), rnd(Math.min(...lows)), rnd(Math.max(...lows)), Math.round(med(pts.map(p => p[2])))]);
  }
  for (const [k, pts] of Object.entries(H.bz)) {
    const avg = i => rnd(pts.reduce((s, p) => s + p[i], 0) / pts.length);
    setDay(D.bz, k, [dnum, avg(1), avg(2), pts[pts.length - 1][3]]);
  }
  writeJSON(df, D);

  // 3. Drop hourly files older than 14 days.
  const cutoff = dayStr(now - HOURLY_KEEP_DAYS * 864e5);
  for (const f of readdirSync(join(OUT, 'hourly'))) if (f.slice(0, 10) < cutoff) unlinkSync(join(OUT, 'hourly', f));

  // 4. Summary: last 30 days of daily points for every item, as day offsets
  //    from `start` (0 = start day).
  const startT = Date.parse(dayStr(now - (SUMMARY_DAYS - 1) * 864e5));
  const months = new Set(); for (let t = startT; t <= now + 864e5; t += 864e5) months.add(dayStr(t).slice(0, 7));
  const S = { start: dayStr(startT), updated: now, ah: {}, bz: {} };
  for (const m of [...months].sort()) {
    const md = readJSON(join(OUT, 'daily', m + '.json'), null); if (!md) continue;
    for (const kind of ['ah', 'bz']) for (const [k, pts] of Object.entries(md[kind])) for (const p of pts) {
      const off = Math.round((Date.parse(`${m}-${String(p[0]).padStart(2, '0')}`) - startT) / 864e5);
      if (off < 0 || off >= SUMMARY_DAYS) continue;
      (S[kind][k] || (S[kind][k] = [])).push([off, ...p.slice(1)]);
    }
  }
  writeJSON(join(OUT, 'summary.json'), S);

  // 5. Meta.
  const metaF = join(OUT, 'meta.json');
  const meta = readJSON(metaF, { firstRun: now, runs: 0 });
  Object.assign(meta, {
    lastRun: now, runs: meta.runs + 1,
    ahItems: ah.status === 'fulfilled' ? ah.value.groups.size : meta.ahItems,
    bzItems: bz.status === 'fulfilled' ? bz.value.size : meta.bzItems,
    ahPages: ah.status === 'fulfilled' ? ah.value.total : meta.ahPages,
    lastError: [ah, bz].filter(r => r.status === 'rejected').map(r => r.reason.message).join('; ') || null,
  });
  writeJSON(metaF, meta);
  console.log(`Recorded ${meta.ahItems} auction items and ${meta.bzItems} bazaar items for ${day} ${hour}:00 UTC (run ${meta.runs}).`);
}
main().catch(e => { console.error(e); process.exit(1); });

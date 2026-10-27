// ChudHouse engine — runs entirely in the visitor's browser on Hypixel's public auction API.
(() => {
  const API = 'https://api.hypixel.net/v2/skyblock';
  const MIN_KEEP = 20_000;              // smallest profit worth computing
  const HISTORY_KEY = 'skyflip-sales-v1';
  const HISTORY_DAYS = 7;

  // ---------- decoding worker (pako gunzip + NBT), kept off the main thread ----------
  const workerSrc = `
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js');
function readNBT(b){let o=0;const v=new DataView(b.buffer,b.byteOffset,b.byteLength);const td=new TextDecoder();
const s=()=>{const n=v.getUint16(o);o+=2;const r=td.decode(b.subarray(o,o+n));o+=n;return r};
function p(t){switch(t){case 1:return v.getInt8(o++);case 2:{const r=v.getInt16(o);o+=2;return r}case 3:{const r=v.getInt32(o);o+=4;return r}
case 4:{const r=Number(v.getBigInt64(o));o+=8;return r}case 5:{const r=v.getFloat32(o);o+=4;return r}case 6:{const r=v.getFloat64(o);o+=8;return r}
case 7:{const n=v.getInt32(o);o+=4;o+=n;return null}case 8:return s();
case 9:{const tt=v.getInt8(o++);const n=v.getInt32(o);o+=4;const a=new Array(n);for(let k=0;k<n;k++)a[k]=p(tt);return a}
case 10:{const ob={};for(;;){const tt=v.getInt8(o++);if(tt===0)return ob;const nm=s();ob[nm]=p(tt)}}
case 11:{const n=v.getInt32(o);o+=4;const a=[];for(let k=0;k<n;k++){a.push(v.getInt32(o));o+=4}return a}
case 12:{const n=v.getInt32(o);o+=4;const a=[];for(let k=0;k<n;k++){a.push(Number(v.getBigInt64(o)));o+=8}return a}
default:throw new Error('tag '+t)}}
if(v.getInt8(o++)!==10)throw new Error('root');s();return p(10)}
function lvlBucket(name){const m=/^\\[Lvl (\\d+)\\]/.exec(name||'');if(!m)return null;const l=+m[1];
if(l===1||l===100||l===200)return 'L'+l;if(l>100)return 'L'+Math.floor(l/10)*10+'+';return 'L'+Math.floor(l/10)*10+'s'}
function describe(b64,name){try{
const bin=atob(b64);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
const nbt=readNBT(pako.ungzip(u));const it=nbt.i&&nbt.i[0];if(!it)return null;
const x=(it.tag&&it.tag.ExtraAttributes)||{};const id=x.id;if(!id)return null;const count=it.Count||1;const flags=[];let parts=[id];
if(id==='PET'&&x.petInfo){let pi={};try{pi=JSON.parse(x.petInfo)}catch(e){}const b=lvlBucket(name);
parts=['PET_'+pi.tier+'_'+pi.type];if(b)parts.push(b);else return {pet:true,key:null};
if(pi.heldItem)parts.push('held:'+pi.heldItem);if(pi.skin)parts.push('skin:'+pi.skin);if(pi.candyUsed>0)flags.push('candied')}
else if(id==='ENCHANTED_BOOK'&&x.enchantments){const e=Object.entries(x.enchantments);if(e.length!==1)return null;parts=['ENCHANTMENT_'+e[0][0].toUpperCase()+'_'+e[0][1]]}
else{if(x.rarity_upgrades)parts.push('recomb');const st=x.upgrade_level!=null?x.upgrade_level:x.dungeon_item_level;if(st)parts.push('stars:'+st);
if(x.skin)parts.push('skin:'+x.skin);if(x.attributes&&typeof x.attributes==='object'){const a=Object.entries(x.attributes).sort().map(([k,v])=>k+v).join(',');if(a)parts.push('attr:'+a)}
if(x.enchantments&&Object.keys(x.enchantments).length)flags.push('enchanted');if(x.hot_potato_count)flags.push('hpb'+x.hot_potato_count)}
return {key:parts.join('|'),count,flags}}catch(e){return null}}
onmessage=e=>{if(e.data.sleep){setTimeout(()=>postMessage({job:e.data.job,out:null}),e.data.sleep);return}const out=e.data.items.map(([id,b64,name])=>[id,describe(b64,name)]);postMessage({job:e.data.job,out})};`;

  let worker, jobN = 0;
  const pending = new Map();
  function startWorker() {
    worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
    worker.onmessage = e => { const r = pending.get(e.data.job); pending.delete(e.data.job); r && r(e.data.out); };
  }
  // Timers run inside the worker: browsers throttle main-page timers in
  // background tabs (down to once a minute), but not a worker's.
  function sleep(ms) {
    return new Promise(res => { const job = ++jobN; pending.set(job, res); worker.postMessage({ job, sleep: Math.max(0, ms) }); });
  }
  function decode(items) {
    if (!items.length) return Promise.resolve([]);
    return new Promise(res => { const job = ++jobN; pending.set(job, res); worker.postMessage({ job, items }); });
  }

  // ---------- fees (Hypixel wiki, Oct 2026) ----------
  const listingFee = p => p * (p >= 100e6 ? 0.025 : p >= 10e6 ? 0.02 : 0.01);
  const claimTax = (p, derpy) => p <= 1e6 ? 0 : Math.min(p * (derpy ? 0.04 : 0.01), p - 1e6);
  const net = (p, derpy) => p - listingFee(p) - claimTax(p, derpy);

  function trimmedMedian(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const cut = s.length >= 5 ? Math.floor(s.length * 0.1) : 0;
    const t = s.slice(cut, s.length - cut);
    const m = t.length >> 1;
    return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2;
  }

  // ---------- sales history, saved in this browser ----------
  const history = new Map(); // key -> [[t, unit], ...]
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    for (const [k, v] of Object.entries(raw)) history.set(k, v);
  } catch {}
  function saveHistory() {
    const cutoff = Date.now() - HISTORY_DAYS * 864e5;
    const out = {};
    for (const [k, v] of history) {
      const keep = v.filter(s => s[0] >= cutoff).slice(-80);
      if (keep.length) out[k] = keep; else history.delete(k);
    }
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(out)); }
    catch { // storage full: drop the quietest items and retry once
      const ks = Object.keys(out).sort((a, b) => out[a].length - out[b].length);
      ks.slice(0, ks.length >> 1).forEach(k => { delete out[k]; history.delete(k); });
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(out)); } catch {}
    }
  }
  const seenSales = new Set();
  let salesThisSession = 0;
  async function recordEnded(list) {
    const fresh = list.filter(a => a.bin && !seenSales.has(a.auction_id));
    fresh.forEach(a => seenSales.add(a.auction_id));
    const dec = await decode(fresh.map(a => [a.auction_id, a.item_bytes, '']));
    const byId = new Map(fresh.map(a => [a.auction_id, a]));
    for (const [id, d] of dec) {
      if (!d || !d.key) continue; // pet levels need the name, which this feed lacks
      const a = byId.get(id);
      const arr = history.get(d.key) || [];
      arr.push([a.timestamp, a.price / d.count]);
      history.set(d.key, arr);
      salesThisSession++;
    }
    saveHistory();
  }

  // ---------- live listings ----------
  const described = new Map(); // auction uuid -> description (decoded once, reused every minute)
  async function getJSON(url, timeoutMs) {
    const ctrl = timeoutMs ? new AbortController() : null;
    const t = ctrl && setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (!r.ok) throw new Error('Hypixel returned HTTP ' + r.status);
      return await r.json();
    } finally { if (t) clearTimeout(t); }
  }

  function computeFlips(auctions, derpy) {
    const groups = new Map();
    let bins = 0;
    for (const a of auctions) {
      if (!a.bin || a.claimed) continue;
      bins++;
      const d = described.get(a.uuid);
      if (!d || !d.key) continue;
      const l = { uuid: a.uuid, name: a.item_name, tier: a.tier, price: a.starting_bid, unit: a.starting_bid / d.count, count: d.count, start: a.start, end: a.end, seller: a.auctioneer, flags: d.flags, key: d.key };
      const g = groups.get(d.key); g ? g.push(l) : groups.set(d.key, [l]);
    }
    const now = Date.now(), out = [], snipes = [];
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      list.sort((x, y) => x.unit - y.unit);
      const low = list[0];
      const others = list.filter(l => l.seller !== low.seller);
      if (!others.length) continue;
      const next = others[0];
      const third = others.find(l => l.seller !== next.seller);
      const hist = (history.get(key) || []).filter(s => now - s[0] < 3 * 864e5);
      const histMedian = hist.length >= 5 ? trimmedMedian(hist.map(s => s[1])) : null;

      const snipe = findSnipe(low, others, histMedian, hist.length, derpy);
      if (snipe) snipes.push(snipe);

      const target = histMedian != null ? Math.min(next.unit, histMedian) : next.unit;
      const profit = Math.round(net(target * low.count, derpy) - low.price);
      if (profit < MIN_KEEP) continue;

      // Two Hypixel-only checks:
      // sales — recent real sales back up the next-cheapest price
      // depth — at least one more seller lists close to that price (not a lone outlier)
      const sales = histMedian == null ? 'thin' : Math.abs(histMedian - next.unit) / next.unit <= 0.12 ? 'agree' : 'disagree';
      const depth = !third ? 'thin' : (third.unit - next.unit) / next.unit <= 0.10 ? 'agree' : 'gap';
      const suspicious = low.unit < target * 0.2;
      const agree = (sales === 'agree') + (depth === 'agree');
      const confidence = suspicious || sales === 'disagree' ? 'risky' : agree === 2 ? 'confirmed' : agree === 1 ? 'likely' : 'unverified';

      out.push({ ...low, target, profit, margin: profit / low.price, secondBin: next.unit, thirdBin: third ? third.unit : null,
        histMedian, histN: hist.length, listed: list.length, checks: { sales, depth }, confidence });
    }
    // Regular (bid) auctions ending soon whose next bid is well below what the
    // same item sells for as a BIN. Priced against the same market as BIN snipes.
    for (const a of auctions) {
      if (a.bin || a.claimed) continue;
      const left = a.end - now;
      if (left <= 0 || left > ENDING_WINDOW) continue;
      const d = described.get(a.uuid);
      if (!d || !d.key) continue;
      const list = groups.get(d.key);
      if (!list || list.length < 2) continue; // need BIN listings to price it
      const hist = (history.get(d.key) || []).filter(s => now - s[0] < 3 * 864e5);
      const histMedian = hist.length >= 5 ? trimmedMedian(hist.map(s => s[1])) : null;
      const bid = a.highest_bid_amount > 0 ? Math.ceil(a.highest_bid_amount * BID_STEP) : a.starting_bid;
      const l = { uuid: a.uuid, name: a.item_name, tier: a.tier, price: bid, unit: bid / d.count, count: d.count, start: a.start, end: a.end, seller: a.auctioneer, flags: d.flags, key: d.key };
      const snipe = findSnipe(l, list.filter(x => x.seller !== a.auctioneer), histMedian, hist.length, derpy, { type: 'auction', minRatio: ENDING_RATIO, bids: (a.bids || []).length });
      if (snipe) snipes.push(snipe);
    }

    // Plain items (no stars, recombobulator, pet or book variants) with their
    // cheapest BIN and how many are listed: the pool for investment candidates.
    const market = [];
    for (const [key, list] of groups) {
      if (key.includes('|') || key.startsWith('PET_') || key.startsWith('ENCHANTMENT_')) continue;
      let low = list[0];
      for (const l of list) if (l.unit < low.unit) low = l;
      market.push({ key, low: low.unit, lowUuid: low.uuid, name: low.name, tier: low.tier, listed: list.length });
    }

    out.sort((a, b) => b.profit - a.profit);
    snipes.sort((a, b) => b.profit - a.profit);
    return { flips: out.slice(0, 800), snipes: snipes.slice(0, 300), market, bins };
  }

  // ---------- snipes: listings priced far below the item's going rate ----------
  // Market price = median of the three cheapest listings from other sellers
  // (one overpriced listing can't inflate it), capped by recent real sales.
  // A listing qualifies when it costs a third of that or less. When the gap is
  // close to 10x, 100x or 1000x, it's labelled as a likely missing zero.
  const SNIPE_RATIO = 3;
  const SNIPE_MIN_PROFIT = 250_000; // a snipe must clear more than this after tax
  // Bid auctions: look at ones ending within 5 minutes (earlier than that they
  // nearly always get bid up to the item's value). The next bid has to beat
  // the current one by about 15%, and a snipe needs the item to be worth at
  // least 1.5x that bid (a bid auction rarely ends at a third of the price).
  const ENDING_WINDOW = 5 * 60e3, BID_STEP = 1.15, ENDING_RATIO = 1.5;
  // How many zeros does the gap look like? Allow ±40% around each power of ten.
  function zerosFor(ratio) {
    const z = Math.round(Math.log10(ratio));
    return z >= 1 && ratio / 10 ** z >= 0.6 && ratio / 10 ** z <= 1.4 ? z : 0;
  }
  // Fold in the 3-day median sale price once it's known: the market price can
  // only go down, so a snipe has to be cheap against what the item has really
  // been selling for, not just against today's listings.
  function applyThreeDay(s) {
    s.market = s.avg3d ? Math.min(s.baseMarket, s.avg3d) : s.baseMarket;
    s.ratio = s.market / s.unit;
    s.profit = Math.round(net(s.market * s.count, isDerpy()) - s.price);
    s.margin = s.profit / s.price;
    s.missingZeros = s.type === 'auction' ? 0 : zerosFor(s.ratio);
    s.below3d = !!s.avg3d && (s.ratio < (s.minRatio || SNIPE_RATIO) || s.profit <= SNIPE_MIN_PROFIT);
    s.reference = s.avg3d && Math.abs(s.avg3d - s.listMedian) / s.listMedian <= 0.25 ? 'solid' : s.baseReference;
  }
  const SNIPE_MAX_AGE = 30 * 60e3; // a real typo gets bought within minutes; older ones usually aren't cheap
  function findSnipe(low, others, histMedian, histN, derpy, opts = {}) {
    const type = opts.type || 'bin', minRatio = opts.minRatio || SNIPE_RATIO;
    if (type === 'bin' && Date.now() - low.start > SNIPE_MAX_AGE) return null;
    const sellers = new Set(), refs = [];
    for (const l of others) {
      if (sellers.has(l.seller)) continue;
      sellers.add(l.seller); refs.push(l.unit);
      if (refs.length === 3) break;
    }
    const listMedian = refs.length === 3 ? refs[1] : refs.length === 2 ? (refs[0] + refs[1]) / 2 : refs[0];
    const market = histMedian != null ? Math.min(listMedian, histMedian) : listMedian;
    const ratio = market / low.unit;
    if (ratio < minRatio) return null;
    const profit = Math.round(net(market * low.count, derpy) - low.price);
    if (profit <= SNIPE_MIN_PROFIT) return null;

    const missingZeros = type === 'bin' ? zerosFor(ratio) : 0;

    // How trustworthy is the market price?
    // solid  — real sales agree with the listings, or three sellers list within 15% of each other
    // likely — two other sellers list within 30% of each other
    // check  — rests on a single listing, or the listings disagree
    const salesAgree = histMedian != null && Math.abs(histMedian - listMedian) / listMedian <= 0.25;
    const tight = refs.length === 3 && (refs[2] - refs[0]) / refs[0] <= 0.15;
    const pair = refs.length >= 2 && (refs[1] - refs[0]) / refs[0] <= 0.30;
    const reference = salesAgree || tight ? 'solid' : pair ? 'likely' : 'check';

    return { ...low, type, minRatio, bids: opts.bids || 0, market, baseMarket: market, baseReference: reference, listMedian, histMedian, histN, refs, ratio, missingZeros, reference,
      profit, margin: profit / low.price, listed: others.length + 1 };
  }

  // ---------- update loop ----------
  // Hypixel rebuilds the list about once a minute. Shortly before the next expected
  // rebuild, poll page 0 every second until it changes. Then fetch every page at once,
  // and while those load, show snipes from page 0 straight away (it holds the newest
  // listings), compared against the previous full scan.
  let lastUpdated = 0, raw = [], lastEnded = 0, lastCycleAt = 0, totalPages = 1;
  // Derpy quadruples the claim tax, so read the current mayor from Hypixel every 10 minutes.
  let mayor = null, mayorAt = 0;
  async function refreshMayor() {
    if (Date.now() - mayorAt < 10 * 60e3) return;
    try { const j = await getJSON('https://api.hypixel.net/v2/resources/skyblock/election'); mayor = j.mayor && j.mayor.name; mayorAt = Date.now(); } catch {}
  }
  const isDerpy = () => mayor === 'Derpy';
  const listeners = [];
  const state = { status: 'starting', error: null };

  // Snipes from the first pages to arrive, shown before the full scan finishes.
  async function earlySnipes(firstPages, t0) {
    const fresh = [];
    for (const p of firstPages) for (const a of p.auctions) if (!described.has(a.uuid)) fresh.push(a);
    const nowMs = Date.now();
    const todo = fresh.filter(a => a.bin || (a.end - nowMs > 0 && a.end - nowMs <= ENDING_WINDOW)).map(a => [a.uuid, a.item_bytes, a.item_name]);
    for (const [id, d] of await decode(todo)) described.set(id, d);
    const ids = new Set(fresh.map(a => a.uuid));
    const quick = computeFlips(fresh.concat(raw.filter(a => !ids.has(a.uuid))), isDerpy());
    state.snipes = quick.snipes;
    state.earlyMs = performance.now() - t0;
    annotateVolumes();
    emit();
    wantVolumes(quick.snipes);
  }

  async function cycle() {
    // Wait for Hypixel's next rebuild. The ended-auctions feed is tiny and is
    // rebuilt together with the auction pages, so it's the cheapest signal.
    // Page 0 alone can't be trusted: Hypixel sometimes serves it minutes stale.
    let ended;
    for (;;) {
      try {
        ended = await getJSON(`${API}/auctions_ended`);
        state.error = null;
        if (ended.lastUpdated !== lastEnded) break;
        if (Date.now() - lastCycleAt > 75_000) break; // safety net if the feed itself stalls
      } catch (e) { state.error = e.message; emit(); }
      await sleep(1000);
    }
    lastEnded = ended.lastUpdated;
    lastCycleAt = Date.now();
    const t0 = performance.now();
    if (!raw.length) { state.status = 'fetching'; emit(); }

    // Fetch every page at once, requested from both ends inward (0, last, 1,
    // last-1, ...). Each page gets 5 seconds; a page that hasn't arrived by then
    // is skipped for this update rather than holding everything up.
    const PAGE_TIMEOUT = 5000;
    const getPage = p => getJSON(`${API}/auctions?page=${p}`, PAGE_TIMEOUT).catch(() => null);
    const order = [];
    for (let lo = 0, hi = totalPages - 1; lo <= hi; lo++, hi--) { order.push(lo); if (hi !== lo) order.push(hi); }
    const got = new Array(totalPages).fill(undefined);
    let early = null;
    const reqs = order.map(p => getPage(p).then(pg => {
      got[p] = pg;
      // Early pass: once the first two pages from each end are in, show
      // snipes from them straight away (merged with last update's listings).
      if (!early && raw.length && order.slice(0, 4).every(i => got[i] !== undefined)) early = earlySnipes(order.slice(0, 4).map(i => got[i]).filter(Boolean), t0);
      return pg;
    }));
    let pages = await Promise.all(reqs);
    if (early) await early;
    const reported = Math.max(0, ...pages.filter(Boolean).map(p => p.totalPages || 0));
    if (reported > totalPages) pages = pages.concat(await Promise.all(Array.from({ length: reported - totalPages }, (_, i) => getPage(totalPages + i))));
    if (reported) totalPages = reported;
    const skippedPages = pages.filter(p => !p || !p.auctions).length;
    pages = pages.filter(p => p && p.auctions);
    if (!pages.length) throw new Error('Hypixel returned no auction pages');

    // Use the newest snapshot. A page stuck on an older snapshot still counts
    // (its listings are mostly still valid), but duplicates are dropped.
    const newest = Math.max(...pages.map(p => p.lastUpdated));
    const stalePages = pages.filter(p => p.lastUpdated !== newest).length;
    const seen = new Set(), auctions = [];
    for (const p of pages.sort((a, b) => b.lastUpdated - a.lastUpdated)) {
      for (const a of p.auctions) if (!seen.has(a.uuid)) { seen.add(a.uuid); auctions.push(a); }
    }
    const fetchMs = performance.now() - t0;

    // Decode only listings we haven't seen before; forget ones that are gone.
    for (const k of described.keys()) if (!seen.has(k)) described.delete(k);
    const nowMs = Date.now();
    const wanted = a => a.bin || (a.end - nowMs > 0 && a.end - nowMs <= ENDING_WINDOW);
    const todo = auctions.filter(a => wanted(a) && !described.has(a.uuid)).map(a => [a.uuid, a.item_bytes, a.item_name]);
    state.status = described.size ? 'updating' : 'decoding'; emit();
    for (let i = 0; i < todo.length; i += 4000) {
      for (const [id, d] of await decode(todo.slice(i, i + 4000))) described.set(id, d);
    }
    await Promise.all([recordEnded(ended.auctions || []), refreshMayor()]);

    lastUpdated = newest;
    raw = auctions;
    const res = computeFlips(raw, isDerpy());
    Object.assign(state, {
      status: 'live', lastUpdated, auctions: auctions.length, bins: res.bins, stalePages, skippedPages,
      fetchMs, totalMs: performance.now() - t0, flips: res.flips, snipes: res.snipes,
      salesSession: salesThisSession, historyItems: history.size, mayor, derpy: isDerpy(),
      market: res.market,
    });
    annotateVolumes();
    wantHistories(res.market);
    evaluateInvestments();
    emit();
    wantVolumes(res.snipes);
    // Sleep until just before the next expected rebuild, then poll every second.
    await sleep(Math.max(500, Math.min(ended.lastUpdated + 57_000 - Date.now(), 60_000)));
  }

  // ---------- sales speed (Coflnet) ----------
  // Hypixel's API only lists the last minute of sales, so how fast an item sells
  // comes from Coflnet's public price API (sky.coflnet.com), which allows
  // requests from any site. Its price summary covers the last 3 days: "volume"
  // is the average sales per day and "median" the typical sale price.
  // Results are cached for 3 hours and requests are paced well under its limit
  // (30 per 10 seconds); none of this ever delays a Hypixel refresh.
  const VOL_KEY = 'skyflip-volume-v1', VOL_TTL = 3 * 3600e3;
  const volumes = new Map(); // coflnet id -> { v: sales/day or null, at }
  try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(VOL_KEY) || '{}'))) volumes.set(k, v); } catch {}
  const saveVolumes = () => { try { const o = {}; const cut = Date.now() - VOL_TTL; for (const [k, v] of volumes) if (v.at > cut && v.v != null) o[k] = v; localStorage.setItem(VOL_KEY, JSON.stringify(o)); } catch {} };
  const volQueue = [];
  let volBusy = false;
  // Build the Coflnet query that matches this exact kind of item: same rarity
  // (which also covers recombobulated items), same stars, same pet level range.
  function coflFor(s) {
    const parts = s.key.split('|');
    const pet = /^PET_(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC)_(.+)$/.exec(parts[0]);
    const q = new URLSearchParams();
    let tag = parts[0];
    if (pet) {
      tag = 'PET_' + pet[2];
      q.set('Rarity', pet[1]);
      const lv = /^L(\d+)(s|\+)?$/.exec(parts[1] || '');
      if (lv) q.set('PetLevel', lv[2] ? `${lv[1]}-${+lv[1] + 9}` : lv[1]);
    } else if (!tag.startsWith('ENCHANTMENT_')) {
      if (s.tier) q.set('Rarity', s.tier);
      const st = parts.find(p => p.startsWith('stars:'));
      if (st) q.set('Stars', st.slice(6));
    }
    const qs = q.toString();
    // Kuudra attributes aren't matched, so the 3-day price would be misleading there.
    return { tag, q: qs ? '?' + qs : '', id: tag + (qs ? '?' + qs : ''), priceOk: !parts.some(p => p.startsWith('attr:')) };
  }
  function annotateVolumes() {
    if (!state.snipes) return;
    for (const s of state.snipes) {
      const c = coflFor(s), v = volumes.get(c.id);
      s.volume = v ? v.v : undefined;
      s.avg3d = v && c.priceOk && v.med ? v.med : null;
      applyThreeDay(s);
    }
  }
  function wantVolumes(snipes) {
    const now = Date.now();
    // Newest listings first: those are the ones worth acting on quickly.
    for (const s of [...snipes].sort((a, b) => b.start - a.start)) {
      const c = coflFor(s), v = volumes.get(c.id);
      if ((!v || now - v.at > VOL_TTL) && !volQueue.some(x => x.id === c.id)) volQueue.push(c);
    }
    pumpVolumes();
  }
  async function pumpVolumes() {
    if (volBusy) return;
    volBusy = true;
    let since = 0;
    while (volQueue.length) {
      const c = volQueue.shift();
      try {
        const r = await fetch(`https://sky.coflnet.com/api/item/price/${encodeURIComponent(c.tag)}${c.q}`);
        if (r.status === 429) { volQueue.unshift(c); await sleep(10_000); continue; }
        const j = r.ok ? await r.json() : null;
        volumes.set(c.id, { v: j && typeof j.volume === 'number' ? j.volume : 0, med: j && j.median || null, at: Date.now() });
        state.volStatus = 'ok';
      } catch {
        // Unreachable: retry this item in about 5 minutes, show snipes unfiltered meanwhile.
        volumes.set(c.id, { v: null, at: Date.now() - VOL_TTL + 5 * 60e3 });
        state.volStatus = 'error';
      }
      if (++since >= 4 || !volQueue.length) { since = 0; annotateVolumes(); emit(); }
      await sleep(400);
    }
    saveVolumes();
    volBusy = false;
  }

  // ---------- bazaar ----------
  // Hypixel's bazaar endpoint (no key needed) lists every product's order book.
  // For order flipping we need the top of each side:
  //   sell_summary[0] = the highest buy order  (you outbid it by 0.1 to buy)
  //   buy_summary[0]  = the lowest sell offer  (you undercut it by 0.1 to sell)
  // and how much trades: sellMovingWeek = items instantly sold into buy orders,
  // buyMovingWeek = items instantly bought from sell offers (last 7 days).
  // It refreshes about every 20 seconds, independently of the auction loop.
  async function bazaarCycle() {
    const j = await getJSON(`${API}/bazaar`);
    const rows = [];
    for (const p of Object.values(j.products || {})) {
      const bid = p.sell_summary && p.sell_summary[0], ask = p.buy_summary && p.buy_summary[0], q = p.quick_status || {};
      if (!bid || !ask) continue;
      rows.push({
        id: p.product_id, bid: bid.pricePerUnit, ask: ask.pricePerUnit,
        buyOrders: q.buyOrders || 0, sellOrders: q.sellOrders || 0,
        instaSoldWeek: q.sellMovingWeek || 0, instaBoughtWeek: q.buyMovingWeek || 0,
      });
    }
    state.bazaar = rows;
    state.bazaarUpdated = j.lastUpdated;
    state.bazaarError = null;
    emit();
  }

  // ---------- investments ----------
  // Looks for liquid items whose price has dropped well below a stable 30-day
  // level, without having been in a slide before the drop: the kind of dip that
  // usually comes back (an event flooding the market, a mayor perk ending...).
  // Daily price history comes from Coflnet (sky.coflnet.com/api/item/price/
  // {item}/history/month): 31 days of average, min, max and volume per day.
  // Fetched for the 120 most-listed plain items worth over 100k, paced well
  // under Coflnet's limits, and cached in this browser for 6 hours.
  const HIST_KEY = 'chudhouse-history-v1', HIST_TTL = 6 * 3600e3;
  const INV_CANDIDATES = 120, INV_MIN_PRICE = 100_000;
  const histories = new Map(); // item id -> { at, days: [[avg, min, volume], ...] oldest first }
  try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(HIST_KEY) || '{}'))) if (Date.now() - v.at < HIST_TTL) histories.set(k, v); } catch {}
  const saveHistories = () => { try { localStorage.setItem(HIST_KEY, JSON.stringify(Object.fromEntries(histories))); } catch {} };
  const histQueue = [];
  let histBusy = false;
  function wantHistories(market) {
    const picks = market.filter(m => m.low >= INV_MIN_PRICE).sort((a, b) => b.listed - a.listed).slice(0, INV_CANDIDATES);
    state.investTotal = picks.length;
    const now = Date.now();
    for (const m of picks) {
      const h = histories.get(m.key);
      if ((!h || now - h.at > HIST_TTL) && !histQueue.includes(m.key)) histQueue.push(m.key);
    }
    pumpHistories();
  }
  async function pumpHistories() {
    if (histBusy) return;
    histBusy = true;
    let since = 0;
    while (histQueue.length) {
      const id = histQueue.shift();
      try {
        const r = await fetch(`https://sky.coflnet.com/api/item/price/${encodeURIComponent(id)}/history/month`);
        if (r.status === 429) { histQueue.unshift(id); await sleep(15_000); continue; }
        const j = r.ok ? await r.json() : [];
        histories.set(id, { at: Date.now(), days: (Array.isArray(j) ? j : []).map(d => [d.avg || 0, d.min || 0, d.volume || 0]) });
        state.investError = null;
      } catch {
        state.investError = 'Coflnet could not be reached';
        histQueue.push(id);
        await sleep(30_000);
      }
      if (++since >= 5 || !histQueue.length) { since = 0; evaluateInvestments(); saveHistories(); }
      await sleep(700);
    }
    histBusy = false;
  }
  const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function evaluateInvestments() {
    if (!state.market) return;
    const rows = [];
    let checked = 0;
    for (const m of state.market) {
      const h = histories.get(m.key);
      if (!h) continue;
      checked++;
      const days = h.days.filter(d => d[2] > 0);
      if (days.length < 20) continue;
      const recent = days.slice(-2), base = days.slice(0, -2);
      const vwap = ds => { const v = ds.reduce((s, d) => s + d[2], 0); return v ? ds.reduce((s, d) => s + d[0] * d[2], 0) / v : null; };
      const recentAvg = vwap(recent), recentMin = med(recent.map(d => d[1]));
      const baseAvg = med(base.map(d => d[0])), baseMin = med(base.map(d => d[1]));
      if (!recentAvg || !baseAvg || !baseMin || !recentMin) continue;
      const dip = 1 - recentAvg / baseAvg, dipMin = 1 - recentMin / baseMin;
      // Stability of the normal price, and whether it was already sliding.
      const mean = base.reduce((s, d) => s + d[0], 0) / base.length;
      const cv = Math.sqrt(base.reduce((s, d) => s + (d[0] - mean) ** 2, 0) / base.length) / mean;
      const half = base.length >> 1;
      const trend = med(base.slice(half).map(d => d[0])) / med(base.slice(0, half).map(d => d[0]));
      const volume = med(days.map(d => d[2]));
      if (dip < 0.12 || dip > 0.6 || dipMin < 0.10) continue;   // a clear drop on both measures
      if (cv > 0.3 || trend < 0.9 || volume < 10) continue;       // stable, not sliding, liquid
      const recovery = baseAvg / recentAvg;                      // how far back up "normal" is
      const target = m.low * recovery;
      const profit = Math.round(net(target, isDerpy()) - m.low);
      if (profit <= 0) continue;
      const confidence = cv <= 0.15 && trend >= 0.97 && volume >= 50 ? 'strong' : 'moderate';
      rows.push({ ...m, target, profit, upside: profit / m.low, dip, dipMin, cv, trend, volume, confidence,
        spark: days.map(d => d[0]), baseAvg });
    }
    rows.sort((a, b) => b.profit - a.profit);
    state.invest = rows;
    state.investChecked = checked;
    emit();
  }

  function emit() { listeners.forEach(f => f(state)); }

  window.SkyFlipEngine = {
    start() {
      startWorker();
      (async () => { for (;;) { try { await cycle(); } catch (e) { state.error = e.message; emit(); await sleep(5000); } } })();
      (async () => { for (;;) { try { await bazaarCycle(); } catch (e) { state.bazaarError = e.message; emit(); } await sleep(20_000); } })();
    },
    on(f) { listeners.push(f); },
  };
})();

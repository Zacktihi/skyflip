// SkyFlip engine — runs entirely in the visitor's browser on Hypixel's public auction API.
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
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('Hypixel returned HTTP ' + r.status);
    return r.json();
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
    out.sort((a, b) => b.profit - a.profit);
    snipes.sort((a, b) => b.profit - a.profit);
    return { flips: out.slice(0, 800), snipes: snipes.slice(0, 300), bins };
  }

  // ---------- snipes: listings priced far below the item's going rate ----------
  // Market price = median of the three cheapest listings from other sellers
  // (one overpriced listing can't inflate it), capped by recent real sales.
  // A listing qualifies when it costs a third of that or less. When the gap is
  // close to 10x, 100x or 1000x, it's labelled as a likely missing zero.
  const SNIPE_RATIO = 3;
  const SNIPE_MAX_AGE = 30 * 60e3; // a real typo gets bought within minutes; older ones usually aren't cheap
  function findSnipe(low, others, histMedian, histN, derpy) {
    if (Date.now() - low.start > SNIPE_MAX_AGE) return null;
    const sellers = new Set(), refs = [];
    for (const l of others) {
      if (sellers.has(l.seller)) continue;
      sellers.add(l.seller); refs.push(l.unit);
      if (refs.length === 3) break;
    }
    const listMedian = refs.length === 3 ? refs[1] : refs.length === 2 ? (refs[0] + refs[1]) / 2 : refs[0];
    const market = histMedian != null ? Math.min(listMedian, histMedian) : listMedian;
    const ratio = market / low.unit;
    if (ratio < SNIPE_RATIO) return null;
    const profit = Math.round(net(market * low.count, derpy) - low.price);
    if (profit < 100_000) return null;

    // How many zeros does the gap look like? Allow ±40% around each power of ten.
    const zeros = Math.round(Math.log10(ratio));
    const missingZeros = zeros >= 1 && ratio / 10 ** zeros >= 0.6 && ratio / 10 ** zeros <= 1.4 ? zeros : 0;

    // How trustworthy is the market price?
    // solid  — real sales agree with the listings, or three sellers list within 15% of each other
    // likely — two other sellers list within 30% of each other
    // check  — rests on a single listing, or the listings disagree
    const salesAgree = histMedian != null && Math.abs(histMedian - listMedian) / listMedian <= 0.25;
    const tight = refs.length === 3 && (refs[2] - refs[0]) / refs[0] <= 0.15;
    const pair = refs.length >= 2 && (refs[1] - refs[0]) / refs[0] <= 0.30;
    const reference = salesAgree || tight ? 'solid' : pair ? 'likely' : 'check';

    return { ...low, market, listMedian, histMedian, histN, refs, ratio, missingZeros, reference,
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

    // Fetch every page at once. totalPages comes from the last cycle; any page
    // reporting more pages than expected triggers a follow-up for the extras.
    const getPage = p => getJSON(`${API}/auctions?page=${p}`).catch(() => null);
    let pages = await Promise.all(Array.from({ length: totalPages }, (_, p) => getPage(p)));
    const reported = Math.max(0, ...pages.filter(Boolean).map(p => p.totalPages || 0));
    if (reported > totalPages) pages = pages.concat(await Promise.all(Array.from({ length: reported - totalPages }, (_, i) => getPage(totalPages + i))));
    if (reported) totalPages = reported;
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
    const todo = auctions.filter(a => a.bin && !described.has(a.uuid)).map(a => [a.uuid, a.item_bytes, a.item_name]);
    state.status = described.size ? 'updating' : 'decoding'; emit();
    for (let i = 0; i < todo.length; i += 4000) {
      for (const [id, d] of await decode(todo.slice(i, i + 4000))) described.set(id, d);
    }
    await Promise.all([recordEnded(ended.auctions || []), refreshMayor()]);

    lastUpdated = newest;
    raw = auctions;
    const res = computeFlips(raw, isDerpy());
    Object.assign(state, {
      status: 'live', lastUpdated, auctions: auctions.length, bins: res.bins, stalePages,
      fetchMs, totalMs: performance.now() - t0, flips: res.flips, snipes: res.snipes,
      salesSession: salesThisSession, historyItems: history.size, mayor, derpy: isDerpy(),
    });
    emit();
    // Sleep until just before the next expected rebuild, then poll every second.
    await sleep(Math.max(500, Math.min(ended.lastUpdated + 57_000 - Date.now(), 60_000)));
  }

  function emit() { listeners.forEach(f => f(state)); }

  window.SkyFlipEngine = {
    start() {
      startWorker();
      (async () => { for (;;) { try { await cycle(); } catch (e) { state.error = e.message; emit(); await sleep(5000); } } })();
    },
    on(f) { listeners.push(f); },
  };
})();

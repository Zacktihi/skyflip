// ChudHouse profile page: a player's SkyBlock character.
// Without an API key: skin, UUID and auction history (PlayerDB + Coflnet).
// With the player's own Hypixel API key (kept only in this browser's
// localStorage and sent only to api.hypixel.net): SkyBlock level, coins,
// skills, slayers, dungeons, worn gear, active pet, the accessory bag with
// magical power, the cheapest magical power to buy next, and live auctions.
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => n == null || !isFinite(n) ? '–' : Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toString();
  const strip = s => String(s || '').replace(/§./g, '');
  const icon = id => id ? `<img class="icon" src="https://sky.coflnet.com/static/icon/${encodeURIComponent(id)}" alt="" width="24" height="24" loading="lazy" onerror="this.style.visibility='hidden'">` : '';
  const KEY_STORE = 'chudhouse-api-key', NAME_STORE = 'chudhouse-profile-name';
  let market = null; // live prices from the main engine, for item values
  if (window.SkyFlipEngine) SkyFlipEngine.on(s => { if (s.lows) market = s; });

  // ---------- level tables ----------
  const SKILL_XP = [50,125,200,300,500,750,1000,1500,2000,3500,5000,7500,10000,15000,20000,30000,50000,75000,100000,200000,300000,400000,500000,600000,700000,800000,900000,1000000,1100000,1200000,1300000,1400000,1500000,1600000,1700000,1800000,1900000,2000000,2100000,2200000,2300000,2400000,2500000,2600000,2750000,2900000,3100000,3400000,3700000,4000000,4300000,4600000,4900000,5200000,5500000,5800000,6100000,6400000,6700000,7000000];
  const RUNE_XP = [50,100,125,160,200,250,315,400,500,625,785,1000,1250,1600,2000,2465,3125,4000,5000,6200,7800,9800,12200,15300,19050];
  const SOCIAL_XP = [50,100,150,250,500,750,1000,1250,1500,2000,2500,3000,3750,4500,6000,8000,10000,12500,15000,20000,25000,30000,35000,40000,50000];
  const CATA_XP = [50,75,110,160,230,330,470,670,950,1340,1890,2665,3760,5260,7380,10300,14400,20000,27600,38000,52500,71500,97000,132000,180000,243000,328000,445000,600000,800000,1065000,1410000,1900000,2500000,3300000,4300000,5600000,7200000,9200000,12000000,15000000,19000000,24000000,30000000,38000000,48000000,60000000,75000000,93000000,116250000];
  const SKILL_CAP = { FARMING: 60, MINING: 60, COMBAT: 60, FORAGING: 54, FISHING: 50, ENCHANTING: 60, ALCHEMY: 50, TAMING: 60, CARPENTRY: 50, RUNECRAFTING: 25, SOCIAL: 25 };
  const SLAYER_XP = {
    zombie: ['Revenant Horror', [5, 15, 200, 1000, 5000, 20000, 100000, 400000, 1000000]],
    spider: ['Tarantula Broodfather', [5, 25, 200, 1000, 5000, 20000, 100000, 400000, 1000000]],
    wolf: ['Sven Packmaster', [10, 30, 250, 1500, 5000, 20000, 100000, 400000, 1000000]],
    enderman: ['Voidgloom Seraph', [10, 30, 250, 1500, 5000, 20000, 100000, 400000, 1000000]],
    blaze: ['Inferno Demonlord', [10, 30, 250, 1500, 5000, 20000, 100000, 400000, 1000000]],
    vampire: ['Riftstalker Bloodfiend', [20, 75, 240, 840, 2400]],
  };
  // Level (with fraction toward the next one) from XP and a per-level table.
  function levelFrom(xp, table, cap = table.length) {
    let lvl = 0, left = xp || 0;
    for (const need of table.slice(0, cap)) { if (left < need) return { lvl, frac: left / need, xp }; left -= need; lvl++; }
    return { lvl, frac: 1, xp, max: true };
  }
  const slayerLevel = (xp, steps) => { let l = 0; for (const s of steps) if (xp >= s) l++; return l; };

  // ---------- NBT (inventory data is gzip + NBT, base64) ----------
  // The browser's built-in gzip decoder, so no extra library is needed.
  const gunzip = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
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
  async function decodeItems(data) {
    if (!data) return [];
    const raw = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const nbt = readNBT(await gunzip(raw));
    return (nbt.i || []).map(it => {
      if (!it || !it.tag) return null;
      const x = it.tag.ExtraAttributes || {}, d = it.tag.display || {};
      const lore = (d.Lore || []).map(strip);
      const tierLine = [...lore].reverse().find(l => /\b(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC|DIVINE|SPECIAL)\b/.test(l)) || '';
      const tier = (tierLine.match(/\b(VERY SPECIAL|COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC|DIVINE|SPECIAL)\b/) || [])[1] || '';
      return { id: x.id, name: strip(d.Name), tier: tier.replace(' ', '_'), stars: x.upgrade_level || x.dungeon_item_level || 0, recomb: !!x.rarity_upgrades };
    });
  }

  // ---------- fetching ----------
  const getJSON = async (url, opts) => { const r = await fetch(url, opts); const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && (j.cause || j.message)) || 'HTTP ' + r.status); return j; };
  const hypixel = (path, key) => getJSON('https://api.hypixel.net/v2/' + path, { headers: { 'API-Key': key } });
  async function lookupName(name) {
    const j = await getJSON('https://playerdb.co/api/player/minecraft/' + encodeURIComponent(name));
    const p = j && j.data && j.data.player;
    if (!p) throw new Error('No Minecraft player called ' + name);
    return { name: p.username, uuid: p.raw_id || p.id.replace(/-/g, '') };
  }

  // ---------- looks ----------
  const SKILL_LOOK = {
    FARMING: ['🌾', '#e2b93b'], MINING: ['⛏️', '#8fa3ba'], COMBAT: ['⚔️', '#e5533d'], FORAGING: ['🌳', '#3fae55'],
    FISHING: ['🎣', '#2fa5de'], ENCHANTING: ['✨', '#a463db'], ALCHEMY: ['⚗️', '#de4ca3'], TAMING: ['🐾', '#ec8f3e'],
    CARPENTRY: ['🪚', '#b07b4f'], RUNECRAFTING: ['🔮', '#dc74dc'], SOCIAL: ['💬', '#45c4a3'], HUNTING: ['🏹', '#c9873f'],
  };
  const SLAYER_LOOK = {
    zombie: ['MHF_Zombie', '#5fae4f'], spider: ['MHF_Spider', '#c4413b'], wolf: ['MHF_Wolf', '#b9c2cc'],
    enderman: ['MHF_Enderman', '#a556dd'], blaze: ['MHF_Blaze', '#f2a51f'], vampire: [null, '#d0304a'],
  };
  const CLASS_LOOK = { healer: ['💖', '#ee6fab'], mage: ['🪄', '#45b5e8'], berserk: ['🗡️', '#e05a4f'], archer: ['🏹', '#ec9f3f'], tank: ['🛡️', '#86a36f'] };
  // SkyBlock level colours as the game shows them (every 40 levels).
  const LEVEL_COLORS = ['#aaaaaa', '#ffffff', '#ffff55', '#55ff55', '#00aa00', '#55ffff', '#00aaaa', '#5555ff', '#ff55ff', '#aa00aa', '#ffaa00', '#ff5555', '#aa0000'];
  const MP = { COMMON: 3, UNCOMMON: 5, RARE: 8, EPIC: 12, LEGENDARY: 16, MYTHIC: 22, SPECIAL: 3, VERY_SPECIAL: 5, DIVINE: 22 };
  const TIER_ORDER = ['MYTHIC', 'DIVINE', 'LEGENDARY', 'EPIC', 'RARE', 'UNCOMMON', 'COMMON', 'VERY_SPECIAL', 'SPECIAL'];
  const mobHead = name => name ? `<img class="pmob" src="https://mc-heads.net/avatar/${name}/40" alt="" width="40" height="40" loading="lazy">` : '<span class="pmob pemoji">🧛</span>';

  // ---------- rendering ----------
  const bar = (frac, color) => `<div class="pbar"><i style="width:${Math.max(0, Math.min(1, frac)) * 100}%;${color ? 'background:' + color : ''}"></i></div>`;
  const stat = (k, v, sub = '', style = '') => `<div class="pstat"${style ? ` style="${style}"` : ''}><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const tile = (iconHtml, label, value, frac, color, sub, max) => `<div class="ptile" style="--c:${color}">${iconHtml}<div class="ptxt"><span>${label}</span><b>${value}${max ? ' <em>max</em>' : ''}</b>${bar(max ? 1 : frac, color)}<small>${sub || ''}</small></div></div>`;
  const RANKS = { VIP: 'VIP', VIP_PLUS: 'VIP+', MVP: 'MVP', MVP_PLUS: 'MVP+', SUPERSTAR: 'MVP++', YOUTUBER: 'YOUTUBE', ADMIN: 'ADMIN', GAME_MASTER: 'GM', MODERATOR: 'MOD', HELPER: 'HELPER' };
  const itemKey = it => [it.id, it.recomb ? 'recomb' : null, it.stars ? 'stars:' + it.stars : null].filter(Boolean).join('|');
  function itemValue(it) {
    if (!it || !it.id || !market || !market.lows) return null;
    const l = market.lows.get(itemKey(it)) || market.lows.get(it.id);
    return l ? l.low : null;
  }
  const gear = (it, slot) => it
    ? `<div class="pgearitem" title="${esc(it.name)}${itemValue(it) ? ' · lowest BIN ' + fmt(itemValue(it)) : ''}">${icon(it.id)}<div><span class="r-${esc(it.tier)}">${esc(it.name)}</span><small>${esc(slot)}${itemValue(it) ? ' · ' + fmt(itemValue(it)) : ''}</small></div></div>`
    : `<div class="pgearitem empty"><div><span>–</span><small>${esc(slot)}</small></div></div>`;

  // ---------- talismans ----------
  let talData = null; // { acc: Map id -> {name, tier}, upgrades: {id: [higher ids]} }
  const talReady = fetch('talismans.json?v=1').then(r => r.json()).then(j => {
    talData = { acc: new Map(j.accessories.map(([id, name, tier]) => [id, { name, tier }])), upgrades: j.upgrades || {} };
  }).catch(() => {});
  // Which owned accessories count: one per id, and none that an owned upgrade replaces.
  function accessoryState(items) {
    const owned = new Map();
    for (const it of items) if (it && it.id && (!owned.has(it.id) || (MP[it.tier] || 0) > (MP[owned.get(it.id).tier] || 0))) owned.set(it.id, it);
    const up = (talData && talData.upgrades) || {};
    const list = items.filter(Boolean).map((it, i) => {
      const dup = owned.get(it.id) !== it;
      const replacedBy = (up[it.id] || []).find(x => owned.has(x));
      let mp = MP[it.tier] || 0;
      if (it.id === 'HEGEMONY_ARTIFACT') mp *= 2;
      return { ...it, active: !dup && !replacedBy, why: dup ? 'duplicate' : replacedBy ? 'upgraded version owned' : '', mp };
    });
    const mp = list.filter(x => x.active).reduce((a, x) => a + x.mp, 0);
    return { list, owned, mp };
  }
  // Cheapest magical power: every accessory not owned (and not made pointless by
  // an owned upgrade), priced at the cheapest BIN or bazaar instant buy, ranked by
  // coins per magical power gained. An upgrade only gains the difference over the
  // accessory it replaces.
  function bestValue(state) {
    if (!talData || !market || !market.lows) return null;
    const up = talData.upgrades, owned = state ? state.owned : new Map();
    const bz = new Map((market.bazaar || []).map(r => [r.id, r]));
    const out = [];
    for (const [id, a] of talData.acc) {
      if (owned.has(id)) continue;
      if ((up[id] || []).some(x => owned.has(x))) continue;
      let replaces = null, base = 0;
      for (const [oid, it] of owned) if ((up[oid] || []).includes(id)) { const m = MP[it.tier] || 0; if (m >= base) { base = m; replaces = it; } }
      const gain = (MP[a.tier] || 0) * (id === 'HEGEMONY_ARTIFACT' ? 2 : 1) - base;
      if (gain <= 0) continue;
      const l = market.lows.get(id), b = bz.get(id);
      const price = l ? l.low : b ? b.ask : null;
      if (!price) continue;
      out.push({ id, ...a, gain, price, per: price / gain, replaces, listed: l ? l.n : null });
    }
    return out.sort((x, y) => x.per - y.per);
  }
  function talismanCards(state, hasKey) {
    const parse = s => { const m = /^\s*([\d.]+)\s*([kmb]?)\s*$/i.exec(s || ''); return m ? +m[1] * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1) : 0; };
    const cap = parse(($('#tmax') && $('#tmax').value) || savedMax);
    // Viewer
    let left;
    if (!state) left = `<div class="pcard"><h3>🎒 Accessory bag</h3><div class="empty">${hasKey ? 'The inventory API is off for this profile, so the accessory bag can\'t be read.' : 'Add your API key to see the talismans you use.'}</div></div>`;
    else {
      const byTier = [...state.list].sort((a, b) => (b.active - a.active) || TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.name.localeCompare(b.name));
      const value = state.list.filter(x => x.active).reduce((a, x) => a + (itemValue(x) || 0), 0);
      const counts = {}; state.list.filter(x => x.active).forEach(x => counts[x.tier] = (counts[x.tier] || 0) + 1);
      left = `<div class="pcard"><h3>🎒 Accessory bag <small>${state.list.filter(x => x.active).length} active · ${state.mp} magical power${value ? ' · worth ~' + fmt(value) : ''}</small></h3>
        <div class="ptiers">${TIER_ORDER.filter(t => counts[t]).map(t => `<span class="r-${t}">${counts[t]} ${t.replace('_', ' ').toLowerCase()}</span>`).join('')}</div>
        <div class="ptals">${byTier.map(x => `<div class="ptal${x.active ? '' : ' off'}" title="${esc(x.name)} · ${x.active ? '+' + x.mp + ' MP' : 'not counted: ' + x.why}${itemValue(x) ? ' · lowest BIN ' + fmt(itemValue(x)) : ''}">${icon(x.id)}<span class="r-${esc(x.tier)}">${esc(x.name)}</span><b>${x.active ? x.mp : '–'}</b></div>`).join('')}</div></div>`;
    }
    // Best value finder
    const rows = bestValue(state);
    let right;
    if (!rows) right = `<div class="pcard"><h3>💰 Cheapest magical power</h3><div class="empty">Waiting for auction house prices…</div></div>`;
    else {
      const present = TIER_ORDER.filter(t => rows.some(r => r.tier === t));
      const pick = present.filter(t => tierPick.has(t));
      const shown = rows.filter(r => (!cap || r.price <= cap) && (!pick.length || pick.includes(r.tier))).slice(0, 40);
      const chips = `<div class="prar" role="group" aria-label="Filter by rarity"><button type="button" data-tier="" class="${pick.length ? '' : 'on'}">All</button>${present.map(t => `<button type="button" data-tier="${t}" class="r-${t}${tierPick.has(t) ? ' on' : ''}">${t.replace('_', ' ').toLowerCase()}</button>`).join('')}</div>`;
      let sumP = 0, sumM = 0; shown.slice(0, 10).forEach(r => { sumP += r.price; sumM += r.gain; });
      right = `<div class="pcard"><h3>💰 Cheapest magical power <small>${state ? 'talismans you don\'t have yet' : 'for an empty bag'}</small></h3>
        <div class="pfind"><label>Max price <input id="tmax" type="text" inputmode="decimal" placeholder="e.g. 5m" value="${esc(($('#tmax') && $('#tmax').value) || savedMax)}"></label>
        ${chips}
        ${shown.length ? `<span class="psum">Top 10: <b>+${sumM} MP</b> for <b>${fmt(sumP)}</b></span>` : ''}</div>
        ${shown.length ? `<table class="ptable"><thead><tr><th>Talisman</th><th class="num">+MP</th><th class="num">Price</th><th class="num">Per MP</th></tr></thead><tbody>${shown.map(r => `<tr>
          <td>${icon(r.id)}<span class="r-${esc(r.tier)}" data-item="${esc(r.id)}" data-kind="ah" data-tier="${esc(r.tier)}">${esc(r.name)}</span>${r.replaces ? ` <small class="pup">upgrades ${esc(r.replaces.name)}</small>` : ''}</td>
          <td class="num"><b class="pmp">+${r.gain}</b></td><td class="num">${fmt(r.price)}</td><td class="num">${fmt(r.per)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">Nothing ${pick.length ? 'of that rarity ' : ''}${cap ? 'under that price ' : ''}right now.</div>`}
        <div class="note">Magical power per rarity: common 3, uncommon 5, rare 8, epic 12, legendary 16, mythic 22. Upgrades only count what they add over the version you own. Prices are the cheapest BIN (or bazaar instant buy) right now; ${state ? 'recombobulating what you already own is not included.' : 'add your key to skip the ones you already own.'}</div></div>`;
    }
    return `<div class="ptwo">${left}${right}</div>`;
  }
  let savedMax = '';
  // Rarities picked in the cheapest-MP filter (none picked = all), kept in this browser.
  const TIER_STORE = 'chudhouse-mp-tiers';
  let tierPick = new Set();
  try { tierPick = new Set(JSON.parse(localStorage.getItem(TIER_STORE) || '[]')); } catch {}

  let current = null;
  async function show(name) {
    name = (name || '').trim();
    if (!name) return;
    const out = $('#pout'), key = ($('#pkey').value || '').trim();
    out.innerHTML = '<div class="pcard empty">Looking up ' + esc(name) + '…</div>';
    try {
      const who = await lookupName(name);
      try { localStorage.setItem(NAME_STORE, who.name); } catch {}
      setNavHead(who.uuid);
      current = { ...who, profiles: null, player: null, auctions: null, error: null, items: {} };
      const jobs = [talReady, getJSON(`https://sky.coflnet.com/api/player/${who.uuid}/auctions?page=0`).then(a => current.history = a).catch(() => current.history = [])];
      if (key) {
        jobs.push(hypixel('skyblock/profiles?uuid=' + who.uuid, key).then(j => current.profiles = j.profiles || []).catch(e => current.error = e.message));
        jobs.push(hypixel('player?uuid=' + who.uuid, key).then(j => current.player = j.player).catch(() => {}));
        jobs.push(hypixel('skyblock/auction?player=' + who.uuid, key).then(j => current.auctions = j.auctions || []).catch(() => {}));
      }
      await Promise.all(jobs);
      if (current.auctions) for (const a of current.auctions) {
        try { const [it] = await decodeItems(typeof a.item_bytes === 'string' ? a.item_bytes : a.item_bytes && a.item_bytes.data); if (it && it.id) a._key = itemKey(it); } catch {}
      }
      const sel = current.profiles && (current.profiles.find(p => p.selected) || current.profiles[0]);
      current.profileId = sel ? sel.profile_id : null;
      await render();
    } catch (e) {
      out.innerHTML = '<div class="pcard empty">' + esc(e.message) + '</div>';
    }
  }
  // Decode a profile's armour, equipment and accessory bag once.
  async function itemsFor(m, pid) {
    if (current.items[pid]) return current.items[pid];
    const inv = (m && m.inventory) || {}, dec = async d => { try { return await decodeItems(d && d.data); } catch { return []; } };
    const [armor, equip, tal] = await Promise.all([dec(inv.inv_armor), dec(inv.equipment_contents), dec(inv.bag_contents && inv.bag_contents.talisman_bag)]);
    const hasInv = !!(inv.inv_armor || inv.equipment_contents || (inv.bag_contents && inv.bag_contents.talisman_bag));
    return current.items[pid] = { armor: armor.reverse(), equip, tal: tal.filter(Boolean), hasInv };
  }
  async function render() {
    const c = current, out = $('#pout');
    if (!c) return;
    const hasKey = !!$('#pkey').value.trim();
    const prof = c.profiles && c.profiles.find(p => p.profile_id === c.profileId);
    const m = prof && prof.members && prof.members[c.uuid];
    const it = m ? await itemsFor(m, c.profileId) : { armor: [], equip: [], tal: [], hasInv: false };
    const rank = c.player && (c.player.prefix ? strip(c.player.prefix) : RANKS[c.player.rank !== 'NORMAL' && c.player.rank] || RANKS[c.player.monthlyPackageRank === 'SUPERSTAR' && 'SUPERSTAR'] || RANKS[c.player.newPackageRank] || '');
    const pets = (m && m.pets_data && m.pets_data.pets) || [], pet = pets.find(p => p.active);
    const petName = pet ? pet.type.split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ') : null;

    // Character: armour | skin | equipment, then name and headline stats.
    let html = `<div class="pcard pchar">
      <div class="pgearcol">${['Helmet', 'Chestplate', 'Leggings', 'Boots'].map((n, i) => gear(it.armor[i], n)).join('')}</div>
      <div class="pskinwrap"><img class="pskin" src="https://mc-heads.net/body/${c.uuid}/180" alt="${esc(c.name)}'s skin" width="90" height="216" onerror="this.style.visibility='hidden'"></div>
      <div class="pgearcol">${['Necklace', 'Cloak', 'Belt', 'Gloves'].map((n, i) => gear(it.equip[i], n)).join('')}
        ${pet ? `<div class="pgearitem" title="Active pet">${icon('PET_' + pet.type)}<div><span class="r-${esc(pet.tier)}">${esc(petName)}</span><small>Pet${pet.heldItem ? ' · ' + esc(pet.heldItem.replace(/_/g, ' ').toLowerCase()) : ''}</small></div></div>` : `<div class="pgearitem empty"><div><span>–</span><small>Pet</small></div></div>`}
      </div>
      <div class="pwho">
        <h2>${rank ? `<span class="prank">[${esc(rank.replace(/^\[|\]$/g, ''))}]</span> ` : ''}${esc(c.name)}</h2>
        <code>${c.uuid}</code>
        ${c.profiles && c.profiles.length ? `<label class="psel">Profile <select id="pprof">${c.profiles.map(p => `<option value="${p.profile_id}"${p.profile_id === c.profileId ? ' selected' : ''}>${esc(p.cute_name)}${p.game_mode ? ' (' + esc(p.game_mode) + ')' : ''}${p.selected ? ' · active' : ''}</option>`).join('')}</select></label>` : ''}
        <div class="plinks"><a href="https://sky.shiiyu.moe/stats/${encodeURIComponent(c.name)}" target="_blank" rel="noopener">SkyCrypt ↗</a><a href="https://sky.coflnet.com/player/${c.uuid}" target="_blank" rel="noopener">Coflnet ↗</a></div>`;
    if (m) {
      const lvl = (m.leveling && m.leveling.experience || 0) / 100, lc = LEVEL_COLORS[Math.min(12, Math.floor(lvl / 40))];
      const purse = m.currencies && m.currencies.coin_purse, bank = prof.banking && prof.banking.balance;
      const gearValue = [...it.armor, ...it.equip].reduce((a, x) => a + (itemValue(x) || 0), 0);
      html += `<div class="pstats">
        ${stat('SkyBlock level', `<span class="plevel" style="color:${lc}">${Math.floor(lvl)}</span>`, bar(lvl % 1, lc))}
        ${stat('Purse', '🪙 ' + fmt(purse))}
        ${stat('Bank', bank == null ? 'API off' : '🏦 ' + fmt(bank))}
        ${stat('Fairy souls', '🧚 ' + ((m.fairy_soul && m.fairy_soul.total_collected) || 0))}
        ${gearValue ? stat('Gear worth', '⚔️ ' + fmt(gearValue), 'at lowest BIN') : ''}
        ${stat('Playing since', m.profile && m.profile.first_join ? new Date(m.profile.first_join).toLocaleDateString() : '–')}
      </div>`;
    }
    html += `</div></div>`;
    if (!hasKey) html += `<div class="pcard pnote"><b>Add your Hypixel API key to see your character.</b> Levels, skills, slayers, dungeons, your gear, your talismans and your live auctions come from Hypixel's API, which needs a key for player data. Make one at <a href="https://developer.hypixel.net" target="_blank" rel="noopener">developer.hypixel.net</a> (sign in, then create a key) and paste it above. It is kept only in this browser and sent only to Hypixel.</div>`;
    else if (c.error) html += `<div class="pcard pnote">Hypixel said: <b>${esc(c.error)}</b>. ${/invalid/i.test(c.error) ? 'Check the key; personal development keys expire after a few days and need renewing at developer.hypixel.net.' : ''}</div>`;
    else if (!m) html += `<div class="pcard pnote">No SkyBlock profiles found for this player.</div>`;

    if (m) {
      // Skills
      const exp = (m.player_data && m.player_data.experience) || {};
      const skills = Object.entries(exp).filter(([k]) => k.startsWith('SKILL_')).map(([k, xp]) => {
        const name = k.slice(6), table = name === 'RUNECRAFTING' ? RUNE_XP : name === 'SOCIAL' ? SOCIAL_XP : SKILL_XP;
        return { name, ...(name in SKILL_CAP ? levelFrom(xp, table, SKILL_CAP[name]) : { lvl: null, frac: 0, xp }) };
      }).sort((a, b) => a.name.localeCompare(b.name));
      const counted = skills.filter(s => !['RUNECRAFTING', 'SOCIAL', 'CARPENTRY'].includes(s.name) && s.lvl != null);
      const avg = counted.length ? counted.reduce((a, s) => a + s.lvl + (s.max ? 0 : s.frac), 0) / counted.length : null;
      html += `<div class="pcard"><h3>📊 Skills${avg != null ? ` <small>average ${avg.toFixed(2)}</small>` : ''}</h3>${skills.length ? `<div class="pgrid">${skills.map(s => { const [e, col] = SKILL_LOOK[s.name] || ['⭐', '#8a8f98']; return tile(`<span class="pemoji">${e}</span>`, s.name[0] + s.name.slice(1).toLowerCase(), s.lvl == null ? fmt(s.xp) + ' XP' : s.lvl, s.frac, col, s.lvl == null ? 'level table not known yet' : fmt(s.xp) + ' XP', s.max); }).join('')}</div>` : '<div class="empty">Skills API is turned off for this profile.</div>'}</div>`;
      // Slayers
      const sb = (m.slayer && m.slayer.slayer_bosses) || {};
      html += `<div class="pcard"><h3>🗡️ Slayers</h3><div class="pgrid">${Object.entries(SLAYER_XP).map(([k, [nm, steps]]) => {
        const xp = (sb[k] && sb[k].xp) || 0, l = slayerLevel(xp, steps), next = steps[l], [head, col] = SLAYER_LOOK[k];
        return tile(mobHead(head), nm, l, next ? xp / next : 1, col, fmt(xp) + ' XP' + (next ? ' · ' + fmt(next - xp) + ' to ' + (l + 1) : ''), !next);
      }).join('')}</div></div>`;
      // Dungeons
      const dg = m.dungeons || {}, cata = dg.dungeon_types && dg.dungeon_types.catacombs || {};
      const cl = levelFrom(cata.experience || 0, CATA_XP);
      const classes = Object.entries(dg.player_classes || {}).map(([k, v]) => ({ k, ...levelFrom(v.experience || 0, CATA_XP) }));
      html += `<div class="pcard"><h3>💀 Dungeons</h3><div class="pgrid">
        ${tile('<span class="pemoji">🏰</span>', 'Catacombs', cl.lvl, cl.frac, '#d14b4b', fmt(cata.experience || 0) + ' XP', cl.max)}
        ${classes.map(x => { const [e, col] = CLASS_LOOK[x.k] || ['⭐', '#8a8f98']; return tile(`<span class="pemoji">${e}</span>`, x.k[0].toUpperCase() + x.k.slice(1), x.lvl, x.frac, col, fmt(x.xp) + ' XP', x.max); }).join('')}
        ${dg.secrets != null ? tile('<span class="pemoji">🗝️</span>', 'Secrets found', Number(dg.secrets).toLocaleString(), 0, '#c9a227', '') : ''}
      </div></div>`;
    }
    // Talismans + cheapest magical power, side by side.
    html += talismanCards(m && it.hasInv ? accessoryState(it.tal) : null, hasKey && !!m);
    // Live auctions (key) and auction history
    if (c.auctions) {
      const live = c.auctions.filter(a => !a.claimed && a.end > Date.now());
      html += `<div class="pcard"><h3>🏷️ Your live auctions <small>${live.length}</small></h3>${live.length ? `<table class="ptable"><thead><tr><th>Item</th><th class="num">Price</th><th class="num">Lowest BIN now</th><th class="num">Ends</th></tr></thead><tbody>${live.map(a => {
        const price = a.bin ? a.starting_bid : Math.max(a.highest_bid_amount || 0, a.starting_bid);
        const lowest = lowestFor(a), under = a.bin && lowest && lowest.low < price && lowest.uuid !== a.uuid;
        return `<tr><td><span class="r-${esc(a.tier)}">${esc(a.item_name)}</span>${a.bin ? '' : ' <span class="flag">auction</span>'}${under ? ' <span class="flag tag-soon">undercut</span>' : ''}</td><td class="num">${fmt(price)}</td><td class="num">${lowest ? fmt(lowest.low) : '–'}</td><td class="num">${until(a.end)}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">No live auctions.</div>'}</div>`;
    }
    if (c.history && c.history.length) {
      html += `<div class="pcard"><h3>📜 Recent auctions <small>from Coflnet</small></h3><table class="ptable"><thead><tr><th>Item</th><th class="num">Price</th><th class="num">Ended</th></tr></thead><tbody>${c.history.slice(0, 12).map(a => `<tr><td>${icon(a.tag)}<span class="r-${esc(a.tier || '')}">${esc(a.itemName)}</span>${a.bin ? '' : ' <span class="flag">auction</span>'}</td><td class="num">${fmt(a.highestBid || a.startingBid)}</td><td class="num">${new Date(a.end).toLocaleDateString()}</td></tr>`).join('')}</tbody></table></div>`;
    }
    out.innerHTML = html;
    const ps = $('#pprof'); if (ps) ps.addEventListener('change', () => { current.profileId = ps.value; render(); });
    const tm = $('#tmax'); if (tm) tm.addEventListener('change', () => { savedMax = tm.value; render(); });
  }
  const lowestFor = a => (a._key && market && market.lows && market.lows.get(a._key)) || null;
  const until = t => { const s = Math.max(0, Math.round((t - Date.now()) / 1000)); const h = Math.floor(s / 3600), mi = Math.floor(s % 3600 / 60); return h >= 24 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + mi + 'm' : mi + 'm'; };
  // The big Profile button shows the saved player's face.
  function setNavHead(uuidOrName) { const img = $('#navhead'); if (img && uuidOrName) img.src = `https://mc-heads.net/avatar/${encodeURIComponent(uuidOrName)}/64`; }

  // ---------- wiring ----------
  let pricedOnce = false;
  if (window.SkyFlipEngine) SkyFlipEngine.on(s => { if (s.lows && !pricedOnce && current && !$('#v-profile').hidden) { pricedOnce = true; render(); } });
  function init() {
    try { $('#pkey').value = localStorage.getItem(KEY_STORE) || ''; } catch {}
    try { $('#pname').value = localStorage.getItem(NAME_STORE) || ''; } catch {}
    if ($('#pname').value) setNavHead($('#pname').value);
    $('#pout').addEventListener('click', e => {
      const b = e.target.closest('.prar button'); if (!b) return;
      const t = b.dataset.tier;
      if (!t) tierPick.clear(); else if (tierPick.has(t)) tierPick.delete(t); else tierPick.add(t);
      try { localStorage.setItem(TIER_STORE, JSON.stringify([...tierPick])); } catch {}
      render();
    });
    $('#pform').addEventListener('submit', e => { e.preventDefault(); show($('#pname').value); });
    $('#pkey').addEventListener('change', () => { try { const v = $('#pkey').value.trim(); v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE); } catch {} });
    $('#pforget').addEventListener('click', () => { $('#pkey').value = ''; try { localStorage.removeItem(KEY_STORE); } catch {} if (current) render(); });
    const go = () => { if (location.hash === '#profile' && !current && $('#pname').value) show($('#pname').value); };
    addEventListener('hashchange', go); go();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

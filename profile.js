// ChudHouse profile page: a player's SkyBlock character.
// Without an API key: skin, UUID and auction history (PlayerDB + Coflnet).
// With the player's own Hypixel API key (kept only in this browser's
// localStorage and sent only to api.hypixel.net): SkyBlock level, coins,
// skills, slayers, dungeons, worn armour and equipment, active pet and the
// player's live auctions compared with the cheapest BIN.
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

  // ---------- rendering ----------
  const bar = (frac, cls = '') => `<div class="pbar ${cls}"><i style="width:${Math.max(0, Math.min(1, frac)) * 100}%"></i></div>`;
  const stat = (k, v, sub = '') => `<div class="pstat"><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const RANKS = { VIP: 'VIP', VIP_PLUS: 'VIP+', MVP: 'MVP', MVP_PLUS: 'MVP+', SUPERSTAR: 'MVP++', YOUTUBER: 'YOUTUBE', ADMIN: 'ADMIN', GAME_MASTER: 'GM', MODERATOR: 'MOD', HELPER: 'HELPER' };
  function itemValue(it) {
    if (!it || !it.id || !market || !market.lows) return null;
    const key = [it.id, it.recomb ? 'recomb' : null, it.stars ? 'stars:' + it.stars : null].filter(Boolean).join('|');
    const l = market.lows.get(key) || market.lows.get(it.id);
    return l ? l.low : null;
  }
  const itemRow = (it, slot) => it ? `<div class="pitem">${icon(it.id)}<div><span class="r-${esc(it.tier)}">${esc(it.name)}</span><small>${esc(slot)}${itemValue(it) ? ' · lowest BIN ' + fmt(itemValue(it)) : ''}</small></div></div>` : `<div class="pitem empty"><div><span>–</span><small>${esc(slot)}</small></div></div>`;

  let current = null; // { name, uuid, profiles, player }
  async function show(name) {
    name = (name || '').trim();
    if (!name) return;
    const out = $('#pout'), key = ($('#pkey').value || '').trim();
    out.innerHTML = '<div class="empty">Looking up ' + esc(name) + '…</div>';
    try {
      const who = await lookupName(name);
      try { localStorage.setItem(NAME_STORE, who.name); } catch {}
      current = { ...who, profiles: null, player: null, auctions: null, error: null };
      const jobs = [getJSON(`https://sky.coflnet.com/api/player/${who.uuid}/auctions?page=0`).then(a => current.history = a).catch(() => current.history = [])];
      if (key) {
        jobs.push(hypixel('skyblock/profiles?uuid=' + who.uuid, key).then(j => current.profiles = j.profiles || []).catch(e => current.error = e.message));
        jobs.push(hypixel('player?uuid=' + who.uuid, key).then(j => current.player = j.player).catch(() => {}));
        jobs.push(hypixel('skyblock/auction?player=' + who.uuid, key).then(j => current.auctions = j.auctions || []).catch(() => {}));
      }
      await Promise.all(jobs);
      // Work out each live auction's item key so it can be compared with the cheapest BIN.
      if (current.auctions) for (const a of current.auctions) {
        try { const [it] = await decodeItems(typeof a.item_bytes === 'string' ? a.item_bytes : a.item_bytes && a.item_bytes.data); if (it && it.id) a._key = [it.id, it.recomb ? 'recomb' : null, it.stars ? 'stars:' + it.stars : null].filter(Boolean).join('|'); } catch {}
      }
      const sel = current.profiles && (current.profiles.find(p => p.selected) || current.profiles[0]);
      current.profileId = sel ? sel.profile_id : null;
      await render();
    } catch (e) {
      out.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    }
  }
  async function render() {
    const c = current, out = $('#pout');
    if (!c) return;
    const prof = c.profiles && c.profiles.find(p => p.profile_id === c.profileId);
    const m = prof && prof.members && prof.members[c.uuid];
    const rank = c.player && (c.player.prefix ? strip(c.player.prefix) : RANKS[c.player.rank !== 'NORMAL' && c.player.rank] || RANKS[c.player.monthlyPackageRank === 'SUPERSTAR' && 'SUPERSTAR'] || RANKS[c.player.newPackageRank] || '');
    let html = `<div class="pcard phead">
      <img class="pskin" src="https://mc-heads.net/body/${c.uuid}/180" alt="${esc(c.name)}'s skin" width="90" height="216" onerror="this.style.visibility='hidden'">
      <div class="pwho">
        <h2>${rank ? `<span class="prank">[${esc(rank.replace(/^\[|\]$/g, ''))}]</span> ` : ''}${esc(c.name)}</h2>
        <code>${c.uuid}</code>
        ${c.profiles && c.profiles.length ? `<label class="psel">Profile <select id="pprof">${c.profiles.map(p => `<option value="${p.profile_id}"${p.profile_id === c.profileId ? ' selected' : ''}>${esc(p.cute_name)}${p.game_mode ? ' (' + esc(p.game_mode) + ')' : ''}${p.selected ? ' · active' : ''}</option>`).join('')}</select></label>` : ''}
        <div class="plinks"><a href="https://sky.shiiyu.moe/stats/${encodeURIComponent(c.name)}" target="_blank" rel="noopener">SkyCrypt ↗</a><a href="https://sky.coflnet.com/player/${c.uuid}" target="_blank" rel="noopener">Coflnet ↗</a></div>
      </div>`;
    if (m) {
      const lvl = (m.leveling && m.leveling.experience || 0) / 100;
      const purse = m.currencies && m.currencies.coin_purse, bank = prof.banking && prof.banking.balance;
      html += `<div class="pstats">
        ${stat('SkyBlock level', Math.floor(lvl), bar(lvl % 1))}
        ${stat('Purse', fmt(purse))}
        ${stat('Bank', bank == null ? 'API off' : fmt(bank))}
        ${stat('Fairy souls', (m.fairy_soul && m.fairy_soul.total_collected) || 0)}
        ${stat('First joined', m.profile && m.profile.first_join ? new Date(m.profile.first_join).toLocaleDateString() : '–')}
      </div>`;
    }
    html += `</div>`;
    if (!$('#pkey').value.trim()) {
      html += `<div class="pcard pnote"><b>Add your Hypixel API key to see your character.</b> Levels, skills, slayers, dungeons, what you're wearing and your live auctions all come from Hypixel's API, which needs a key for player data. Make one at <a href="https://developer.hypixel.net" target="_blank" rel="noopener">developer.hypixel.net</a> (sign in, then create a key) and paste it above. It is kept only in this browser and sent only to Hypixel.</div>`;
    } else if (c.error) {
      html += `<div class="pcard pnote">Hypixel said: <b>${esc(c.error)}</b>. ${/invalid/i.test(c.error) ? 'Check the key; personal development keys expire after a few days and need renewing at developer.hypixel.net.' : ''}</div>`;
    } else if (!m) {
      html += `<div class="pcard pnote">No SkyBlock profiles found for this player.</div>`;
    }
    if (m) {
      // Skills
      const exp = (m.player_data && m.player_data.experience) || {};
      const skills = Object.entries(exp).filter(([k]) => k.startsWith('SKILL_')).map(([k, xp]) => {
        const name = k.slice(6), table = name === 'RUNECRAFTING' ? RUNE_XP : name === 'SOCIAL' ? SOCIAL_XP : SKILL_XP;
        const known = name in SKILL_CAP;
        return { name, ...(known ? levelFrom(xp, table, SKILL_CAP[name]) : { lvl: null, frac: 0, xp }), cap: SKILL_CAP[name] };
      }).sort((a, b) => a.name.localeCompare(b.name));
      const counted = skills.filter(s => !['RUNECRAFTING', 'SOCIAL', 'CARPENTRY'].includes(s.name) && s.lvl != null);
      const avg = counted.length ? counted.reduce((a, s) => a + s.lvl + (s.max ? 0 : s.frac), 0) / counted.length : null;
      html += `<div class="pcard"><h3>Skills${avg != null ? ` <small>average ${avg.toFixed(2)}</small>` : ''}</h3>${skills.length ? `<div class="pgrid">${skills.map(s => `<div class="pskill"><span>${s.name[0] + s.name.slice(1).toLowerCase()}</span><b>${s.lvl == null ? fmt(s.xp) + ' XP' : s.lvl + (s.max ? ' <em>max</em>' : '')}</b>${bar(s.max ? 1 : s.frac, s.max ? 'max' : '')}${s.lvl == null ? '<small>level table not known yet</small>' : `<small>${fmt(s.xp)} XP</small>`}</div>`).join('')}</div>` : '<div class="empty">Skills API is turned off for this profile.</div>'}</div>`;
      // Slayers
      const sb = (m.slayer && m.slayer.slayer_bosses) || {};
      html += `<div class="pcard"><h3>Slayers</h3><div class="pgrid">${Object.entries(SLAYER_XP).map(([k, [nm, steps]]) => { const xp = (sb[k] && sb[k].xp) || 0, l = slayerLevel(xp, steps); const next = steps[l]; return `<div class="pskill"><span>${nm}</span><b>${l}${l === steps.length ? ' <em>max</em>' : ''}</b>${bar(next ? xp / next : 1, next ? '' : 'max')}<small>${fmt(xp)} XP</small></div>`; }).join('')}</div></div>`;
      // Dungeons
      const dg = m.dungeons || {}, cata = dg.dungeon_types && dg.dungeon_types.catacombs || {};
      const cl = levelFrom(cata.experience || 0, CATA_XP);
      const classes = Object.entries(dg.player_classes || {}).map(([k, v]) => ({ k, ...levelFrom(v.experience || 0, CATA_XP) }));
      html += `<div class="pcard"><h3>Dungeons</h3><div class="pgrid">
        <div class="pskill"><span>Catacombs</span><b>${cl.lvl}${cl.max ? ' <em>max</em>' : ''}</b>${bar(cl.frac, cl.max ? 'max' : '')}<small>${fmt(cata.experience || 0)} XP</small></div>
        ${classes.map(x => `<div class="pskill"><span>${x.k[0].toUpperCase() + x.k.slice(1)}</span><b>${x.lvl}</b>${bar(x.frac, x.max ? 'max' : '')}<small>${fmt(x.xp)} XP</small></div>`).join('')}
        ${dg.secrets != null ? `<div class="pskill"><span>Secrets found</span><b>${Number(dg.secrets).toLocaleString()}</b></div>` : ''}
      </div></div>`;
      // Equipment
      const inv = m.inventory || {};
      let armor = [], equip = [];
      try { armor = (await decodeItems(inv.inv_armor && inv.inv_armor.data)).reverse(); } catch {}
      try { equip = await decodeItems(inv.equipment_contents && inv.equipment_contents.data); } catch {}
      const pets = (m.pets_data && m.pets_data.pets) || [];
      const pet = pets.find(p => p.active);
      const armorNames = ['Helmet', 'Chestplate', 'Leggings', 'Boots'], equipNames = ['Necklace', 'Cloak', 'Belt', 'Gloves'];
      const worn = armor.length || equip.length;
      const total = [...armor, ...equip].reduce((a, it) => a + (itemValue(it) || 0), 0);
      html += `<div class="pcard"><h3>Wearing${total ? ` <small>about ${fmt(total)} at lowest BIN</small>` : ''}</h3>${worn ? `<div class="pgear">
        <div>${armorNames.map((n, i) => itemRow(armor[i], n)).join('')}</div>
        <div>${equipNames.map((n, i) => itemRow(equip[i], n)).join('')}
          <div class="pitem">${pet ? icon('PET_' + pet.type) : ''}<div><span class="r-${esc(pet && pet.tier)}">${pet ? esc(pet.type.split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ')) + ' pet' : '–'}</span><small>Active pet${pet && pet.heldItem ? ' · holding ' + esc(pet.heldItem.replace(/_/g, ' ').toLowerCase()) : ''}</small></div></div>
        </div></div>` : '<div class="empty">Inventory API is turned off for this profile.</div>'}</div>`;
    }
    // Live auctions (key) or auction history (no key)
    if (c.auctions) {
      const live = c.auctions.filter(a => !a.claimed && a.end > Date.now());
      html += `<div class="pcard"><h3>Your live auctions <small>${live.length}</small></h3>${live.length ? `<table class="ptable"><thead><tr><th>Item</th><th class="num">Price</th><th class="num">Lowest BIN now</th><th class="num">Ends</th></tr></thead><tbody>${live.map(a => {
        const price = a.bin ? a.starting_bid : Math.max(a.highest_bid_amount || 0, a.starting_bid);
        const lowest = lowestFor(a);
        const under = a.bin && lowest && lowest.low < price && lowest.uuid !== a.uuid;
        return `<tr><td><span class="r-${esc(a.tier)}">${esc(a.item_name)}</span>${a.bin ? '' : ' <span class="flag">auction</span>'}${under ? ' <span class="flag tag-soon">undercut</span>' : ''}</td><td class="num">${fmt(price)}</td><td class="num">${lowest ? fmt(lowest.low) : '–'}</td><td class="num">${until(a.end)}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">No live auctions.</div>'}</div>`;
    }
    if (c.history && c.history.length) {
      html += `<div class="pcard"><h3>Recent auctions <small>from Coflnet</small></h3><table class="ptable"><thead><tr><th>Item</th><th class="num">Price</th><th class="num">Ended</th></tr></thead><tbody>${c.history.slice(0, 12).map(a => `<tr><td>${icon(a.tag)}<span class="r-${esc(a.tier || '')}">${esc(a.itemName)}</span>${a.bin ? '' : ' <span class="flag">auction</span>'}</td><td class="num">${fmt(a.highestBid || a.startingBid)}</td><td class="num">${new Date(a.end).toLocaleDateString()}</td></tr>`).join('')}</tbody></table></div>`;
    }
    out.innerHTML = html;
    const ps = $('#pprof'); if (ps) ps.addEventListener('change', () => { current.profileId = ps.value; render(); });
  }
  // Cheapest BIN of the same kind of item, from the main engine's latest scan.
  const lowestFor = a => (a._key && market && market.lows && market.lows.get(a._key)) || null;
  const until = t => { const s = Math.max(0, Math.round((t - Date.now()) / 1000)); const h = Math.floor(s / 3600), mi = Math.floor(s % 3600 / 60); return h >= 24 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + mi + 'm' : mi + 'm'; };

  // ---------- wiring ----------
  function init() {
    try { $('#pkey').value = localStorage.getItem(KEY_STORE) || ''; } catch {}
    try { $('#pname').value = localStorage.getItem(NAME_STORE) || ''; } catch {}
    $('#pform').addEventListener('submit', e => { e.preventDefault(); show($('#pname').value); });
    $('#pkey').addEventListener('change', () => { try { const v = $('#pkey').value.trim(); v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE); } catch {} });
    $('#pforget').addEventListener('click', () => { $('#pkey').value = ''; try { localStorage.removeItem(KEY_STORE); } catch {} if (current) render(); });
    const go = () => { if (location.hash === '#profile' && !current && $('#pname').value) show($('#pname').value); };
    addEventListener('hashchange', go); go();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

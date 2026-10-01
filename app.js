const API = 'https://api.guildwars2.com/v2';
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = t => $('#status').textContent = t;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money = c => { const n = Math.abs(Math.round(c)), g = Math.floor(n / 1e4), s = Math.floor(n % 1e4 / 100);
  return (c < 0 ? '-' : '') + (g ? g + 'g ' : '') + (g || s ? s + 's ' : '') + (n % 100) + 'c'; };

let R = [], P = {}, SH = {}, have = {}, unlocked = new Set(), S = {}, ready = false;
const NAMES = {};
let FAIL = 0;
try { SH = JSON.parse(localStorage.gw2s || '{}'); $('#key').value = localStorage.gw2key || ''; } catch {}

async function get(path, key) {
  for (let t = 0; t < 4; t++) {
    let r;
    try { r = await fetch(API + path + (key ? (path.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(key) : '')); }
    catch { if (t < 3) { await sleep(1000); continue; } throw new Error('Network request blocked or failed for ' + path.split('?')[0]); }
    if (r.status === 429) { await sleep(1500); continue; }
    if (!r.ok) throw new Error(path.split('?')[0] + ' failed (' + r.status + ')');
    return r.json();
  }
  throw new Error('Rate limited by the GW2 API, try again shortly.');
}

async function chunked(path, ids, onProg) {
  const chunks = [], out = []; let i = 0, done = 0;
  for (let j = 0; j < ids.length; j += 200) chunks.push(ids.slice(j, j + 200));
  const worker = async () => {
    while (i < chunks.length) {
      const c = chunks[i++];
      try { out.push(...await get(path + c.join(','))); } catch { FAIL++; }
      onProg && onProg(++done / chunks.length);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  return out;
}

async function loadRecipes() {
  try { const c = JSON.parse(localStorage.gw2r2 || 'null'); if (c && c.r.length > 5000 && Date.now() - c.t < 6048e5) { R = c.r; return; } } catch {}
  const ids = await get('/recipes');
  const raw = await chunked('/recipes?ids=', ids, p => say('Loading recipes ' + Math.round(p * 100) + '% (first run only)'));
  R = raw.filter(r => r.output_item_id).map(r => ({
    id: r.id, o: r.output_item_id, c: r.output_item_count,
    i: r.ingredients.filter(x => (x.type || 'Item') === 'Item').map(x => [x.id ?? x.item_id, x.count]),
    ok: r.ingredients.every(x => (x.type || 'Item') === 'Item') && !(r.guild_ingredients && r.guild_ingredients.length),
    d: r.disciplines, f: r.flags }));
  if (!FAIL) try { localStorage.gw2r2 = JSON.stringify({ t: Date.now(), r: R }); } catch {}
}

async function loadPrices() {
  const ids = new Set(Object.values(SH));
  for (const r of R) if (r.ok) { ids.add(r.o); r.i.forEach(x => ids.add(x[0])); }
  const list = await chunked('/commerce/prices?ids=', [...ids], p => say('Loading prices ' + Math.round(p * 100) + '%'));
  P = {};
  for (const p of list) P[p.id] = { b: p.buys.unit_price, s: p.sells.unit_price, bq: p.buys.quantity };
}

async function scan() {
  const key = $('#key').value.trim();
  if (!key) return say('Paste an API key first.');
  $('#scan').disabled = true;
  try {
    try { localStorage.gw2key = key; } catch {}
    say('Reading your account...');
    const warn = []; FAIL = 0;
    const opt = async p => { try { return await get(p, key); } catch { warn.push(p.replace('/account/', '')); return []; } };
    const mats = await get('/account/materials', key);
    const bank = await opt('/account/bank');
    const shared = await opt('/account/inventory');
    const rec = await opt('/account/recipes');
    if (warn.length) say('Could not read: ' + warn.join(', ') + '. Continuing without it.');
    have = {};
    for (const s of [...mats, ...bank, ...shared]) if (s) have[s.id] = (have[s.id] || 0) + s.count;
    unlocked = new Set(rec);
    await loadRecipes();
    await loadPrices();
    buildProd();
    const ds = new Set(); R.forEach(r => r.d.forEach(d => ds.add(d)));
    ds.add('Mystic Forge');
    $('#disc').innerHTML = '<option value="">All</option>' + [...ds].sort().map(d => `<option>${esc(d)}</option>`).join('');
    ready = true; say(warn.length ? 'Done, but could not read: ' + warn.join(', ') + '.' : 'Done.'); refresh();
  } catch (e) {
    say('Error: ' + e.message + (/\(40[01]\)/.test(e.message) ? '. Check the key has account, inventories and unlocks permissions.' : '.'));
  }
  $('#scan').disabled = false;
}

async function scanSheets() {
  $('#sheets').disabled = true;
  try {
    const ids = await get('/commerce/prices');
    const items = await chunked('/items?ids=', ids, p => say('Scanning items ' + Math.round(p * 100) + '%'));
    SH = {};
    for (const it of items) if (it.details && it.details.unlock_type === 'CraftingRecipe') SH[it.details.recipe_id] = it.id;
    try { localStorage.gw2s = JSON.stringify(SH); } catch {}
    say('Found ' + Object.keys(SH).length + ' tradable recipe sheets. Scan your account again to price them.');
  } catch (e) { say('Error: ' + e.message); }
  $('#sheets').disabled = false;
}

const sellNet = id => { const p = P[id]; if (!p) return 0;
  const v = S.instantSell ? p.b : Math.max(1, p.s - (S.undercut ? 1 : 0));
  return p.s || p.b ? Math.floor((v || 0) * 0.85) : 0; };
const buyCost = id => { const p = P[id]; if (!p) return Infinity;
  return S.instantBuy ? (p.s || Infinity) : (p.b ? p.b + 1 : Infinity); };

// The API does not expose daily cooldowns, so these are listed by hand:
// Lump of Mithrillium, Glob of Elder Spirit Residue, Spool of Thick Elonian Cord, Spool of Silk Weaving Thread
const DAILY = new Set([46742, 46744, 46745, 46740]);
const KS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 250];
const BOX = /\bbox\b/i;
let PROD = {};
const isForge = r => !r.d.length || r.d.includes('Mystic Forge');
const isLearned = r => isForge(r) || unlocked.has(r.id) || r.f.includes('AutoLearned');

function buildProd() {
  PROD = {};
  for (const r of R) {
    if (!r.ok || !r.i.length || isForge(r) || !isLearned(r) || DAILY.has(r.o) || r.i.some(x => !x[0])) continue;
    const l = PROD[r.o] = PROD[r.o] || [];
    if (l.length < 2) l.push(r);
  }
}

// Cheapest way to get qty of an item: use stock, then buy or craft it (up to d levels deep).
// Returns [total cost, money spent buying]. log (optional) records the steps.
function plan(id, qty, used, d, log) {
  let cost = 0;
  const take = Math.min(Math.max(0, (have[id] || 0) - (used[id] || 0)), qty);
  if (take) {
    used[id] = (used[id] || 0) + take;
    if (S.opp) cost += take * sellNet(id);
    log && log.push({ t: 'own', id, q: take });
    qty -= take;
  }
  if (!qty) return [cost, 0];
  const bc = buyCost(id) * qty;
  let best = { c: bc, s: bc, craft: null };
  if (d > 0 && PROD[id]) for (const r of PROD[id]) {
    const crafts = Math.ceil(qty / r.c), u2 = { ...used }, l2 = log ? [] : null;
    let c = 0, s = 0;
    for (const [sid, n] of r.i) { const [a, b] = plan(sid, n * crafts, u2, d - 1, l2); c += a; s += b; if (c >= best.c) break; }
    if (c < best.c) best = { c, s, craft: { r, crafts, u2, l2 } };
  }
  if (best.craft) { Object.assign(used, best.craft.u2); log && log.push({ t: 'craft', id, r: best.craft.r, crafts: best.craft.crafts, sub: best.craft.l2 }); }
  else if (bc < Infinity) log && log.push({ t: 'buy', id, q: qty, unit: buyCost(id) });
  return [cost + best.c, best.s];
}

function compute() {
  const rows = [];
  for (const r of R) {
    if (!r.ok || !P[r.o] || !r.i.length) continue;
    const unit = sellNet(r.o) * r.c;
    if (unit <= 0) continue;
    const forge = isForge(r), learned = isLearned(r), daily = DAILY.has(r.o);
    let rc = 0, note = '';
    if (!learned) {
      if (r.f.includes('LearnedFromItem')) {
        const sh = SH[r.id], c = sh ? buyCost(sh) : Infinity;
        if (c < Infinity) { rc = c; note = 'Buy recipe sheet: ' + money(c); } else note = 'Recipe sheet needed (price unknown)';
      } else note = 'Must be discovered by crafting';
    }
    let kOwn = Infinity;
    for (const [id, n] of r.i) kOwn = Math.min(kOwn, Math.floor((have[id] || 0) / n));
    const kMax = daily ? 1 : 250;
    const ks = [...new Set([...KS, kOwn])].filter(k => isFinite(k) && k >= 1 && k <= kMax).sort((a, b) => a - b);
    let best = null;
    for (const k of ks) {
      const used = {}; let cost = 0, spend = 0;
      for (const [id, n] of r.i) { const [c, s] = plan(id, n * k, used, S.chain ? 2 : 0); cost += c; spend += s; }
      if (cost === Infinity || spend > S.budget) break;
      const profit = k * unit - cost - rc;
      if (!best || profit > best.profit) best = { k, profit, cost, spend };
    }
    if (!best || best.profit <= 0) continue;
    rows.push({ r, ...best, rc, per: best.profit / best.k, roi: best.profit / (best.cost + rc || 1),
      note, forge, learned, daily, low: P[r.o].bq < Math.max(25, best.k * r.c) });
  }
  return rows;
}

async function names(ids) {
  const need = [...new Set(ids)].filter(i => i && !NAMES[i]);
  for (const it of await chunked('/items?ids=', need)) NAMES[it.id] = it.name;
}

const nm = id => esc(NAMES[id] || id);
const list = r => r.i.map(([i, n]) => n + ' &times; ' + nm(i)).join(', ');
function collect(log, set) {
  for (const e of log) { set.add(e.id); if (e.t === 'craft') { e.r.i.forEach(x => set.add(x[0])); collect(e.sub, set); } }
}
function buys(log, out = []) {
  for (const e of log) { if (e.t === 'buy') out.push(e); else if (e.t === 'craft') buys(e.sub, out); }
  return out;
}
function steps(log) {
  return '<ul>' + log.map(e => e.t === 'own' ? `<li>Use ${e.q} &times; ${nm(e.id)} from your stock</li>`
    : e.t === 'buy' ? `<li>Buy ${e.q} &times; ${nm(e.id)} at ${money(e.unit)} each (${money(e.q * e.unit)})</li>`
    : `<li>Craft ${e.crafts} &times; ${nm(e.id)} (each: ${list(e.r)}; makes ${e.r.c})${steps(e.sub)}</li>`).join('') + '</ul>';
}

async function refresh() {
  if (!ready) return;
  try { await refresh2(); } catch (e) { say('Error: ' + e.message); }
}

async function refresh2() {
  S = { instantSell: $('input[name=sell]:checked').value === 'instant', undercut: $('#undercut').checked,
    instantBuy: $('input[name=buy]:checked').value === 'instant', budget: $('#budget').value * 1e4,
    opp: $('#opp').checked, chain: $('#chain').checked };
  $('#bv').textContent = $('#budget').value + 'g';
  const d = $('#disc').value, min = $('#min').value * 1e4, by = $('#sort').value;
  const all = compute();
  say(R.length + ' recipes, ' + Object.keys(P).length + ' prices, ' + all.length + ' profitable crafts before filters' + (FAIL ? ', ' + FAIL + ' data requests failed (rescan)' : '') + '.');
  let rows = all.filter(x => x.profit >= min && (!d || x.r.d.includes(d) || (d === 'Mystic Forge' && x.forge))
    && !($('#nolow').checked && x.low) && !($('#nolearn').checked && !x.learned));
  rows.sort((a, b) => b[by] - a[by]);
  rows = rows.slice(0, 400);
  if ($('#nobox').checked) { await names(rows.map(x => x.r.o)); rows = rows.filter(x => !BOX.test(NAMES[x.r.o] || '')); }
  rows = rows.slice(0, 100);
  const ids = new Set();
  for (const x of rows) {
    x.log = []; const used = {};
    for (const [id, n] of x.r.i) plan(id, n * x.k, used, S.chain ? 2 : 0, x.log);
    ids.add(x.r.o); x.r.i.forEach(i => ids.add(i[0])); collect(x.log, ids);
  }
  await names([...ids]);
  $('#out tbody').innerHTML = rows.map(x => {
    const b = buys(x.log), crafted = x.log.some(e => e.t === 'craft');
    return `<tr class="main" tabindex="0">
    <td><b>${nm(x.r.o)}</b> &times;${x.k * x.r.c}
      ${x.daily ? '<span class="tag">1 craft per day</span>' : ''}${x.low ? '<span class="tag">Low demand</span>' : ''}${x.note ? `<span class="tag">${esc(x.note)}</span>` : ''}
      <small>${x.forge ? 'Mystic Forge' : esc(x.r.d.join(', '))}${crafted ? ', includes intermediate crafts' : ''}</small></td>
    <td class="pos">${money(x.profit)}</td><td>${money(x.per)}</td>
    <td>${b.length ? b.map(e => `${e.q} &times; ${nm(e.id)}`).join('<br>') + `<small>Cost ${money(x.spend)}</small>` : 'Nothing, all from your stock'}</td></tr>
    <tr class="detail" hidden><td colspan="4">
      <p><b>Craft ${x.k} &times;</b> ${nm(x.r.o)} to make ${x.k * x.r.c}. Each craft uses: ${list(x.r)}.</p>
      ${steps(x.log)}
      <small>Sells for ${money(sellNet(x.r.o) * x.r.c * x.k)} after fees. Materials ${money(x.cost)} (your stock counted at sale value if ticked)${x.rc ? ', plus recipe sheet ' + money(x.rc) : ''}.</small>
    </td></tr>`;
  }).join('') || '<tr><td colspan="4">No profitable crafts match. Try a larger spend limit or relax the filters.</td></tr>';
}

$('#out tbody').addEventListener('click', e => {
  const tr = e.target.closest('tr.main');
  if (tr) tr.nextElementSibling.hidden = !tr.nextElementSibling.hidden;
});
$('#out tbody').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const tr = e.target.closest('tr.main'); if (tr) tr.click(); }
});

$('#scan').onclick = scan;
$('#sheets').onclick = scanSheets;
document.querySelectorAll('.ctl').forEach(el => el.addEventListener('input', refresh));

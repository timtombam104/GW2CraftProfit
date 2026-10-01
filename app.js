const API = 'https://api.guildwars2.com/v2';
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = t => $('#status').textContent = t;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money = c => { const n = Math.abs(Math.round(c)), g = Math.floor(n / 1e4), s = Math.floor(n % 1e4 / 100);
  return (c < 0 ? '-' : '') + (g ? g + 'g ' : '') + (g || s ? s + 's ' : '') + (n % 100) + 'c'; };

let R = [], P = {}, SH = {}, have = {}, unlocked = new Set(), S = {}, ready = false;
const NAMES = {};
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
      try { out.push(...await get(path + c.join(','))); } catch {}
      onProg && onProg(++done / chunks.length);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  return out;
}

async function loadRecipes() {
  try { const c = JSON.parse(localStorage.gw2r || 'null'); if (c && Date.now() - c.t < 6048e5) { R = c.r; return; } } catch {}
  const ids = await get('/recipes');
  const raw = await chunked('/recipes?ids=', ids, p => say('Loading recipes ' + Math.round(p * 100) + '% (first run only)'));
  R = raw.filter(r => r.output_item_id).map(r => ({
    id: r.id, o: r.output_item_id, c: r.output_item_count,
    i: r.ingredients.filter(x => x.type === 'Item').map(x => [x.id, x.count]),
    ok: r.ingredients.every(x => x.type === 'Item') && !(r.guild_ingredients && r.guild_ingredients.length),
    d: r.disciplines, f: r.flags }));
  try { localStorage.gw2r = JSON.stringify({ t: Date.now(), r: R }); } catch {}
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
    const warn = [];
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

function compute() {
  const rows = [];
  for (const r of R) {
    if (!r.ok || !P[r.o]) continue;
    const unit = sellNet(r.o) * r.c;
    if (unit <= 0) continue;
    const forge = !r.d.length || r.d.includes('Mystic Forge');
    const learned = forge || unlocked.has(r.id) || r.f.includes('AutoLearned');
    let rc = 0, note = '';
    if (!learned) {
      if (r.f.includes('LearnedFromItem')) {
        const sh = SH[r.id], c = sh ? buyCost(sh) : Infinity;
        if (c < Infinity) { rc = c; note = 'Buy recipe sheet: ' + money(c); } else note = 'Recipe sheet needed (price unknown)';
      } else note = 'Must be discovered by crafting';
    }
    let best = null;
    for (let k = 1; k <= 250; k++) {
      let buy = 0, opp = 0, ok = true;
      for (const [id, n] of r.i) {
        const need = n * k, own = Math.min(have[id] || 0, need), miss = need - own;
        if (miss) { const bc = buyCost(id); if (bc === Infinity) { ok = false; break; } buy += miss * bc; }
        if (S.opp && own) opp += own * sellNet(id);
      }
      if (!ok || buy > S.budget) break;
      const profit = k * unit - buy - opp - rc;
      if (!best || profit > best.profit) best = { k, profit, buy, opp };
    }
    if (!best || best.profit <= 0) continue;
    const miss = r.i.map(([id, n]) => [id, Math.max(0, n * best.k - (have[id] || 0))]).filter(x => x[1]);
    rows.push({ r, ...best, per: best.profit / best.k, roi: best.profit / (best.buy + best.opp + rc || 1),
      miss, note, forge, learned, low: P[r.o].bq < Math.max(25, best.k * r.c) });
  }
  return rows;
}

async function names(ids) {
  const need = [...new Set(ids)].filter(i => !NAMES[i]);
  for (const it of await chunked('/items?ids=', need)) NAMES[it.id] = it.name;
}

async function refresh() {
  if (!ready) return;
  S = { instantSell: $('input[name=sell]:checked').value === 'instant', undercut: $('#undercut').checked,
    instantBuy: $('input[name=buy]:checked').value === 'instant', budget: $('#budget').value * 1e4, opp: $('#opp').checked };
  $('#bv').textContent = $('#budget').value + 'g';
  const d = $('#disc').value, min = $('#min').value * 1e4, by = $('#sort').value;
  let rows = compute().filter(x => x.profit >= min && (!d || x.r.d.includes(d) || (d === 'Mystic Forge' && x.forge))
    && !($('#nolow').checked && x.low) && !($('#nolearn').checked && !x.learned));
  rows.sort((a, b) => b[by] - a[by]);
  rows = rows.slice(0, 100);
  await names(rows.flatMap(x => [x.r.o, ...x.miss.map(m => m[0])]));
  $('#out tbody').innerHTML = rows.map(x => `<tr>
    <td><b>${esc(NAMES[x.r.o] || x.r.o)}</b> &times;${x.k * x.r.c}
      ${x.low ? '<span class="tag">Low demand</span>' : ''}${x.note ? `<span class="tag">${esc(x.note)}</span>` : ''}
      <small>${x.forge ? 'Mystic Forge' : esc(x.r.d.join(', '))}</small></td>
    <td class="pos">${money(x.profit)}</td><td>${money(x.per)}</td>
    <td>${x.miss.length ? x.miss.map(m => `${m[1]} &times; ${esc(NAMES[m[0]] || m[0])}`).join('<br>') + `<small>Cost ${money(x.buy)}</small>` : 'None, all from your stock'}</td></tr>`).join('')
    || '<tr><td colspan="4">No profitable crafts match. Try a larger spend limit or relax the filters.</td></tr>';
}

$('#scan').onclick = scan;
$('#sheets').onclick = scanSheets;
document.querySelectorAll('.ctl').forEach(el => el.addEventListener('input', refresh));

'use strict';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; };
const cardsWord = (n) => `${n} ${plural(n, 'карточка', 'карточки', 'карточек')}`;
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- storage ---------- */
const SETS_KEY = 'qv.sets', SETTINGS_KEY = 'qv.settings';
function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
let sets = load(SETS_KEY, null);
let settings = Object.assign({ apiKey: '', model: '', direction: 'term', models: [] }, load(SETTINGS_KEY, {}));
const FOLDERS_KEY = 'qv.folders', DEL_KEY = 'qv.deleted';
let folders = load(FOLDERS_KEY, []); // [{ id, title, setIds: [], created, syncAt }]
let deleted = load(DEL_KEY, []); // удалённые наборы и папки [{ k: 'set'|'folder', id, at }] — чтобы удаление дошло до других устройств
// Для синхронизации: у каждого набора и папки есть syncAt — когда они менялись. saveSets() сам находит изменённые
// (сравнивает с прошлым снимком) и ставит им syncAt, а исчезнувшие заносит в deleted.
const COLLS = { set: () => sets, folder: () => folders };
const delKind = (d) => d.k || 'set';
const setHash = (s) => { const { syncAt, ...rest } = s; return JSON.stringify(rest); };
let setHashes = new Map(); // 'set:<id>' / 'folder:<id>' → снимок
function persistSets() {
  localStorage.setItem(SETS_KEY, JSON.stringify(sets));
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  localStorage.setItem(DEL_KEY, JSON.stringify(deleted));
}
function saveSets() {
  const t = Date.now(), seen = new Set();
  for (const [k, list] of Object.entries(COLLS)) {
    for (const o of list()) {
      const key = k + ':' + o.id, h = setHash(o);
      seen.add(key);
      if (setHashes.get(key) !== h || !o.syncAt) { o.syncAt = t; setHashes.set(key, h); }
    }
  }
  for (const key of [...setHashes.keys()]) {
    if (seen.has(key)) continue;
    setHashes.delete(key);
    const i = key.indexOf(':'), k = key.slice(0, i), id = key.slice(i + 1);
    deleted = deleted.filter((d) => !(delKind(d) === k && d.id === id));
    deleted.push({ k, id, at: t });
  }
  deleted = deleted.filter((d) => !seen.has(delKind(d) + ':' + d.id));
  persistSets();
  if (typeof scheduleSync === 'function') scheduleSync();
}
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
const getSet = (id) => sets.find((s) => s.id === id);
const getFolder = (id) => folders.find((f) => f.id === id);
const setFolders = (setId) => folders.filter((f) => f.setIds.includes(setId));
function findCard(id) { for (const s of sets) { const c = s.cards.find((x) => x.id === id); if (c) return c; } return null; }
// Папка как один большой набор: все карточки её наборов (те же объекты карточек)
function folderDeck(f) {
  const ss = f.setIds.map(getSet).filter(Boolean);
  return { id: f.id, isFolder: true, title: f.title, cards: ss.flatMap((x) => x.cards), bestMatch: f.bestMatch };
}
const home = (s) => (s.isFolder ? `#/folder/${s.id}` : `#/set/${s.id}`);
const newCard = (term = '', def = '') => ({ id: uid(), term, def, streak: 0, right: 0, wrong: 0 });

if (!Array.isArray(sets)) {
  sets = [{
    id: uid(), demo: true, title: 'Пример: спорт', created: Date.now(), updated: Date.now(),
    cards: [
      ['to play ball', '(по)играть в мяч'],
      ['to win', 'выигрывать / выиграть'],
      ['to lose', 'проигрывать / проиграть'],
      ['team', 'команда'],
      ['coach', 'тренер'],
      ['referee', 'судья'],
      ['to score a goal', 'забить гол'],
      ['match', 'матч'],
    ].map(([t, d]) => newCard(t, d)),
  }];
  saveSets();
}
for (const [k, list] of Object.entries(COLLS)) for (const o of list()) { if (!o.syncAt) o.syncAt = o.updated || o.created || 1; setHashes.set(k + ':' + o.id, setHash(o)); }

/* ---------- синхронизация через свой сервер ----------
   Наборы хранятся на устройстве, а на сервер уходит их зашифрованная копия (по образцу «Монетки»).
   Ключ — 32 символа; из него (HKDF-SHA256) получаются ключ шифрования, ключ для обезличенных
   идентификаторов, токен входа и номер «пространства». Сервер видит только rid, время и шифр.
   Одна запись на сервере = один набор целиком (с карточками и прогрессом); удаление пишется в ту же запись.
   Побеждает более поздняя правка (syncAt). Настройки синхронизации — в localStorage['qv.sync']. */
const SYNC_CFG_KEY = 'qv.sync';
const SYNC_DEFAULT_SERVER = 'https://kartochki-sync.lav11.com';
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: без I, L, O, U
const SYNC_BATCH = 200;
const sync = { busy: false, again: false, timer: null, error: '', keys: null, keysFor: '' };

function syncCfg() { try { return JSON.parse(localStorage.getItem(SYNC_CFG_KEY) || 'null'); } catch { return null; } }
function syncSaveCfg(c) { try { if (c) localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(c)); else localStorage.removeItem(SYNC_CFG_KEY); } catch {} }

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
function b32enc(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of str) { const i = B32.indexOf(ch); if (i < 0) return null; val = ((val << 5) | i) & 0xffff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
// Ключ: 19 случайных байт + 1 байт проверки = 32 символа, группы по 4 через дефис
async function syncCheckByte(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))[0]; }
async function syncNewKey() {
  const r = crypto.getRandomValues(new Uint8Array(19));
  const all = new Uint8Array(20); all.set(r); all[19] = await syncCheckByte(r);
  return b32enc(all).match(/.{4}/g).join('-');
}
// Ключ в каноническом виде или null, если в нём опечатка
async function syncNormKey(input) {
  const s = String(input || '').toUpperCase().replace(/[OО]/g, '0').replace(/[ILІ]/g, '1').replace(/[^0-9A-Z]/g, '');
  if (s.length !== 32) return null;
  const bytes = b32dec(s);
  if (!bytes || bytes.length !== 20) return null;
  if (await syncCheckByte(bytes.slice(0, 19)) !== bytes[19]) return null;
  return s.match(/.{4}/g).join('-');
}
function syncNormServer(s) {
  s = String(s || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

async function syncKeys(key) {
  if (sync.keys && sync.keysFor === key) return sync.keys;
  const raw = b32dec(key.replace(/-/g, ''));
  const te = new TextEncoder();
  const hk = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const p = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('kartochki-sync-v1'), info: te.encode(info) });
  sync.keys = {
    enc: await crypto.subtle.deriveKey(p('kartochki/enc'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    mac: await crypto.subtle.deriveKey(p('kartochki/rid'), hk, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
    token: hex(await crypto.subtle.deriveBits(p('kartochki/auth'), hk, 256)),
    space: hex(await crypto.subtle.deriveBits(p('kartochki/space'), hk, 128)),
  };
  sync.keysFor = key;
  return sync.keys;
}
const syncRid = async (k, kind, id) => hex(await crypto.subtle.sign('HMAC', k.mac, new TextEncoder().encode(kind + '\n' + id))).slice(0, 32);
async function syncSeal(k, rid, ts, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(rid + ':' + ts) }, k.enc, new TextEncoder().encode(JSON.stringify(payload)));
  return { rid, ts, blob: b64(iv) + '.' + b64(ct) };
}
async function syncOpen(k, it) {
  const [iv, ct] = it.blob.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(it.rid + ':' + it.ts) }, k.enc, unb64(ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

// Что изменилось на устройстве после since → зашифрованные записи
async function syncBuild(k, since) {
  const out = [];
  for (const s of sets) if ((s.syncAt || 0) > since) out.push(await syncSeal(k, await syncRid(k, 'set', s.id), s.syncAt, { s }));
  for (const f of folders) if ((f.syncAt || 0) > since) out.push(await syncSeal(k, await syncRid(k, 'folder', f.id), f.syncAt, { f }));
  for (const d of deleted) if (d.at > since) out.push(await syncSeal(k, await syncRid(k, delKind(d), d.id), d.at, { d: { ...d, k: delKind(d) } }));
  return out;
}
async function syncUnpack(k, items) {
  const ch = { sets: [], folders: [], deleted: [] };
  for (const it of items) {
    let p;
    try { p = await syncOpen(k, it); } catch { console.warn('sync: запись не расшифровалась', it.rid); continue; }
    if (p.s && p.s.id && Array.isArray(p.s.cards)) ch.sets.push(p.s);
    else if (p.f && p.f.id && Array.isArray(p.f.setIds)) ch.folders.push(p.f);
    else if (p.d && p.d.id) ch.deleted.push(p.d);
  }
  return ch;
}
// Принять изменения с других устройств: побеждает более позднее
function applyRemote(ch) {
  let n = 0;
  for (const [k, incoming] of [['set', ch.sets || []], ['folder', ch.folders || []]]) {
    for (const r of incoming) {
      const list = COLLS[k]();
      const tomb = deleted.find((d) => delKind(d) === k && d.id === r.id);
      if (tomb && tomb.at >= (r.syncAt || 0)) continue;
      const i = list.findIndex((x) => x.id === r.id);
      if (i < 0) { if (tomb) deleted = deleted.filter((d) => d !== tomb); list.push(r); }
      else if ((r.syncAt || 0) > (list[i].syncAt || 0)) list[i] = r;
      else continue;
      setHashes.set(k + ':' + r.id, setHash(r)); n++;
    }
  }
  for (const d of ch.deleted || []) {
    const k = delKind(d);
    if (!COLLS[k]) continue;
    const list = COLLS[k](), i = list.findIndex((x) => x.id === d.id);
    if (i >= 0 && (list[i].syncAt || 0) > d.at) continue; // здесь правили позже удаления
    if (i >= 0) { list.splice(i, 1); setHashes.delete(k + ':' + d.id); n++; }
    if (!deleted.some((x) => delKind(x) === k && x.id === d.id)) deleted.push({ ...d, k });
  }
  if (n) persistSets();
  return n;
}

async function syncPost(cfg, k, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  let r;
  try {
    r = await fetch(cfg.server + '/sync', { method: 'POST', signal: ctl.signal, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k.token }, body: JSON.stringify({ space: k.space, ...body }) });
  } catch { throw new Error('offline'); }
  finally { clearTimeout(t); }
  if (r.status === 401) throw new Error('Ключ не подходит к этому серверу');
  if (r.status === 403) throw new Error('Сервер не принимает новые ключи');
  if (r.status === 429) throw new Error('Слишком часто, попробуй через минуту');
  if (!r.ok) throw new Error('Ошибка сервера (' + r.status + ')');
  return r.json();
}
async function syncPullAll(cfg, k) {
  const items = [];
  let cursor = 0, more = true;
  while (more) {
    const r = await syncPost(cfg, k, { since: cursor, push: [] });
    if (r.reset) return { items: [], cursor: 0 };
    items.push(...r.items); cursor = r.cursor; more = r.more;
  }
  return { items, cursor };
}
const syncErrText = (e) => (e.message === 'offline' ? 'Нет связи с сервером — наборы сохранены на телефоне' : e.message);

// Полный обмен: отправить своё, получить чужое
async function syncNow(manual) {
  const cfg = syncCfg();
  if (!cfg) return;
  if (sync.busy) { sync.again = true; return; }
  clearTimeout(sync.timer);
  sync.busy = true; sync.error = '';
  syncRefreshUI();
  let changed = 0;
  try {
    const k = await syncKeys(cfg.key);
    for (let attempt = 0; attempt < 2; attempt++) {
      const at = Date.now();
      const recs = await syncBuild(k, cfg.pushedAt || 0);
      let cursor = cfg.cursor || 0, i = 0, more = false, reset = false;
      const incoming = [];
      do {
        const r = await syncPost(cfg, k, { since: cursor, push: recs.slice(i, i + SYNC_BATCH) });
        if (r.reset) { reset = true; break; }
        i += SYNC_BATCH; incoming.push(...r.items); cursor = r.cursor; more = r.more;
      } while (i < recs.length || more);
      if (reset) { cfg.cursor = 0; cfg.pushedAt = 0; continue; } // сервер начал с чистого листа — отправляем всё заново
      changed = applyRemote(await syncUnpack(k, incoming));
      cfg.cursor = cursor; cfg.pushedAt = at - 1; cfg.lastOk = Date.now();
      break;
    }
    syncSaveCfg(cfg);
    if (manual) toast(changed ? `Готово, обновлено наборов: ${changed}` : 'Синхронизировано');
  } catch (e) {
    sync.error = syncErrText(e);
    if (manual) toast(sync.error);
  }
  sync.busy = false;
  // во время игры экран не перерисовываем, чтобы не сбить упражнение
  const h = location.hash.replace(/^#\/?/, '');
  if (changed && (h === '' || h === 'all' || /^(set|folder)\/[^/]+$/.test(h))) route();
  else syncRefreshUI();
  if (sync.again) { sync.again = false; scheduleSync(1000); }
}
// После каждого сохранения — обмен через несколько секунд (несколько ответов подряд уйдут одним запросом)
function scheduleSync(ms = 4000) {
  if (!syncCfg()) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => syncNow(false), ms);
}
// Подключить это устройство. key — уже проверенный ключ.
async function syncConnect(server, key, isNew) {
  const cfg = { server, key, cursor: 0, pushedAt: 0 };
  const k = await syncKeys(key);
  const got = await syncPullAll(cfg, k); // заодно проверяет адрес и ключ
  if (!isNew && got.items.length) {
    const own = sets.filter((s) => !(s.demo || (s.title === 'Пример: спорт' && s.cards.length === 8)));
    const replace = (!own.length && !folders.length) || confirm('На сервере уже есть наборы.\n\nОК — заменить наборы этого устройства наборами с сервера (рекомендуется).\nОтмена — объединить: на сервер уйдут и наборы этого устройства.');
    if (replace) {
      sets = []; folders = []; deleted = []; setHashes = new Map();
      applyRemote(await syncUnpack(k, got.items));
      persistSets();
      cfg.pushedAt = Date.now(); cfg.cursor = got.cursor;
    }
  }
  syncSaveCfg(cfg);
  await syncNow(false);
}
function syncStatusText() {
  const cfg = syncCfg();
  if (!cfg) return 'Выключена';
  if (sync.busy) return 'Синхронизация…';
  if (sync.error) return sync.error;
  if (!cfg.lastOk) return 'Ещё не синхронизировано';
  const d = new Date(cfg.lastOk), now = new Date();
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return 'Последняя: ' + (d.toDateString() === now.toDateString() ? 'сегодня' : d.toLocaleDateString('ru-RU')) + ' в ' + hm;
}
function syncRefreshUI() {
  const el = document.getElementById('syncStatus');
  if (el) el.textContent = (sync.busy ? '🔄 ' : sync.error ? '⚠️ ' : syncCfg()?.lastOk ? '✅ ' : '') + syncStatusText();
  const b = document.getElementById('syncNow');
  if (b) b.disabled = sync.busy;
}
// Когда синхронизировать: при открытии, при возвращении в приложение, при появлении сети и раз в 5 минут
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(500); });
window.addEventListener('online', () => scheduleSync(1000));
setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 5 * 60 * 1000);

const status = (c) => ((c.streak || 0) >= 2 ? 'known' : (c.right || c.wrong) ? 'learning' : 'new');
const knownCount = (s) => s.cards.filter((c) => status(c) === 'known').length;

function mark(set, card, ok) {
  const c = findCard(card.id);
  if (!c) return;
  c.prevStreak = c.streak || 0;
  if (ok) { c.right = (c.right || 0) + 1; c.streak = (c.streak || 0) + 1; }
  else { c.wrong = (c.wrong || 0) + 1; c.streak = 0; }
  saveSets();
}
function unmarkWrong(set, card) {
  const c = findCard(card.id);
  if (!c) return;
  c.wrong = Math.max(0, (c.wrong || 0) - 1);
  c.right = (c.right || 0) + 1;
  c.streak = (c.prevStreak || 0) + 1;
  saveSets();
}

// Какая сторона — вопрос, какая — ответ
function qa(card) {
  let d = settings.direction;
  if (d === 'mix') d = Math.random() < 0.5 ? 'term' : 'def';
  return d === 'term' ? { q: card.term, a: card.def, side: 'term' } : { q: card.def, a: card.term, side: 'def' };
}

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith(lang));
  const rank = (v) => (/premium|enhanced|улучш/i.test(v.name) ? 4 : 0) + (/samantha|daniel|karen|serena|milena|google/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  return voices.sort((a, b) => rank(b) - rank(a))[0] || null;
}
function speak(text) {
  if (!('speechSynthesis' in window)) return toast('Озвучка не поддерживается');
  speechSynthesis.cancel();
  const ru = /[а-яё]/i.test(text);
  const u = new SpeechSynthesisUtterance(text.replace(/[()]/g, ''));
  u.lang = ru ? 'ru-RU' : 'en-US';
  const v = pickVoice(ru ? 'ru' : 'en');
  if (v) u.voice = v;
  u.rate = ru ? 1 : 0.9;
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();

/* ---------- Gemini ---------- */
const AI = {
  base: 'https://generativelanguage.googleapis.com/v1beta',

  async listModels(key = settings.apiKey) {
    const r = await fetch(`${AI.base}/models?pageSize=200&key=${encodeURIComponent(key)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(AI.errorText(r.status, data));
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /gemini/.test(n) && !/(image|tts|audio|live|embedding|robotics|computer|vision)/.test(n));
    const score = (n) => {
      const v = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
      let s = v * 10;
      if (n === 'gemini-flash-latest') s += 1000;
      if (/flash/.test(n)) s += 100;
      if (/lite/.test(n)) s -= 5;
      if (/preview|exp/.test(n)) s -= 8;
      if (/\d{3}$/.test(n)) s -= 1;
      return s;
    };
    return names.sort((a, b) => score(b) - score(a));
  },

  errorText(code, data) {
    const msg = data?.error?.message || '';
    if (code === 429) return 'Бесплатный лимит запросов Gemini на сейчас исчерпан. Подожди минуту (или до завтра) и попробуй снова.';
    if (code === 400 && /api key/i.test(msg)) return 'Ключ Gemini не подошёл. Проверь его в настройках.';
    if (code === 403) return 'Доступ к Gemini запрещён. Проверь ключ; в некоторых странах Gemini работает только через VPN.';
    if (code === 404) return 'Модель не найдена. Выбери другую модель в настройках.';
    return `Ошибка Gemini (${code}): ${msg || 'неизвестная ошибка'}`;
  },

  async ensureModel() {
    if (settings.model) return settings.model;
    const list = await AI.listModels();
    if (!list.length) throw new Error('Для этого ключа не нашлось подходящих моделей Gemini.');
    settings.models = list;
    settings.model = list[0];
    saveSettings();
    return settings.model;
  },

  async ask(prompt) {
    if (!settings.apiKey) throw new Error('Добавь бесплатный ключ Gemini в настройках (⚙︎).');
    if (!navigator.onLine) throw new Error('Нет интернета — ИИ сейчас недоступен.');
    const model = await AI.ensureModel();
    let r;
    try {
      r = await fetch(`${AI.base}/models/${model}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.8 },
        }),
      });
    } catch {
      throw new Error('Не удалось связаться с Gemini. Проверь интернет (или VPN).');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(AI.errorText(r.status, data));
    const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (!text) throw new Error('Gemini вернул пустой ответ. Попробуй ещё раз.');
    return AI.parse(text);
  },

  parse(text) {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(clean); } catch {}
    const m = clean.match(/[\[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    throw new Error('Не получилось разобрать ответ ИИ. Попробуй ещё раз.');
  },

  async judge({ question, expected, answer, card }) {
    const prompt = `Ты проверяешь ответ русскоязычного ученика, который учит английский язык по карточкам.
${card ? `Карточка: «${card.term}» — «${card.def}».\n` : ''}Задание: «${question}»
Правильный ответ по ключу: «${expected}»
Ответ ученика: «${answer}»

Засчитай ответ (correct: true), если он передаёт тот же смысл и грамматически допустим: синонимы, другой вид глагола (играть / поиграть), другой порядок слов, британское или американское написание и лексика, сокращения (don't / do not), пропущенные артикли, мелкие опечатки — это нормально. Если в английском ответе есть грамматическая ошибка, которая не мешает смыслу (например, время или артикль), засчитай, но коротко укажи на неё в комментарии.
Не засчитывай (correct: false), если смысл другой, слово переведено неверно или ответ слишком неполный.
Верни только JSON: {"correct": true или false, "comment": "одно-два коротких предложения по-русски: почему, и как правильно, если есть ошибка"}`;
    const res = await AI.ask(prompt);
    return { correct: !!res.correct, comment: String(res.comment || '') };
  },

  async makeTasks(set, n) {
    const cards = shuffle(set.cards)
      .sort((a, b) => (a.streak || 0) - (b.streak || 0) || (b.wrong || 0) - (a.wrong || 0))
      .slice(0, 40);
    const list = cards.map((c) => `- ${c.term} — ${c.def}`).join('\n');
    const prompt = `Ты составляешь упражнения для русскоязычного ученика, который учит английский язык по карточкам.
Набор «${set.title}» (термин — значение):
${list}

Обычно термин — на английском, значение — на русском (если наоборот, разберись сам). Уровень сложности предложений подбери по словам набора: простые слова — простые предложения.
Составь ${n} разнообразных упражнений, каждое — на одно слово/фразу из набора. В первую очередь используй слова из начала списка (они сложнее для ученика). Чередуй типы:
- "fill": предложение на английском с пропуском "___"; answer — английское слово/фраза из набора в нужной грамматической форме (won, played, is playing и т.п.); hint — перевод всего предложения на русский.
- "translate": короткое естественное предложение на русском, которое нужно перевести на английский, используя слово из набора; answer — эталонный английский перевод; hint — какое слово из набора нужно использовать.
- "choice": вопрос на понимание с 4 вариантами: что означает английское слово, какое слово подходит в английское предложение, какое предложение звучит естественно и т.п.; options — 4 варианта; answer — точный текст правильного варианта.
Пиши простые, живые предложения уровня ученика. Поле explanation — одно короткое пояснение по-русски.
Верни только JSON: {"tasks": [{"type": "fill|translate|choice", "question": "...", "answer": "...", "hint": "...", "options": ["..."], "explanation": "..."}]}`;
    const res = await AI.ask(prompt);
    const tasks = (Array.isArray(res) ? res : res.tasks || [])
      .filter((t) => t && typeof t.question === 'string' && t.question.trim() && t.answer)
      .map((t) => {
        const type = ['fill', 'translate', 'choice'].includes(t.type) ? t.type : 'translate';
        const answer = String(t.answer);
        let options = Array.isArray(t.options) ? t.options.map(String).filter(Boolean) : [];
        if (type === 'choice' && !options.includes(answer)) options = [];
        return { ...t, type: type === 'choice' && options.length < 2 ? 'fill' : type, answer, options: shuffle(options) };
      });
    if (!tasks.length) throw new Error('ИИ не прислал заданий. Попробуй ещё раз.');
    return tasks;
  },
};

/* ---------- layout ---------- */
let cleanup = null;
function layout(title, body, { back, actions = '' } = {}) {
  return `<header class="top">${back ? `<a class="icon-btn" href="${back}" aria-label="Назад">‹</a>` : '<span class="logo">🃏</span>'}<h1>${esc(title)}</h1><div class="top-actions">${actions}</div></header><main>${body}</main>`;
}
const bar = (pct, cls = '') => `<div class="bar ${cls}"><div style="width:${Math.round(pct)}%"></div></div>`;

/* ---------- router ---------- */
function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  window.scrollTo(0, 0);
  const p = location.hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'new') return viewEdit(null);
  if (p[0] === 'import') return viewImport(null);
  if (p[0] === 'settings') return viewSettings();
  if (p[0] === 'all') return viewAllSets();
  if (p[0] === 'newfolder') return viewFolderEdit(null);
  if (p[0] === 'folder' && p[1]) {
    const f = getFolder(p[1]);
    if (!f) return go('#/');
    if (p[2] === 'edit') return viewFolderEdit(f);
    if (p[2] === 'play' && MODES[p[3]]) return MODES[p[3]](folderDeck(f));
    return viewFolder(f);
  }
  if (p[0] === 'set' && p[1]) {
    const s = getSet(p[1]);
    if (!s) return go('#/');
    if (p[2] === 'edit') return viewEdit(s);
    if (p[2] === 'import') return viewImport(s);
    if (p[2] === 'folders') return viewSetFolders(s);
    if (p[2] === 'play' && MODES[p[3]]) return MODES[p[3]](s);
    return viewSet(s);
  }
  viewHome();
}
window.addEventListener('hashchange', route);
const MODES = { flash: (s) => playFlash(s), write: (s) => playWrite(s), test: (s) => playTest(s), match: (s) => playMatch(s), ai: (s) => playAI(s) };
let lastFolder = null; // из какой папки пришли — туда ведёт «назад» с экрана набора

/* ---------- home ---------- */
const setItem = (s) => {
  const k = knownCount(s);
  return `<a class="set-item" href="#/set/${s.id}"><div class="set-title">${esc(s.title)}</div><div class="muted small">${cardsWord(s.cards.length)} · выучено ${k}</div>${bar(s.cards.length ? (k / s.cards.length) * 100 : 0)}</a>`;
};
const folderItem = (f) => {
  const d = folderDeck(f), k = knownCount(d), n = f.setIds.filter(getSet).length;
  return `<a class="set-item folder-item" href="#/folder/${f.id}"><div class="set-title">📁 ${esc(f.title)}</div><div class="muted small">${n} ${plural(n, 'набор', 'набора', 'наборов')} · ${cardsWord(d.cards.length)} · выучено ${k}</div>${bar(d.cards.length ? (k / d.cards.length) * 100 : 0)}</a>`;
};
const byUpdated = (a, b) => (b.updated || 0) - (a.updated || 0);
const byTitle = (a, b) => a.title.localeCompare(b.title, 'ru');

function viewHome() {
  lastFolder = null;
  const inFolder = new Set(folders.flatMap((f) => f.setIds));
  const loose = sets.filter((s) => !inFolder.has(s.id)).sort(byUpdated);
  const empty = !sets.length && !folders.length;
  const aiNote = settings.apiKey ? '' : `<a class="set-item" href="#/settings" style="background:var(--accent-soft)"><b>✨ Подключи ИИ бесплатно</b><div class="small muted">Вставь ключ Gemini — и приложение будет само придумывать задания и понимать ответы по смыслу.</div></a>`;
  app.innerHTML = layout('Мои наборы', `
    <div class="row"><a class="btn primary" href="#/new">＋ Набор</a><a class="btn" href="#/newfolder">＋ Папка</a><a class="btn" href="#/import">⇩ Quizlet</a></div>
    ${aiNote}
    ${empty ? `<div class="empty"><div class="big">🗂️</div><p>Пока нет ни одного набора.<br>Создай свой или импортируй из Quizlet.</p></div>` : ''}
    ${folders.length ? `<h2 class="section">Папки</h2>${[...folders].sort(byTitle).map(folderItem).join('')}` : ''}
    ${loose.length ? `<h2 class="section">${folders.length ? 'Наборы без папки' : 'Наборы'}</h2>${loose.map(setItem).join('')}` : ''}
    ${folders.length && sets.length ? `<a class="btn wide mt" href="#/all">Все наборы (${sets.length})</a>` : ''}`,
  { actions: `<a class="icon-btn" href="#/settings" aria-label="Настройки">⚙︎</a>` });
}

function viewAllSets() {
  app.innerHTML = layout('Все наборы', [...sets].sort(byTitle).map(setItem).join('') || '<div class="muted">Наборов нет</div>', { back: '#/' });
}

// Режимы учёбы и выбор направления — общие для набора и папки
function modesHTML(base, what) {
  return `<div class="modes">
      <a class="mode" href="${base}/play/flash"><span class="ico">🃏</span>Карточки<small>Переворачивай и запоминай</small></a>
      <a class="mode" href="${base}/play/write"><span class="ico">✍️</span>Письмо<small>Пиши ответ сам</small></a>
      <a class="mode" href="${base}/play/test"><span class="ico">✅</span>Тест<small>Выбери вариант</small></a>
      <a class="mode" href="${base}/play/match"><span class="ico">🧩</span>Подбор пар<small>На скорость</small></a>
      <a class="mode ai" href="${base}/play/ai"><span class="ico">✨</span>ИИ-задания<small>Gemini придумает упражнения ${what}</small></a>
    </div>
    <div class="field"><span>Что спрашивать</span>
      <div class="seg">${[['term', 'Термин → значение'], ['def', 'Значение → термин'], ['mix', 'Вперемешку']].map(([v, l]) => `<button data-dir="${v}" class="${settings.direction === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>`;
}
function bindDir() {
  $$('[data-dir]').forEach((b) => b.onclick = () => {
    settings.direction = b.dataset.dir; saveSettings();
    $$('[data-dir]').forEach((x) => x.classList.toggle('on', x === b));
  });
}

/* ---------- folder ---------- */
function viewFolder(f) {
  lastFolder = f.id;
  const d = folderDeck(f), k = knownCount(d);
  const list = f.setIds.map(getSet).filter(Boolean);
  app.innerHTML = layout('📁 ' + f.title, `
    <div class="muted small">${list.length} ${plural(list.length, 'набор', 'набора', 'наборов')} · ${cardsWord(d.cards.length)} · выучено ${k}</div>
    ${bar(d.cards.length ? (k / d.cards.length) * 100 : 0)}
    ${d.cards.length ? modesHTML(`#/folder/${f.id}`, 'по всем словам папки') : ''}
    <h2 class="section">Наборы в папке</h2>
    ${list.map(setItem).join('') || '<div class="muted">В папке пока нет наборов</div>'}
    <div class="stack mt">
      <a class="btn" href="#/folder/${f.id}/edit">📁 Выбрать наборы и название</a>
      <button class="btn" id="reset">↺ Сбросить прогресс по папке</button>
      <button class="btn bad" id="del">Удалить папку</button>
    </div>`, { back: '#/' });
  bindDir();
  $('#reset').onclick = () => {
    if (!confirm('Сбросить прогресс по всем наборам папки?')) return;
    d.cards.forEach((c) => { const x = findCard(c.id); if (x) { x.streak = 0; x.right = 0; x.wrong = 0; } });
    saveSets(); route();
  };
  $('#del').onclick = () => {
    if (!confirm(`Удалить папку «${f.title}»? Наборы останутся.`)) return;
    folders = folders.filter((x) => x.id !== f.id); saveSets(); go('#/');
  };
}

function viewFolderEdit(existing) {
  const all = [...sets].sort(byTitle);
  const ids = new Set(existing?.setIds || []);
  app.innerHTML = layout(existing ? 'Папка' : 'Новая папка', `
    <label class="field"><span>Название</span><input id="title" value="${esc(existing?.title || '')}" placeholder="Например: Travel"></label>
    <h2 class="section">Наборы в папке</h2>
    <p class="hint">Один набор может лежать в нескольких папках.</p>
    <div class="panel">${all.map((s) => `<label class="check"><input type="checkbox" data-id="${s.id}" ${ids.has(s.id) ? 'checked' : ''}><span>${esc(s.title)} <small class="muted">· ${s.cards.length}</small></span></label>`).join('') || '<div class="muted">Наборов пока нет</div>'}</div>
    <div class="sticky-bottom"><button class="btn primary wide" id="save">Сохранить</button></div>`,
  { back: existing ? `#/folder/${existing.id}` : '#/' });
  $('#save').onclick = () => {
    const title = $('#title').value.trim() || 'Без названия';
    const checked = $$('[data-id]').filter((x) => x.checked).map((x) => x.dataset.id);
    const old = existing ? existing.setIds.filter((id) => checked.includes(id)) : []; // прежний порядок, новые — в конец
    const setIds = [...old, ...checked.filter((id) => !old.includes(id))];
    let f = existing && getFolder(existing.id);
    if (f) Object.assign(f, { title, setIds });
    else { f = { id: uid(), title, setIds, created: Date.now() }; folders.push(f); }
    saveSets(); go(`#/folder/${f.id}`);
  };
}

// В какие папки положить набор
function viewSetFolders(s) {
  app.innerHTML = layout('Папки набора', `
    <div class="muted small">${esc(s.title)}</div>
    <div class="panel mt">${[...folders].sort(byTitle).map((f) => `<label class="check"><input type="checkbox" data-id="${f.id}" ${f.setIds.includes(s.id) ? 'checked' : ''}><span>📁 ${esc(f.title)}</span></label>`).join('') || '<div class="muted">Папок пока нет</div>'}</div>
    <label class="field mt"><span>Или новая папка</span><input id="newf" placeholder="Название новой папки"></label>
    <div class="sticky-bottom"><button class="btn primary wide" id="save">Сохранить</button></div>`, { back: `#/set/${s.id}` });
  $('#save').onclick = () => {
    for (const box of $$('[data-id]')) {
      const f = getFolder(box.dataset.id);
      if (!f) continue;
      const has = f.setIds.includes(s.id);
      if (box.checked && !has) f.setIds.push(s.id);
      if (!box.checked && has) f.setIds = f.setIds.filter((id) => id !== s.id);
    }
    const nf = $('#newf').value.trim();
    if (nf) folders.push({ id: uid(), title: nf, setIds: [s.id], created: Date.now() });
    saveSets(); go(`#/set/${s.id}`);
  };
}

/* ---------- set ---------- */
function viewSet(s) {
  const k = knownCount(s);
  const rows = s.cards.map((c) => `<div class="card-row"><div>${esc(c.term)}</div><div class="muted">${esc(c.def)}</div><div class="dot ${status(c)}" title="${status(c) === 'known' ? 'выучено' : status(c) === 'learning' ? 'учу' : 'новое'}"></div></div>`).join('');
  const fs = setFolders(s.id);
  const back = lastFolder && getFolder(lastFolder)?.setIds.includes(s.id) ? `#/folder/${lastFolder}` : '#/';
  app.innerHTML = layout(s.title, `
    <div class="muted small">${cardsWord(s.cards.length)} · выучено ${k}</div>
    ${bar(s.cards.length ? (k / s.cards.length) * 100 : 0)}
    <a class="folder-line small" href="#/set/${s.id}/folders">📁 ${fs.length ? fs.map((f) => esc(f.title)).join(', ') : 'Положить в папку'}</a>
    ${modesHTML(`#/set/${s.id}`, 'именно под этот набор')}
    <div class="panel mt">${rows || '<div class="muted">В наборе нет карточек</div>'}</div>
    <div class="stack mt">
      <a class="btn" href="#/set/${s.id}/import">⇩ Добавить карточки из текста</a>
      <button class="btn" id="export">⧉ Скопировать как текст</button>
      <button class="btn" id="reset">↺ Сбросить прогресс</button>
      <button class="btn bad" id="del">Удалить набор</button>
    </div>`, { back, actions: `<a class="icon-btn" href="#/set/${s.id}/edit" aria-label="Редактировать">✎</a>` });
  bindDir();
  $('#export').onclick = async () => {
    const text = s.cards.map((c) => `${c.term}\t${c.def}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Скопировано'); } catch { prompt('Скопируй текст:', text); }
  };
  $('#reset').onclick = () => {
    if (!confirm('Сбросить прогресс по этому набору?')) return;
    (getSet(s.id) || s).cards.forEach((c) => { c.streak = 0; c.right = 0; c.wrong = 0; });
    saveSets(); route();
  };
  $('#del').onclick = () => {
    if (!confirm(`Удалить набор «${s.title}»?`)) return;
    sets = sets.filter((x) => x.id !== s.id);
    for (const f of folders) if (f.setIds.includes(s.id)) f.setIds = f.setIds.filter((id) => id !== s.id);
    saveSets(); go(back);
  };
}

/* ---------- edit ---------- */
function viewEdit(existing) {
  const draft = existing ? JSON.parse(JSON.stringify(existing)) : { id: uid(), title: '', created: Date.now(), cards: [newCard(), newCard(), newCard()] };
  const draw = () => {
    app.innerHTML = layout(existing ? 'Редактирование' : 'Новый набор', `
      <label class="field"><span>Название</span><input id="title" value="${esc(draft.title)}" placeholder="Например: Unit 5 — Sport"></label>
      <p class="hint">Несколько правильных ответов пиши через « / » или «;», необязательную часть — в скобках: <b>(по)играть в мяч</b>. Пометки sb/sth и кого-л./что-л. при проверке можно не писать.</p>
      <div id="rows">${draft.cards.map((c, i) => `
        <div class="edit-card"><div class="edit-head"><span class="muted small">${i + 1}</span><button class="icon-btn small" data-del="${i}" aria-label="Удалить">✕</button></div>
        <textarea data-i="${i}" data-f="term" rows="1" placeholder="Термин">${esc(c.term)}</textarea>
        <textarea data-i="${i}" data-f="def" rows="1" placeholder="Значение">${esc(c.def)}</textarea></div>`).join('')}</div>
      <button class="btn wide mt" id="add">＋ Добавить карточку</button>
      <div class="sticky-bottom"><button class="btn primary wide" id="save">Сохранить</button></div>`,
    { back: existing ? `#/set/${existing.id}` : '#/' });
    $('#title').oninput = (e) => { draft.title = e.target.value; };
    $$('textarea[data-f]').forEach((t) => t.oninput = () => { draft.cards[t.dataset.i][t.dataset.f] = t.value; });
    $$('[data-del]').forEach((b) => b.onclick = () => { draft.cards.splice(+b.dataset.del, 1); draw(); });
    $('#add').onclick = () => {
      draft.cards.push(newCard()); draw();
      const ts = $$('textarea[data-f="term"]'); ts[ts.length - 1].focus();
    };
    $('#save').onclick = () => {
      draft.cards = draft.cards.map((c) => ({ ...c, term: c.term.trim(), def: c.def.trim() })).filter((c) => c.term || c.def);
      if (!draft.cards.length) return toast('Добавь хотя бы одну карточку');
      draft.title = draft.title.trim() || 'Без названия';
      draft.updated = Date.now();
      const cur = getSet(draft.id);
      if (cur) Object.assign(cur, draft); else sets.push(draft);
      saveSets(); go(`#/set/${draft.id}`);
    };
  };
  draw();
}

/* ---------- import ---------- */
function parseImport(raw, sepT, sepC, custom) {
  const chunks = sepC === 'semi' ? raw.split(';') : raw.split(/\r?\n/);
  const cards = [], bad = [];
  for (const chunk of chunks) {
    const line = chunk.trim();
    if (!line) continue;
    let sep = null;
    if (sepT === 'tab' || (sepT === 'auto' && line.includes('\t'))) sep = '\t';
    else if (sepT === 'comma') sep = ',';
    else if (sepT === 'dash') sep = /\s[-–—]\s/;
    else if (sepT === 'custom') sep = custom || null;
    else sep = [/\s[-–—]\s/, ' = ', ':', ','].find((s) => (typeof s === 'string' ? line.includes(s) : s.test(line)));
    if (!sep) { bad.push(line); continue; }
    let idx, len;
    if (typeof sep === 'string') { idx = line.indexOf(sep); len = sep.length; }
    else { const m = line.match(sep); idx = m ? m.index : -1; len = m ? m[0].length : 0; }
    if (idx < 0) { bad.push(line); continue; }
    const term = line.slice(0, idx).trim(), def = line.slice(idx + len).trim();
    if (term && def) cards.push(newCard(term, def)); else bad.push(line);
  }
  return { cards, bad };
}

function viewImport(target) {
  app.innerHTML = layout(target ? 'Добавить карточки' : 'Импорт из Quizlet', `
    <details class="howto" ${target ? '' : 'open'}><summary>Как перенести набор из Quizlet</summary>
      <ol>
        <li>Открой свой набор на сайте <b>quizlet.com</b> в браузере (в приложении Quizlet экспорта нет).</li>
        <li>Нажми «⋯» рядом с названием → <b>«Экспортировать»</b>.</li>
        <li>Оставь настройки как есть: между термином и определением — «Tab», между карточками — «Новая строка».</li>
        <li>Нажми «Копировать текст» и вставь его сюда.</li>
      </ol>
      <div class="small muted">Экспорт обычно доступен только для твоих наборов. Чужой набор сначала скопируй себе в Quizlet. Подойдёт и любой список вида «слово - перевод».</div>
    </details>
    ${target ? '' : `<label class="field"><span>Название набора</span><input id="title" placeholder="Например: Unit 5 — Sport"></label>`}
    ${target || !folders.length ? '' : `<label class="field"><span>Папка</span><select id="folder"><option value="">Без папки</option>${[...folders].sort(byTitle).map((f) => `<option value="${f.id}" ${f.id === lastFolder ? 'selected' : ''}>${esc(f.title)}</option>`).join('')}</select></label>`}
    <label class="field"><span>Текст</span><textarea id="raw" rows="8" placeholder="dog&#9;собака&#10;cat - кошка"></textarea></label>
    <div class="grid2">
      <label class="field"><span>Термин ↔ значение</span><select id="sepT">
        <option value="auto">Авто</option><option value="tab">Tab</option><option value="comma">Запятая</option><option value="dash">Тире « - »</option><option value="custom">Свой…</option></select></label>
      <label class="field"><span>Между карточками</span><select id="sepC">
        <option value="nl">Новая строка</option><option value="semi">Точка с запятой</option></select></label>
    </div>
    <input id="custom" class="hidden mt" placeholder="Свой разделитель">
    <div class="preview" id="preview"></div>
    <div class="sticky-bottom"><button class="btn primary wide" id="save" disabled>Импортировать</button></div>`,
  { back: target ? `#/set/${target.id}` : '#/' });

  let parsed = { cards: [], bad: [] };
  const update = () => {
    $('#custom').classList.toggle('hidden', $('#sepT').value !== 'custom');
    parsed = parseImport($('#raw').value, $('#sepT').value, $('#sepC').value, $('#custom').value);
    const { cards, bad } = parsed;
    $('#save').disabled = !cards.length;
    $('#save').textContent = cards.length ? `Импортировать ${cardsWord(cards.length)}` : 'Импортировать';
    $('#preview').innerHTML = !cards.length && !bad.length ? '' : `
      <table>${cards.slice(0, 5).map((c) => `<tr><td>${esc(c.term)}</td><td class="muted">${esc(c.def)}</td></tr>`).join('')}</table>
      ${cards.length > 5 ? `<div class="muted small">…и ещё ${cards.length - 5}</div>` : ''}
      ${bad.length ? `<div class="small" style="color:var(--bad);margin-top:8px">Не удалось разобрать ${bad.length} строк(и), например: «${esc(bad[0].slice(0, 60))}». Попробуй выбрать другой разделитель.</div>` : ''}`;
  };
  ['raw', 'sepT', 'sepC', 'custom'].forEach((id) => { $('#' + id).oninput = update; });
  $('#save').onclick = () => {
    if (!parsed.cards.length) return;
    if (target) {
      target = getSet(target.id) || target;
      target.cards.push(...parsed.cards); target.updated = Date.now();
      saveSets(); toast(`Добавлено: ${cardsWord(parsed.cards.length)}`); go(`#/set/${target.id}`);
    } else {
      const s = { id: uid(), title: $('#title').value.trim() || 'Импорт из Quizlet', created: Date.now(), updated: Date.now(), cards: parsed.cards };
      sets.push(s);
      const f = $('#folder') && getFolder($('#folder').value);
      if (f) f.setIds.push(s.id);
      saveSets(); toast('Набор импортирован'); go(`#/set/${s.id}`);
    }
  };
}

/* ---------- settings ---------- */
function viewSettings() {
  const modelOptions = () => {
    const list = [...new Set([settings.model, ...(settings.models || [])].filter(Boolean))];
    return list.length ? list.map((m) => `<option ${m === settings.model ? 'selected' : ''}>${esc(m)}</option>`).join('') : '<option value="">выберется автоматически</option>';
  };
  app.innerHTML = layout('Настройки', `
    <div class="panel">
      <b>✨ ИИ: Google Gemini (бесплатно)</b>
      <ol class="small" style="padding-left:20px;margin:8px 0">
        <li>Открой <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> и войди с Google-аккаунтом.</li>
        <li>Нажми «Create API key» и скопируй ключ.</li>
        <li>Вставь его сюда и нажми «Сохранить».</li>
      </ol>
      <label class="field"><span>Ключ Gemini API</span><input id="key" type="password" autocomplete="off" value="${esc(settings.apiKey)}" placeholder="AIza…"></label>
      <div class="row mt"><button class="btn primary" id="saveKey">Сохранить и проверить</button><button class="btn" id="showKey">👁</button></div>
      <div id="keyStatus" class="small mt muted">${settings.apiKey ? 'Ключ сохранён.' : 'Ключ не добавлен — ИИ-функции выключены.'}</div>
      <label class="field"><span>Модель</span><select id="model">${modelOptions()}</select></label>
      <p class="hint">Ключ хранится только в этом браузере на твоём телефоне и отправляется только в Google. На бесплатном тарифе есть лимит запросов в день, а Google может использовать запросы для улучшения своих моделей — не пиши в карточки ничего личного.</p>
      ${settings.apiKey ? '<button class="link" id="removeKey">Удалить ключ</button>' : ''}
    </div>
    <div class="panel mt" id="syncPanel">${syncPanelHTML()}</div>
    <div class="panel mt">
      <b>💾 Резервная копия</b>
      <p class="hint">${syncCfg() ? 'Наборы хранятся на устройстве, а зашифрованная копия — на твоём сервере. Файл-копия пригодится на всякий случай.' : 'Все наборы хранятся только на этом устройстве. Если очистить данные браузера, они пропадут — время от времени сохраняй копию или включи синхронизацию.'}</p>
      <div class="stack"><button class="btn" id="backup">Скачать копию (файл)</button>
      <label class="btn">Восстановить из файла<input type="file" id="restore" accept=".json,application/json" class="hidden"></label></div>
    </div>
    <div class="panel mt">
      <b>📱 Установка на iPhone</b>
      <ol class="small" style="padding-left:20px;margin:8px 0">
        <li>Открой эту страницу в <b>Safari</b>.</li>
        <li>Нажми кнопку «Поделиться» <b>⎋</b> (квадрат со стрелкой вверх).</li>
        <li>Выбери <b>«На экран „Домой“»</b> → «Добавить».</li>
      </ol>
      <p class="hint">Так приложение работает на весь экран и без интернета, а iOS не удаляет его данные. Важно: у иконки на экране «Домой» и у вкладки в Safari <b>разные хранилища</b> — пользуйся чем-то одним (лучше иконкой). Перенести наборы между ними можно через резервную копию.</p>
    </div>`,
  { back: '#/' });

  bindSyncPanel();
  const st = $('#keyStatus');
  $('#showKey').onclick = () => { const k = $('#key'); k.type = k.type === 'password' ? 'text' : 'password'; };
  $('#saveKey').onclick = async () => {
    const key = $('#key').value.trim();
    if (!key) return toast('Вставь ключ');
    st.textContent = 'Проверяю ключ…';
    $('#saveKey').disabled = true;
    try {
      const list = await AI.listModels(key);
      if (!list.length) throw new Error('Ключ работает, но подходящих моделей не нашлось.');
      settings.apiKey = key;
      settings.models = list;
      if (!list.includes(settings.model)) settings.model = list[0];
      saveSettings();
      $('#model').innerHTML = modelOptions();
      st.innerHTML = `<span style="color:var(--good)">✓ Ключ работает. Модель: ${esc(settings.model)}</span>`;
    } catch (e) {
      st.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
    } finally { $('#saveKey').disabled = false; }
  };
  $('#model').onchange = (e) => { settings.model = e.target.value; saveSettings(); toast('Модель выбрана'); };
  if ($('#removeKey')) $('#removeKey').onclick = () => { settings.apiKey = ''; settings.model = ''; settings.models = []; saveSettings(); route(); };

  $('#backup').onclick = async () => {
    const json = JSON.stringify({ app: 'kartochki', version: 2, sets, folders }, null, 2);
    const name = `kartochki-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Карточки — резервная копия' }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#restore').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data.sets;
      if (!Array.isArray(incoming)) throw new Error();
      let added = 0, addedF = 0;
      for (const s of incoming) {
        if (!s || !Array.isArray(s.cards)) continue;
        const i = sets.findIndex((x) => x.id === s.id);
        if (i >= 0) sets[i] = s; else sets.push(s);
        added++;
      }
      for (const f of Array.isArray(data.folders) ? data.folders : []) {
        if (!f || !f.id || !Array.isArray(f.setIds)) continue;
        const i = folders.findIndex((x) => x.id === f.id);
        if (i >= 0) folders[i] = f; else folders.push(f);
        addedF++;
      }
      saveSets(); toast(`Восстановлено наборов: ${added}` + (addedF ? `, папок: ${addedF}` : '')); go('#/');
    } catch { toast('Не удалось прочитать файл'); }
  };
}

/* ---------- экран синхронизации (в настройках) ---------- */
const syncForm = { server: SYNC_DEFAULT_SERVER, key: '', created: false, show: false, busy: false };
function syncPanelHTML() {
  const cfg = syncCfg();
  if (cfg) return `<b>☁️ Синхронизация</b>
    <div id="syncStatus" class="small mt">${esc((sync.busy ? '🔄 ' : sync.error ? '⚠️ ' : cfg.lastOk ? '✅ ' : '') + syncStatusText())}</div>
    <div class="small muted mt">Сервер: ${esc(cfg.server)}</div>
    ${syncForm.show ? `<div class="sync-key">${esc(cfg.key)}</div>` : ''}
    <div class="row mt"><button class="btn" id="syncShow">${syncForm.show ? 'Скрыть ключ' : 'Показать ключ'}</button><button class="btn" id="syncCopy">Скопировать ключ</button></div>
    <button class="btn primary wide mt" id="syncNow" ${sync.busy ? 'disabled' : ''}>🔄 Синхронизировать сейчас</button>
    <p class="hint">Чтобы подключить другое устройство или новый адрес приложения: открой там Настройки → Синхронизация и введи этот ключ. Без ключа наборы на сервере прочитать невозможно — храни его в «Паролях».</p>
    <button class="link" id="syncOff">Отключить на этом устройстве</button>`;
  const f = syncForm;
  return `<b>☁️ Синхронизация с сервером</b>
    <p class="hint">Наборы и прогресс сохраняются в <b>зашифрованном</b> виде на твоём сервере и появляются на всех устройствах с тем же ключом. Расшифровать их можно только этим ключом.</p>
    <form id="syncForm" autocomplete="on">
      <label class="field"><span>Сервер</span><input id="syncServer" name="username" autocomplete="username" inputmode="url" autocapitalize="off" spellcheck="false" value="${esc(f.server)}"></label>
      <label class="field"><span>Ключ</span><input id="syncKey" type="password" name="password" autocomplete="${f.created ? 'new-password' : 'current-password'}" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-…" value="${esc(f.key)}" style="font-family:ui-monospace,monospace"></label>
      ${f.created ? `<div class="sync-key">${esc(f.key)}</div><div class="verdict ai small">🔑 Это новый ключ. <b>Сохрани его</b>: после «Подключить» iPhone предложит сохранить его в «Пароли». Без ключа копию на сервере не открыть.</div>` : ''}
      <button class="btn primary wide mt" ${f.busy ? 'disabled' : ''}>${f.busy ? 'Подключаю…' : 'Подключить'}</button>
    </form>
    ${f.created ? '' : `<p class="hint">Первое устройство? Создай ключ. Уже есть ключ с другого устройства — введи его выше.</p>
    <button class="btn wide" id="syncCreate">🔑 Создать новый ключ</button>`}`;
}
function bindSyncPanel() {
  const panel = $('#syncPanel');
  const redraw = () => { panel.innerHTML = syncPanelHTML(); bindSyncPanel(); };
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  on('syncShow', () => { syncForm.show = !syncForm.show; redraw(); });
  on('syncCopy', async () => { try { await navigator.clipboard.writeText(syncCfg().key); toast('Ключ скопирован'); } catch { prompt('Скопируй ключ:', syncCfg().key); } });
  on('syncNow', () => syncNow(true));
  on('syncOff', () => {
    if (!confirm('Отключить синхронизацию на этом устройстве? Наборы на устройстве и на сервере останутся.')) return;
    syncSaveCfg(null); sync.error = ''; syncForm.show = false; redraw(); toast('Синхронизация отключена');
  });
  on('syncCreate', async () => { syncForm.key = await syncNewKey(); syncForm.created = true; redraw(); });
  const form = $('#syncForm');
  if (!form) return;
  $('#syncServer').oninput = (e) => { syncForm.server = e.target.value; };
  $('#syncKey').oninput = (e) => { syncForm.key = e.target.value; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const server = syncNormServer(syncForm.server);
    if (!/^https:\/\/[^/]+|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(server)) return toast('Введи адрес сервера (https://…)');
    const key = await syncNormKey(syncForm.key);
    if (!key) return toast('В ключе ошибка — проверь его');
    syncForm.busy = true; redraw();
    try {
      await syncConnect(server, key, syncForm.created);
      Object.assign(syncForm, { server: SYNC_DEFAULT_SERVER, key: '', created: false, show: false });
      toast('Синхронизация включена');
    } catch (err) { toast(syncErrText(err)); }
    syncForm.busy = false;
    if ($('#syncPanel')) redraw();
  };
}

/* ---------- shared game bits ---------- */
function finishScreen(s, title, big, sub, extra = '', retry) {
  app.innerHTML = layout(title, `
    <div class="result-big"><div class="num">${big}</div><div class="muted">${sub}</div></div>
    ${extra}
    <div class="stack mt">
      ${retry ? `<button class="btn primary" id="retry">${retry.label}</button>` : ''}
      <button class="btn" id="again">Начать заново</button>
      <a class="btn" href="${home(s)}">${s.isFolder ? 'К папке' : 'К набору'}</a>
    </div>`, { back: home(s) });
  if (retry) $('#retry').onclick = retry.fn;
  $('#again').onclick = () => route();
}
const needCards = (s, n) => {
  if (s.cards.length >= n) return false;
  app.innerHTML = layout(s.title, `<div class="empty"><div class="big">🃏</div><p>Для этого режима нужно хотя бы ${cardsWord(n)}.</p><a class="btn primary" href="${s.isFolder ? `#/folder/${s.id}/edit` : `#/set/${s.id}/edit`}">${s.isFolder ? 'Добавить наборы' : 'Добавить карточки'}</a></div>`, { back: home(s) });
  return true;
};

function verdictHTML(res, expected, answer, aiState) {
  if (res.ok) {
    return `<div class="verdict ok"><b class="title">Верно! 🎉</b>
      ${res.note ? `<div class="line small">${esc(res.note)}</div>` : ''}
      ${res.kind !== 'exact' ? `<div class="line">Ответ по карточке: <b>${esc(expected)}</b></div>` : ''}</div>`;
  }
  return `<div class="verdict no"><b class="title">${res.kind === 'empty' ? 'Нет ответа' : 'Неверно'}</b>
      ${answer ? `<div class="line">Твой ответ: ${esc(answer)}</div>` : ''}
      <div class="line">Правильно: <b>${esc(expected)}</b></div>
      ${res.comment ? `<div class="line small">✨ ${esc(res.comment)}</div>` : ''}</div>
    ${answer && !aiState ? `<div class="row"><button class="btn" id="override">Мой ответ верный</button>${settings.apiKey ? '<button class="btn" id="askAI">✨ Спросить ИИ</button>' : ''}</div>` : ''}
    ${aiState === 'loading' ? '<div class="verdict ai small">✨ ИИ проверяет ответ…</div>' : ''}`;
}

/* ---------- flashcards ---------- */
function playFlash(s, subset) {
  if (needCards(s, 1)) return;
  const deck = shuffle(subset || s.cards).map((c) => ({ c, ...qa(c) }));
  let i = 0, flipped = false;
  const learn = [];
  const draw = () => {
    if (i >= deck.length) {
      const known = deck.length - learn.length;
      return finishScreen(s, 'Карточки', `${known} / ${deck.length}`, 'карточек ты уже знаешь', '',
        learn.length ? { label: `Повторить «ещё учу» (${learn.length})`, fn: () => playFlash(s, learn) } : null);
    }
    const it = deck[i];
    flipped = false;
    app.innerHTML = layout(`${i + 1} / ${deck.length}`, `
      ${bar((i / deck.length) * 100, 'accent')}
      <div class="flip-wrap"><div class="flip" id="card">
        <div class="face front"><span class="side">${it.side === 'term' ? 'Термин' : 'Значение'}</span><button class="icon-btn speak" data-say="q">🔊</button>${esc(it.q)}</div>
        <div class="face back"><span class="side">${it.side === 'term' ? 'Значение' : 'Термин'}</span><button class="icon-btn speak" data-say="a">🔊</button>${esc(it.a)}</div>
      </div></div>
      <div class="swipe-hint">Нажми, чтобы перевернуть · свайп ← ещё учу, → знаю</div>
      <div class="row"><button class="btn bad" id="no">Ещё учу</button><button class="btn good" id="yes">Знаю</button></div>`,
    { back: home(s) });
    const card = $('#card');
    card.onclick = (e) => {
      if (e.target.closest('[data-say]')) return;
      flipped = !flipped; card.classList.toggle('flipped', flipped);
    };
    $$('[data-say]').forEach((b) => b.onclick = () => speak(b.dataset.say === 'q' ? it.q : it.a));
    const answer = (ok) => { mark(s, it.c, ok); if (!ok) learn.push(it.c); i++; draw(); };
    $('#yes').onclick = () => answer(true);
    $('#no').onclick = () => answer(false);
    let x0 = null;
    card.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    card.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 70) answer(dx > 0);
    });
  };
  draw();
}

/* ---------- write ---------- */
function playWrite(s) {
  if (needCards(s, 1)) return;
  const queue = shuffle(s.cards).map((c) => ({ c, ...qa(c), retry: false }));
  const total = queue.length;
  const missed = [];
  let i = 0, right = 0, phase = 'ask', res = null, answer = '', aiState = null;

  const draw = () => {
    if (i >= queue.length) {
      const extra = missed.length ? `<div class="panel mistakes"><b>Над чем поработать</b>${missed.map((m) => `<div>${esc(m.q)} — <b>${esc(m.a)}</b></div>`).join('')}</div>` : '';
      return finishScreen(s, 'Письмо', `${right} / ${total}`, 'правильно с первой попытки', extra);
    }
    const it = queue[i];
    const done = queue.slice(0, i).filter((x) => !x.retry).length;
    let body = `${bar((done / total) * 100, 'accent')}
      <div class="qcard"><span class="badge">${it.retry ? 'Ещё раз' : it.side === 'term' ? 'Напиши значение' : 'Напиши термин'}</span><div class="q">${esc(it.q)}</div></div>`;
    if (phase === 'ask') {
      body += `<form class="answer" id="f"><input id="ans" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Твой ответ" enterkeyhint="done">
        <button class="btn primary">Проверить</button></form>
        <div class="center"><button class="link" id="idk">Не знаю</button></div>`;
    } else {
      body += verdictHTML(res, it.a, answer, aiState) + `<button class="btn primary wide mt" id="next">Дальше</button>`;
    }
    app.innerHTML = layout(s.title, body, { back: home(s) });

    if (phase === 'ask') {
      const input = $('#ans');
      input.focus();
      const submit = (val) => {
        answer = val.trim();
        res = Check.checkAnswer(answer, it.a);
        aiState = null;
        if (!it.retry) { mark(s, it.c, res.ok); if (res.ok) right++; }
        if (!res.ok) { if ((it.tries || 0) < 2) queue.push({ ...it, retry: true, tries: (it.tries || 0) + 1 }); if (!it.retry) missed.push(it); }
        phase = 'result'; draw();
      };
      $('#f').onsubmit = (e) => { e.preventDefault(); submit(input.value); };
      $('#idk').onclick = () => submit('');
    } else {
      const next = () => { i++; phase = 'ask'; draw(); };
      $('#next').onclick = next;
      $('#next').focus();
      const accept = (note) => {
        res = { ok: true, kind: 'override', note };
        if (!it.retry) { unmarkWrong(s, it.c); right++; missed.splice(missed.indexOf(it), 1); }
        const last = queue[queue.length - 1];
        if (last && last.retry && last.c === it.c) queue.pop();
        aiState = 'done'; draw();
      };
      if ($('#override')) $('#override').onclick = () => accept('Засчитано вручную');
      if ($('#askAI')) $('#askAI').onclick = async () => {
        aiState = 'loading'; draw();
        try {
          const j = await AI.judge({ question: it.q, expected: it.a, answer, card: it.c });
          if (j.correct) accept('✨ ИИ: ' + j.comment);
          else { res = { ...res, comment: j.comment }; aiState = 'done'; draw(); }
        } catch (e) { aiState = null; toast(e.message); draw(); }
      };
    }
  };
  draw();
}

/* ---------- test ---------- */
function playTest(s) {
  if (needCards(s, 2)) return;
  const qs = shuffle(s.cards).slice(0, 20).map((c) => {
    const x = qa(c);
    const key = x.side === 'term' ? 'def' : 'term';
    const seen = new Set([Check.norm(x.a)]);
    const others = [];
    for (const o of shuffle(s.cards)) {
      const v = o[key], n = Check.norm(v);
      if (o === c || seen.has(n)) continue;
      seen.add(n); others.push(v);
      if (others.length === 3) break;
    }
    return { c, ...x, opts: shuffle([x.a, ...others]) };
  });
  let i = 0, right = 0;
  const missed = [];
  const draw = () => {
    if (i >= qs.length) {
      const extra = missed.length ? `<div class="panel mistakes"><b>Ошибки</b>${missed.map((m) => `<div>${esc(m.q)} — <b>${esc(m.a)}</b></div>`).join('')}</div>` : '';
      return finishScreen(s, 'Тест', `${right} / ${qs.length}`, 'правильных ответов', extra);
    }
    const it = qs[i];
    app.innerHTML = layout(`Тест · ${i + 1} / ${qs.length}`, `
      ${bar((i / qs.length) * 100, 'accent')}
      <div class="qcard"><span class="badge">${it.side === 'term' ? 'Выбери значение' : 'Выбери термин'}</span><div class="q">${esc(it.q)}</div></div>
      <div class="options">${it.opts.map((o, k) => `<button class="btn opt" data-k="${k}">${esc(o)}</button>`).join('')}</div>
      <button class="btn primary wide mt hidden" id="next">Дальше</button>`, { back: home(s) });
    let answered = false;
    $$('.opt').forEach((b) => b.onclick = () => {
      if (answered) return;
      answered = true;
      const ok = it.opts[+b.dataset.k] === it.a;
      mark(s, it.c, ok);
      $$('.opt').forEach((x) => { if (it.opts[+x.dataset.k] === it.a) x.classList.add('right'); });
      if (ok) { right++; setTimeout(() => { i++; draw(); }, 700); }
      else { b.classList.add('wrong'); missed.push(it); $('#next').classList.remove('hidden'); $('#next').onclick = () => { i++; draw(); }; }
    });
  };
  draw();
}

/* ---------- match ---------- */
function playMatch(s) {
  if (needCards(s, 2)) return;
  const pick = shuffle(s.cards).slice(0, 6);
  const tiles = shuffle(pick.flatMap((c) => [{ id: c.id, t: c.term, k: 't' }, { id: c.id, t: c.def, k: 'd' }]));
  let sel = null, matched = 0, penalty = 0;
  const start = Date.now();
  app.innerHTML = layout('Подбор пар', `
    <div class="row" style="justify-content:space-between;align-items:center"><span class="muted small">Найди пары: термин + значение</span><span class="timer" id="timer">0.0 с</span></div>
    <div class="match-grid">${tiles.map((t, k) => `<button class="tile" data-k="${k}">${esc(t.t)}</button>`).join('')}</div>
    ${s.bestMatch ? `<p class="hint center">Рекорд: ${s.bestMatch.toFixed(1)} с</p>` : ''}`, { back: home(s) });
  const elapsed = () => (Date.now() - start + penalty) / 1000;
  const timer = setInterval(() => { const el = $('#timer'); if (el) el.textContent = elapsed().toFixed(1) + ' с'; }, 100);
  cleanup = () => clearInterval(timer);
  $$('.tile').forEach((b) => b.onclick = () => {
    const k = +b.dataset.k;
    if (sel === null) { sel = k; b.classList.add('sel'); return; }
    const a = $(`.tile[data-k="${sel}"]`);
    if (sel === k) { a.classList.remove('sel'); sel = null; return; }
    const t1 = tiles[sel], t2 = tiles[k];
    a.classList.remove('sel');
    if (t1.id === t2.id && t1.k !== t2.k) {
      a.classList.add('gone'); b.classList.add('gone'); matched++;
      if (matched === pick.length) {
        clearInterval(timer);
        const time = elapsed();
        const record = !s.bestMatch || time < s.bestMatch;
        if (record) { s.bestMatch = time; const cur = s.isFolder ? getFolder(s.id) : getSet(s.id); if (cur) cur.bestMatch = time; saveSets(); }
        setTimeout(() => finishScreen(s, 'Подбор пар', `${time.toFixed(1)} с`, record ? '🏆 Новый рекорд!' : `Рекорд: ${s.bestMatch.toFixed(1)} с`), 300);
      }
    } else {
      penalty += 1000;
      [a, b].forEach((x) => { x.classList.add('bad'); setTimeout(() => x.classList.remove('bad'), 400); });
      toast('+1 секунда');
    }
    sel = null;
  });
}

/* ---------- AI tasks ---------- */
function playAI(s) {
  if (needCards(s, 2)) return;
  if (!settings.apiKey) {
    app.innerHTML = layout('ИИ-задания', `<div class="empty"><div class="big">✨</div>
      <p>Чтобы ИИ придумывал задания под этот набор, добавь бесплатный ключ Gemini.<br>Это займёт пару минут.</p>
      <a class="btn primary" href="#/settings">Открыть настройки</a></div>`, { back: home(s) });
    return;
  }
  const typeName = { fill: 'Вставь пропущенное', translate: 'Переведи', choice: 'Выбери ответ' };
  let tasks = [], i = 0, right = 0, phase = 'setup', res = null, answer = '', error = '', count = 8, alive = true;
  const missed = [];
  cleanup = () => { alive = false; };

  const draw = () => {
    if (!alive) return;
    if (phase === 'setup') {
      app.innerHTML = layout('ИИ-задания', `
        <div class="panel"><b>Gemini составит упражнения по словам из «${esc(s.title)}»</b>
        <p class="hint">Предложения с пропусками, перевод фраз и вопросы на понимание. Чаще попадаются слова, которые тебе даются труднее.</p>
        <div class="field"><span>Сколько заданий</span><div class="seg">${[5, 8, 12].map((n) => `<button data-n="${n}" class="${n === count ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        ${error ? `<div class="verdict no small mt">${esc(error)}</div>` : ''}
        <button class="btn primary wide mt" id="gen">✨ Сгенерировать</button></div>`, { back: home(s) });
      $$('[data-n]').forEach((b) => b.onclick = () => { count = +b.dataset.n; draw(); });
      $('#gen').onclick = async () => {
        phase = 'loading'; draw();
        try { tasks = await AI.makeTasks(s, count); i = 0; right = 0; missed.length = 0; phase = 'ask'; error = ''; }
        catch (e) { error = e.message; phase = 'setup'; }
        draw();
      };
      return;
    }
    if (phase === 'loading') {
      app.innerHTML = layout('ИИ-задания', `<div class="spinner"></div><p class="center muted">Gemini придумывает задания…</p>`, { back: home(s) });
      return;
    }
    if (i >= tasks.length) {
      const extra = missed.length ? `<div class="panel mistakes"><b>Разбор ошибок</b>${missed.map((t) => `<div>${esc(t.question)}<br><b>${esc(t.answer)}</b>${t.explanation ? `<div class="small muted">${esc(t.explanation)}</div>` : ''}</div>`).join('')}</div>` : '';
      finishScreen(s, 'ИИ-задания', `${right} / ${tasks.length}`, 'правильно', extra, { label: '✨ Новые задания', fn: () => { phase = 'setup'; draw(); } });
      $('#again').classList.add('hidden');
      return;
    }
    const t = tasks[i];
    let body = `${bar((i / tasks.length) * 100, 'accent')}
      <div class="qcard"><span class="badge">${typeName[t.type]}</span><div class="q">${esc(t.question)}</div>
      ${t.hint ? `<details class="small muted mt"><summary>Подсказка</summary>${esc(t.hint)}</details>` : ''}</div>`;
    if (phase === 'ask') {
      body += t.type === 'choice'
        ? `<div class="options">${t.options.map((o, k) => `<button class="btn opt" data-k="${k}">${esc(o)}</button>`).join('')}</div>`
        : `<form class="answer" id="f"><input id="ans" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Твой ответ" enterkeyhint="done"><button class="btn primary">Проверить</button></form>
           <div class="center"><button class="link" id="idk">Не знаю</button></div>`;
    } else if (phase === 'checking') {
      body += `<div class="verdict ai">✨ ИИ проверяет перевод…</div>`;
    } else {
      body += verdictHTML(res, t.answer, t.type === 'choice' ? '' : answer, 'done')
        + (t.explanation ? `<div class="hint">${esc(t.explanation)}</div>` : '')
        + `<button class="btn primary wide mt" id="next">Дальше</button>`;
    }
    app.innerHTML = layout(`ИИ · ${i + 1} / ${tasks.length}`, body, { back: home(s) });

    const finish = (r) => { res = r; if (r.ok) right++; else missed.push(t); phase = 'result'; draw(); };
    if (phase === 'ask' && t.type === 'choice') {
      $$('.opt').forEach((b) => b.onclick = () => finish({ ok: t.options[+b.dataset.k] === t.answer, kind: 'exact' }));
    } else if (phase === 'ask') {
      const input = $('#ans');
      input.focus();
      const submit = async (val) => {
        answer = val.trim();
        const local = Check.checkAnswer(answer, t.answer);
        if (local.ok || !answer) return finish(local);
        phase = 'checking'; draw();
        try {
          const j = await AI.judge({ question: t.question, expected: t.answer, answer });
          if (alive) finish(j.correct ? { ok: true, kind: 'ai', note: '✨ ' + j.comment } : { ok: false, kind: 'wrong', comment: j.comment });
        } catch (e) { toast(e.message); if (alive) finish(local); }
      };
      $('#f').onsubmit = (e) => { e.preventDefault(); submit(input.value); };
      $('#idk').onclick = () => submit('');
    } else if (phase === 'result') {
      $('#next').onclick = () => { i++; phase = 'ask'; draw(); };
      $('#next').focus();
    }
  };
  draw();
}

/* ---------- start ---------- */
route();
scheduleSync(300);
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

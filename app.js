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
const saveSets = () => localStorage.setItem(SETS_KEY, JSON.stringify(sets));
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
const getSet = (id) => sets.find((s) => s.id === id);
const newCard = (term = '', def = '') => ({ id: uid(), term, def, streak: 0, right: 0, wrong: 0 });

if (!Array.isArray(sets)) {
  sets = [{
    id: uid(), title: 'Пример: спорт', created: Date.now(), updated: Date.now(),
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

const status = (c) => ((c.streak || 0) >= 2 ? 'known' : (c.right || c.wrong) ? 'learning' : 'new');
const knownCount = (s) => s.cards.filter((c) => status(c) === 'known').length;

function mark(set, card, ok) {
  const c = set.cards.find((x) => x.id === card.id);
  if (!c) return;
  c.prevStreak = c.streak || 0;
  if (ok) { c.right = (c.right || 0) + 1; c.streak = (c.streak || 0) + 1; }
  else { c.wrong = (c.wrong || 0) + 1; c.streak = 0; }
  saveSets();
}
function unmarkWrong(set, card) {
  const c = set.cards.find((x) => x.id === card.id);
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
  if (p[0] === 'set' && p[1]) {
    const s = getSet(p[1]);
    if (!s) return go('#/');
    if (p[2] === 'edit') return viewEdit(s);
    if (p[2] === 'import') return viewImport(s);
    if (p[2] === 'play') {
      const modes = { flash: playFlash, write: playWrite, test: playTest, match: playMatch, ai: playAI };
      if (modes[p[3]]) return modes[p[3]](s);
    }
    return viewSet(s);
  }
  viewHome();
}
window.addEventListener('hashchange', route);

/* ---------- home ---------- */
function viewHome() {
  const list = sets.length
    ? [...sets].sort((a, b) => (b.updated || 0) - (a.updated || 0)).map((s) => {
        const k = knownCount(s);
        return `<a class="set-item" href="#/set/${s.id}"><div class="set-title">${esc(s.title)}</div><div class="muted small">${cardsWord(s.cards.length)} · выучено ${k}</div>${bar(s.cards.length ? (k / s.cards.length) * 100 : 0)}</a>`;
      }).join('')
    : `<div class="empty"><div class="big">🗂️</div><p>Пока нет ни одного набора.<br>Создай свой или импортируй из Quizlet.</p></div>`;
  const aiNote = settings.apiKey ? '' : `<a class="set-item" href="#/settings" style="background:var(--accent-soft)"><b>✨ Подключи ИИ бесплатно</b><div class="small muted">Вставь ключ Gemini — и приложение будет само придумывать задания и понимать ответы по смыслу.</div></a>`;
  app.innerHTML = layout('Мои наборы', `
    <div class="row"><a class="btn primary" href="#/new">＋ Новый набор</a><a class="btn" href="#/import">⇩ Из Quizlet</a></div>
    ${aiNote}${list}`, { actions: `<a class="icon-btn" href="#/settings" aria-label="Настройки">⚙︎</a>` });
}

/* ---------- set ---------- */
function viewSet(s) {
  const k = knownCount(s);
  const dirBtn = (v, label) => `<button data-dir="${v}" class="${settings.direction === v ? 'on' : ''}">${label}</button>`;
  const rows = s.cards.map((c) => `<div class="card-row"><div>${esc(c.term)}</div><div class="muted">${esc(c.def)}</div><div class="dot ${status(c)}" title="${status(c) === 'known' ? 'выучено' : status(c) === 'learning' ? 'учу' : 'новое'}"></div></div>`).join('');
  app.innerHTML = layout(s.title, `
    <div class="muted small">${cardsWord(s.cards.length)} · выучено ${k}</div>
    ${bar(s.cards.length ? (k / s.cards.length) * 100 : 0)}
    <div class="modes">
      <a class="mode" href="#/set/${s.id}/play/flash"><span class="ico">🃏</span>Карточки<small>Переворачивай и запоминай</small></a>
      <a class="mode" href="#/set/${s.id}/play/write"><span class="ico">✍️</span>Письмо<small>Пиши ответ сам</small></a>
      <a class="mode" href="#/set/${s.id}/play/test"><span class="ico">✅</span>Тест<small>Выбери вариант</small></a>
      <a class="mode" href="#/set/${s.id}/play/match"><span class="ico">🧩</span>Подбор пар<small>На скорость</small></a>
      <a class="mode ai" href="#/set/${s.id}/play/ai"><span class="ico">✨</span>ИИ-задания<small>Gemini придумает упражнения именно под этот набор</small></a>
    </div>
    <div class="field"><span>Что спрашивать</span>
      <div class="seg">${dirBtn('term', 'Термин → значение')}${dirBtn('def', 'Значение → термин')}${dirBtn('mix', 'Вперемешку')}</div>
    </div>
    <div class="panel mt">${rows || '<div class="muted">В наборе нет карточек</div>'}</div>
    <div class="stack mt">
      <a class="btn" href="#/set/${s.id}/import">⇩ Добавить карточки из текста</a>
      <button class="btn" id="export">⧉ Скопировать как текст</button>
      <button class="btn" id="reset">↺ Сбросить прогресс</button>
      <button class="btn bad" id="del">Удалить набор</button>
    </div>`, { back: '#/', actions: `<a class="icon-btn" href="#/set/${s.id}/edit" aria-label="Редактировать">✎</a>` });

  $$('[data-dir]').forEach((b) => b.onclick = () => {
    settings.direction = b.dataset.dir; saveSettings();
    $$('[data-dir]').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#export').onclick = async () => {
    const text = s.cards.map((c) => `${c.term}\t${c.def}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Скопировано'); } catch { prompt('Скопируй текст:', text); }
  };
  $('#reset').onclick = () => {
    if (!confirm('Сбросить прогресс по этому набору?')) return;
    s.cards.forEach((c) => { c.streak = 0; c.right = 0; c.wrong = 0; });
    saveSets(); route();
  };
  $('#del').onclick = () => {
    if (!confirm(`Удалить набор «${s.title}»?`)) return;
    sets = sets.filter((x) => x.id !== s.id); saveSets(); go('#/');
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
      if (existing) Object.assign(existing, draft); else sets.push(draft);
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
      target.cards.push(...parsed.cards); target.updated = Date.now();
      saveSets(); toast(`Добавлено: ${cardsWord(parsed.cards.length)}`); go(`#/set/${target.id}`);
    } else {
      const s = { id: uid(), title: $('#title').value.trim() || 'Импорт из Quizlet', created: Date.now(), updated: Date.now(), cards: parsed.cards };
      sets.push(s); saveSets(); toast('Набор импортирован'); go(`#/set/${s.id}`);
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
    <div class="panel mt">
      <b>💾 Резервная копия</b>
      <p class="hint">Все наборы хранятся только на этом устройстве. Если очистить данные браузера, они пропадут — время от времени сохраняй копию.</p>
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
    const json = JSON.stringify({ app: 'kartochki', version: 1, sets }, null, 2);
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
      let added = 0;
      for (const s of incoming) {
        if (!s || !Array.isArray(s.cards)) continue;
        const i = sets.findIndex((x) => x.id === s.id);
        if (i >= 0) sets[i] = s; else sets.push(s);
        added++;
      }
      saveSets(); toast(`Восстановлено наборов: ${added}`); go('#/');
    } catch { toast('Не удалось прочитать файл'); }
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
      <a class="btn" href="#/set/${s.id}">К набору</a>
    </div>`, { back: `#/set/${s.id}` });
  if (retry) $('#retry').onclick = retry.fn;
  $('#again').onclick = () => route();
}
const needCards = (s, n) => {
  if (s.cards.length >= n) return false;
  app.innerHTML = layout(s.title, `<div class="empty"><div class="big">🃏</div><p>Для этого режима нужно хотя бы ${cardsWord(n)}.</p><a class="btn primary" href="#/set/${s.id}/edit">Добавить карточки</a></div>`, { back: `#/set/${s.id}` });
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
    { back: `#/set/${s.id}` });
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
    app.innerHTML = layout(s.title, body, { back: `#/set/${s.id}` });

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
      <button class="btn primary wide mt hidden" id="next">Дальше</button>`, { back: `#/set/${s.id}` });
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
    ${s.bestMatch ? `<p class="hint center">Рекорд: ${s.bestMatch.toFixed(1)} с</p>` : ''}`, { back: `#/set/${s.id}` });
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
        if (record) { s.bestMatch = time; saveSets(); }
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
      <a class="btn primary" href="#/settings">Открыть настройки</a></div>`, { back: `#/set/${s.id}` });
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
        <button class="btn primary wide mt" id="gen">✨ Сгенерировать</button></div>`, { back: `#/set/${s.id}` });
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
      app.innerHTML = layout('ИИ-задания', `<div class="spinner"></div><p class="center muted">Gemini придумывает задания…</p>`, { back: `#/set/${s.id}` });
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
    app.innerHTML = layout(`ИИ · ${i + 1} / ${tasks.length}`, body, { back: `#/set/${s.id}` });

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
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

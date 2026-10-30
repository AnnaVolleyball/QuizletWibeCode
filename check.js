// Умная проверка ответов (настроена на пару английский ↔ русский).
// Правила:
//  - регистр, знаки препинания, лишние пробелы и «ё/е» не важны;
//  - варианты ответа: «a / b», «a; b», «a | b», короткие списки через запятую;
//  - слэш внутри фразы: «играть/поиграть в мяч» → оба варианта;
//  - скобки — необязательная часть: «(по)играть в мяч» → «играть в мяч» и «поиграть в мяч»;
//  - артикли a/an/the и «to» в начале можно не писать;
//  - сокращения равны полной форме: don't = do not, I'm = I am;
//  - британское и американское написание равны: colour = color, realise = realize, centre = center;
//  - пометки sb/sth/smb, кого-л./что-л. можно не писать;
//  - глаголы, отличающиеся только приставкой вида (играть/поиграть, делать/сделать, писать/написать), равны;
//  - прощаются мелкие опечатки и другой порядок слов.
const Check = (() => {
  const ARTICLES = new Set(['a', 'an', 'the']);
  const ASPECT_PREFIXES = ['по', 'с', 'на'];
  const isVerb = (w) => /(ть|ться|ти|тись|чь|чься)$/.test(w);

  const CONTRACTIONS = [
    [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/\bwon't\b/g, 'will not'], [/\bshan't\b/g, 'shall not'],
    [/\bain't\b/g, 'am not'], [/n't\b/g, ' not'], [/'re\b/g, ' are'], [/'ve\b/g, ' have'], [/'ll\b/g, ' will'],
    [/'d\b/g, ' would'], [/\bi'm\b/g, 'i am'], [/\blet's\b/g, 'let us'],
    [/\b(it|he|she|that|there|what|who|where|here|how)'s\b/g, '$1 is'],
  ];
  const PLACEHOLDERS_EN = /\b(sb|sth|smb|smth|smbd|someone|somebody|something|one's|oneself|sb's|smb's)\b\.?/g;
  const PLACEHOLDERS_RU = /(?<!\p{L})(кто|кого|что|кому|чему|кем|чем|ком|чём|чего|чей|чья|чье|чьё|чьи|где|куда|какой)[\s-]?(л|либо|нибудь|то)(?!\p{L})\.?/gu;

  function norm(s) {
    let t = String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[’‘`´ʼ]/g, "'");
    t = t.replace(PLACEHOLDERS_EN, ' ').replace(PLACEHOLDERS_RU, ' ');
    for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
    return t
      .replace(/'/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Британское → американское написание
  function spelling(w) {
    if (!/^[a-z]+$/.test(w) || w.length < 5) return w;
    if (w.length >= 6) {
      w = w.replace(/our(s|ed|ing|ite|ites|able|ful)?$/, 'or$1');
      w = w.replace(/([^aeiou])is(e|es|ed|ing|ation|ations)$/, '$1iz$2');
      w = w.replace(/ys(e|es|ed|ing)$/, 'yz$1');
    }
    w = w.replace(/([^aeiou])tre(s)?$/, '$1ter$2');
    w = w.replace(/([aeiou])ll(ed|ing|er|ers)$/, '$1l$2');
    w = w.replace(/ogue$/, 'og');
    return w;
  }

  function words(s) {
    let w = norm(s).split(' ').filter(Boolean).map(spelling);
    const noArticles = w.filter((x) => !ARTICLES.has(x));
    if (noArticles.length) w = noArticles;
    if (w[0] === 'to' && w.length > 1) w = w.slice(1);
    return w;
  }

  function expandParens(s, depth = 0) {
    const m = s.match(/\(([^()]*)\)/);
    if (!m || depth > 5) return [s.replace(/[()]/g, ' ')];
    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length);
    return [
      ...expandParens(before + m[1] + after, depth + 1),
      ...expandParens(before + ' ' + after, depth + 1),
    ].slice(0, 32);
  }

  function expandSlash(s) {
    let res = [[]];
    for (const t of s.split(/\s+/).filter(Boolean)) {
      const opts = t.includes('/') ? t.split('/').filter(Boolean) : [t];
      res = res.flatMap((r) => opts.map((o) => [...r, o])).slice(0, 64);
    }
    return res.map((r) => r.join(' '));
  }

  function alternatives(expected) {
    let parts = String(expected ?? '')
      .replace(/\[/g, '(').replace(/\]/g, ')')
      .split(/\s+\/\s+|;|\||\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    parts = parts.flatMap((p) => {
      const c = p.split(',').map((s) => s.trim()).filter(Boolean);
      const short = c.every((x) => x.split(/\s+/).length <= 3);
      return c.length > 1 && short ? [p, ...c] : [p];
    });
    const out = new Set();
    for (const p of parts)
      for (const q of expandParens(p))
        for (const r of expandSlash(q)) {
          const w = words(r);
          if (w.length) out.add(w.join(' '));
        }
    return [...out];
  }

  // 0 — одинаковые, 1 — отличаются приставкой вида, -1 — разные
  function sameWord(a, b) {
    if (a === b) return 0;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!isVerb(y) || y.length < 4) continue;
      for (const p of ASPECT_PREFIXES) {
        if (x === p + y) return 1;
        if (p === 'с' && y[0] === 'и' && x === 'сы' + y.slice(1)) return 1; // играть → сыграть
      }
    }
    return -1;
  }

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  const allowedTypos = (len) => (len <= 4 ? 0 : len <= 9 ? 1 : 2);

  function checkAnswer(answer, expected) {
    const ans = words(answer);
    if (!ans.length) return { ok: false, kind: 'empty' };
    const a = ans.join(' ');
    const alts = alternatives(expected);
    if (!alts.length) return { ok: false, kind: 'wrong' };

    if (alts.includes(a)) return { ok: true, kind: 'exact' };

    for (const e of alts) {
      const ew = e.split(' ');
      if (ew.length !== ans.length) continue;
      let ok = true, aspect = false;
      for (let i = 0; i < ew.length; i++) {
        const r = sameWord(ans[i], ew[i]);
        if (r < 0) { ok = false; break; }
        if (r > 0) aspect = true;
      }
      if (ok && aspect) return { ok: true, kind: 'aspect', note: 'Засчитано: другой вид глагола (как играть / поиграть)' };
    }

    const sorted = (s) => s.split(' ').sort().join(' ');
    for (const e of alts) {
      if (e.includes(' ') && sorted(e) === sorted(a)) return { ok: true, kind: 'order', note: 'Засчитано: другой порядок слов' };
    }

    for (const e of alts) {
      if (lev(a, e) <= allowedTypos(e.length)) return { ok: true, kind: 'typo', note: 'Засчитано с опечаткой' };
    }

    return { ok: false, kind: 'wrong' };
  }

  return { checkAnswer, alternatives, norm };
})();

if (typeof module !== 'undefined') module.exports = Check;

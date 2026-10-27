// Markdown сообщений агента → HTML. Без внешних библиотек: стенд работает в закрытом контуре.
// Безопасность: весь текст экранируется, теги порождает только этот модуль — HTML из сообщения виден как текст.
// Ссылки — только http(s) и mailto, открываются в новой вкладке; картинки не загружаются, вместо них ссылка.
// Перевод строки внутри абзаца сохраняется, как в чатах и комментариях GitHub.
// Поддержано: абзацы, заголовки, списки с вложенностью и задачами, цитаты, блоки кода, таблицы, разделитель,
// жирный, курсив, зачёркнутый, код в строке, ссылки и автоссылки. Не поддержано: HTML, сноски, ссылки-определения.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Глубже остаток показывается текстом: вложенность из тысяч «>» не обрушит страницу. */
const MAX_DEPTH = 12;

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
const AUTOLINK = /<((?:https?|mailto):[^\s<>]*)>/iy;
const BARE = /(?:https?:\/\/|www\.)[\p{L}\p{N}][^\s<]*/iuy;
const BARE_BEFORE = /[\s*_~(«"'„“[]/u;

export function markdown(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD').replace(/\t/g, '    ');
  return blocks(src.split('\n'));
}

// ----------------------------------------------------------------- блоки

function indentOf(line) {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
}

function dedent(line, n) {
  let k = 0;
  while (k < n && line[k] === ' ') k++;
  return line.slice(k);
}

function fenceOpen(line) {
  const m = FENCE.exec(line);
  if (!m || (m[2][0] === '`' && m[3].includes('`'))) return null;
  return { indent: m[1].length, fence: m[2] };
}

function closesFence(line, fence) {
  if (indentOf(line) > 3) return false;
  const t = line.trim();
  let n = 0;
  while (t[n] === fence[0]) n++;
  return n >= fence.length && n === t.length;
}

function heading(line) {
  const m = ATX.exec(line);
  if (!m) return null;
  let t = line.slice(m[0].length).trim();
  // Закрывающие «#» отбрасываются, если перед ними пробел.
  let e = t.length;
  while (e > 0 && t[e - 1] === '#') e--;
  if (e === 0) t = '';
  else if (e < t.length && t[e - 1] === ' ') t = t.slice(0, e).trimEnd();
  return { level: m[1].length, text: t };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Строка-разделитель таблицы: выравнивание столбцов или null. */
function aligns(line) {
  if (!/^[ \t|:-]+$/.test(line) || !line.includes('|') || !line.includes('-')) return null;
  const cells = splitRow(line);
  if (!cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'c' : 'r') : ''));
}

function tableAt(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes('|')) return null;
  const al = aligns(lines[i + 1]);
  if (!al) return null;
  const head = splitRow(lines[i]);
  return head.length === al.length ? { head, al } : null;
}

const interrupts = (line) => !!(fenceOpen(line) || heading(line) || HR.test(line) || QUOTE.test(line));

/** Начинает ли строка новый блок внутри абзаца. */
function startsBlock(lines, i) {
  const line = lines[i];
  if (interrupts(line)) return true;
  const m = ITEM.exec(line);
  // Абзац прерывает непустой пункт; нумерованный — только с 1, иначе «2026. год» посреди текста стал бы списком.
  if (m && m[4]?.trim() && (!/\d/.test(m[2]) || parseInt(m[2], 10) === 1)) return true;
  return !!tableAt(lines, i);
}

function blocks(lines, tight = false, depth = 0) {
  if (depth > MAX_DEPTH) {
    const text = lines.map((l) => l.trim()).filter(Boolean).join('\n');
    return text ? `<p>${inline(text)}</p>` : '';
  }
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const f = fenceOpen(line);
    if (f) {
      const code = [];
      for (i++; i < lines.length && !closesFence(lines[i], f.fence); i++) code.push(dedent(lines[i], f.indent));
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (indentOf(line) >= 4) {
      const code = [];
      for (; i < lines.length && (!lines[i].trim() || indentOf(lines[i]) >= 4); i++) code.push(dedent(lines[i], 4));
      while (!code[code.length - 1].trim()) code.pop();
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = heading(line);
    if (h) {
      out.push(`<h${h.level}>${inline(h.text)}</h${h.level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length; i++) {
        if (QUOTE.test(lines[i])) inner.push(lines[i].replace(QUOTE, ''));
        // Ленивое продолжение: строка без «>» продолжает абзац цитаты.
        else if (lines[i].trim() && inner[inner.length - 1].trim() && !startsBlock(lines, i)) inner.push(lines[i]);
        else break;
      }
      out.push(`<blockquote>${blocks(inner, false, depth + 1)}</blockquote>`);
      continue;
    }
    if (ITEM.test(line)) {
      const l = list(lines, i, depth);
      out.push(l.html);
      i = l.end;
      continue;
    }
    const t = tableAt(lines, i);
    if (t) {
      const r = table(lines, i, t);
      out.push(r.html);
      i = r.end;
      continue;
    }
    // Абзац; подчёркивание из «=» или «-» делает его заголовком.
    const para = [line.trim()];
    let level = 0;
    for (i++; i < lines.length && lines[i].trim(); i++) {
      const s = SETEXT.exec(lines[i]);
      if (s) {
        level = s[1][0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (startsBlock(lines, i)) break;
      para.push(lines[i].trim());
    }
    const text = inline(para.join('\n'));
    out.push(level ? `<h${level}>${text}</h${level}>` : tight ? text : `<p>${text}</p>`);
  }
  return out.join('');
}

/** Список с вложенными блоками. Пустые строки между пунктами или внутри пункта делают его «свободным»: абзацы в <p>. */
function list(lines, i, depth) {
  const first = ITEM.exec(lines[i]);
  const ordered = /\d/.test(first[2]);
  const kind = first[2].slice(-1);
  const sibling = (line) => {
    if (HR.test(line)) return false;
    const m = ITEM.exec(line);
    return !!m && /\d/.test(m[2]) === ordered && m[2].slice(-1) === kind;
  };
  const items = [];
  let loose = false;
  for (;;) {
    const m = ITEM.exec(lines[i]);
    const w = m[1].length + m[2].length + (m[4] ? Math.min(m[3].length, 4) : 1);
    const body = [m[4] ?? ''];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length || indentOf(lines[j]) < w) break;
        for (; i < j; i++) body.push('');
        loose = true;
        continue;
      }
      if (indentOf(line) >= w) body.push(line.slice(w));
      // Ленивое продолжение: строка без отступа продолжает абзац пункта.
      else if (body[body.length - 1].trim() && !startsBlock(lines, i) && !ITEM.test(line)) body.push(line.trim());
      else break;
      i++;
    }
    items.push(body);
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length || !sibling(lines[j])) break;
    if (j > i) loose = true;
    i = j;
  }
  const tag = ordered ? 'ol' : 'ul';
  const n = parseInt(first[2], 10);
  const attrs = `${ordered && n !== 1 ? ` start="${n}"` : ''}${loose ? ' class="loose"' : ''}`;
  const lis = items.map((body) => {
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]);
    if (!task) return `<li>${blocks(body, !loose, depth + 1)}</li>`;
    body[0] = body[0].slice(task[0].length);
    return `<li class="task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}>${blocks(body, !loose, depth + 1)}</li>`;
  });
  return { html: `<${tag}${attrs}>${lis.join('')}</${tag}>`, end: i };
}

/** Таблица GFM: строка заголовков, разделитель с выравниванием, строки до пустой строки или нового блока. */
function table(lines, i, { head, al }) {
  const cell = (tag, text, a) => `<${tag}${a ? ` class="al-${a}"` : ''}>${inline(text)}</${tag}>`;
  const rows = [];
  for (i += 2; i < lines.length && lines[i].trim() && !interrupts(lines[i]) && !ITEM.test(lines[i]); i++) {
    const cells = splitRow(lines[i]);
    rows.push(`<tr>${al.map((a, k) => cell('td', cells[k] ?? '', a)).join('')}</tr>`);
  }
  const thead = `<thead><tr>${head.map((c, k) => cell('th', c, al[k])).join('')}</tr></thead>`;
  return { html: `<div><table>${thead}${rows.length ? `<tbody>${rows.join('')}</tbody>` : ''}</table></div>`, end: i };
}

// ----------------------------------------------------------------- строка

function runLength(s, i, ch) {
  let n = 0;
  while (s[i + n] === ch) n++;
  return n;
}

function codeSpan(s, i) {
  const n = runLength(s, i, '`');
  for (let k = s.indexOf('`', i + n); k >= 0; ) {
    const m = runLength(s, k, '`');
    if (m === n) {
      let code = s.slice(i + n, k).replace(/\n/g, ' ');
      if (code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
      return { html: `<code>${esc(code)}</code>`, end: k + m };
    }
    k = s.indexOf('`', k + m);
  }
  return null;
}

const unescape = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const skipSpace = (s, k) => {
  while (s[k] === ' ' || s[k] === '\n') k++;
  return k;
};

/** Ссылка [текст](адрес "заголовок") с позиции «[»: текст, адрес, заголовок и конец или null. Длина ссылки ограничена. */
function linkAt(s, i) {
  let limit = Math.min(s.length, i + 1000);
  let depth = 0;
  let j = i;
  for (; j < limit; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '`') {
      const code = codeSpan(s, j);
      j = code ? code.end - 1 : j + runLength(s, j, '`') - 1;
    } else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (j >= limit || s[j + 1] !== '(') return null;
  limit = Math.min(s.length, j + 2048);
  let k = skipSpace(s, j + 2);
  let href;
  if (s[k] === '<') {
    const e = s.indexOf('>', k);
    if (e < 0 || e >= limit) return null;
    href = s.slice(k + 1, e);
    if (/[\n<]/.test(href)) return null;
    k = e + 1;
  } else {
    const st = k;
    let par = 0;
    for (; k < limit; k++) {
      const c = s[k];
      if (c === '\\') k++;
      else if (c === ' ' || c === '\n') break;
      else if (c === '(') par++;
      else if (c === ')') {
        if (!par) break;
        par--;
      }
    }
    href = s.slice(st, k);
  }
  k = skipSpace(s, k);
  let title = '';
  const q = s[k];
  if (q === '"' || q === "'" || q === '(') {
    const e = s.indexOf(q === '(' ? ')' : q, k + 1);
    if (e < 0 || e >= limit) return null;
    title = s.slice(k + 1, e);
    k = skipSpace(s, e + 1);
  }
  if (s[k] !== ')') return null;
  return { text: s.slice(i + 1, j), href: unescape(href), title: unescape(title), end: k + 1 };
}

const safeUrl = (u) => (/^(?:https?:\/\/|mailto:)\S+$/i.test(u.trim()) ? u.trim() : null);
const anchor = (url, body, title = '') => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title || url)}">${body}</a>`;

function link(l) {
  const url = safeUrl(l.href);
  const body = inline(l.text, true);
  return url ? anchor(url, body, l.title) : body;
}

function image(l) {
  const url = safeUrl(l.href);
  const label = `изображение${l.text ? `: ${esc(l.text)}` : ''}`;
  return url ? anchor(url, label, `Картинка в стенде не загружается, откроется по ссылке: ${url}`) : `[${label}]`;
}

/** Хвостовая пунктуация не входит в автоссылку; закрывающая скобка — только парная. */
function trimUrl(u) {
  const count = (ch) => u.split(ch).length - 1;
  for (;;) {
    const c = u[u.length - 1];
    if ('?!.,:;*_~\'"»”’…'.includes(c)) u = u.slice(0, -1);
    else if (c === ')' && count(')') > count('(')) u = u.slice(0, -1);
    else return u;
  }
}

/** Строчная разметка. inLink — внутри текста ссылки: вложенные ссылки не создаются. */
function inline(s, inLink = false) {
  const nodes = [];
  let text = '';
  const flush = () => {
    if (text) nodes.push({ t: 'text', v: text });
    text = '';
  };
  const put = (v) => {
    flush();
    nodes.push({ t: 'html', v });
  };
  // Ссылка невозможна правее последнего «](»: тысячи «[» без ссылок не разбираются по одной.
  const linkMid = inLink ? -1 : s.lastIndexOf('](');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && (ASCII_PUNCT.includes(s[i + 1]) || s[i + 1] === '\n')) {
      if (s[i + 1] !== '\n') text += s[i + 1];
      i += s[i + 1] === '\n' ? 1 : 2;
      continue;
    }
    if (c === '\n') {
      put('<br>');
      i++;
      continue;
    }
    if (c === '`') {
      const code = codeSpan(s, i);
      if (code) {
        put(code.html);
        i = code.end;
        continue;
      }
      const n = runLength(s, i, '`');
      text += s.slice(i, i + n);
      i += n;
      continue;
    }
    if (!inLink) {
      if (c === '<') {
        AUTOLINK.lastIndex = i;
        const m = AUTOLINK.exec(s);
        if (m) {
          put(anchor(m[1], esc(m[1])));
          i = AUTOLINK.lastIndex;
          continue;
        }
      }
      if ((c === '[' || (c === '!' && s[i + 1] === '[')) && i < linkMid) {
        const l = linkAt(s, c === '!' ? i + 1 : i);
        if (l) {
          put(c === '!' ? image(l) : link(l));
          i = l.end;
          continue;
        }
      }
      if ((c === 'h' || c === 'H' || c === 'w' || c === 'W') && (i === 0 || BARE_BEFORE.test(s[i - 1]))) {
        BARE.lastIndex = i;
        const m = BARE.exec(s);
        if (m) {
          const url = trimUrl(m[0]);
          put(anchor(/^www\./i.test(url) ? `http://${url}` : url, esc(url)));
          i += url.length;
          continue;
        }
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      // Правила CommonMark: открывать может серия перед текстом, закрывать — после; «_» внутри слова не размечает,
      // поэтому get_close_with_answer остаётся именем инструмента. Зачёркивание — только «~~».
      const n = runLength(s, i, c);
      const before = i > 0 ? s[i - 1] : ' ';
      const after = i + n < s.length ? s[i + n] : ' ';
      const left = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before));
      const right = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after));
      let open = left;
      let close = right;
      if (c === '_') {
        open = left && (!right || PUNCT.test(before));
        close = right && (!left || PUNCT.test(after));
      }
      if (c === '~' && n !== 2) open = close = false;
      flush();
      nodes.push({ t: 'delim', ch: c, n, orig: n, open, close });
      i += n;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  emphasis(nodes);
  return nodes.map(render).join('');
}

/** Разделитель: закрытые им теги, оставшиеся символы, открытые теги — внутренняя пара ближе к тексту. */
function render(n) {
  if (n.t === 'text') return esc(n.v);
  if (n.t === 'html') return n.v;
  return `${n.closes.map((t) => `</${t}>`).join('')}${n.ch.repeat(n.n)}${n.opens.map((t) => `<${t}>`).reverse().join('')}`;
}

/**
 * Пары разделителей по алгоритму CommonMark: для закрывающего — ближайший подходящий открывающий слева, правило трёх.
 * Стек разделителей — двусвязный список, нижняя граница поиска запоминается (openers_bottom): разбор линейный.
 */
function emphasis(nodes) {
  let last = null;
  for (const d of nodes) {
    if (d.t !== 'delim') continue;
    Object.assign(d, { opens: [], closes: [], prev: last, next: null, gone: false });
    if (last) last.next = d;
    last = d;
  }
  const unlink = (d) => {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    d.gone = true;
  };
  const bottom = new Map();
  for (const closer of nodes) {
    if (closer.t !== 'delim' || closer.gone || !closer.close) continue;
    while (closer.n > 0) {
      const key = `${closer.ch}${closer.open ? 1 : 0}${closer.orig % 3}`;
      const stop = bottom.get(key) ?? null;
      let o = closer.prev;
      for (; o && o !== stop; o = o.prev) {
        if (o.ch !== closer.ch || !o.open) continue;
        if (closer.ch === '~' ? o.n !== closer.n : (o.close || closer.open) && (o.orig + closer.orig) % 3 === 0 && (o.orig % 3 !== 0 || closer.orig % 3 !== 0)) continue;
        break;
      }
      if (!o || o === stop) {
        bottom.set(key, closer.prev);
        if (!closer.open) unlink(closer);
        break;
      }
      const use = closer.ch === '~' ? 2 : o.n >= 2 && closer.n >= 2 ? 2 : 1;
      const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      o.opens.push(tag);
      closer.closes.push(tag);
      o.n -= use;
      closer.n -= use;
      // Разделители внутри пары остаются текстом.
      for (let d = o.next; d && d !== closer; d = d.next) d.gone = true;
      o.next = closer;
      closer.prev = o;
      if (o.n === 0) unlink(o);
      if (closer.n === 0) unlink(closer);
    }
  }
}

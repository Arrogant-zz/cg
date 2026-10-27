// Markdown сообщений агента (web/js/md.js): разметка, экранирование HTML, допустимые ссылки, устойчивость; пузырь в ленте.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Модули интерфейса без DOM на верхнем уровне — загружаются как есть, без сборки.
const web = (file: string) => import(pathToFileURL(path.resolve('web/js', file)).href);
const { markdown } = (await web('md.js')) as { markdown: (text: string) => string };
const lib = await web('lib.js');

const p = (s: string) => `<p>${s}</p>`;

test('Markdown: блоки — заголовки, списки, цитаты, код, таблица; перевод строки внутри абзаца сохраняется', () => {
  assert.equal(markdown('Первая строка.\nВторая.\n\nНовый абзац.'), '<p>Первая строка.<br>Вторая.</p><p>Новый абзац.</p>');
  assert.equal(markdown('# Итог\n## Шаги ##\n#хэштег\nТекст\n---'), '<h1>Итог</h1><h2>Шаги</h2><h2>#хэштег<br>Текст</h2>');
  // Ход fake-agent: проверки списком, ответ клиенту выделен.
  assert.equal(
    markdown('Проверил:\n- `get_card_history` выполнен\n\n**Ответ клиенту:** «Сумма заблокирована»\n\nМожно закрывать обращение?'),
    '<p>Проверил:</p><ul><li><code>get_card_history</code> выполнен</li></ul><p><strong>Ответ клиенту:</strong> «Сумма заблокирована»</p><p>Можно закрывать обращение?</p>',
  );
  assert.equal(markdown('1. **Шаг**\n   - деталь\n2. Второй'), '<ol><li><strong>Шаг</strong><ul><li>деталь</li></ul></li><li>Второй</li></ol>');
  assert.equal(markdown('3. три\n\n4. четыре'), '<ol start="3" class="loose"><li><p>три</p></li><li><p>четыре</p></li></ol>', 'пустая строка между пунктами — абзацы');
  assert.equal(markdown('- [ ] сделать\n- [x] готово'), '<ul><li class="task"><input type="checkbox" disabled>сделать</li><li class="task"><input type="checkbox" disabled checked>готово</li></ul>');
  assert.equal(markdown('Абзац\n2. не список\n1. список'), '<p>Абзац<br>2. не список</p><ol><li>список</li></ol>', 'абзац прерывает только список с 1');
  assert.equal(markdown('> Цитата\nпродолжение\n> > вложенная'), '<blockquote><p>Цитата<br>продолжение</p><blockquote><p>вложенная</p></blockquote></blockquote>');
  assert.equal(markdown('```json\n{"a": "<b>"}\n```\nпосле'), '<pre><code>{&quot;a&quot;: &quot;&lt;b&gt;&quot;}</code></pre><p>после</p>');
  assert.equal(markdown('    код с отступом'), '<pre><code>код с отступом</code></pre>');
  assert.equal(markdown('a\n***\nb'), '<p>a</p><hr><p>b</p>');
  assert.equal(
    markdown('Операции:\n| Дата | Сумма | Статус |\n|:--|--:|:-:|\n| 25.10 | 7 800 ₽ | `HOLD` |\n| 26.10 |'),
    '<p>Операции:</p><div><table><thead><tr><th>Дата</th><th class="al-r">Сумма</th><th class="al-c">Статус</th></tr></thead><tbody><tr><td>25.10</td><td class="al-r">7 800 ₽</td><td class="al-c"><code>HOLD</code></td></tr><tr><td>26.10</td><td class="al-r"></td><td class="al-c"></td></tr></tbody></table></div>',
  );
  assert.equal(markdown(''), '');
});

test('Markdown: строчная разметка по правилам CommonMark; «_» внутри имени инструмента — не курсив', () => {
  const cases: [string, string][] = [
    ['*курсив*, _курсив_, **жирный**, __жирный__, ***оба***, ~~нет~~, ~примерно~', '<em>курсив</em>, <em>курсив</em>, <strong>жирный</strong>, <strong>жирный</strong>, <em><strong>оба</strong></em>, <del>нет</del>, ~примерно~'],
    ['get_close_with_answer и a * b', 'get_close_with_answer и a * b'],
    ['*foo**bar**baz*', '<em>foo<strong>bar</strong>baz</em>'],
    ['***foo** bar*', '<em><strong>foo</strong> bar</em>'],
    ['foo******bar*********baz', 'foo<strong><strong><strong>bar</strong></strong></strong>***baz'],
    ['*foo _bar* baz_', '<em>foo _bar</em> baz_'],
    ['**Сумма**7 800 ₽', '<strong>Сумма</strong>7 800 ₽'],
    ['`` a ` b `` и `*не курсив*`', '<code>a ` b</code> и <code>*не курсив*</code>'],
    ['\\*буквально\\* и \\\\', '*буквально* и \\'],
  ];
  for (const [src, want] of cases) assert.equal(markdown(src), p(want), src);
});

test('Markdown: HTML из сообщения — текст; ссылки только http(s) и mailto, в новой вкладке; картинки не загружаются', () => {
  const a = (url: string, text = url, title = url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" title="${title}">${text}</a>`;
  assert.equal(markdown('<script>alert(1)</script> <img src=x onerror=alert(1)>'), p('&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(markdown('[док](https://example.com "Справка") и <mailto:a@b.c>'), p(`${a('https://example.com', 'док', 'Справка')} и ${a('mailto:a@b.c')}`));
  assert.equal(markdown('[скрипт](javascript:alert(1)) и [внутренняя](/runs/1) и [данные](data:text/html,x)'), p('скрипт и внутренняя и данные'), 'чужие схемы и относительные адреса — без ссылки');
  assert.equal(markdown('[a](https://a.com/"onmouseover="x)'), p(a('https://a.com/&quot;onmouseover=&quot;x', 'a')), 'кавычки в адресе не выходят из атрибута');
  assert.equal(
    markdown('См. https://example.com/a_b?x=1&y=2. И (www.sber.ru), «https://ya.ru/x».'),
    p(`См. ${a('https://example.com/a_b?x=1&amp;y=2')}. И (${a('http://www.sber.ru', 'www.sber.ru')}), «${a('https://ya.ru/x')}».`),
    'хвостовая пунктуация и непарная скобка не входят в автоссылку',
  );
  assert.equal(markdown('![схема](https://x.test/s.png)'), p(a('https://x.test/s.png', 'изображение: схема', 'Картинка в стенде не загружается, откроется по ссылке: https://x.test/s.png')));
  assert.equal(markdown('[https://a.com](https://b.com)'), p(a('https://b.com', 'https://a.com')), 'внутри ссылки автоссылок нет');
});

test('Markdown: глубокая вложенность и патологический текст разбираются быстро и без исключений', () => {
  const deep = markdown(`${'>'.repeat(20000)} x`);
  assert.ok(deep.includes('x') && (deep.match(/<blockquote>/g) ?? []).length <= 14, 'глубже предела — текстом');
  const t = performance.now();
  for (const s of ['*a'.repeat(30000), 'a* '.repeat(30000), '[a]('.repeat(20000), '['.repeat(50000), '~~a'.repeat(30000)]) markdown(s);
  assert.ok(performance.now() - t < 2000, `разбор занял ${Math.round(performance.now() - t)} мс`);
});

test('лента: сообщение агента — с разметкой и переключателем «исходный текст»; реплики оператора и человека — как есть', () => {
  const agent = String(lib.messageView({ type: 'agent_message', seq: 7, turn: 2, text: '**Ответ клиенту:** <b>готово</b>' }));
  assert.match(agent, /<div class="bub"><div class="md"><p><strong>Ответ клиенту:<\/strong> &lt;b&gt;готово&lt;\/b&gt;<\/p><\/div><div class="md-src">\*\*Ответ клиенту:\*\* &lt;b&gt;готово&lt;\/b&gt;<\/div><\/div>/);
  assert.match(agent, /data-action="mdSource" aria-pressed="false"/);
  const plain = String(lib.messageView({ type: 'agent_message', seq: 8, text: 'Без разметки.\nВторая строка.' }));
  assert.match(plain, /<div class="md"><p>Без разметки\.<br>Вторая строка\.<\/p><\/div><\/div>/);
  assert.doesNotMatch(plain, /mdSource|md-src/, 'нечего переключать — переключателя нет');
  const operator = String(lib.messageView({ type: 'operator_message', seq: 9, text: '**не разметка**' }));
  assert.match(operator, /<div class="bub" style="white-space: pre-wrap">\*\*не разметка\*\*<\/div>/);
});

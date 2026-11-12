// Правила стилей интерфейса (web/app.css), которые не дают длинному тексту выйти за свой блок.
// Раскладку тест не проверяет — её показывает только браузер, — но случайно убрать правило он не даст.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.resolve('web/app.css'), 'utf8');

/** Объявления правила с этим селектором. В web/app.css одно правило — одна строка. */
function rule(selector: string): Record<string, string> {
  const line = css.split('\n').find((l) => l.startsWith(`${selector}{`));
  assert.ok(line, `в web/app.css нет правила ${selector}`);
  const body = line.slice(selector.length + 1, line.lastIndexOf('}'));
  return Object.fromEntries(
    body
      .split(';')
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
  );
}

function has(selector: string, decls: Record<string, string>): void {
  const r = rule(selector);
  for (const [prop, value] of Object.entries(decls)) assert.equal(r[prop], value, `${selector}: ${prop}`);
}

// Перенос по строкам внутри блока: элемент может сжаться, не шире блока, длинное слово тоже переносится.
const WRAPS = { 'min-width': '0', 'max-width': '100%', 'white-space': 'normal', 'overflow-wrap': 'anywhere' };

test('метка в строке отметок переносится и не шире своего блока; в одну строку она той же формы, что раньше', () => {
  has('.kvh>span', { ...WRAPS, 'min-height': '24px', 'border-radius': '12px' });
});

test('пилюля со свободным текстом .pill.note переносит его в любом месте интерфейса, а в таблице ограничена по ширине', () => {
  has('.pill.note', { ...WRAPS, 'border-radius': '12px', padding: '4px 10px' });
  has('.pill.note .ic', { 'align-self': 'flex-start', flex: 'none' });
  has('.pill.na.note', { padding: '3px 9px' });
  has('.tbl .pill.note', { width: 'max-content', 'max-width': '360px' });
  assert.doesNotMatch(css, /\.cmd \.pill\.note/, 'правило общее, а не только для записей стенда в ленте');
});

test('длинное слово без пробелов переносится внутри реплики и скрытого блока журнала', () => {
  has('.msg>.bub', { 'max-width': '100%', 'overflow-wrap': 'anywhere' });
  has('.hid', { 'overflow-wrap': 'anywhere' });
});

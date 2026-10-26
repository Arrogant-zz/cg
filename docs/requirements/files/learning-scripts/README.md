# learning-scripts: механика case-capture / skill-curator

> Копия от 26 октября 2026 года для репозитория ClawGym. Оригинал — `files/learning-scripts/README.md` в проекте AEFClaw, sha256 `0416c5dceb1a`. Источник истины — оригинал: копия сама не обновляется.

Только stdlib Python (минимум 3.9 по vermin; проверено на 3.11.15 — как в `openclaw-sandbox:bookworm-slim` — и 3.12).
Сеть не нужна, запись только внутри workspace. Каждый CLI печатает один JSON-объект (кроме `curator.py show`,
`list_learned_skills.py --read` и `learning_stats.py --format md` — текст; `curator.py prepare` и `stage` печатают
JSON и за ним текст кейсов или staging-копии: внутри JSON он был бы экранирован).

Подключение к оркестратору: команды, разбор ответов, политика запуска curator — [INTEGRATION.md](INTEGRATION.md).

## Куда класть

```
<workspace>/
├── skills/
│   ├── _learning-lib/                  общий код; без SKILL.md, OpenClaw не грузит его как skill
│   │   ├── learnlib/                   пакет без файла инициализации; кэш байткода скрипты не пишут
│   │   │   ├── common.py               workspace, пути, время, ID, JSON-вывод, журнал, VERSION
│   │   │   ├── fsops.py                запись без перезаписи, атомарная замена, перенос с проверкой
│   │   │   ├── frontmatter.py          однострочный frontmatter (как парсер OpenClaw)
│   │   │   ├── pii.py                  сканер ПДн/секретов, автозамена, маскирование
│   │   │   ├── cases.py                формат кейса, валидация, сила evidence, архив
│   │   │   ├── skills.py               каталог learned skills, проверка SKILL.md, provenance
│   │   │   └── trace.py                след обращения по журналу, свежие уроки из pending
│   │   ├── list_learned_skills.py      для AGENTS.md: каталог + свежие уроки, --read <skill>
│   │   ├── doctor.py                   проверка окружения в sandbox перед выводом
│   │   ├── learning_stats.py           метрики обучения (для людей, не для агента)
│   │   └── pii_scan.py                 ручные проверки и CI
│   ├── case-capture/
│   │   ├── SKILL.md
│   │   └── scripts/capture.py
│   └── skill-curator/
│       ├── SKILL.md
│       └── scripts/
│           ├── curator.py
│           └── curator_report.py
└── learning/                           создаётся скриптами
    ├── cases/{pending,processed,conflicts,quarantine}/
    ├── .staging/{capture,curator/<run_id>}/   черновики (сюда модель пишет write/edit)
    ├── reservations/capture/           резервы capture init → commit (пишут и читают только скрипты)
    ├── runs/<run_id>/{state.json,decisions.json}
    ├── journal/YYYY-MM.jsonl           append-only аудит
    ├── backups/  reports/
    └── pii-allowlist.txt               опционально, ведут люди (литералы-исключения)

tests/smoke_test.py                     НЕ в workspace агента: репозиторий скиллов / CI
```

Скрипты находят `learnlib` сами: `$LEARNLIB_PATH` → `learnlib/` рядом со скриптом → `skills/_learning-lib/`.
Если sandbox синхронизирует только каталоги со SKILL.md (workspaceAccess не `rw`), положи копию `learnlib/`
в `scripts/` каждого skill — она подхватится первой.

## Поток

обычное обращение (агент по AGENTS.md):

```
python3 skills/_learning-lib/list_learned_skills.py --category "<тематика>" --request-ref <ref>
#   → JSON одной строкой: тематические skills (name, description) + general_skills с текстом + fresh_lessons
#     (case_id, тематика, тема, поправки), без путей к файлам; hint — что делать, если status или
#     fresh_lessons_status не ok; partial — часть файлов skills не прочитана (errors), остальные доступны;
#     журнал: catalog.listed, skill.provided (с request_ref)
python3 skills/_learning-lib/list_learned_skills.py --read card-reissue
#   → полный текст skill; журнал: skill.read с sha версии и ref последнего вызова каталога
#     (во время прохода curator — mode: curator, в след обращения не попадает)
#   тексты skills в каталоге и в --read — без раздела Learning provenance (файл skill не меняется, sha — по файлу)
```

capture (оркестратор → операторская сессия):

```
python3 {baseDir}/scripts/capture.py init --topic "перевыпуск карты" --request-ref <hash> --category "<тематика>"
#   → case_id, captured_at, draft_path, skill_usage (блоки Skill usage для прочитанных skills с <TODO…>),
#     lessons_shown, existing_for_request (reusable: false у карантина), skills_available,
#     trace {catalog_listed, skills_read, skills_provided, lessons_shown, boundary} — события журнала с этим
#     request_ref после его прошлого завершённого capture; без них — эвристическое окно (boundary: heuristic)
#   draft init не создаёт: модель пишет его одним write в learning/.staging/capture/<case_id>.md по шаблону
#   из case-capture/SKILL.md (во frontmatter только outcome и knowledge_signal), файл не читая;
#   резерв — learning/reservations/capture/<case_id>.json, его меняет только скрипт
python3 {baseDir}/scripts/capture.py commit --case-id <id>
#   → result_line: "Case captured: <path> — signal: <x>"   (или errors/pii_blocking → исправить и повторить)
python3 {baseDir}/scripts/capture.py reuse --path <existing> --case-id <id>   # повторный вызов без новых фактов
python3 {baseDir}/scripts/capture.py skip --case-id <id> | abort --case-id <id> --reason "..."
python3 {baseDir}/scripts/capture.py schema [--format md]   # шаблон и правила полей — из таблиц валидатора
```

curator (по протоколу skill-curator/SKILL.md: одна правка skill — 6 вызовов модели, проход без правок — 3;
число ходов на Qwen подтверждает стенд):

```
curator.py prepare [--max-bytes N]                   → JSON: run_id, пачка (case_id, topic, strength, size_chars),
#     агрегаты routing по пачке, skills с полными description, карантин и blocked, давние конфликты;
#     за JSON — тексты кейсов пачки без секций None. и полей skills_available, skills_read_sha (в пределах
#     LEARN_CURATOR_SHOW_BYTES; не поместившиеся — not_shown). Файл решений не создаётся; пустая пачка → сразу apply
curator.py show --run R [--cases ID,...]             → тексты архивных и невыданных кейсов в том же виде
curator.py search --run R --terms a,b --skill S      → архивные подтверждения
curator.py routing-stats --run R --cases ID,... --skill S   → агрегаты по архивным кейсам
curator.py stage --run R --skill S | --new S [--general]   → staging-копия и её текст; правки — edit по нему
curator.py commit-skill --run R --skill S --mode routing --evidence ID,...
curator.py commit-skill --run R --skill S --mode update|create --evidence ID,... --provenance-topic T
#     [--allow-removal "<причина>"]
#   модель пишет learning/.staging/curator/R/decisions.json по примеру из skill-curator/SKILL.md
#   (тот же пример — в curator.py schema, тест сверяет копию)
curator.py apply --run R                             → result_line: "Curator complete: …" / "Curator failed: …"
```

## Что гарантируют скрипты (а не промпт)

- case_id и время — с системных часов; модель не может их подменить. Резерв init лежит вне staging модели
  (`learning/reservations/capture/`) и проверяется по схеме: ключи и типы, case_id = `--case-id`, имя файла
  без каталогов, итоговый путь — только `learning/cases/pending/`. Commit записывает во frontmatter ровно
  набор полей скрипта из резерва (включая `topic`) и удаляет добавленные моделью. `--case-id` во всех командах
  capture проверяется до построения путей: неверный — код 2, пустой — без очистки.
- След обращения (`catalog_listed`, `skills_read` с sha прочитанных версий, `skills_provided`, `lessons_shown`,
  `skills_available` из каталога этого обращения) берётся из журнала по `request_ref`, а не со слов модели;
  незавершённый capture прошлого обращения и чтения во время прохода curator в след не попадают. Без событий
  с ref — эвристическое окно и `trace_boundary: heuristic`. Прочитанный командой skill обязан быть описан
  в Skill usage. Повтор commit после сбоя не создаёт дубликат.
- Модель пишет во frontmatter draft только `outcome` и `knowledge_signal`. `skills_active`, `skills_helpful`,
  `skills_insufficient` и `skill_missing` commit вычисляет из блоков Skill usage, вписанные моделью значения
  заменяет. Старые кейсы, где списки писала модель, curator читает по-прежнему. `knowledge_signal` commit
  выравнивает: есть поправка оператора — `strong`, нет ни поправок, ни кандидатов (кроме `Type: none`) — `none`
  (исправление — в `knowledge_signal_adjusted`); `medium` и `weak` — оценка модели.
- Формат кейса задаёт одна таблица полей в `learnlib/cases.py`: по ней проверяет commit, строит заготовку init
  и печатает шаблон `capture.py schema`; тест сверяет копию шаблона в `case-capture/SKILL.md` с выводом команды.
  Draft commit не меняет (кроме автозамены номеров при отказе — `draft_rewritten: true`), номера строк в ошибках —
  строки draft.
- Разбор кейса терпим к оформлению LLM (жирные имена полей, нумерация, значение на следующей строке,
  строки-продолжения, заголовки в другом регистре, значение перечисления в `коде` или с пояснением);
  строка с незнакомым именем поля — ошибка, а не часть правила. Заглушка — только `<TODO…>` и литералы
  перечислений: «Заявка по продукту <тип продукта> принята» — законный текст. Символы китайского, японского и
  корейского письма commit кейса и `commit-skill` отклоняют с номером строки.
- `Correction` длиннее `LEARN_CORRECTION_MAX_CHARS` commit отклоняет; свежий урок выдаётся целиком, а не
  поместившийся в бюджет выдачи не показывается и считается в `fresh_lessons_omitted`.
- Свежие уроки: коррекции оператора из pending-кейсов видны агенту в следующем обращении, до curator;
  общие (Scope: general) — в любой тематике. После apply кейс уходит из pending, и урок исчезает.
- Общие skills (metadata.aef.scope: general) выдаются в каждом обращении с текстом; не больше 5, до 4000 символов;
  правка общего skill — только по evidence со Scope: general; тип skill правкой не меняется.
- ПДн: capture автоматически заменяет только числовые и структурные идентификаторы (карты, счета, телефоны,
  e-mail, паспорта, токены) и возвращает список замен (`pii_replacements`: правило, строка, маска, плейсхолдер).
  `пароль: <значение>` не заменяется: значение из одних букв — предупреждение, с цифрами или символами — блок.
  ФИО и адреса блокируют запись до ручного исправления. `commit-skill` ничего не заменяет: блокирующая
  находка — код 2, текст правит модель. `decisions.json` проверяется до сохранения в `runs/`, свежие уроки —
  по окончательному тексту выдачи. В выводе скриптов — только маски, соседние находки в контексте тоже
  замаскированы. Проверенные публичные коды (номера ошибок, реквизиты банка) вносят в `learning/pii-allowlist.txt`.
  Кейсы с ПДн в очереди уходят в `quarantine/`, а не в evidence.
- Журнал: если событие не записалось, JSON-ответ содержит `audit_degraded: true`; события результата
  (`capture.*`, `curator.finalized`) пишут `request_ref` / `run_id` и `result_line` для сверки оркестратором.
- Evidence policy: несуществующие case ID отклоняются; нужен operator_explicit/validated_result или
  ≥2 observed из разных обращений — разных непустых request_ref (кейс без ref независимого подтверждения не
  добавляет). Сила считается по пунктам: кандидат `Type: none` и поправка без валидного `Source` evidence не дают;
  для общего skill считаются только пункты со `Scope: general`. Routing-правка — только при наблюдаемом промахе
  подбора: если в кейсе есть `skills_available`, решает механический след, имя skill в `Routing evidence` —
  запасной вариант только для старых кейсов без него; при `catalog_listed: false` — никогда.
- Одна правка skill за прогон; lock по sha256 от момента stage с повторной сверкой перед записью;
  backup с проверкой; атомарная замена; чужая правка → `modified_during_run`, кейсы остаются в pending.
- update: до записи тело (без provenance) сравнивается с базой; исчезло больше `LEARN_CURATOR_MAX_REMOVED_PCT`
  строк базы — код 2 со списком, повтор с `--allow-removal "<причина>"`. Исчезнувшие строки и причина — в отчёте
  всегда, даже ниже порога. create: scope нового skill должен совпадать с `stage` (`--general`), лимит общих
  skills проверяется и при `stage`, и непосредственно перед созданием файла.
- UPDATE_ROUTING меняет только description (тело и остальной frontmatter сверяются побайтно).
- Каждый кейс пачки обязан получить решение; куда он уйдёт (pending/conflicts/processed), считает скрипт.
  `diagnosis` — код (`working`, `content_problem`, `routing_problem`, `execution_problem`, `coverage_gap`,
  `routing_not_observable`; прежние русские фразы принимаются как синонимы), русская подпись — только в отчёте.
- Застрявшие кейсы: коллизия case_id с архивом, размер больше бюджета пачки и неверная кодировка — apply переносит
  в `quarantine/` с причиной; файл без доступа на чтение остаётся в pending как `blocked` (JSON и отчёт) и
  учитывается в `left`. Пустая пачка — штатный маршрут: `show` с кодом 0, `apply` без decisions.json.
- Отчёт пишется до переносов, переносы — с проверкой обоих условий, счётчики — по факту после проверки.
- Обрыв посреди apply доводится при следующем prepare; повторный apply идемпотентен.

## Переменные окружения

| Переменная | По умолчанию | Смысл |
| --- | --- | --- |
| `LEARN_WORKSPACE` | над `skills/` | корень workspace |
| `LEARNLIB_PATH` | — | явный путь к каталогу с `learnlib/` |
| `LEARN_TZ` | `Europe/Moscow` | зона для имён файлов; без tzdata — фиксированный +03:00 |
| `LEARN_CASE_WARN_CHARS` / `LEARN_CASE_MAX_CHARS` | 4000 / 8000 | предупреждение по тексту кейса без полей скрипта / отказ по размеру файла |
| `LEARN_CORRECTION_MAX_CHARS` | 400 | длина одной `Correction` |
| `LEARN_CAPTURE_MAX_ATTEMPTS` | 3 | попыток commit до `gave_up` |
| `LEARN_CURATOR_MAX_CASES` | 10 | кейсов в пачке |
| `LEARN_CURATOR_CASE_BUDGET` | 30000 | символов на кейсы пачки |
| `LEARN_CURATOR_SHOW_BYTES` | 45000 | байт текстов кейсов в одном выводе `prepare` / `show` |
| `LEARN_CURATOR_MAX_REMOVED_PCT` | 30 | доля строк тела базы (%), которые update может убрать без `--allow-removal` |
| `LEARN_CURATOR_MAX_HISTORY` | 10 | архивных кейсов на прогон через `show` |
| `LEARN_LESSONS_MAX` | 10 | свежих уроков в выводе каталога |
| `LEARN_LESSONS_MAX_CHARS` | 6000 | текста поправок в выводе каталога (урок не обрезается, а пропускается) |
| `LEARN_GENERAL_MAX_SKILLS` | 5 | общих skills в библиотеке |
| `LEARN_GENERAL_MAX_CHARS` | 4000 | тело одного общего skill |
| `LEARN_GENERAL_CATALOG_CHARS` | 12000 | текст общих skills в одном выводе каталога |
| `LEARN_NOW` | — | только для тестов |

Коды возврата: 0 успех · 1 IO/внутренняя ошибка · 2 исправь вход и повтори · 3 предусловие/конфликт, не повторяй вслепую · 4 аргументы.

## Обвязка (без неё скрипты — рекомендация, а не гарантия)

Комплект не содержит обвязки: её настраивают в OpenClaw / AEF Workstation. Гарантии скриптов держатся на том,
что модель не может обойти их файловыми инструментами и `exec`.

- RO-bind `skills/_learning-lib`, `skills/case-capture`, `skills/skill-curator` в sandbox.
- `before_tool_call`, файловые инструменты:
  - write/edit модели — только в `learning/.staging/**`. Каталог резервов `learning/reservations/**`, а также
    `skills/learned/**`, `learning/cases/**`, `learning/runs/**`, `learning/journal/**`, `learning/backups/**`,
    `learning/reports/**` и инфраструктура (`AGENTS.md`, служебные skills, `_learning-lib`) — только для скриптов;
  - чтение `skills/learned/**` файловым инструментом запрещено с подсказкой «читай через
    `python3 skills/_learning-lib/list_learned_skills.py --read <name>`»: тогда факт чтения и версию skill
    записывает скрипт после успешной выдачи текста. Писать `skill.read` из самого `before_tool_call` нельзя:
    хук видит попытку, а не выданный текст.
- `before_tool_call`, `exec` — allowlist проверяет не только скрипт, но и аргументы:
  - только `python3 skills/_learning-lib/list_learned_skills.py`, `skills/case-capture/scripts/capture.py`,
    `skills/skill-curator/scripts/curator.py` с подкомандами и флагами из их `SKILL.md` и `AGENTS.md`;
  - без `--workspace`, `--no-log`, `--no-lessons` (флаги для людей и CI) и без `--decisions` вне
    `learning/.staging/curator/<run_id>/` (скрипт это тоже проверяет);
  - без префиксов окружения (`LEARN_WORKSPACE=…`, `LEARNLIB_PATH=…`, любые `LEARN_*`) и без цепочек:
    `;`, `&&`, `||`, `|`, перенаправлений, `` ` `` и `$(…)`.
- `agents.defaults.compaction.memoryFlush.enabled: false`, запрет записи в `memory/` — иначе ПДн уходят мимо capture.
- В SKILL.md обоих skills: `metadata: {"openclaw":{"requires":{"bins":["python3"]}}}` (проверяется на хосте gateway).

Приёмочный тест прав — под реальными правами агента, до вывода и после каждого изменения обвязки:

- создание draft одним write (без чтения) в `learning/.staging/capture/` и правка staging-копии в
  `learning/.staging/curator/` проходят;
- прямая запись файловым инструментом в `skills/learned/`, `learning/cases/`, `learning/runs/`,
  `learning/reservations/` и инфраструктурные файлы отклоняется;
- чтение `skills/learned/**` файловым инструментом отклоняется с подсказкой про `--read`;
- запрещённые аргументы `exec` отклоняются: `--workspace`, `--no-log`, `--decisions /tmp/x.json`,
  `LEARN_WORKSPACE=/tmp python3 …`, `python3 … ; rm …`, вызов другого скрипта или интерпретатора.

`doctor.py` этот тест не заменяет: он проверяет файловую систему и права процесса, а не перехват вызовов модели.

## Проверка

```
python3 tests/smoke_test.py          # 294 проверки (регрессии этапов 1–4 и части этапа 5), временный workspace
python3 skills/_learning-lib/doctor.py --init    # в sandbox оператора перед выводом
python3 skills/_learning-lib/learning_stats.py --format md
```

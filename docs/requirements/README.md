# Документы требований — копии от 26 октября 2026 года

Копии документов проекта AEFClaw. Они лежат в репозитории, чтобы ClawGym можно было дорабатывать во внутреннем контуре без доступа к папке проекта (см. [CLI_plan.md](../../CLI_plan.md)).

**Источник истины — оригиналы в проекте AEFClaw.** Копии сами не обновляются. Если владелец изменил оригинал, обновите копию и эту таблицу.

| Копия | Оригинал в проекте AEFClaw | sha256 оригинала | Что это |
| --- | --- | --- | --- |
| [gap.md](gap.md) | `gap.md` | `5ff5d77dc950…` | Решения владельца, задачи первой автоматической версии, сквозные сценарии приёмки, статус реализации (раздел 18) |
| [plan.md](plan.md) | `plan.md` | `9d73c2c9f10e…` | Полный план ClawGym: этап 0 (контракты), архитектура, модель и поведение, этапы |
| [plan_start.md](plan_start.md) | `plan_start.md` | `60c60cc489cb…` | Ручной режим: чат с агентом на заглушках и его приёмка на стенде |
| [ui/style-guide.md](ui/style-guide.md) | `ui/style-guide.md` | `39fb93e8fe3b…` | Стиль интерфейса ClawGym. Классы — в `web/clawgym.css` |
| [files/learning-scripts/INTEGRATION.md](files/learning-scripts/INTEGRATION.md) | `files/learning-scripts/INTEGRATION.md` | `8515df90fe65…` | Что оркестратор отправляет агенту для обучения и как разбирать ответы `/case-capture` и `/skill-curator` |
| [files/learning-scripts/README.md](files/learning-scripts/README.md) | `files/learning-scripts/README.md` | `0416c5dceb1a…` | Устройство комплекта обучения: раскладка workspace, capture, curator, журнал |

Копии отличаются от оригиналов только строкой-пометкой под заголовком. Пути сохранены как в проекте, поэтому ссылки между этими файлами работают.

**Что не скопировано:**

- `design.md` и `AGENTS.md` проекта;
- папки `logos/` и `presentations/`;
- код комплекта обучения, включая `files/learning-scripts/skills/_learning-lib/learning_stats.py`, который нужен для сверки метрик (`CLI_plan.md`, раздел 10.1). Его запросите у владельца.

Ссылки из копий на эти файлы и на `clawgym/…` не открываются. Пути вида `clawgym/…` соответствуют корню этого репозитория.

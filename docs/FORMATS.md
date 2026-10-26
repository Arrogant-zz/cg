# Форматы файлов настроек

Дата: 26 октября 2026 года. Задача CFG-01 из `gap.md`. Форматы — предложение реализации: владелец задал только состав сущностей и их связи.

Файлы пишутся в YAML; `contracts/tools.json` и шаблоны тела — в JSON. ClawGym проверяет их по схемам из `src/config/schemas.ts`. Неизвестное поле даёт предупреждение и игнорируется, чтобы файлы для следующих версий продолжали загружаться. Ошибка указывает файл, строку, поле, причину и действие. Файлы с именем на `_` не загружаются.

Идентификаторы: латиница, цифры и `. _ / -`. Ссылки между файлами — по идентификаторам. Секреты — только `${env:NAME}`; значение по умолчанию — `${env:NAME:-значение}`.

## Кейс — `cases/<id>.yaml`

Ситуация, стартовые данные, заглушки и общий эталон. Поведение оператора в кейсе не хранится.

```yaml
id: card-blocked-wrong-pin            # совпадает с именем файла, иначе предупреждение
title: Карта заблокирована после неверных PIN
topic: Карты / Блокировка             # точная тематика: идёт в стартовое сообщение и /case-capture
tags: [Карты, PIN]
situation: >                          # для людей и оператора; агенту не передаётся
  Клиент трижды ввёл неверный PIN…
start:                                # поля шаблона contracts/start-message.txt: {{start.*}}
  channel: чат
  client: { id: CL-TEST-0017, name: Тестовый Клиент А-17 }
  card: "****4417"
facts:                                # факты, на вопросы о которых оператор может отвечать
  - PIN-код не менялся больше года.
state:                                # начальное состояние выполнения: {{state.*}}, меняется effect
  card: blocked
tools:                                # заглушки по имени инструмента
  get_card_status:
    - id: blocked-pin                 # имя видно в журнале; по умолчанию <tool>#<n>
      when: { card: "****4417" }      # подмножество аргументов
      result:
        json: { status: "{{state.card}}", reason: pin_attempts }
  unblock_card:
    - id: ok
      sequence:                       # ответы на последовательные вызовы, последний повторяется
        - result: { json: { status: active } }
          effect: { card: active }    # изменение состояния этого выполнения
        - error: { message: already_active, code: CARD_ALREADY_ACTIVE }
  close_case:
    - delayMs: 1200
      result: { file: cases/closed.json }   # файл из data/
reference:                            # общий эталон; агенту не передаётся
  procedure: [Проверить статус карты, Проверить последние операции, …]
  answer: Карта разблокирована, клиенту рекомендовано сменить PIN.
  criteria:                           # для LLM-оценки
    - id: change-pin
      text: Советует сменить PIN
      lesson: L-cards-005             # урок, к которому относится критерий
      hint: сменить PIN               # подсказка только для dev/fake-llm (models: devHints)
  actions:                            # для автоматических проверок
    required:
      - tool: get_recent_operations
        before: unblock_card          # порядок
        lesson: L-cards-004
        args: { card: "****4417" }    # необязательные условия на аргументы
    forbidden:
      - tool: reissue_card
    final: close_case                 # итоговое действие должно быть выполнено
  lessons:                            # каталог известных уроков кейса (MET-04)
    - id: L-cards-004
      rule: Перед разблокировкой посмотреть последние операции по карте.
```

**Условия в `when`:**

| Запись | Значение |
| --- | --- |
| Значение | Равенство; числа и строки сравниваются как строки |
| `{ regex: "^OP-" }` | Регулярное выражение |
| `{ in: [a, b] }` | Одно из значений |
| `{ exists: true }` | Аргумент задан |
| `{ not: x }` | Не равно |
| `client.id` | Вложенный аргумент |

Из подходящих заглушек выбирается та, у которой больше условий. Если в кейсе подходящей заглушки нет, поиск продолжается в `contracts/tool-defaults.yaml`.

**Ответ:** ровно одно из `result.json`, `result.text`, `result.file` — или `error` (строка либо `{ message, code }`). Дополнительно можно задать `delayMs` и `effect`.

**Шаблоны в строках:**

| Шаблон | Что подставляется |
| --- | --- |
| `{{case.*}}` | Поля кейса |
| `{{start.*}}` | Стартовые данные |
| `{{args.*}}` | Аргументы вызова |
| `{{state.*}}` | Состояние выполнения |
| `{{execution.caseNumber}}`, `{{execution.requestRef}}` | Номер обращения и `request_ref` выполнения |
| `{{now}}` | Текущее время |

## Решение — `solutions/<кейс>/<имя>.yaml`

Сценарий LLM-оператора для кейса. Идентификатор по умолчанию — путь без `solutions/` и расширения, например `card-blocked-wrong-pin/explain-now`.

```yaml
case: card-blocked-wrong-pin
title: «Объясняет сразу»
goal: усвоит ли агент правило, если его сразу объяснили.
operator:
  instruction: >                      # главное для LLM-оператора
    Отклоняй действия, которые расходятся с эталоном, и сразу объясняй правило.
  style: explain-now                  # необязательная метка; утверждённого перечня режимов нет
  seesToolResults: true               # видит ли оператор ответы инструментов (по умолчанию да)
  lessons: []                         # дополнительные уроки к каталогу кейса
limits: { maxTurns: 20 }              # переопределение лимитов прогона
```

## Корзина — `baskets/<id>.yaml`

```yaml
id: cards-train
title: Обучение · блокировки и перевыпуск карт
type: training                        # training | checking; смешивать нельзя
curator:                              # только training; без блока curator не запускается
  every: 2                            # каждые N завершённых решений; 0 — без периодических
  final: true                         # дополнительный проход в конце неполной пачки
  resetBefore: true                   # /reset перед /skill-curator (по умолчанию да)
checking:                             # только checking
  confirmations: approve              # approve — без вмешательства оператора; operator — решает LLM
items:                                # фиксированный порядок; решение может повторяться
  - solution: card-blocked-wrong-pin/explain-now
    limits: { maxTurns: 12 }          # параметры конкретного элемента
  - curator: true                     # явный шаг curator (только training)
```

В проверяющей корзине блок `curator` с проходами и шаги `curator` — ошибка.

## Настройка прогона — `runs/<id>.yaml`

```yaml
id: demo-cards-train
title: Обучение · карты · fake-agent
basket: cards-train                   # тип прогона берётся из корзины
agent: fake-agent
models:
  agent: fake-agent-a                 # только если подключение переключает модель запросом
  operator: fake-operator             # обязательно
  judge: fake-judge                   # без неё ответ «не оценён»
skillset: { id: cards, version: V1 }  # version: latest — последняя готовая; build — стартовые скиллы сборки; none — без набора
metrics: all                          # или список идентификаторов из metrics/
limits: { maxTurns: 20, maxDurationSec: 900, maxOperatorCalls: 30 }
repetitions: 1                        # независимые линии со своими сессиями и копиями
startAt: 2026-10-27T01:00:00+03:00    # необязательное время старта
```

## Агент — `agents/<id>.yaml`

```yaml
id: pagurus-stand
title: Pagurus · стенд
request:
  url: ${env:AGENT_URL}
  method: POST
  headers: { Authorization: Bearer ${env:PAGURUS_STAND_TOKEN} }
  body: templates/a2a-message.json    # файл или объект; {{text}}, {{taskId}}, {{senderId}}, {{messageId}}
  textPath: $.params.message.parts[0].text   # вместо {{text}} в шаблоне
  taskIdHeader: x-task-id
  senderIdHeader: x-a2a-sender-id
  taskIdScope: execution              # execution | message
  timeoutMs: 900000
response:
  mode: sync                          # реализован только sync
  replyPath: $.result.parts[*].text
  statusPath: $.result.status.state
  errorPath: $.error.message
  usage: { inputPath: …, outputPath: …, totalPath: … }
commands:                             # по умолчанию — тексты из INTEGRATION.md
  reset: /reset
  capture: /case-capture request_ref={{requestRef}} category={{topic}}
  curator: /skill-curator
mcp: { contract: contracts/tools.json, protocolVersion: 2025-06-18, taskIdFrom: [header, meta, argument] }
model: { switch: none, fixed: main }  # none — задана развёртыванием; request — значение по model.path
sessions: { max: 3 }
skills:
  installer: none                     # none | directory (root, skillsDir, pendingDir) | http (baseUrl, headers)
  note: Установка набора в AEFClaw не подтверждена
healthUrl: …                          # без него доступность «не проверяется»
build: метка сборки
learningKit: версия комплекта обучения
```

Подробности и статус каждого поля — в [CONTRACTS.md](CONTRACTS.md).

## Модель — `models/<id>.yaml`

```yaml
id: op-a
roles: [operator]                     # agent | operator | judge
provider: openai-compatible           # openai-compatible | gigachat-v1 | gigachat-v2 | anthropic | deployment | agent-request
baseUrl: ${env:LLM_BASE_URL}
path: /chat/completions               # необязательно: путь метода, если шлюз отличается от стандартного
apiKey: ${env:LLM_API_KEY}
model: ${env:LLM_OPERATOR_MODEL}
headers: {}
tls:                                  # необязательно: клиентский сертификат (mTLS)
  cert: ${env:LLM_CERT_FILE}          # клиентский сертификат, PEM
  key: ${env:LLM_KEY_FILE}            # закрытый ключ, PEM
params:
  temperature: 0.3                    # не передаётся в Anthropic Messages API
  maxTokens: 4000
  timeoutMs: 120000
  retries: 2                          # повторы при 429, 5xx и сетевых сбоях
  responseFormat: json_schema         # json_schema | json_object | none
  effort: medium                      # только anthropic
  fallbacks: default                  # только anthropic; по умолчанию включён для claude-opus-5-5 и др.
  devHints: false                     # только для dev/fake-llm
```

Для роли `agent` используются провайдеры `deployment` (модель задана развёртыванием) и `agent-request` (значение `model` уходит в запрос агенту). Ответы оператора и судьи проверяются по JSON-схеме; при ошибке формата модель переспрашивается один раз.

### GigaChat — `gigachat-v1` и `gigachat-v2`

Формат — по OpenAPI-спецификации GigaChat API на developers.sber.ru, прочитанной 26 октября 2026 года. С настоящим GigaChat не проверялся. Пример — `models/op-gigachat.yaml` (v1) и `models/judge-gigachat.yaml` (v2).

```yaml
id: judge-gigachat
roles: [judge]
provider: gigachat-v2                 # gigachat-v1 — POST {baseUrl}/v1/chat/completions; gigachat-v2 — POST {baseUrl}/v2/chat/completions
baseUrl: ${env:GIGACHAT_BASE_URL}     # корень API без версии: https://gigachat.devices.sberbank.ru/api или http://… внутри Istio
path: /v2/chat/completions            # необязательно: другой путь, если его требует шлюз контура
model: ${env:GIGACHAT_JUDGE_MODEL:-GigaChat-2-Max}
tls:                                  # необязательно
  cert: ${env:GIGACHAT_CERT_FILE:-}   # клиентский сертификат, PEM; пусто — вызов без сертификата
  key: ${env:GIGACHAT_KEY_FILE:-}     # закрытый ключ, PEM
  # pfx: ${env:GIGACHAT_PFX_FILE:-}   # или сертификат с ключом в PKCS#12 — вместо cert и key
  passphrase: ${env:GIGACHAT_KEY_PASSPHRASE:-}
  ca: ${env:GIGACHAT_CA_FILE:-}       # корневой сертификат сервера, если его нет в хранилище Node.js
params:
  temperature: 0.01                   # GigaChat принимает только больше 0
  maxTokens: 4000
  timeoutMs: 120000
  retries: 2
  responseFormat: json_schema         # json_schema | none
```

- **Авторизация** — клиентский сертификат (mTLS), если заданы его файлы. Файлы читаются при каждом вызове: новый сертификат подхватывается без перезапуска.
- **Без сертификата** — если файлы не заданы, ClawGym вызывает адрес как есть. Так работает установка внутри Istio: `baseUrl` — http-адрес внутри сетки, а mTLS до GigaChat делает sidecar или egress-шлюз. Решение владельца от 26 октября 2026 года. Http без сертификата используйте только внутри сетки: иначе запросы к модели идут без шифрования.
- **Сертификат задаётся целиком:** `tls.cert` и `tls.key` вместе или один `tls.pfx`. Только по https: сертификат вместе с http-адресом — ошибка настройки, а не тихий отказ от mTLS. Только `tls.ca` — для https без клиентского сертификата.
- **Токен.** Заголовок `Authorization: Bearer …` добавляется, только если задан `apiKey`; получение токена OAuth не реализовано.
- **Сертификат сервера.** Если сертификат сервера выдан центром, которого нет в хранилище Node.js, укажите `tls.ca`, например, корневой сертификат НУЦ Минцифры. Другой вариант — переменная `NODE_EXTRA_CA_CERTS`.
- **Запрос v1:** `messages` из строк `system` и `user`, `temperature`, `max_tokens`, `stream: false`, `response_format`.
- **Запрос v2:** части `content: [{ text }]`, параметры — внутри `model_options`.
- **Структурированный ответ** — `response_format: { type: json_schema, schema, strict: true }`, схема без обёртки OpenAI. Если GigaChat отклонит схему (HTTP 422), задайте `responseFormat: none`: ответ всё равно проверяется, при ошибке формата модель переспрашивается.
- **Ответ:**
  - текст берётся из `choices[0].message.content` (v1) или из частей `messages[].content[].text` (v2);
  - токены — из `usage`;
  - `finish_reason: length` — обрезка ответа;
  - `blacklist` и другие срабатывания фильтра — отказ модели.
- **Трассировка.** Каждый вызов получает свой `X-Request-ID`; он попадает в текст ошибки, чтобы найти запрос в журналах GigaChat. Дополнительные заголовки, например `X-Client-ID`, задаются в `headers`.
- **Ошибки сертификата** объясняют, что исправить: нет `tls.ca`, сервер не принял клиентский сертификат, ключ не подходит или неверен пароль. Такие ошибки не повторяются.

## Набор скиллов — `skillsets/<id>.yaml`

```yaml
id: cards
title: Карты · блокировки и перевыпуск
compatibility: { agent: fake-agent, learningKit: learning-scripts 2026.10 }
versions:
  - id: V1
    path: cards/V1                    # каталог skillsets/cards/V1 с файлами skills/learned/**
    createdAt: 2026-10-21
    source: { kind: import, note: исходная версия }
```

Файлы версии лежат с путями workspace: `skillsets/cards/V1/skills/learned/<скилл>/SKILL.md`. Контрольная сумма версии — sha256 строк «путь:sha256» по всем файлам.

Версии, полученные обучением, ClawGym сохраняет в `$CLAWGYM_DATA/skillsets/<набор>/V<n>/`: `version.json` (источник, прогон, линия, статус) и `files/`. Версии не перезаписываются.

## Метрики — `metrics/*.yaml`

Файл с одной метрикой или списком `metrics:`. Каждая метрика выбирает встроенный расчёт:

```yaml
metrics:
  - id: success
    builtin: success                  # см. ниже
    title: Итоговый успех
    description: …
    level: [кейс, корзина]
    needs: обе проверки
    version: v1
```

Встроенные расчёты:

| Расчёт | Что считает |
| --- | --- |
| `action-checks` | Проверки действий |
| `answer-quality` | Качество ответа |
| `success` | Итоговый успех |
| `corrections` | Поправки |
| `repeated-corrections` | Повторные поправки |
| `rejected-actions` | Отклонённые действия |
| `unexpected-tools` | Неожиданные инструменты |
| `turns-duration` | Ходы и длительность |
| `tokens` | Токены |
| `skill-changes` | Изменения скиллов; в проверке — неизменность набора |
| `operator-errors` | Сбои LLM-оператора |

Нет данных — «нет данных» с причиной, а не ноль.

## Контракт — `contracts/`

- `tools.json`: `tools[]` — `name`, `description`, `inputSchema`, `requiresConfirmation`, `kind`; `result.mode` — `text` | `structured` | `both`; `errors` — тексты для агента с `{{tool}}`; `conditional: true` — пока не сверено с оркестратором.
- `start-message.txt`: шаблон стартового сообщения; строка с пустой подстановкой выпадает.
- `tool-defaults.yaml`: `tools:` — заглушки по умолчанию в формате кейса.

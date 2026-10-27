// JSON Schema файлов настроек. Неизвестные поля дают предупреждение, а не ошибку:
// файлы, написанные для следующих версий, продолжают загружаться.
import { FINAL_CLASSES } from './types.js';

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: { type: 'string' } } as const;
const idPattern = '^[A-Za-z0-9][A-Za-z0-9._/-]*$';
const id = { type: 'string', pattern: idPattern } as const;

const lesson = {
  type: 'object',
  required: ['id', 'rule'],
  properties: { id: str, rule: str },
  additionalProperties: false,
} as const;

const limits = {
  type: 'object',
  properties: {
    maxTurns: { type: 'integer', minimum: 1, maximum: 500 },
    maxDurationSec: { type: 'integer', minimum: 10, maximum: 86400 },
    maxOperatorCalls: { type: 'integer', minimum: 1, maximum: 1000 },
  },
  additionalProperties: false,
} as const;

const stubResponseProps = {
  result: {
    type: 'object',
    properties: { json: {}, text: str, file: str },
    additionalProperties: false,
  },
  error: {
    anyOf: [
      str,
      {
        type: 'object',
        required: ['message'],
        properties: { message: str, code: { type: ['string', 'number'] } },
        additionalProperties: false,
      },
    ],
  },
  delayMs: { type: 'number', minimum: 0, maximum: 600000 },
  effect: { type: 'object' },
} as const;

const stubResponse = { type: 'object', properties: stubResponseProps, additionalProperties: false } as const;

const stub = {
  type: 'object',
  properties: {
    id: str,
    when: { type: 'object' },
    sequence: { type: 'array', minItems: 1, items: stubResponse },
    ...stubResponseProps,
  },
  additionalProperties: false,
} as const;

const action = {
  type: 'object',
  required: ['tool'],
  properties: { id: str, tool: str, before: str, args: { type: 'object' }, lesson: str, text: str },
  additionalProperties: false,
} as const;

export const caseSchema = {
  type: 'object',
  required: ['id', 'title', 'topic'],
  properties: {
    id,
    title: str,
    topic: str,
    tags: strArr,
    situation: str,
    start: { type: 'object' },
    facts: strArr,
    state: { type: 'object' },
    tools: { type: 'object', additionalProperties: { type: 'array', items: stub } },
    reference: {
      type: 'object',
      properties: {
        procedure: strArr,
        answer: str,
        finalText: str,
        finalClass: { enum: [...FINAL_CLASSES] },
        tools: {
          type: 'array',
          items: { anyOf: [str, { type: 'object', required: ['tool'], properties: { tool: str, count: { type: 'integer', minimum: 1 } }, additionalProperties: false }] },
        },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            required: ['text'],
            properties: { id: str, text: str, hint: str, lesson: str },
            additionalProperties: false,
          },
        },
        actions: {
          type: 'object',
          properties: {
            required: { type: 'array', items: action },
            forbidden: { type: 'array', items: action },
            final: str,
          },
          additionalProperties: false,
        },
        lessons: { type: 'array', items: lesson },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

export const solutionSchema = {
  type: 'object',
  required: ['case', 'operator'],
  properties: {
    id,
    case: id,
    title: str,
    goal: str,
    operator: {
      type: 'object',
      required: ['instruction'],
      properties: {
        instruction: str,
        style: str,
        seesToolResults: { type: 'boolean' },
        lessons: { type: 'array', items: lesson },
      },
      additionalProperties: false,
    },
    limits,
  },
  additionalProperties: false,
} as const;

export const basketSchema = {
  type: 'object',
  required: ['id', 'title', 'type', 'items'],
  properties: {
    id,
    title: str,
    type: { enum: ['training', 'checking'] },
    description: str,
    curator: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        every: { type: 'integer', minimum: 0, maximum: 1000 },
        final: { type: 'boolean' },
        resetBefore: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    checking: {
      type: 'object',
      properties: { confirmations: { enum: ['approve', 'operator'] } },
      additionalProperties: false,
    },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { solution: id, curator: {}, limits, note: str },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

const strMap = { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } } as const;

export const agentSchema = {
  type: 'object',
  required: ['id', 'title', 'request', 'response'],
  properties: {
    id,
    title: str,
    kind: { enum: ['rest'] },
    request: {
      type: 'object',
      required: ['url'],
      properties: {
        url: str,
        method: { enum: ['POST', 'PUT', 'post', 'put'] },
        headers: strMap,
        body: {},
        textPath: str,
        taskIdHeader: str,
        senderIdHeader: str,
        taskIdScope: { enum: ['execution', 'message'] },
        timeoutMs: { type: 'integer', minimum: 1000 },
      },
      additionalProperties: false,
    },
    response: {
      type: 'object',
      required: ['replyPath'],
      properties: {
        mode: { enum: ['sync', 'stream', 'poll'] },
        replyPath: str,
        statusPath: str,
        errorPath: str,
        usage: {
          type: 'object',
          properties: { inputPath: str, outputPath: str, totalPath: str },
          additionalProperties: false,
        },
        sample: str,
      },
      additionalProperties: false,
    },
    commands: {
      type: 'object',
      properties: { reset: str, capture: str, curator: str },
      additionalProperties: false,
    },
    mcp: {
      type: 'object',
      properties: {
        contract: str,
      },
      additionalProperties: false,
    },
    // Метка модели агента: задана сборкой или развёртыванием, ClawGym её не переключает.
    model: str,
    sessions: {
      type: 'object',
      properties: { max: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    healthUrl: str,
    build: str,
    learningKit: str,
  },
  additionalProperties: false,
} as const;

export const modelSchema = {
  type: 'object',
  required: ['id', 'roles', 'provider'],
  properties: {
    id,
    title: str,
    roles: { type: 'array', minItems: 1, items: { enum: ['operator', 'judge'] } },
    provider: { enum: ['gigachat-v1', 'gigachat-v2'] },
    baseUrl: str,
    path: { type: 'string', pattern: '^/' },
    apiKey: str,
    model: str,
    headers: strMap,
    tls: {
      type: 'object',
      properties: { cert: str, key: str, pfx: str, passphrase: str, ca: str },
      additionalProperties: false,
    },
    description: str,
    params: {
      type: 'object',
      properties: {
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        maxTokens: { type: 'integer', minimum: 64 },
        timeoutMs: { type: 'integer', minimum: 1000 },
        retries: { type: 'integer', minimum: 0, maximum: 10 },
        responseFormat: { enum: ['json_schema', 'none'] },
        devHints: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;


const metric = {
  type: 'object',
  required: ['id', 'builtin'],
  properties: {
    id,
    builtin: str,
    title: str,
    description: str,
    unit: str,
    level: strArr,
    needs: str,
    params: { type: 'object' },
    version: str,
  },
  additionalProperties: false,
} as const;

// Параметры метрик аналитика (27.10.2026): проверяются при загрузке, ошибка видна до запуска прогона.
const classTools = { type: 'array', items: { anyOf: [str, { type: 'object', required: ['tool'], properties: { tool: str, args: { type: 'object' } }, additionalProperties: false }] } } as const;
const perClass = (schema: object) => ({ type: 'object', properties: Object.fromEntries(FINAL_CLASSES.map((k) => [k, schema])), additionalProperties: false });

export const metricParamsSchemas: Record<string, object> = {
  'final-action': { type: 'object', properties: { classes: perClass(classTools) }, additionalProperties: false },
  'tools-f1': {
    type: 'object',
    properties: { duplicates: { enum: ['tolerate', 'strict', 'whole'] }, maxRepeats: { type: 'integer', minimum: 1 }, ignore: strArr },
    additionalProperties: false,
  },
  'answer-match': { type: 'object', properties: { runs: { type: 'integer', minimum: 1, maximum: 9 }, text: perClass(strArr) }, additionalProperties: false },
  'case-score': {
    type: 'object',
    properties: {
      weights: { type: 'object', required: ['tools', 'answer'], properties: { tools: { type: 'number', minimum: 0, maximum: 1 }, answer: { type: 'number', minimum: 0, maximum: 1 } }, additionalProperties: false },
    },
    additionalProperties: false,
  },
};

export const metricsFileSchema = {
  anyOf: [
    metric,
    { type: 'object', required: ['metrics'], properties: { metrics: { type: 'array', items: metric } }, additionalProperties: false },
  ],
} as const;
export const metricSchema = metric;

export const runSchema = {
  type: 'object',
  required: ['id', 'basket', 'agent', 'models'],
  properties: {
    id,
    title: str,
    basket: id,
    agent: id,
    models: {
      type: 'object',
      properties: { operator: str, judge: str },
      additionalProperties: false,
    },
    // Продолжить на тестовом операторе последнего завершённого прогона этой настройки (решение владельца от 27.10.2026).
    continueFrom: id,
    metrics: { anyOf: [{ enum: ['all'] }, strArr] },
    limits,
    repetitions: { type: 'integer', minimum: 1, maximum: 10 },
    startAt: str,
  },
  additionalProperties: false,
} as const;

export const contractSchema = {
  type: 'object',
  required: ['tools'],
  properties: {
    version: str,
    conditional: { type: 'boolean' },
    note: str,
    result: {
      type: 'object',
      properties: { mode: { enum: ['text', 'structured', 'both'] } },
      additionalProperties: false,
    },
    errors: {
      type: 'object',
      properties: {
        rejected: str,
        noStub: str,
        unknownTool: str,
        unknownTask: str,
        timeout: str,
        stopped: str,
      },
      additionalProperties: false,
    },
    startMessage: str,
    tools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'description', 'inputSchema'],
        properties: {
          // Поля MCP — как в tools/list оркестратора, агенту отдаются без изменений.
          name: str,
          title: str,
          description: str,
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          annotations: { type: 'object' },
          _meta: { type: 'object' },
          // Поля ClawGym — агенту не отдаются.
          requiresConfirmation: { type: 'boolean' },
          kind: { enum: ['info', 'action'] },
          enabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export const toolDefaultsSchema = {
  type: 'object',
  properties: { tools: { type: 'object', additionalProperties: { type: 'array', items: stub } } },
  additionalProperties: false,
} as const;

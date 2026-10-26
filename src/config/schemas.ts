// JSON Schema файлов настроек. Неизвестные поля дают предупреждение, а не ошибку:
// файлы, написанные для следующих версий, продолжают загружаться.

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
  required: ['id', 'title', 'topic', 'start'],
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
        protocolVersion: str,
        taskIdFrom: { type: 'array', items: { enum: ['header', 'meta', 'argument'] } },
      },
      additionalProperties: false,
    },
    model: {
      type: 'object',
      properties: { switch: { enum: ['none', 'request'] }, path: str, fixed: str },
      additionalProperties: false,
    },
    sessions: {
      type: 'object',
      properties: { max: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    skills: {
      type: 'object',
      required: ['installer'],
      properties: {
        installer: { enum: ['none', 'directory', 'http'] },
        note: str,
        root: str,
        skillsDir: str,
        pendingDir: str,
        reportsDir: str,
        baseUrl: str,
        headers: strMap,
      },
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
    roles: { type: 'array', minItems: 1, items: { enum: ['agent', 'operator', 'judge'] } },
    provider: { enum: ['openai-compatible', 'anthropic', 'deployment', 'agent-request'] },
    baseUrl: str,
    apiKey: str,
    model: str,
    headers: strMap,
    description: str,
    params: {
      type: 'object',
      properties: {
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        maxTokens: { type: 'integer', minimum: 64 },
        timeoutMs: { type: 'integer', minimum: 1000 },
        retries: { type: 'integer', minimum: 0, maximum: 10 },
        responseFormat: { enum: ['json_schema', 'json_object', 'none'] },
        effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        fallbacks: { enum: ['default', 'off'] },
        devHints: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

export const skillsetSchema = {
  type: 'object',
  required: ['id', 'title', 'versions'],
  properties: {
    id,
    title: str,
    description: str,
    compatibility: {
      type: 'object',
      properties: { agent: str, learningKit: str },
      additionalProperties: false,
    },
    versions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'path'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9._-]+$' },
          path: str,
          createdAt: str,
          source: {
            type: 'object',
            properties: { kind: { enum: ['import', 'training', 'manual'] }, note: str, from: str, run: { type: 'integer' } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
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
      properties: { agent: str, operator: str, judge: str },
      additionalProperties: false,
    },
    skillset: {
      anyOf: [
        { enum: ['build', 'none'] },
        { type: 'null' },
        {
          type: 'object',
          required: ['id', 'version'],
          properties: { id, version: str },
          additionalProperties: false,
        },
      ],
    },
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
          name: str,
          description: str,
          inputSchema: { type: 'object' },
          requiresConfirmation: { type: 'boolean' },
          kind: { enum: ['info', 'action'] },
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

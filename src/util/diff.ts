// Построчное сравнение файлов скиллов: число добавленных и удалённых строк и unified-фрагмент.

export interface LineDiff {
  added: number;
  removed: number;
  unified: string;
}

export function diffLines(a: string, b: string, context = 2): LineDiff {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  const n = x.length;
  const m = y.length;
  // LCS по таблице: файлы скиллов небольшие.
  if (n * m > 4_000_000) {
    return { added: m, removed: n, unified: '(файлы слишком велики для построчного сравнения)' };
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ t: ' ', s: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', s: x[i++] });
    } else {
      ops.push({ t: '+', s: y[j++] });
    }
  }
  while (i < n) ops.push({ t: '-', s: x[i++] });
  while (j < m) ops.push({ t: '+', s: y[j++] });

  const added = ops.filter((o) => o.t === '+').length;
  const removed = ops.filter((o) => o.t === '-').length;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t !== ' ') for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = true;
  });
  const lines: string[] = [];
  let gap = false;
  ops.forEach((o, k) => {
    if (keep[k]) {
      lines.push(`${o.t}${o.s}`);
      gap = false;
    } else if (!gap) {
      lines.push('@@');
      gap = true;
    }
  });
  return { added, removed, unified: lines.join('\n') };
}

export interface TreeChange {
  path: string;
  kind: 'added' | 'modified' | 'removed';
  added: number;
  removed: number;
  unified?: string;
}

export function diffTrees(
  before: { path: string; sha256: string; content?: string }[],
  after: { path: string; sha256: string; content?: string }[],
  withUnified = true,
): TreeChange[] {
  const a = new Map(before.map((f) => [f.path, f]));
  const b = new Map(after.map((f) => [f.path, f]));
  const out: TreeChange[] = [];
  for (const [p, fb] of b) {
    const fa = a.get(p);
    if (!fa) {
      const lines = (fb.content ?? '').split(/\r?\n/).length;
      out.push({ path: p, kind: 'added', added: lines, removed: 0, unified: withUnified ? (fb.content ?? '').split(/\r?\n/).map((l) => '+' + l).join('\n') : undefined });
    } else if (fa.sha256 !== fb.sha256) {
      const d = diffLines(fa.content ?? '', fb.content ?? '');
      out.push({ path: p, kind: 'modified', added: d.added, removed: d.removed, unified: withUnified ? d.unified : undefined });
    }
  }
  for (const [p, fa] of a) {
    if (!b.has(p)) {
      const lines = (fa.content ?? '').split(/\r?\n/).length;
      out.push({ path: p, kind: 'removed', added: 0, removed: lines });
    }
  }
  return out.sort((p, q) => p.path.localeCompare(q.path));
}

import type { Cue } from './types';

/**
 * 合并双语轨：当前字幕为主轨，另一份 WebVTT 为副轨。
 *
 * 仅当主、副片段时间有交集，且交集时长不短于较短片段时长的 50% 时，
 * 二者才构成候选配对。随后在“保持双方顺序、每条片段最多使用一次”的
 * 约束下求总交集时长最大的配对（加权序列对齐 DP）；总分并列时选择
 * 副轨索引序列字典序更小的方案。
 */

const EPS = 0.0005; // 0.5ms，吸收浮点噪声
/** 候选阈值：交集时长 / 较短片段时长 */
export const OVERLAP_RATIO = 0.5;

export interface MergePair {
  primaryId: string;
  /** 副轨 0 基索引（面板展示时 +1） */
  secondaryIndex: number;
  /** 时间交集时长（秒） */
  overlap: number;
  /** 交集时长 / 较短片段时长（≥ OVERLAP_RATIO） */
  ratio: number;
}

export interface MergePlan {
  /** 主轨序列（按开始时间排序，与解析顺序无关） */
  primary: Cue[];
  /** 副轨序列（按开始时间排序） */
  secondary: Cue[];
  /** 最优配对，按主轨顺序排列；每个主/副片段至多出现一次 */
  pairs: MergePair[];
  /** 未参与配对的副轨 0 基索引（确认时这些内容不会写入） */
  unmatchedSecondary: number[];
  /** 总交集时长（秒） */
  totalOverlap: number;
}

const byTime = (a: Cue, b: Cue) => a.start - b.start || a.end - b.end;

/** 交集时长（秒）；无交集返回 0 */
export function overlapOf(primary: Cue, secondary: Cue): number {
  return Math.max(0, Math.min(primary.end, secondary.end) - Math.max(primary.start, secondary.start));
}

/** 判定二者是否为候选配对：有交集且交集 ≥ 较短片段时长的 50% */
export function isCandidate(primary: Cue, secondary: Cue): boolean {
  const ov = overlapOf(primary, secondary);
  if (ov <= EPS) return false;
  const shorter = Math.min(primary.end - primary.start, secondary.end - secondary.start);
  return shorter > EPS && ov >= shorter * OVERLAP_RATIO - EPS;
}

/** 持久化配对序列节点（头尾结构共享，便于字典序比较） */
interface SeqNode {
  i: number;
  j: number;
  len: number;
  tail: SeqNode | null;
}

/**
 * 比较两条副轨索引序列的字典序（元素逐位比较；前缀较短者更小）。
 * 节点身份相同（结构共享）时 O(1)。
 */
function compareSeq(a: SeqNode | null, b: SeqNode | null): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const la = a.len;
  const lb = b.len;
  const va = new Int32Array(la);
  const vb = new Int32Array(lb);
  let p: SeqNode | null = a;
  for (let k = la - 1; k >= 0 && p; k--, p = p.tail) va[k] = p.j;
  p = b;
  for (let k = lb - 1; k >= 0 && p; k--, p = p.tail) vb[k] = p.j;
  const n = Math.min(la, lb);
  for (let k = 0; k < n; k++) {
    if (va[k] !== vb[k]) return va[k] - vb[k];
  }
  return la - lb;
}

/**
 * 计算最优配对。
 *
 * 后缀 DP（对齐网格 (m+1) × (n+1)）：
 *   best[i][j] = 仅使用主轨 i..m-1、副轨 j..n-1 时可取得的最大总交集时长；
 *               转移 = 跳过主 i、跳过副 j、或配对 (i,j) 三者取大。
 *   firstCol[i][j] = 取得 best 的路径中，首对配对的最小副轨列号
 *               （由三个转移来源直接取最小，O(1)）。
 * 回溯时在每列的可行主轨行中递归比较后续序列，整体取字典序最小。
 */
export function planMergeBilingual(primaryIn: Cue[], secondaryIn: Cue[]): MergePlan {
  const primary = [...primaryIn].sort(byTime);
  const secondary = [...secondaryIn].sort(byTime);
  const m = primary.length;
  const n = secondary.length;
  const W = n + 1;

  // 候选与权重（0 表示不可配对）
  const weight = Array.from({ length: m }, () => new Float64Array(n));
  const ratioTable = Array.from({ length: m }, () => new Float64Array(n));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const ov = overlapOf(primary[i], secondary[j]);
      const shorter = Math.min(
        primary[i].end - primary[i].start,
        secondary[j].end - secondary[j].start,
      );
      const ratio = shorter > EPS ? ov / shorter : 0;
      if (ov > EPS && shorter > EPS && ratio >= OVERLAP_RATIO - EPS) {
        weight[i][j] = ov;
        ratioTable[i][j] = ratio;
      }
    }
  }

  const best = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  // -1 = 不存在取得正分的路径
  const firstCol = Array.from({ length: m + 1 }, () => new Int32Array(n + 1).fill(-1));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const viaSkipI = best[i + 1][j];
      const viaSkipJ = best[i][j + 1];
      const w = weight[i][j];
      const viaPair = w > 0 ? w + best[i + 1][j + 1] : 0;
      const v = Math.max(viaSkipI, viaSkipJ, viaPair);
      best[i][j] = v;
      if (v <= EPS) continue;

      let col = n + 1;
      if (w > 0 && Math.abs(viaPair - v) <= EPS) col = j;
      if (Math.abs(viaSkipI - v) <= EPS && firstCol[i + 1][j] >= 0) {
        col = Math.min(col, firstCol[i + 1][j]);
      }
      if (Math.abs(viaSkipJ - v) <= EPS && firstCol[i][j + 1] >= 0) {
        col = Math.min(col, firstCol[i][j + 1]);
      }
      firstCol[i][j] = col <= n ? col : -1;
    }
  }

  // 记忆化：f(i,j) = 网格 (i,j) 中取得 best[i][j] 的字典序最小配对序列
  const memo = new Map<number, SeqNode | null>();
  function f(i: number, j: number): SeqNode | null {
    const key = i * W + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: SeqNode | null = null;
    const v = best[i][j];
    const jj = firstCol[i][j];
    if (v > EPS && jj >= 0) {
      // 首列已确定为 jj；在该列所有可行主轨行中取后续序列字典序最小者
      for (let ii = i; ii < m; ii++) {
        const w = weight[ii][jj];
        if (w <= 0) continue;
        if (Math.abs(w + best[ii + 1][jj + 1] - v) > EPS) continue;
        const tail = f(ii + 1, jj + 1);
        if (!result || compareSeq(tail, result.tail) < 0) {
          result = { i: ii, j: jj, len: (tail?.len ?? 0) + 1, tail };
        }
      }
    }
    memo.set(key, result);
    return result;
  }

  const pairs: MergePair[] = [];
  for (let node = f(0, 0); node; node = node.tail) {
    pairs.push({
      primaryId: primary[node.i].id,
      secondaryIndex: node.j,
      overlap: weight[node.i][node.j],
      ratio: ratioTable[node.i][node.j],
    });
  }

  const matchedSecondary = new Set(pairs.map((p) => p.secondaryIndex));
  const unmatchedSecondary: number[] = [];
  for (let j = 0; j < n; j++) {
    if (!matchedSecondary.has(j)) unmatchedSecondary.push(j);
  }

  return {
    primary,
    secondary,
    pairs,
    unmatchedSecondary,
    totalOverlap: m > 0 && n > 0 ? best[0][0] : 0,
  };
}

/**
 * 确认合并：仅将配对副轨文本作为新一行追加到对应主轨片段；
 * 保留主轨时间、标识符、cue 设置与锁定状态。
 * 未配对的主/副内容均不写入；不修改输入数组。
 */
export function applyMergeBilingual(cues: Cue[], plan: MergePlan): Cue[] {
  if (plan.pairs.length === 0) return cues;
  const byPrimary = new Map(plan.pairs.map((p) => [p.primaryId, p]));
  return cues.map((c) => {
    const pair = byPrimary.get(c.id);
    if (!pair) return c;
    const secondaryText = plan.secondary[pair.secondaryIndex]?.text ?? '';
    return { ...c, text: `${c.text}\n${secondaryText}` };
  });
}

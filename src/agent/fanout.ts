/**
 * Fan-out guard.
 *
 * Decides whether one user prompt should be split into several sequential
 * sub-tasks. Fan-out is OPT-IN: the default is one coherent turn, and a prompt
 * only fans out when the user explicitly asks for it —
 *
 *   1. explicit parallelism   ("并行处理…", "in parallel", "concurrently"), or
 *   2. an explicit task list  (one numbered/bulleted item per line, and the
 *      items are actually instructions).
 *
 * There is deliberately no "conjunction implies multiple tasks" rule. Session
 * 044031dc proved why: a single image request (345 chars, 18 occurrences of
 * 和/与/，) was split into 9 sub-tasks, one per sentence of the artwork
 * description, because surface tokens were mistaken for intent. A false
 * positive costs N full turns and produces meaningless fragments, so the guard
 * errs toward "single turn".
 */

/** Imperative verbs that can open an action sentence ("生成…", "分析…"). */
export const ACTION_VERBS =
  '分析|对比|比较|读取|生成|处理|查找|查询|提取|创建|编辑|删除|修改|更新|添加|补充|' +
  '移除|重命名|迁移|同步|上传|下载|提交|发布|归档|备份|恢复|总结|翻译|解释|解决|修复|' +
  '实现|开发|构建|重构|编写|写|画|绘制|设计|制作|整理|列出|扫描|检查|校验|验证|统计|计算|' +
  '优化|测试|部署|安装|保存|导出|转换|合并|拆分|清理';

const LEAD_IN =
  /^(?:请|请你|帮我|帮忙|麻烦|然后|接着|再次?|并|并且|同时|分别|先|最后|另外|以及|please|then|and|also)\s*/gi;

/** Explicit "run these in parallel" directives (6 UN languages). */
const PARALLEL_PATTERNS = [
  /并行/,
  /同时\s*(?:执行|处理|运行)/i,
  /分别\s*(?:执行|处理)/i,
  /\bin parallel\b/i,
  /\bparallel(?:ly)?\b/i,
  /\bconcurrent(?:ly)?\b/i,
  /\bsimultaneous(?:ly)?\b/i,
  /\bparallèlement\b/i,
  /\bsimultanément\b/i,
  /\bпараллельно\b/i,
  /\bодновременно\b/i,
  /\bparalelamente\b/i,
  /\bsimultáneamente\b/i,
  /\bبالتوازي\b/,
  /\bفي نفس الوقت\b/,
];

/** One list item per line: "1. …", "1) …", "- …", "任务 1：…", "Task 1: …". */
const LIST_ITEM =
  /^\s*(?:\d{1,2}[.、)）]|[-*•]\s+|(?:任务|task|tâche|tarea|задача|مهمة)\s*\d{1,2}\s*[:：.、]?)\s*(.+)$/i;

/**
 * A request for one artifact ("生成1张图片", "画一幅海报", "write a poem") is
 * atomic: every following sentence is a requirement for that one artifact, not
 * an independent task. No trigger may split it.
 */
export function isSingleArtifactRequest(prompt: string): boolean {
  const zh = new RegExp(
    '(?:生成|绘制|画出|画|创作|设计|制作|做|写|合成|渲染|出)\\s*(?:一|1|两|2)?\\s*' +
      '(?:张|幅|个|份|首|篇|段|支)?\\s*' +
      '(?:图片|图像|照片|插画|海报|封面|logo|标志|图标|视频|音频|诗|歌词|文章|文案|故事)',
    'i',
  );
  const en =
    /\b(?:generate|create|draw|render|design|make|write|produce)\s+(?:a|an|one|1|two|2)?\s*(?:image|picture|photo|illustration|poster|logo|icon|video|audio|song|poem|essay|story|article)\b/i;
  return zh.test(prompt) || en.test(prompt);
}

/**
 * Split a prompt into sentences. Deliberately NOT splitting on `和/与/，/、`:
 * those join nouns inside one clause ("冷蓝与暖橙对比") and were the reason
 * descriptive prose used to fragment into one sub-task per phrase.
 */
export function splitSentences(prompt: string): string[] {
  return prompt
    .split(/[。；;!?！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when the sentence opens with an imperative verb (after lead-ins). */
export function isActionSentence(sentence: string): boolean {
  let s = sentence;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(LEAD_IN, '');
    if (next === s) break;
    s = next;
  }
  return new RegExp(`^(?:${ACTION_VERBS})`).test(s);
}

/**
 * Statement-like prompts (a conjunction but no action verb anywhere) merely
 * describe or compare concepts; they belong in one reasoning turn.
 */
export function isDeclarativePrompt(prompt: string): boolean {
  const hasConjunction = /(?:和|与|以及|、|&|and)/i.test(prompt);
  const hasVerb = new RegExp(ACTION_VERBS, 'i').test(prompt);
  return hasConjunction && !hasVerb;
}

/** Extract one-per-line list items (markers stripped). */
export function extractListItems(prompt: string): string[] {
  const items: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    const m = line.match(LIST_ITEM);
    const item = m?.[1]?.trim();
    if (item) items.push(item);
  }
  return items;
}

/** Explicit task list: ≥2 items on their own lines, each an instruction. */
export function hasExplicitTaskList(prompt: string): boolean {
  return extractListItems(prompt).filter(isActionSentence).length >= 2;
}

export function hasParallelDirective(prompt: string): boolean {
  return PARALLEL_PATTERNS.some((p) => p.test(prompt));
}

/**
 * Whether the prompt should enter the fan-out path at all. Only explicit
 * signals qualify; everything else runs as a single turn.
 */
export function shouldUseFanout(prompt: string): boolean {
  if (isSingleArtifactRequest(prompt)) return false;
  if (isDeclarativePrompt(prompt)) return false;
  return hasExplicitTaskList(prompt) || hasParallelDirective(prompt);
}

/**
 * Decompose a prompt into sub-task prompts.
 *
 * Returns `[]` when the prompt must stay a single turn. Preference order:
 * explicit one-per-line list → action sentences. A flood of fragments is
 * treated as prose, not a task list.
 */
export function planFanoutClauses(prompt: string): string[] {
  if (!shouldUseFanout(prompt)) return [];

  const listed = extractListItems(prompt);
  const actionItems = listed.filter(isActionSentence);
  const parts =
    actionItems.length >= 2
      ? actionItems
      : splitSentences(prompt).filter(isActionSentence);

  // A long prompt that happens to contain two verbs is usually still prose.
  // Real multi-task prompts are bounded; treat a flood of fragments as one.
  if (parts.length <= 1 || parts.length > 6) return [];
  return parts;
}

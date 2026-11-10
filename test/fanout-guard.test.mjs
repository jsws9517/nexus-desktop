/**
 * Fan-out guard — regression tests for task-splitting.
 *
 * Session 044031dc ("image-gen") is the reference bug: one request to generate
 * one image was split into 9 sub-tasks because the prompt contained 。 and
 * several 和/与 conjunctions. Each fragment was a sentence of the artwork
 * description, so none of them was an executable task.
 *
 * Fan-out is now opt-in: only an explicit per-line task list or an explicit
 * parallelism directive may split; everything else is one coherent turn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  isSingleArtifactRequest,
  splitSentences,
  isActionSentence,
  shouldUseFanout,
  planFanoutClauses,
} = await import('../dist/agent/fanout.js');

const IMAGE_PROMPT =
  '帮我按照以下文案，生成1张图片：\n' +
  '一幅超写实风格的雨夜东京街头摄影作品，35mm 胶片质感，轻微颗粒感。' +
  '画面中央是一位穿着透明黄色雨衣的年轻女孩，正低头看着手中发光的复古翻盖手机，雨滴悬停在手机屏幕上方。' +
  '她身后是一家狭小的拉面店，暖橙色灯光从半开的门缝溢出，门帘上印着清晰的日文汉字"拉面"。' +
  '湿漉漉的柏油路面反射着霓虹招牌的倒影——左侧是红色居酒屋灯笼，右侧是蓝绿色药妆店灯箱。' +
  '街角自动贩卖机的冷白光与暖色街灯形成对比。' +
  '画面右下角有一只橘猫蹲在纸箱上，毛发被雨水打湿。' +
  '构图采用低角度仰拍，景深较浅，背景虚化但保留霓虹光斑。' +
  '整体色调偏冷蓝与暖橙对比，电影感强，暗部保留细节，高光不过曝。' +
  '画面中需要出现至少三处可辨认的文字：拉面店门帘的"拉面"、居酒屋灯笼上的"酒"、药妆店灯箱上的"24H"。';

describe('fan-out guard', () => {
  it('treats a one-image request as a single atomic task', () => {
    assert.equal(isSingleArtifactRequest(IMAGE_PROMPT), true);
    assert.equal(shouldUseFanout(IMAGE_PROMPT), false);
    assert.deepEqual(planFanoutClauses(IMAGE_PROMPT), []);
  });

  it('does not fan out a single prompt just because it has several action verbs', () => {
    const p =
      '分析当前目录下的 package.json 和 README.md 和 tsconfig.json，分别提取：' +
      '1) 项目名称和版本 2) 主要功能描述 3) TypeScript配置特点，最后对比三个文件的关键信息';
    assert.equal(shouldUseFanout(p), false);
    assert.deepEqual(planFanoutClauses(p), []);
  });

  it('does not split implicit multi-action prose (explicit signals only)', () => {
    const p = '分析 src 目录的模块依赖。然后生成一份依赖关系报告。';
    assert.equal(shouldUseFanout(p), false);
    assert.deepEqual(planFanoutClauses(p), []);
  });

  it('splits an explicit one-per-line task list', () => {
    const p =
      '请并行完成以下任务：\n' +
      '1. 分析 src 目录的模块依赖\n' +
      '2. 生成依赖关系报告\n' +
      '3. 更新 README 的架构说明';
    assert.equal(shouldUseFanout(p), true);
    assert.deepEqual(planFanoutClauses(p), [
      '分析 src 目录的模块依赖',
      '生成依赖关系报告',
      '更新 README 的架构说明',
    ]);
  });

  it('does not treat an inline checklist as a task list', () => {
    const p = '提取：1) 名称 2) 版本 3) 描述。最后对比三个文件';
    assert.equal(shouldUseFanout(p), false);
    assert.deepEqual(planFanoutClauses(p), []);
  });

  it('ignores a list whose items are not instructions', () => {
    const p = '配色方案：\n1. 冷蓝\n2. 暖橙\n3. 灰白';
    assert.equal(shouldUseFanout(p), false);
    assert.deepEqual(planFanoutClauses(p), []);
  });

  it('honours an explicit parallel directive', () => {
    assert.equal(shouldUseFanout('请并行处理这两个构建任务'), true);
    assert.equal(shouldUseFanout('Run the two builds in parallel'), true);
  });

  it('cannot split a parallel directive that has no separable instructions', () => {
    // Explicit opt-in, but there is nothing to cut: falls back to one turn.
    assert.equal(shouldUseFanout('请并行处理这两个构建任务'), true);
    assert.deepEqual(planFanoutClauses('请并行处理这两个构建任务'), []);
  });

  it('keeps an atomic artifact request atomic even with a parallel word', () => {
    const p = '并行生成1张图片：雨夜东京街头，女孩与猫。';
    assert.equal(shouldUseFanout(p), false);
    assert.deepEqual(planFanoutClauses(p), []);
  });

  it('treats a flood of list items as prose, not a task list', () => {
    const p =
      '请并行处理：\n' +
      Array.from({ length: 8 }, (_, i) => `${i + 1}. 分析第 ${i + 1} 个文件`).join('\n');
    assert.deepEqual(planFanoutClauses(p), []);
  });

  it('splits sentences on terminators but not on 和/与/，', () => {
    assert.deepEqual(splitSentences('A和B，C与D。E；F'), ['A和B，C与D', 'E', 'F']);
    assert.equal(isActionSentence('生成一张图片：女孩与猫'), true);
    assert.equal(isActionSentence('冷蓝与暖橙对比'), false);
  });
});

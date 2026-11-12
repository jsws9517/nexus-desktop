# Scheduled Automations — Natural-Language Usage Guide / 定时任务·自然语言使用指南

Bilingual quick reference for the six automation tools. You never need to name a
tool or a field — say what you want, in your own words.
双语快速参考。六个自动化工具无需点名、无需填字段——用你自己的话描述要做什么即可。

---

## / 总览 Overview

| # | Tool / 工具 | What it does / 作用 | Say something like / 你可以这样说 |
|---|---|---|---|
| 1 | `automation_create` | Create a scheduled task / 新建定时任务 | "帮我建个任务：每天晚上10点生成日报" / "Set up a task that runs every morning at 9" |
| 2 | `automation_list` | See all tasks / 查看所有任务 | "看下我有哪些任务" / "List my scheduled tasks" |
| 3 | `automation_update` | Change / pause a task / 修改或暂停任务 | "把日报任务改到中午12点" / "Change that task to noon, and pause the other one" |
| 4 | `automation_delete` | Delete a task + its history / 删除任务及运行历史 | "不要那个磁盘检查任务了" / "Delete that disk-check task" |
| 5 | `automation_run_now` | Run a task immediately / 立即手动运行一次 | "把日报任务现在跑一下" / "Run the daily report right now" |
| 6 | `automation_runs` | Check run history / 查看运行历史 | "日报任务最近跑过几次，成功了吗" / "Has the weekly report run recently? Did it succeed?" |

All six are reachable from plain natural language (no jargon needed) because the
tool router carries colloquial trigger words for each one.
六个工具都可从纯自然语言触发（无需术语）：路由表为每个工具都挂了口语化触发词。

Typical flow / 典型闭环:
**list** to locate ("那个日报任务" → its id) → **create** / **update** /
**run_now** to act → **runs** to verify → **delete** to clean up.
**list** 定位 → **create/update/run_now** 操作 → **runs** 验证 → **delete** 清理。

---

## 1. Create / 新建任务 (`automation_create`)

**Chinese phrasings that trigger it / 中文自然说法：**
"帮我建一个每天早上9点的任务…" · "每周一早上8点帮我跑一下周报汇总" ·
"建个任务，每隔30分钟检查一次磁盘空间" · "定期帮我提醒…"

**English phrasings / 英文自然说法：**
"Set up a scheduled task that …" · "Run X every morning at 9" ·
"Check disk space every 30 minutes"

What to give it / 需要说清三件事：

- **Name / 名字** — a short label: "日报生成". / 短标签，如 "daily-report".
- **What to do / 做什么** — the instruction text, as concrete as you like:
  "读取 D:\…\日常备份 里当天日期的目录，生成日报 Word 存到 D:\…\out".
  路径、格式、输出位置写得越具体，运行结果越好。
- **When / 什么时候** — a fixed clock time, a day-of-week, or an interval
  (see below / 固定钟点、星期几、或间隔，见下节).

`profile` is optional — office read/write tools stay available on every run,
so you never have to mention it. 无需说 "profile 用 office"：所有定时运行都会
自动保留 Office 读写工具。

### Time words → schedule / 时间说法 → 排程

| You say / 你说 | Stored as / 存为 |
|---|---|
| 每天晚上10点 / "every night at 10pm" | cron `0 22 * * *` (24-hour clock / 24 小时制，10pm = 22) |
| 中午12点 / "noon" | cron `0 12 * * *` |
| 下午3点 / "3pm" | cron `0 15 * * *` |
| 每周一早上8点 / "Mondays at 8am" | cron `0 8 * * 1` (Mon=1 … Sun=0/7) |
| 每隔30分钟 / "every 30 minutes" | interval `everyMs: 1800000` |
| 每小时 / "every hour" | interval `everyMs: 3600000` |

> **12-hour clock is translated, not literal / 12 小时制会被正确翻译：**
> "晚上10点" becomes **22:00**, never 10:00. After creation you get the
> computed next-fire time to double-check: 创建后结果会回显机器计算的下一次
> 触发时间，例如 `next fire: 2026-11-13 22:00 Asia/Shanghai` —
> 一眼核对"10点"是不是 22 点。
>
> Timezone / 时区: omitted = host local time / 缺省 = 本机时区；
> 点名城市则显式给时区（如 `Asia/Shanghai`）。

> **Missed runs / 错过运行:** tasks fire only while the app is running.
> A missed cron fire is skipped by default (`missPolicy: "skip"`);
> `"catchup"` re-runs one missed fire within a grace window.
> 任务只在应用运行时触发；默认跳过错过的触发（skip），可选 catchup
> 在宽限期内补跑一次。

## 2. List / 查看任务 (`automation_list`)

"看下我有哪些任务" · "列一下任务" · "我的定时任务都在干嘛" /
"List my scheduled tasks" · "What automations do I have?"

Returns every task (enabled and paused) with schedule, profile, and last-updated
time. 返回全部任务（含已暂停）的排程、profile 与更新时间。

## 3. Update / 修改·暂停 (`automation_update`)

"把日报任务改到每天中午12点" · "那个任务时间调一下" · "先停掉周报任务" /
"Change the daily report to noon" · "Pause that one for now"

- Only the fields you mention change / 只改你提到的字段（时间、提示词、目录…）。
- **Pause without deleting / 暂停不删除:** "先停掉" → `enabled: false`;
  restart the same way. 说"停掉/暂停"会用 enabled=false，随时可恢复。
- Changing the time triggers the same next-fire echo as create, so a wrong
  12h→24h conversion is caught before you confirm.
  改时间同样回显下次触发时间，12h/24h 转错当场可见。

## 4. Delete / 删除 (`automation_delete`)

"把那个磁盘检查任务删了" · "不要那个任务了" /
"Delete that disk-check task"

Removes the task **and all its run history** — unlike pause, this is
irreversible. 删除任务**及其全部运行历史**，不可恢复；"先不要了"一般用
update 暂停，明确说"删"才走这里。

## 5. Run now / 立即运行 (`automation_run_now`)

"把日报任务现在跑一下" · "先手动跑一次周报任务" /
"Run the daily report right now" · "Manually trigger that one"

Bypasses the schedule and runs immediately. If a run for that task is already
in flight you get a busy result instead of a duplicate.
绕过排程立即执行；该任务已有运行在飞时返回 busy，不会重复执行。
验收一个新任务（acceptance）最常用这个。

## 6. Runs / 运行历史 (`automation_runs`)

"日报任务最近跑过几次" · "看下任务运行记录，有没有失败的" /
"Has the daily report run recently?" · "Any failed runs?"

Per run: status (`succeeded` / `failed` / `timeout` / `missed`), start/end
times, summary, and error. A run that stalled without producing output is
recorded as **failed with a diagnostic summary**, never a false green.
每条记录含状态（succeeded/failed/timeout/missed）、起止时间、摘要与错误；
没有产出物的死路运行会被记为 failed + 诊断摘要，不会假绿。

---

## End-to-end example / 完整示例

**You / 你说：**
> 帮我建个任务，名字叫"日报生成"：每天晚上10点，读取 D:\广东移动结构优化\日常备份
> 里当天日期时间戳的目录，生成当天的日报 Word 文档，存到 D:\项目周报\out

**Result you get back / 你会收到的确认（含下次触发回显）：**
```
automation created: aut_mwdkerpbusse
  name:    日报生成
  schedule: cron "0 22 * * *"
  next fire: 2026-11-13 22:00 Asia/Shanghai (cron "0 22 * * *")
  profile: default
```

Then: "现在跑一下日报生成" → run now · "改成明天中午先跑一次试试" → update +
run now · "最近跑过的结果怎么样" → runs · "不要了" → delete.
随后："现在跑一下日报生成" → 立即运行 · "改到中午12点" → 修改 ·
"最近跑得怎么样" → 历史 · "不要了" → 删除。

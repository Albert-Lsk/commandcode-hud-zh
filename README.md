# commandcode-hud

## English overview

A single-line context HUD for Command Code — Chinese by default, English when the app interface language is English. It shows context usage, session spend, compaction count and reclaimed tokens, and the active tool. It warns about large tool results, ineffective compaction, and an oversized outgoing request payload — the ~23 MB zone where the gateway cuts streams with a 502 — and adapts its layout when the terminal is resized.

Install from the public GitHub repository:

```bash
cmd mods add Albert-Lsk/commandcode-hud-zh
```

Then `/reload` or start a new session. Use `/hud` for details. Output language follows the Command Code interface language (Chinese by default); override with `--mod-option lang=zh|en`.

Synthetic preview — these values are examples, not a real session:

```text
[deepseek-v4.1-flash·high] │ ctx ███████████░ 95% 996k/1.0M │ 📦 23.1MB │ $0.204 │ ⇄2 −438k │ ⚙ read_file
```

Cost comes from the current session transcript when it can be located; otherwise the HUD falls back to a bundled price-table estimate. Context limits also come from a bundled model table and can be overridden with `--mod-option ctx-limit=...`.

The mod makes no network requests and does not read authentication files. It reads local session usage and stores HUD counters through the session API; it does not persist tool-result bodies. Tests use synthetic session files. Before sharing `/hud` output, redact the session file path, model name, and usage figures if they are private.

## 中文说明

常驻在输入面板下方的**上下文仪表盘**。参照 [jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud) 的思路，改用 Command Code 的 ModApi 实现。

**它解决的痛点**：上下文溢出是**静默发生**的。自动压缩会悄悄跑很多次，界面上没有任何提示，直到某一条消息直接报 400 —— 而且此时 `continue` 只会让情况更糟。这个 mod 把那个盲区补上。

另一个盲区是**请求体积**：图片多的会话哪怕上下文百分比不高，序列化后的请求体也会堆到 20MB+ —— 网关直接 502 断流（公开 issue #991 / #997），相同体积重试同样失败，只有压缩能救。⑤ 把字节量也做成读数，在 502 区间之前先响。

```
[deepseek-v4.1-flash·high] │ ctx ███████████░ 95% 996k/1.0M │ 📦 23.1MB │ $0.204 │ ⇄2 −438k │ ⚙ read_file
```

从左到右：模型·推理档位 · 上下文进度条+百分比+绝对量 · 请求体估算（到门槛才出现）· 本 session 累计花费 · 压缩次数与累计回收量 · 当前工具。

## 五项能力

| | 做什么 | 数据来源 |
|---|---|---|
| ① **大结果预警** | 任何工具返回超过阈值（默认 100 KB）就提醒一次：这块内容会永久占上下文，还可能钉死压缩锚点 | `tool_completed.result` 的序列化体积 |
| ② **压缩健康度** | 比较压缩前后的上下文。**没降 = 压缩已失效**，连续 2 次就报警并给出处置建议 | `compaction_start` 时的体积 vs 压缩后第一笔请求 |
| ③ **压缩回收量** | 状态栏直接显示 `⇄2 −438k`，压缩到底救回多少一目了然 | `compaction_done.tokensSaved` |
| ④ **精确花费** | 读会话文件里 CLI 自己算的 `costUsd`，不是按价目表估算 | 会话 transcript 增量解析 |
| ⑤ **请求体预警** | 估算序列化后的请求体积（图片占大头），分档预警（黄 65% / 红 87% / 红线 100%），网关真在重试断流时点名「疑似体积」 | 会话日志活跃链字节和（复用压缩标记 + `firstKeptEntryId` 语义）+ 固定开销 |

**② 是里最关键的一条。** 事故的本质不是"用得慢"，而是**压了 9 次、地板一动不动**——界面上完全看不出来。只显示"压了几次"没用，得显示"压了之后有没有用"。

## 颜色档位（实测值，非估计）

```
   < 70%   🟢 绿
70–90%     🟡 黄
  ≥ 90%    🔴 红
```

`color-probe.ts` 可以把每个百分比下真正发出的 ANSI 码打出来，改阈值后跑一遍就知道有没有跑偏。

## 三条硬约束（先说清楚）

1. **只能单行。** 渲染走的是 `cmd.ui.setStatus`（TUI 底部常驻段），它会把换行和制表符压成空格。claude-hud 那种两行布局今天复刻不了。
2. **`cmd.ui.widget` 还不能用。** 官方文档明确写着 "Widgets are not wired into the TUI yet… they currently render nowhere"。等它接线了，可以把上下文条挪到编辑器上方做多行版。
3. **模型上下文上限不在 API 里。** 事件只给 `model` 和 `usage`，不给窗口大小。所以上限表是从随包的模型目录生成的，内联在 `hud.ts` 里（66 个模型）。**文档写 "1M"，实际是 2^20 = 1048576** —— 这里按实测值修正过。表里没有的模型回退到 1M，可用 `--mod-option ctx-limit=` 覆盖。

## 和同类 mod 的区别

Command Code 的 HUD/状态栏类 mod 已经有一批（`hu9osaez/commandcode-hud`、`cmd-statusline`、`command-code-mod-session-stats`、`cmd-footer`）。这个的差异只在两点，但两点都是真的：

1. **关注"什么时候会坏"，而不是"用了多少"。** 上面五项能力全是这个方向：大结果占位、压缩失效、回收量、精确花费、**请求体离 502 还有多远**。别的 HUD 告诉你 `45%`，这个告诉你是**怎么涨上去的、以及压不压得下来**。
2. **主动提醒，而不只是显示。** 70% / 85% / 90% 各响一次；大结果、压缩失效各自单独报警。默认中文，跟随 Command Code 界面语言可切英文（全部文案已双语）。

另外刻意做了两件"不做"：**不 patch CLI 的 dist**（CLI 自更新会冲掉，需要反复修）、**不读 `~/.commandcode/auth.json` 也不联网**。

## 安装

```bash
cmd mods add Albert-Lsk/commandcode-hud-zh      # 从 GitHub 装
```

或者手动丢文件：

```bash
cp hud.ts ~/.commandcode/mods/commandcode-hud.ts
```

然后在会话里 `/reload`（mods 每个进程只加载一次），或者开新 session。

确认已注册：

```bash
cmd mods list
# Mods (1)
#   commandcode-hud · user · ~/.commandcode/mods/commandcode-hud.ts
```

**禁用手动安装的版本**：删除 `~/.commandcode/mods/commandcode-hud.ts` 后 `/reload` 或重启会话，使当前进程卸载它。

## 用法

| 操作 | 说明 |
|---|---|
| 自动 | 每次模型响应 / 工具调用 / 压缩后自动刷新 |
| `/hud` | 打印一份详细快照（多行，含进度条、精度更高的花费、本轮工具数） |
| `/hud off` | 清空底部状态栏（下一轮会自动回来） |
| `--mod-option ctx-limit=200000` | 手动指定上下文上限（BYOK / 表里没有的模型） |
| `--mod-option ctx-width=20` | 进度条宽度，默认 12 |
| `--mod-option ctx-bar=ascii` | 进度条字形换成 `#-`。**字体渲染块字符不稳时用这个**（实测某些终端会把 `█░` 渲染成色块，看不出进度） |
| `--mod-option big-result-kb=200` | 大结果预警阈值（KB），默认 100，设 0 关闭 |
| `--mod-option payload-limit-mb=23` | 请求体红线（MB），默认 23；显示/黄/红按 10%/65%/87% 等比缩放，设 0 关闭 |
| `--mod-option lang=en` | 输出语言 zh / en；默认跟随 Command Code 界面语言（Settings → Interface language 或 `/language`），改完 `/reload` 生效 |

## 阈值提醒

每个 session 每档只响一次：

| 阈值 | 行为 |
|---|---|
| 70%（转黄）| 提示当前占比 |
| 85% | 建议**现在** `/compact`，别等自动压缩 |
| 90%（转红）| 警告：自动压缩的锚点一旦被大附件钉住就会失效；建议成果落盘后 `/clear`，或 `/rewind` 回到爆点之前 |

请求体三档（红线默认 23MB，`--mod-option payload-limit-mb=` 等比缩放显示/黄/红 10%/65%/87%）：

| 阈值 | 行为 |
|---|---|
| 65%（默认 15MB，转黄）| 提醒：已进入实测 502 观察带（本机 13.7MB 起有案例）|
| 87%（默认 20MB，转红）| 警告：公开复现口径「roughly 20 MB+」开始断流；建议落盘后 `/compact` |
| 100%（默认 23MB）| 危险：实测 502 尺寸（23.1MB 的请求 90% 是图片）；立即 `/compact` 或落盘后 `/clear` |

93% 那条的措辞是照着一次真实事故写的：某个 session 的 9 次自动压缩全部把锚点钉在同一张 389.9 KB 的截图上，导致压缩彻底失效、上下文地板卡在 4.26 MB，最后直接 400。

## 三个从实测里挖出来的坑

**1. 开发时的 `model_request_end` 事件不带 `costUsd`。** HUD 优先读取当前会话日志中的 `usage.costUsd`；无法定位会话文件时，才按随包价目表估算。如果事件提供 `costUsd`，会优先采用该值作为无会话文件时的兜底。`/hud` 会标明花费来源。估算口径中 `inputTokens` 已含 `cacheRead`（OpenAI 口径），先拆出缓存部分再计价，避免重复收费计算。

**2. `cmd.session` 在 factory 执行时是 `undefined`**，要等 host 绑定（`onSessionStart`）之后才有。所以读写都必须是**懒加载**，不能在 factory 顶层取。

**3. 客户端没有体积闸。** bundle 里没有任何请求体大小检查（唯一 413 是本地 OAuth 回调的小上限），图片发送时也不重压缩——502 是服务端掐流，客户端只在「流没等到 finish 事件」时合成一个 502 再重试。所以"提前预警"只能由 mod 自己算。

## 上下文百分比怎么算的

- **已用** = 最近一次响应的 `usage.inputTokens + usage.outputTokens`。下一次请求的输入大致就是这个数，所以它是「再问一轮会占多少」的真实预估。
- **上限** = `MODEL_CONTEXT[model]`，查不到就用 1048576，或被 `ctx-limit` 覆盖。

**已知偏差**：状态栏只在事件触发时刷新，所以它是「上一次模型调用时刻」的快照。一个跑了二十次工具调用、还没回到模型的回合，真实上下文会比显示的大。这是事件驱动的固有限制，不是 bug。

## 冷启动与持久化

mods 每个进程只加载一次，闭包里的计数器**活不过 `/reload`**。第一次装完 `/reload`，你会看到状态栏只有一个 `ctx —` —— 那是「mod 活着，但还没数据」，发一条消息就会填上。

为了不让它每次 reload 都失忆，HUD 用官方给的持久化接缝 `cmd.session` 把计数器写进会话文件：

- **写**：每个用户轮结束（`run_end`）落一次，压缩发生时也落一次。不会每轮模型调用都写。
- **读**：`onSessionStart` 时恢复，或者第一次渲染时懒加载。
- **一起恢复的还有「已提醒过的阈值」** —— 否则 reload 之后同一个档位会再响一次。

`cmd.session` 写进去的是 `custom` 条目，**永远不会送给模型**，也不会被渲染，只是挂在会话文件上。`--no-session` 或单元测试里 session 是 `undefined`，此时静默跳过，不影响运行。

**恢复不了的东西**：`本轮工具数` 是 run 级状态，reload 后归零（这是对的，它本来就该每轮清零）。

**⚠️ 已知的不确定性**：无头（`cmd -p`）环境下这套持久化**行为不一致** —— 实测同样的写入，有时落到会话文件、有时不落。所以别用 `-p` 验它，要用交互式会话。`/hud` 命令末行会打持久化诊断：

```
持久化 ✅ 可用　本进程写入 2 次　已读回 5 条
```

`已读回` 增长说明真的写进去了；一直是 0 就说明没落盘。

## 已知限制

- **状态栏只有一行。** `cmd.ui.widget`（多行、可放编辑器上方）在 API 里存在但**未接线**，官方文档写明 "they currently render nowhere"。
- **上下文数字是"上一次模型调用时刻"的快照。** 事件驱动，跑了一堆工具还没回到模型时，真实值会比显示的大。
- **精确花费需要定位会话文件。** `/reload` 之后拿不到 session id，靠写一条带 token 的探针条目反查（同 `estifie` 的做法）；找不到就退回价目表估算，`/hud` 里会标明来源。
- **压缩健康度需要两次采样。** 第一次压缩后如果立刻又压，可能来不及比较——这种情况按"无法判定"处理，不误报。
- **请求体是估算，不是实测。** 活跃链字节和 + 固定开销（系统提示 / 工具 schema / 请求字段，标定 ≈1.3MB）。`/rewind` 之后活跃叶变了，估算按 `cmd.sessions.leafId()` 校正；拿不到时才退回"最后一条记录"。502 也不只看体积：实测 13.7MB 炸过、25.9MB 也活过——它是风险读数，不是预言机。
- **语言在 mod 加载时解析。** 跟随 Command Code 界面语言（`/language` 改它），或 `--mod-option lang=` 强制；改完需 `/reload` 或开新会话（mods 每个进程只加载一次）。

## 一点坦白

离线测试有 30 项断言、全绿。但**每一次真机验证都还能抓到新问题**：

| 离线时的判断 | 真机打脸 |
|---|---|
| `/hud` 显示 v0.2.0，以为装的是新版 | 内存里跑的是最早那版 —— mods 每个进程只加载一次，`/reload` 之前一直在跑旧代码 |
| 状态栏按「终端宽度 − 1」就够 | 宿主的 `ModStatusLine` 是 `<Box paddingLeft={2}><Text wrap="truncate">`，可用宽度是 **− 2** |
| 有宽度自适应就不会被截断 | 拖动窗口**不是事件**，状态栏根本不重算，一直挂着旧宽度算出的那行 |
| 事件里的 `usage` 应该带 `costUsd` | 不带。只有会话日志里才有 —— 写文件探针才查明白 |

原因很实在：TUI 的边界只能在真机上看。宿主怎么渲染、按多宽截断、哪个 API 是空壳，文档都不写 —— 比如 `cmd.ui.widget`，文档只说"未接线"，bundle 里其实是 `()=>toDisposable(()=>{})`。

所以：**这个 mod 的行为以真机为准，不以测试为准。** 发现哪里不对，给截图最有用。

## 开发

```bash
# 本地测试台：用假的 ModApi 灌真实事件序列，打印每一步的渲染结果
node test-hud.ts

# 不安装直接试
cmd --mod ./hud.ts

# 改完重新加载
/reload
```

`test-hud.ts` 走的是 `hud.ts` 里真实的渲染与阈值逻辑（30 项断言），包括工具返回正文不进入状态栏、通知或持久化数据的隐私检查。

**只写可擦除语法。** Node 的类型剥离（strip-only）不支持参数属性、enum、namespace、装饰器 —— 用了会直接抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，`node test-hud.ts` 就跑不起来。全文件目前只用可擦除语法，这是刻意的。

### 更新模型上限表

表是从随包的模型目录生成的：

```bash
# 源文件（随 Command Code 版本走，路径里的 dist 可能变）
R=~/.npm-global/lib/node_modules/command-code/dist/bundled/command-code-knowledge/reference/models.md
```

改完把新的 `MODEL_CONTEXT` 重新内联进 `hud.ts`。`model-context.json` 是生成过程的中间产物。

## 边界

- **不用 `cmd.hooks` 改任何行为** —— 纯观察者（`cmd.on`），只读事件，不拦截工具、不改上下文。装它不会影响 agent 的决策。
- **无网络请求。** 只读事件负载和本地模型表。
- **mod 没有沙箱** —— 这是任意代码。渲染、事件监听、会话统计与模型表都在 `hud.ts` 中，可以直接检查源码。
- 日志别用 `console.log`：会污染 TUI。要调试就用 `cmd.ui.notify`，或跑 `test-hud.ts`。

## 许可

MIT。

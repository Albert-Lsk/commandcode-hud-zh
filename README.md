# commandcode-hud

常驻在输入面板下方的**上下文仪表盘**。参照 [jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud) 的思路，改用 Command Code 的 ModApi 实现。

**它解决的痛点**：上下文溢出是**静默发生**的。自动压缩会悄悄跑很多次，界面上没有任何提示，直到某一条消息直接报 400 —— 而且此时 `continue` 只会让情况更糟。这个 mod 把那个盲区补上。

```
[deepseek/deepseek-v4.1-flash] │ ctx ███████████░ 95% 996k/1.0M │ $0.204 │ ⇄2 │ ⚙ read_file
```

从左到右：模型·推理档位 · 上下文进度条+百分比+绝对量 · 本 session 累计花费 · **压缩次数** · 当前工具。

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

## 安装

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

**临时禁用**：删掉 `~/.commandcode/mods/commandcode-hud.ts` 即可，不用重启。

## 用法

| 操作 | 说明 |
|---|---|
| 自动 | 每次模型响应 / 工具调用 / 压缩后自动刷新 |
| `/hud` | 打印一份详细快照（多行，含进度条、精度更高的花费、本轮工具数） |
| `/hud off` | 清空底部状态栏（下一轮会自动回来） |
| `--mod-option ctx-limit=200000` | 手动指定上下文上限（BYOK / 表里没有的模型） |
| `--mod-option ctx-width=20` | 进度条宽度，默认 12 |
| `--mod-option ctx-bar=ascii` | 进度条字形换成 `#-`。**字体渲染块字符不稳时用这个**（实测某些终端会把 `█░` 渲染成色块，看不出进度） |

## 阈值提醒

每个 session 每档只响一次：

| 阈值 | 行为 |
|---|---|
| 70%（转黄）| 提示当前占比 |
| 85% | 建议**现在** `/compact`，别等自动压缩 |
| 90%（转红）| 警告：自动压缩的锚点一旦被大附件钉住就会失效；建议成果落盘后 `/clear`，或 `/rewind` 回到爆点之前 |

93% 那条的措辞是照着一次真实事故写的：某个 session 的 9 次自动压缩全部把锚点钉在同一张 389.9 KB 的截图上，导致压缩彻底失效、上下文地板卡在 4.26 MB，最后直接 400。

## 两个从实测里挖出来的坑

**1. 事件里的 `usage` 没有 `costUsd`。** 会话日志里的 usage 带 `costUsd`，但 `model_request_end` 事件不带。所以花费是**本地按单价算的**（定价表同样从随包模型目录生成，70 个模型）。口径：`inputTokens` 已含 `cacheRead`（OpenAI 口径），先拆出未缓存部分再计价，否则缓存命中的 token 会被按全价重复计算。若将来事件补上 `costUsd`，会优先用官方的。

**2. `cmd.session` 在 factory 执行时是 `undefined`**，要等 host 绑定（`onSessionStart`）之后才有。所以读写都必须是**懒加载**，不能在 factory 顶层取。

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

## 开发

```bash
# 本地测试台：用假的 ModApi 灌真实事件序列，打印每一步的渲染结果
node test-hud.ts

# 不安装直接试
cmd --mod ./hud.ts

# 改完重新加载
/reload
```

`test-hud.ts` 走的是 `hud.ts` 里真实的渲染与阈值逻辑，改完跑一遍就知道有没有回归。

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
- **mod 没有沙箱** —— 这是任意代码。这个文件只有 300 行，可以直接读完。
- 日志别用 `console.log`：会污染 TUI。要调试就用 `cmd.ui.notify`，或跑 `test-hud.ts`。

## 许可

MIT。

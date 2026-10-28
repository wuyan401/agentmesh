# 三个纯函数小工具 · 交付报告

> Mission M-000001 · Lead: dsh-02 · 5 张任务卡全部合并并通过二次验收

喏，搞定啦～ 你要的三个纯函数小工具已经全部落地在 `src/` 里，每个都带独立测试，全程零第三方依赖。

## 交付内容

| 函数 | 实现文件 | 独立测试 | 用例数 | 一句话说明 |
|---|---|---|---|---|
| `formatDuration(totalSeconds)` | `src/format-duration.js` | `test/format-duration.test.js` | 17 | 秒数 → `"1h 1m 1s"`；省略 0 单位，`0 → "0s"`；非法输入抛 `RangeError` |
| `slugify(input)` | `src/slug.js` | `test/slug.test.js` | 16 | 任意文本 → URL slug（trim → NFKD → 去音标 → 小写 → 分隔符折叠 → 去首尾 `-`）；空结果返回 `""` 不抛错 |
| `planBudget(income, expenses)` | `src/budget-planner.js` | `test/budget-planner.test.js` | 15 | 收入/支出明细 → `{ income, totalExpenses, remaining, isOverBudget, savingsRate }`；支持超支与零收入 |

统一入口：`src/index.js`，只做三行重导出，不含任何运行时逻辑。

```js
import { formatDuration, slugify, planBudget } from './src/index.js';

formatDuration(3661);                          // "1h 1m 1s"
slugify('Héllo, Wörld!');                      // "hello-world"
planBudget(1000, { rent: 400, food: 150 });    // remaining = 450
```

`README.md` 里已补上三个函数的签名、入参与示例，以及测试运行方式。

## 验收结果（本人独立复核，不采信各卡自述）

1. **三个函数都能从 `src/` 里 import** ✅
   在 `main@7b94582` 上用 Node v24.21.0 实际执行 `import { formatDuration, slugify, planBudget } from './src/index.js'`，三者 `typeof` 均为 `function`；入口恰好公开这三个具名导出，无 `default`。另抽检了正常值、超支、零收入、Unicode 文本等场景，行为符合契约。
2. **每个函数都有自己的测试，且测试全绿** ✅
   三个测试文件逐文件单独运行均 `exit 0`（17 / 16 / 15 条）；仓库根全量 `node --test --test-isolation=none` 为 **97 tests / 97 pass / 0 fail**，入口可导入性测试 `test/index.test.js` 6 条也全绿。
3. **不新增任何依赖** ✅
   `package.json` 顶层只有 `name / version / private / type / description / scripts`，无 `dependencies`、`devDependencies` 等任何依赖字段；无 lockfile、无 `node_modules`，实现与测试只用 Node 标准库（ESM、`node:test`、`node:assert/strict`）。

## 过程与质量节点

- 5 张卡全部走完「独立实现 → 独立审查 → scope 终审合并」链路，审查记录 R-0001~R-0004、R-0007 逐条给出可复核证据，合并均为 strict 模式、无文件被剥离。
- 依赖图清晰：契约骨架（`package.json`）→ 三个函数并行实现 → 入口导出 + 可导入性测试 + README 收口。
- 无 scope 越界、无违规记录；本 mission 未触发任何打回。

## 一个环境说明（不影响交付）

本沙箱禁止 Node 子进程读取管道，因此**裸 `node --test` 会因子进程 `spawn EPERM` 失败**——这是运行环境限制，不是代码问题。仓库里用的是标准 `node:test`，在任何正常环境裸跑 `node --test` 即可；在本沙箱内请用已验证的命令：

```bash
node --test --test-isolation=none
```

（本机 Node 不在 PATH，可用运行时：`D:\AI\DSH\apps\desktop\.desktop-build\development\home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）

## 小提示

`planBudget` 的支出项按 `Object.keys` 遍历，Symbol 键不参与合计；单个支出都要求是有限非负数，但极端情况下（如 `{a:1e308,b:1e308}`）合计可能溢出为 `Infinity`。这两点都不在本次验收要求内，属于已知边界；如果你希望「金额溢出也报错」或「支持 Symbol 键」，跟我说一声，我再开一张卡补上就好～

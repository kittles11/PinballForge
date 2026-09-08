# tools/selfchecks —— 自检套件（39 个）

每个 `selfcheck-*.ts` 是一个纯 Node 回归锁（零引擎依赖，个别经 hook 动态 import 纯数据模块），
锁定「文案↔实现一致性 / 防御性根修 / 数值锚点」，改任何战斗/UI 代码先跑套件再收工。
其中 `selfcheck-script-syntax.ts` 是语法卫生兜底（裸 doc 行 / 重复顶层导出 / 未闭合块注释 / @ccclass 冲突），
专防「编辑锚点错位」把源文件改出语法错误导致整批组件 MissingScript 的事故（2026-09-07 AudioManager 事故）。

## 运行（仓库根目录执行）

```bash
node --experimental-transform-types --import ./register-ts-hook.mjs tools/selfchecks/selfcheck-frost.ts
```

- `register-ts-hook.mjs` / `ts-resolve-hook.mjs` 固定在仓库根（hook 以自身 url 锚定，勿移动）；
- 部分脚本内部兜底 `register('../../ts-resolve-hook.mjs')`，允许不经 `--import` 直跑：
  `node --experimental-transform-types tools/selfchecks/selfcheck-frost.ts`；
- 退出码：0 全绿 / 1 有失败（Windows 偶发 libuv 退出码污染时以输出末行 ✅/❌ 为准）。

## 新增自检

1. 文件名 `selfcheck-<主题>.ts`，落在本目录（tsconfig glob 已排除，引擎编译零感知）；
2. 用 `process.cwd()` 或 `here + REPO_ROOT` 解析仓库根（勿硬编码 `./assets`）；
3. 断言三轨优先：行为真跑（纯数据模块）> 接线正则（stripComments 后）> 文案↔常量咬合；
4. 收工跑全套：`Get-ChildItem tools/selfchecks/selfcheck-*.ts | % { node --experimental-transform-types --import ./register-ts-hook.mjs $_ }`。

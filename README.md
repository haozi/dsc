# Tiny Harness CLI

一個由 pnpm workspace 與 Turborepo 管理、使用 Bun 執行、以 React + Ink 渲染的最小 CLI 框架。它保留了 DeepSeek Harness 最值得沿用的架構特徵，但刻意不帶入完整 agent、模型、持久化與 Web 層。

## 執行

```bash
pnpm install
pnpm start
```

互動模式中輸入 `help`、`echo hello`、`about`、`clear` 或 `exit`。

單次執行模式適合 shell script：

```bash
pnpm start -- run echo "hello world"
pnpm start -- run help
```

## 架構

```text
apps/cli/src/bin.tsx             解析外層模式，動態載入 surface
  └─ apps/cli/src/boot.ts        掛載 profile
      └─ profiles/default        組合 core 與 command plugins
          ├─ packages/core       framework-neutral services + effects
          ├─ CommandRegistry     可替換、可擴充的命令能力
          └─ Transcript          append-only events + subscriptions
  ├─ surfaces/tui.tsx            React/Ink 互動介面
  └─ surfaces/headless.ts        單次執行介面
```

這對應參考專案的四個原則：入口只分派；profile 負責組合；功能透過 service/plugin 掛載；UI 從事件投影而不是持有業務狀態。插件註冊都透過 `context.effect()`，runtime dispose 時會按相反順序卸載。

## 加一個命令

建立一個 plugin：

```ts
import type { Plugin } from '@tiny-harness/core'

export const helloPlugin: Plugin = {
  name: 'hello',
  apply(context) {
    context.effect(() =>
      context.require('commands').register({
        name: 'hello',
        description: 'Say hello',
        run: ([name = 'world']) => ({ output: `Hello, ${name}!` }),
      }),
    )
  },
}
```

然後把它加入 `apps/cli/src/profiles/default.ts` 的陣列即可。command 不依賴 React，因此同一個 plugin 會同時出現在 TUI 與 `run` 模式。

## 檢查

```bash
pnpm test
pnpm typecheck
pnpm lint
```

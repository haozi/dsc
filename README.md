# dsc

dsc 是以 TypeScript 實作的 coding agent CLI：命令介面對齊
[metacodes](https://github.com/metask-ai/metacodes)（headless `-p/--print`、
`--json`/`--stream-json` NDJSON、終端 REPL、`--web`/`serve`、`doctor`、
`login`/`logout`、`--version`、`--dump-prompt`/`--dump-plugins`、
`--check-providers`），架構則完整沿用 DeepSeek Harness（dsh）：
[cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) 插件框架、Loader
entry tree、profile = 空的 `cordis.yml` 根 + 依序套用的 bundle patch 層、
`plugin` 子命令轉發 pnpm。agent 核心直接使用
`@deepseek-ai/dsh-base`，因此 **任何 dsh 插件或 bundle 都可以不改一行地裝進 dsc
profile**。

## 執行

需要 Node >= 22.12 與 pnpm。

```bash
pnpm install
pnpm start                      # 互動終端（profile tui）
pnpm start -p "run the tests" --json
pnpm start login --api-key sk-...
```

> 下文以 `dsc` 代表 `pnpm start`（即 `pnpm --filter @dsc/cli start`，不要加 `--`）。

## 命令介面

```text
dsc                                   互動終端 REPL（profile tui）
dsc -p "<prompt>" [--json] [--stream-json] [--model <id>] [--permission <mode>] [--session <id>]
echo "<prompt>" | dsc -               headless，prompt 來自 stdin
dsc --dump-prompt                     印出組裝後的 system prompt 後離開
dsc --check-providers [--json]        列出 provider 路由與預設模型後離開（不連網）
dsc --web [port] | dsc serve [port]   瀏覽器 UI（serve 不開瀏覽器）
dsc doctor [--json] [--strict]        診斷：Node、module loader、pnpm、ripgrep、home、bundle、profile、憑證
dsc login --api-key <key> | dsc login status | dsc logout [--ref NAME | --all]
dsc --version [--json]                版本與 build identity（runtime assets 的實際解析版本）
dsc --profile <name> [--patch <file>]... [app args]   啟動任一 profile
dsc --profile <name> --dump-config | --dump-default-config | --dump-plugins
dsc plugin --profile <name> add|remove|update <package>   以 pnpm 管理 profile 插件
```

metacodes 的 `--permission` 六種模式（`default | acceptEdits | plan | auto |
dontAsk | bypassPermissions`）會投影到 dsh 的 sandbox mode + approval policy
preset（`workspace-write` / `read-only` / `dont-ask` / `danger-full-access`）。

### Headless NDJSON

`--stream-json` 即時輸出 `text` / `thinking` / `tool_start` / `tool_result` /
`usage` / `turn_begin` / `turn_end` / `run_end`；`--json` 最後輸出一行
`{"type":"result","stop_reason","turns","tool_calls","input_tokens",...,"text"}`。
每一行都是合法 UTF-8；截斷一律在 code point 邊界並附 `"truncated":true`。

### 終端 REPL

輸入管線與 metacodes 相同：`!cmd` 是本機 shell lane；`/verb` 先查內建表
（`/help /clear /model /permissions /cost /session /tools /exit`，內建優先），
查不到再交給 dsh 的 command registry（`/compact /goal /plan /feedback` ……），其餘
是 prompt。Esc 中斷執行中的 turn；工具需要核准時在提示列按 `y`/`n`。

## 架構

```text
apps/cli/src/bin.ts              launcher：只解析自己的 flag，其餘原封交給 tree（cmdlineArgs）
  ├─ profile-boot.ts             合成 patch 層 → boot → 提供 dscProfile/launchEnvironment/appExit/appReady
  ├─ plugin.ts                   dsc plugin：pnpm 轉發 + bundle 層對帳
  ├─ doctor.ts / version.ts / auth.ts / dump-*.ts
packages/core (@dsc/core)        home、layered .env、profile/bundle/patch 合成、Loader boot、cmdline 服務
packages/bundle-headless         profile headless：startup（解析 -p 等）+ runner（metacodes NDJSON）
packages/bundle-tui              profile tui：startup + Ink REPL（transcript store ← session events）
```

Profile 位於 `$DSC_HOME/profiles/<name>/`（預設 `~/.dsc`）：

- `package.json` — 插件依賴 + `dsc.profile.bundles`（有序 bundle 層；也接受 dsh 的
  `dsh.profile.bundles`）
- `cordis.yml` — 永遠是空陣列的根；整棵樹都是 patch 合成出來的
- `cordis.patch.yml` — 使用者自己的 patch 層，長時執行的介面會熱重載
- `pnpm-workspace.yaml` — `dsc plugin` 用的 hoisted 設定

合成順序：bundle 層（按 `bundles` 順序）→ profile 的 `cordis.patch.yml` →
`$DSC_HOME/cordis.patch.yml` → `--patch` 覆蓋層 → `DSH_TELEMETRY_DISABLED`
開關。bundle 是宣告 `dsc.bundle.patch`（或 dsh 的 `dsh.bundle.patch`，可為檔案列表）
的 npm 套件。模組解析是雙錨點：先從 dsc 安裝本體解析，再從 profile 目錄；安裝本體的
依賴閉包會以 symlink 鋪在 `$DSC_HOME/profiles/node_modules`，所以內建插件在任何
profile 都找得到。

內建 profile 範本：

| profile    | bundles                                              |
| ---------- | ---------------------------------------------------- |
| `tui`      | `@deepseek-ai/dsh-base` + `@dsc/bundle-tui`          |
| `headless` | `@deepseek-ai/dsh-base` + `@dsc/bundle-headless`     |
| `web`      | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` |

## 安裝 dsh 插件

```bash
dsc plugin --profile tui add @deepseek-ai/dsh-time-context   # 普通插件
dsc plugin --profile mine add @deepseek-ai/dsh-headless       # bundle：自動加入層
```

普通插件裝好後在 `cordis.patch.yml` 插一列即可啟用：

```yaml
- insert:
    - id: time-context
      name: '@deepseek-ai/dsh-time-context'
```

宣告了 `dsh.bundle` 的套件會自動加入 `dsc.profile.bundles`。dsh 插件需要的
launcher 服務（`cmdlineArgs`、`appExit`、`appReady`、`launchEnvironment`、
`dshHomePath`）dsc 都會提供；`$DSH_HOME` 未設定時會指向 dsc 的 home，讓 dsh
插件的 session、設定與憑證都落在 `~/.dsc`。

## 寫一個插件

cordis 插件就是一個匯出 `name`、`inject`、`apply(ctx, config)` 的模組：

```ts
export const name = 'hello'
export const inject = ['commands']
export function apply(ctx) {
  ctx.effect(() =>
    ctx.commands.register({
      name: 'hello',
      description: 'Say hello',
      handler: () => ({ kind: 'success', text: 'Hello from a plugin' }),
    }),
  )
}
```

放進 profile 的依賴並在 `cordis.patch.yml` 插入一列後，`/hello` 會同時出現在
dsc 終端與 dsh 的介面裡。

## 檢查

```bash
pnpm test
pnpm typecheck
pnpm lint:check
```

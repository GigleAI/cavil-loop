# Cavil Loop 客户端

`client/` 是一个本地桌面客户端（Electron + TypeScript + React），把多个 GitHub Project 看板和仓库合进一个视图。它只和 `api.github.com` / `github.com` 通信，和 daemon 没有任何交互，也不读 daemon 的配置。设计与拆分见 GigleAI/cavil-loop#135，本目录的第一块是 #136。

## 目录

```
src/
  shared/    类型、来源地址解析、IPC 约定（界面也会打包它，不能引用 Node / Electron）
  data/      GitHub 请求、同步、去重、分列、本地缓存（SQLite）、OAuth 设备授权
  platform/  和操作系统打交道的部分：凭据（v1 只有 macOS 钥匙串）；通知、角标、自启以后加在这里
  main/      Electron 主进程：controller.ts 是不依赖 Electron 的应用逻辑，main.ts 只做接线
  preload/   暴露给界面的 window.cavil
  renderer/  React 界面
test/
  unit/        vitest：数据层 + controller，对着本地假 GitHub 走真 HTTP
  e2e/         Playwright 驱动真 Electron 窗口
  fake-github/ 假 GitHub：GraphQL、REST（带分页）、OAuth 设备授权，可注入失败 / 断网 / 凭据撤销
  fixtures/    从 cavil project（GigleAI #11）录下来的真实接口返回，已脱敏；record.mjs 可重录
  mutation/    负对照
scripts/
  build.mjs             构建 dist/
  mac-open-check.sh     CI 的 Mac 机器上：冒烟 + 第一次打开步骤的实测
```

## 开发

```bash
cd client
npm ci
npm test                       # 单元测试，末尾打印「负对照：跳过 N 项」
npm run test:mutation          # 负对照（MUTATION=1）：先跑未改动的基线，再逐项改坏一处，指定的断言必须失败
npm run typecheck
npm run test:e2e               # 界面测试；Linux 无显示器时自动用 headless，CI 用 xvfb
npm start                      # 本机跑起来（Linux 上凭据只在内存里，退出即忘）
```

## 规则（改代码前读）

- **GitHub 是唯一数据源**：缓存只从 GitHub 往下写。一个来源要么整个读成功、整条覆盖本地，要么沿用上一轮——任何一页失败都不能把半份结果写进去，否则「读失败」会看起来像「条目消失」。
- **缓存只属于一个账号**：退出登录清空缓存；启动时凭据和上次读缓存用的不是同一把（只比对哈希），在 GitHub 确认账号前一律不显示旧缓存；一轮同步发出后有人退出 / 换账号，这一轮整个作废；来源在同步途中被删除（或删了又加）时，这一轮对它的结果不写入。
- **登录要么完整成功，要么什么都不留**：凭据只在登录最后一步写入，所有写入 / 删除在一条队列里依次执行；写完立刻核对这次登录是否已被取消、退出或被更新的登录取代，是就在同一步里删掉，不会误删排在后面的新凭据。
- **去重按条目本身**（`仓库#编号`），不按来源。迭代、状态属于各个 Project：两个 Project 值不同，同一条目在两列各出现一次；里程碑属于仓库。
- **凭据只在平台层**：界面拿不到 token；钥匙串写入走 `security -i` 的标准输入，不进命令行参数。
- **测试模式**（`CAVIL_CLIENT_TEST_MODE=1`）只给自动测试用：可以把 GitHub 地址换成本机回环地址的假服务，换成别的主机会直接报错。
- 只和 `github.com` 通信；外链一律用系统浏览器打开，且只放行 GitHub 的地址。

## OAuth 应用

浏览器授权（设备授权流程）需要一个开启了 **Device Flow** 的 GitHub OAuth App。Client ID 不是秘密，内置在 `src/shared/config.ts` 的 `DEFAULT_OAUTH_CLIENT_ID`；为空时登录页会让你先填一个，设置里也能覆盖。不需要、也不要放 Client secret。

## 发版

改 `package.json` 的 `version` → 合入 main → 打标签 `client/vX.Y.Z` 并推送。`.github/workflows/client.yml` 会在 Mac 机器上打两个 dmg、跑 `scripts/mac-open-check.sh`，通过后建 Release（说明取自 `RELEASE_NOTES.md`，不标成 Latest，daemon 的每周发版不受影响）。

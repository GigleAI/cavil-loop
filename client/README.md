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
  mac-open-check.sh     CI 的 Mac 机器上：dmg 窗口内容 + 冒烟 + 第一次打开步骤的实测
  render-dmg-background.cjs  把 build/dmg-background.html 渲染成 dmg 窗口背景图（改了 HTML 后手动重跑，产物入库）
build/
  dmg-background.html / background.png / background@2x.png   dmg 窗口背景（写着两种放行办法）
  打不开时看这里.txt     放进 dmg 的说明，命令可以直接复制
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

## 登录用的 GitHub 应用

浏览器授权走 GitHub 的设备授权流程（App 显示短码，浏览器里输入、同意）。登录页和设置页都有「登录方式」二选一：**默认 OAuth 应用**（已内置），用户想用时可选 **GitHub App**（预览，维护者 2026-11-05 在 #140 定：第一版先把 OAuth 做完整，GitHub App 以后再完整支持）。选项旁的小字链接「两种有什么区别？」打开一页说明（纯本地文字）。说明页、选项下的权限说明和登录前的 Client ID 核对都来自 `src/shared/appKind.ts` 一处：只说能确定的事——OAuth 应用申请的 scope 是本客户端定的，可以写明；GitHub App 的权限由那个 App 登记时决定、登录请求收窄不了，所以不承诺「碰不到代码」；令牌过不过期是各自应用的设置，不按登录方式一刀切。Client ID 和所选方式对不上（GitHub App 的 ID 以 `Iv` 开头，OAuth 应用的不是）时，输入框当场提示、不让保存，登录也直接拒绝、不联系 GitHub。登录代码本身不区分两种：

| | OAuth 应用（默认，已内置） | GitHub App（可选，预览） |
|---|---|---|
| 权限 | 本客户端整块申请：`repo`（含代码与设置）、`read:org`、`project` | 由 App 登记时逐项勾选（下面「建 GitHub App」推荐只勾 Issues、Pull requests、Projects 读写 + 仓库基本信息只读）；登录时收窄不了，以授权页为准 |
| 令牌 | 看应用设置：开了令牌过期就带续期令牌，没开就不过期 | 看 App 设置：默认 8 小时过期、带续期令牌（约 6 个月），建 App 时可关；GitHub 每次续期都换一个新的续期令牌 |
| 能看到的 | 账号能看到的、申请范围内的 | 账号能看到的、App 权限允许的、App 装到的仓库，三者交集 |
| 这一版 | 内置 Client ID，直接登录 | 没有内置的 App：要填自己建的 GitHub App 的 Client ID；还没做的：内置 App、引导组织安装、提示「哪些仓库没装到」 |

客户端会在令牌到期前 5 分钟自动续期，GitHub 说 401 时也先续期重试一次。续期只在一处进行，同一时刻最多一次（续期令牌用过即作废）。续期的结果只有这几种（`src/main/controller.ts` 的 `ensureFresh` 注释里逐条列着）：

| 续期遇到的 | 结果 |
|---|---|
| 连不上、超时、HTTP 5xx / 429（不管正文写什么） | 暂时不可用：登录、凭据、缓存都保留，下一轮再试 |
| GitHub 回 `bad_refresh_token`（续期令牌错误或过期） | 回登录页并说明原因 |
| 其他错误、回应无法解析、没有新令牌 | 不能证明凭据失效：保留一切，顶部提示，下一轮再试 |
| 拿到新令牌但写钥匙串失败 | GitHub 已作废旧续期令牌，所以新令牌留在内存里继续用、顶部提示，之后每轮重试保存；保存成功前退出 App，下次要重新登录 |
| 续期途中退出登录 / 换账号 | 退出、新登录优先，这次续期什么都不留 |

任何情况下续期都不会抛出没人处理的错误（有真实子进程测试守着）。

**启动时只用「可信」的凭据**：本地数据库里记着一份可信名单（只存凭据的哈希，写入是同步落盘的）。启动时钥匙串里的凭据不在名单上，就不用它登录，回登录页并把它删掉。名单只在这几处改：

| 时机 | 名单怎么变 | 为什么 |
|---|---|---|
| 退出登录（手动、续期被拒、续期令牌到期） | **第一步**清空，然后才切页面、才排队删钥匙串 | 删除排队中、进行中、失败、或进程直接被关掉，重启都不会用旧凭据 |
| 登录 | 写钥匙串前清空；写成功且这次登录没被取消，才加入新凭据 | 写到一半被关掉、或被取消，重启都不信它 |
| 续期 | 写钥匙串时同时信任新旧两份；写成功后只留新的 | 写到一半被关掉，重启用新的继续，不用重新登录 |
| 名单从没写过（这条规则之前的预览版留下的数据） | 当作空名单：不用钥匙串里那份，回登录页并删掉它 | 旧数据分不清「还登录着」和「退出了但没删掉」（只有最后一版预览会记「不得复用」，更早的什么都不记），所以一律不信。代价是装过预览版的人升级后要重新登录一次 |

退出时钥匙串删不掉，登录页会写明旧凭据可能还在钥匙串里；它已不在名单上，下次启动会再试着删。两进程测试（`test/unit/crash-restart.test.ts`）在每个时刻结束第一个进程，再用同一份磁盘数据启动第二个进程核对。

内置的 Client ID 在 `src/shared/config.ts`：OAuth 应用是 `DEFAULT_OAUTH_CLIENT_ID`，GitHub App 是 `DEFAULT_GITHUB_APP_CLIENT_ID`（目前为空）。Client ID 不是秘密。两种方式各存各的覆盖值（`oauthClientId` / `githubAppClientId`），在登录页或设置页「改 Client ID」里改；选了 GitHub App 而没有 Client ID 时，登录直接说明要填什么，不会联系 GitHub。预览版只有一格 Client ID：里面存的是 GitHub App 的 ID（`Iv` 开头）时，升级后自动归到 GitHub App 那一格并保持选 GitHub App。续期时用的是登录那一刻的 Client ID，之后改登录方式或 Client ID 都不影响已登录的令牌（有测试）。

### 建 GitHub App 的逐项设置

1. 在 GigleAI 组织页「Settings → Developer settings → GitHub Apps → New GitHub App」新建（建在组织下，组织的 Project 才能授权给它）。
2. **GitHub App name**：`Cavil Loop`；**Homepage URL**：`https://github.com/GigleAI/cavil-loop`。
3. **Identifying and authorizing users**：勾 **Expire user authorization tokens**（默认已勾）；**Callback URL** 留空也行（设备授权用不到）；不勾「Request user authorization (OAuth) during installation」。
4. 勾 **Enable Device Flow**。
5. **Webhook**：取消勾选 **Active**（客户端不需要回调）。
6. **Permissions**：
   - Repository permissions：**Issues** = Read and write；**Pull requests** = Read and write；**Metadata** = Read-only（必选）。其余保持 No access。
   - Organization permissions：**Projects** = Read and write。其余保持 No access。
   - Account permissions：全部 No access。
7. **Where can this GitHub App be installed?**：Only on this account。点 **Create GitHub App**。
8. 不需要生成 Client secret，也不需要 Private key。
9. 在 App 页面左侧 **Install App** → 安装到 GigleAI → 选 All repositories 或要看的那几个仓库。
10. 把 App 页面上的 **Client ID**（形如 `Iv23li…`）写进 `DEFAULT_GITHUB_APP_CLIENT_ID`，或先在登录页选「GitHub App」、把它填进 Client ID 框试用。

以后子项 #138 做「合并 PR」时，按 GitHub 文档合并接口还要 **Contents** = Read and write（届时单独确认）。

## 发版

改 `package.json` 的 `version` → 合入 main → 打标签 `client/vX.Y.Z` 并推送。`.github/workflows/client.yml` 会在 Mac 机器上打两个 dmg、跑 `scripts/mac-open-check.sh`，通过后建 Release（说明取自 `RELEASE_NOTES.md`，不标成 Latest，daemon 的每周发版不受影响）。

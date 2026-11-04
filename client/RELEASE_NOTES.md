## Cavil Loop 客户端

本地看板客户端：把多个 GitHub Project 和仓库放进一个视图，按迭代 / 状态 / 里程碑分列，可按仓库分泳道；断网时显示上次同步的内容。本版只读（搜索筛选、修改操作、`pending/human` 提醒在后续版本）。

### 下载哪个

- Apple 芯片（M1 及以后）：`Cavil-Loop-<版本>-arm64.dmg`
- Intel 芯片：`Cavil-Loop-<版本>-x64.dmg`

不确定的话：左上角苹果菜单 →「关于本机」，「芯片」一栏写 Apple M… 就选 arm64。

### 第一次打开（App 没有苹果签名，macOS 会拦一次）

1. 打开 dmg，把 **Cavil Loop** 拖进「应用程序」。
2. 双击打开。macOS 会提示无法验证开发者 / 无法打开——点「完成」或「取消」。
3. 任选一种放行方式：
   - **系统设置**：打开「系统设置 → 隐私与安全性」，往下翻到「已阻止使用 Cavil Loop」，点「仍要打开」，输入开机密码，再在弹窗里点「打开」。（macOS 14 及更早也可以在 Finder 里右键 App →「打开」→「打开」。）
   - **终端**：运行下面这行，然后正常双击打开：
     ```bash
     xattr -dr com.apple.quarantine "/Applications/Cavil Loop.app"
     ```
4. 之后就和普通 App 一样。**每装一个新版本**都要重新做一次第 3 步。

怎么验证过的：发版流程在 GitHub 的 Mac 机器上，对两个 dmg 都做了：直接启动通过冒烟测试；标上「从网络下载」后 Gatekeeper 确实拒绝；执行上面的终端命令后，用和双击相同的方式（`open`）能正常启动。「系统设置 → 仍要打开」这条路要人点按钮，CI 上没法点，没有自动验证。

### 登录

点「用 GitHub 登录」→ App 显示一个短码 → 点「打开 GitHub 授权页」→ 在浏览器里输入短码，点「Authorize」。申请的权限是 `repo`、`read:org`、`project`。凭据存进 macOS 钥匙串（条目名「Cavil Loop (GitHub)」），下次启动不用再登录；在设置里「退出登录」会同时删掉它。GigleAI 组织如果开了第三方应用限制，第一次授权需要组织管理员批准。

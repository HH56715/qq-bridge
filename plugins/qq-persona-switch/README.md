# qq-persona-switch

一个 DSH 插件：把 **qq-bridge 的人格卡**和 **DSH 人设插件（dsh-persona-dafeiyu）的人设**放进同一个开关，并且支持**按对话指定**——同一个 bot，在 A 群是「小鲸鱼」，在 B 群是「傲娇助手」，私聊又是另一个人。

## 它解决什么问题

两边的人设是各自独立注入的：

- `qq-bridge` 把 `roles/<名>.md` 拼进每条提示词（**只有一份，全局**）；
- `dsh-persona-dafeiyu` 在 DSH 会话装配时再注一个 prompt section（**也是全局/工作区级**）。

只开一边没问题，两边同时开就会串味 —— 一条回复里混两个人设，而且从界面上看不出是哪边在生效。更麻烦的是，两边都只认「一个」，天生做不了「每个群不同人设」。

这个插件给两种用法：

| 模式 | 适合 | 效果 |
| --- | --- | --- |
| **全局**（默认） | 这台 bot 就是这只人格 | 点一张卡，另一侧自动关掉 |
| **按对话** | 一群一设、公私分流 | 每个对话各挑一个；没挑的不带人设 |

## 前置

| 依赖 | 说明 |
| --- | --- |
| DeepSeek Harness | `>= 0.2.0`（用到 `webServer` 与 `systemPrompt` 两个服务） |
| [dsh-persona-dafeiyu](https://github.com/huaizhuanghub/dsh-persona-dafeiyu) | `v0.8.x`；没有它，「按对话 + 人格卡」和全局模式仍然可用，只有「分给插件人设」这一半失效 |
| qq-bridge | 可选；`>= v0.2.1-r1`（已在该版本实测）。没有它就只剩插件人设那一半 |

两侧都是可选的：一边连不上，另一边照样能切，界面上会标出来并给出原因。

## 安装

本包住在 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的 fork（HH56715/qq-bridge）的 `plugins/` 子目录里，按子目录装：

```powershell
dsh plugin --profile web add github:HH56715/qq-bridge#path:/plugins/qq-persona-switch
```

装完重启 DSH。零依赖、无构建步骤，不需要联网拉别的包。

手动装（或想先看代码再装）：

1. 把 `plugins\qq-persona-switch` 整个目录复制到 DSH 的插件目录：

   ```powershell
   Copy-Item .\plugins\qq-persona-switch C:\Users\<你>\.dsh\plugins\qq-persona-switch -Recurse -Force
   ```

2. 登记进 profile（加一条 `link:` 依赖 + 把包名加进 `bundles`）：

   ```powershell
   node C:\Users\<你>\.dsh\plugins\qq-persona-switch\scripts\install-profile.mjs
   ```

   脚本会先备份 `package.json`，并且是幂等的 —— 重复跑不会重复加。profile 不在默认位置时用
   `--profile=D:/.../profiles/web` 指定。

   > 这两处手改很容易漏：只加 `dependencies` 不加 `bundles` 的话，插件完全不生效，而且**不报错**。

3. 重启 DSH。之后打开：

   ```
   http://127.0.0.1:3080/api/qq-persona-switch
   ```

> 为什么必须重启：DSH 的 profile 在启动时解析 loader entry，`webServer` 路由与 `systemPrompt` 段落都是那时挂的。

回滚：把 `package.json` 的备份换回去，删掉 `~/.dsh/plugins/qq-persona-switch`，再重启。

## 配置

写在 profile 的 `cordis.patch.yml`（或者 `~/.dsh/profiles/web/cordis.patch.yml`）里：

```yaml
- insert:
    - id: qq-persona-switch
      name: qq-persona-switch
      config:
        bridgeDir: C:/Users/<你>/path/to/qq-bridge
```

全部留空也能跑：插件会先自己找 qq-bridge，找到后下面三项都能读出来。找不到才轮到默认值。

| 配置 | 留空时会去读 | 再兜底 |
| --- | --- | --- |
| `bridgeDir` | —— | 先看 `QQ_BRIDGE_DIR`；再从 `workspaceCwd` 和 DSH 进程的 cwd 各自向上找 3 层（每层看本目录与它的 `qq-bridge` 子目录） |
| `bridgeBaseUrl` | `<bridgeDir>/config.json` 的 `consolePort` | `http://127.0.0.1:3100` |
| `dshBaseUrl` | 同上文件的 `dsh.baseUrl` | `http://127.0.0.1:3080` |
| `consoleToken` | 同上文件的 `consoleToken` → `<bridgeDir>/state/console-token` | 环境变量 `QQ_BRIDGE_CONSOLE_TOKEN` |
| `workspaceCwd` | 同上文件的 `sessionCwd` | —— （插件人设**必须有**它） |

**自动发现**认的是目录长相，不是名字：一个有 `config.json`、并且能认出是桥的目录（存在 `src/bridge.js` 或 `state/console-token`，或 `package.json` 的 `name` 像 `qq-bridge`）。所以

```
D:\bots\my-bot\qq-workspace     ← QQ bot 的工作区（插件从这儿上溯）
D:\bots\my-bot\qq-bridge        ← 桥，config.json 在这儿
```

这种「工作区与桥同级」的布局，装完什么都不用填就能直接出来。反过来说：桥放在别的盘、别的层级，就填 `bridgeDir` 或设 `QQ_BRIDGE_DIR`，别指望猜。

> 为什么值得猜一次：市场里一键装完没有配置界面，用户也不会去翻 README —— 不猜的话，打开页面只有一句「没有桥接控制台令牌」，看着就像插件坏了。

令牌每次请求都重新读：桥接重启会重新生成 `state/console-token`，缓存住只会一直 401。

## 模式一：全局

点一张卡 = 一次 `POST /switch`，语义与 qq-bridge 自己的 `/api/persona/switch` 对齐：

| 目标 | 插件侧 | 桥接侧 |
| --- | --- | --- |
| 人格卡 `X` | 关全局 → 切到 workspace 模式 → 清空本工作区人设 | `role = X` |
| 插件人设 `X` | 关全局 → 切到 workspace 模式 → 本工作区人设 = `X` | 清空 role |
| 「不使用任何人设」 | 同上，本工作区人设 = 空 | 清空 role |

两条硬约束：

- **先写插件，再写桥接。** 插件不可达且目标是插件人设时直接失败，绝不先清桥接 role —— 否则 bot 变成完全没有人设，比切换失败更糟。
- **桥接写失败会回滚插件侧。** 桥接是另一个进程，端口没开、令牌过期都会让写失败；不回滚就正好停在「两边都关」这个最差状态上。这一步是相对 qq-bridge 原实现的补强。

另一侧连不上时一律降级为告警，能改的那一侧照改。

## 模式二：按对话

切到「按对话各自指定」后，页面变成一张表：每个出现过的对话一行，各挑一个人设。

### 它怎么做到的

桥接只在**全局**注一层，插件人设也只在全局/工作区级生效。要让 A 群和 B 群拿到不同的人格卡，只能是插件自己按会话注入：

1. **关掉两侧的全局注入**（先把原状态拍进快照，退出时原样还回去）。
2. 本插件注册一个 `systemPrompt` 段落，每次组装提示词时：
   - 从上下文取 `sessionId` → 拿 `qq-bridge/state/sessions.json` 反查它对应哪个 QQ 对话；
   - 该对话分到**人格卡**，就渲染那张卡的正文（渲染规则与桥接逐字一致：按 `〔一代〕/〔二代〕` 筛小节、二代剔掉「按空格分句」这类一代指令、按 `role.maxInjectChars` 截断）；
   - 分到**插件人设**或没分，就返回空串。
3. 分到插件人设的对话，直接调 `set-session-persona(sessionId, personaId)`，由 dafeiyu 自己注入；分到人格卡的对话，则给它写 `none: true` 哨兵，让 dafeiyu 在这个会话闭嘴。两边互相让路，永不叠加。

### 关键行为

| 情况 | 结果 |
| --- | --- |
| 没指定的对话 | **不带任何人设**（两侧全局都关着），只用预设自带的 |
| 对话还没建立会话（bot 没在那儿说过话） | 先记下，标「待生效」；页面上的「补写」或该对话下次出现的消息会让它生效 |
| 退出按对话模式 | 清掉会话级选择，把全局模式的人设、桥接的 role 按快照还回去 |
| 角色卡文件被删了 | 该对话这段注入变成空，不报错、不影响别的对话 |

按对话模式下的状态（以及进模式前的快照）存在 **`<bridgeDir>/state/qq-persona-switch.json`**，与桥接自己的 `state/` 放一起，重启不丢。

## 接口

都是本机回环专用（校验 Host、`application/json`、Origin）：

```
GET  /api/qq-persona-switch             页面
GET  /api/qq-persona-switch/state       两侧状态 + 卡片列表 + perChat（模式与每个对话的指定）
POST /api/qq-persona-switch/switch      {"source":"role"|"plugin"|"none","id":"..."}   全局切换
POST /api/qq-persona-switch/mode        {"mode":"global"|"perChat"}                    进出按对话
POST /api/qq-persona-switch/assign      {"chatKey":"group:123","source":"role"|"plugin"|"none","id":"..."}
POST /api/qq-persona-switch/sync        {}                                            补写待生效的指定
```

`state` 永远回 200，两侧的失败原因摊在 `bridge.reachable` / `bridge.error` / `plugin.reachable` / `plugin.error` 里 —— 界面要能把「谁挂了」显示出来，所以这里不该用一个 5xx 把整页干掉。

按对话模式下 `switch` 会回 400：两边状态是刻意清空的，允许整体切换只会让用户以为点了没反应。

## 开发

```powershell
node test/core.test.js       # 切换语义（谁先写、失败怎么收尾）      12 个用例
node test/http.test.js       # 三道门 + 路由接线 + 配置推导 + 端到端  15 个用例
node test/per-chat.test.js   # 渲染规则 + 存取 + 进出模式 + 单对话    19 个用例
```

`lib/` 下没有任何第三方依赖，三份测试都能在 Node 里裸跑，不需要先装依赖。`npm test` 跑全部。

`lib/switch-core.js` 不 import 任何 DSH 的东西，两个上游都是注入进来的，所以它也可以被别的前端（CLI、别的插件）直接复用。`test/http.test.js` 里有一组用例会起一个真的本机 HTTP 服务扮演两个上游，跑通「路由 → 客户端 → 上游 → 落盘」整条链。

## 已知边界

- 依赖 `dsh-persona-dafeiyu` 的私有回环接口 `/api/dsh-persona-dafeiyu/{status,mutate}`，路径前缀写死在代码里。上游改路由就会断 —— 断的时候表现是界面上「插件人设连不上」，不会静默失败。
- `POST /mutate` 一次只接受一个 action（插件本身的设计，每次落盘），所以一次全局切换是 3 次请求。
- 按对话模式依赖 `qq-bridge/state/sessions.json` 的映射（`group:<号码>` → DSH session id）。这份映射由桥接维护，插件只读；桥接换了存储格式，按对话就找不到人 —— 表现为「指定了但一直待生效」。
- 人格卡渲染规则是**抄**的一份（`lib/role-card.js`，来自 qq-bridge MIT 源码）。桥接以后改了标记语法，这里不会自动跟着变，需要手动同步；`test/per-chat.test.js` 里有一组同源用例盯着这件事。
- 不做「实时同步」：如果有人在 DSH 自己的设置页里改了人设，这个页面要刷新才会看到。
- 按对话模式期间，桥接侧的全局 role 是被**清空**的。如果这时有人在 qq-bridge 控制台里重新选了一张全局人格卡，那一层会重新生效、和按对话的注入叠在一起 —— 回到这个页面点一次模式切换（或重新指定一次）就会重新清掉。
- 没有做多工作区：只认一个 `workspaceCwd`（QQ bot 跑在哪个工作区就填哪个）。

## 许可

MIT。`lib/role-card.js` 源自 [qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）。
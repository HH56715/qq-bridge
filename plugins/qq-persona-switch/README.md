# qq-persona-switch

一个 DSH 插件：把 **qq-bridge 的人格卡**和 **DSH 人设插件（dsh-persona-dafeiyu）的人设**合成同一个开关。

## 它解决什么问题

两边的人设是各自独立注入的：

- `qq-bridge` 把 `roles/<名>.md` 拼进每条提示词；
- `dsh-persona-dafeiyu` 在 DSH 会话装配时再注一个 prompt section。

只开一边没问题，**两边同时开就会串味** —— 一条回复里混两个人设，而且从界面上看不出是哪边在生效。这个插件把两侧列成一张列表，点一张卡就把另一侧显式关掉，并把「同时生效」这件事直接摆成告警。

## 前置

| 依赖 | 说明 |
| --- | --- |
| DeepSeek Harness | `>= 0.2.0`（用到 `webServer` 注入） |
| [dsh-persona-dafeiyu](https://github.com/huaizhuanghub/dsh-persona-dafeiyu) | `v0.8.x`；没有它插件只剩人格卡那一半，功能仍可用 |
| qq-bridge | 可选；>= v0.2.1-r1（已在该版本实测）。没有它只剩插件人设那一半 |

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

> 为什么必须重启：DSH 的 profile 在启动时解析 loader entry，`webServer` 路由也是那时挂的。

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

## 行为

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

## 接口

都是本机回环专用（校验 Host、`application/json`、Origin）：

```
GET  /api/qq-persona-switch          页面
GET  /api/qq-persona-switch/state    两侧状态 + 合并后的卡片列表
POST /api/qq-persona-switch/switch   {"source":"role"|"plugin"|"none","id":"..."}
```

`state` 永远回 200，两侧的失败原因摊在 `bridge.reachable` / `bridge.error` / `plugin.reachable` / `plugin.error` 里 —— 界面要能把「谁挂了」显示出来，所以这里不该用一个 5xx 把整页干掉。

## 开发

```powershell
node test/core.test.js   # 切换语义（谁先写、失败怎么收尾）+ 12 个用例
node test/http.test.js   # 三道门 + 路由接线 + 配置推导与自动发现 + 12 个用例
```

`lib/` 下没有任何第三方依赖，两份测试都能在 Node 里裸跑，不需要先装依赖。

`lib/switch-core.js` 不 import 任何 DSH 的东西，两个上游都是注入进来的，所以它也可以被别的前端（CLI、别的插件）直接复用。

## 已知边界

- 依赖 `dsh-persona-dafeiyu` 的私有回环接口 `/api/dsh-persona-dafeiyu/{status,mutate}`，路径前缀写死在代码里。上游改路由就会断 —— 断的时候表现是界面上「插件人设连不上」，不会静默失败。
- `POST /mutate` 一次只接受一个 action（插件本身的设计，每次落盘），所以一次切换是 3 次请求。
- 不做「实时同步」：如果有人在 DSH 自己的设置页里改了人设，这个页面要刷新才会看到。
- 没有做多工作区：只认一个 `workspaceCwd`（QQ bot 跑在哪个工作区就填哪个）。

## 许可

MIT。
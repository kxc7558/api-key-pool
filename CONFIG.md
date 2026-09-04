# 配置文档教程

`config.json` 是整个代理池的唯一配置入口。本文逐字段讲清楚每个参数的含义、默认值、什么时候该改。

> 核心机制一句话：**改完 `config.json` 保存，服务自动热重载，不用重启**。已生效的 Key 统计、冷却状态都会保留，只有 Key 本身变了才会重置。

---

## 目录

1. [配置文件在哪、怎么改](#一配置文件在哪怎么改)
2. [字段速查表](#二字段速查表)
3. [全局参数详解](#三全局参数详解)
4. [平台（providers）详解](#四平台providers详解)
5. [Key 的三种写法](#五key-的三种写法)
6. [模型别名（models）详解](#六模型别名models详解)
7. [分发鉴权（accessKeys）详解](#七分发鉴权accesskeys详解)
8. [常见配置场景](#八常见配置场景)
9. [一份完整示例](#九一份完整示例)
10. [改完怎么验证](#十改完怎么验证)
11. [监控告警（邮件通知）](#十一监控告警邮件通知)

---

## 一、配置文件在哪、怎么改

- 位置：`api-key-pool/config.json`（与 `server.js` 同级）
- 热重载：保存即生效，无需重启服务
- 格式：标准 JSON，**不支持注释**、末尾不能有多余逗号

> 💡 不想手写 JSON？打开 **操作台** `http://127.0.0.1:8787/admin`，所有配置都能图形化增删改，点「保存」自动写回本文件。本文档讲的是每个字段背后的含义，两处配合着看。

几个约定（贯穿全文）：

| 约定 | 说明 |
|---|---|
| `_` 开头的字段 | 是给人看的注释，程序一律忽略。比如 `"_说明"`、`"_note"`、`"_重要"`，删了不影响运行 |
| `0` 或 `缺省` | 表示「不限」。所有限流类参数都遵循这个规则 |
| 中文 | 只能出现在 `name`、`_note` 这类「给人看」的字段里；**不能进 URL、Key、HTTP 头** |

> 改完若 JSON 写错了，服务会打印「config.json 解析失败」并**继续用上一次的旧配置**，不会崩。

---

## 二、字段速查表

### 全局（顶层）

| 字段 | 默认 | 作用 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。`127.0.0.1`=只本机；`0.0.0.0`=局域网/公网可访问 |
| `port` | `8787` | 监听端口 |
| `proxyApiKey` | `""` | 旧版单 Key 鉴权（兼容保留，新项目用 `accessKeys`） |
| `accessKeys` | `{}` | 中转站分发 Key（推荐，见[第七节](#七分发鉴权accesskeys详解)） |
| `requestTimeoutMs` | `120000` | 单个上游请求超时（毫秒） |
| `streamIdleTimeoutMs` | `90000` | 流式响应多久没数据就断（毫秒） |
| `maxAttempts` | `8` | 单次请求最多尝试多少个「模型 + Key」组合 |
| `waitForSlotMs` | `20000` | 所有 Key 都忙时，最长排队多久再报 503 |
| `cooldownMs` | `60000` | 撞 429 后的基础冷却时长（会指数退避） |
| `maxCooldownMs` | `600000` | 冷却时长上限（10 分钟） |
| `serverErrorCooldownMs` | `8000` | 上游 5xx 报错后的短暂冷却 |
| `strategy` | `round-robin` | 调度策略：`round-robin` 轮流 / `least-used` 挑最闲的 |
| `logLevel` | `info` | 日志详细度：`debug` > `info` > `warn` > `silent` |
| `adminToken` | `""` | 操作台管理密码：留空=仅本机可打开操作台；设置后访问 `/admin` 需输入 |
| `exposePassthrough` | `false` | 是否在 `/v1/models` 里列出 `平台名:__passthrough__` 占位项（默认关：它不可调用，客户端误选会报错） |
| `groupCooldownOn429` | `true` | **连坐冷却**：同账号分组内任意一个 Key 撞 429 → 整组一起冷却，不再逐个白试 |
| `halfOpen` | 对象 | **半开探活**：冷却/下线到期的 Key 先探活再回池，不直接拿真实请求试错（见[三](#三全局参数详解)） |
| `breaker` | 对象 | **模型级熔断**：模型连续多次全败 → 熔断一段时间秒回 503（见[三](#三全局参数详解)） |
| `defaults` | `{}` | 所有平台的默认限流值，见[第四节](#四平台providers详解) |
| `logRetentionDays` | `7` | 服务日志（`logs/server-*.log`）保留天数，超期自动清理 |
| `usageRetentionDays` | `90` | 调用日志（`logs/usage/*.jsonl`）保留天数，超期自动清理；用量趋势接口最多读这么多天 |
| `alert` | 对象 | **监控告警**：邮件通知（QQ 邮箱），见[第十一节](#十一监控告警邮件通知) |

### 每个平台（providers 数组元素）

| 字段 | 默认 | 作用 |
|---|---|---|
| `name` | 必填 | 平台代号，用于日志、`provider:model` 语法 |
| `baseUrl` | 必填 | 平台的 OpenAI 兼容地址（`/v1` 结尾） |
| `chatPath` | `/chat/completions` | 聊天接口路径，一般不用改 |
| `authHeader` | `Authorization` | 鉴权头名，一般不用改 |
| `authPrefix` | `Bearer ` | 鉴权头前缀，一般不用改 |
| `extraHeaders` | `{}` | 额外请求头，如 `{"HTTP-Referer": "xxx"}` |
| `rpmPerKey` | 继承 `defaults` | 每个 Key 每分钟最多发多少次，`0`=不限 |
| `rpmPerAccount` | `0` | 每个账号分组每分钟最多发多少次（配合 `@标签`） |
| `maxConcurrencyPerKey` | 继承 `defaults` | 每个 Key 同时最多几个在途请求，`0`=不限 |
| `cooldownMs` | 继承全局 | 覆盖全局的冷却时长 |
| `maxCooldownMs` | 继承全局 | 覆盖全局冷却上限 |
| `serverErrorCooldownMs` | 继承全局 | 覆盖全局 5xx 冷却 |
| `requestTimeoutMs` | 继承全局（120000） | **平台级请求超时**，覆盖全局值。慢平台调大（如 NIM 冷启动 113s → 设 180000），快平台调小（商汤正常 1~6s → 设 60000，异常时快速失败换 Key），`0`=用全局 |
| `probePath` | 继承 `halfOpen.probePath` | 平台级探活路径覆盖（半开探活用），一般不用配 |
| `keys` | `[]` | Key 数组，见[第五节](#五key-的三种写法) |
| `keysFile` | 无 | 从外部 txt 读 Key（一行一个），与 `keys` 并存会合并 |

---

## 三、全局参数详解

### `host` 与 `port` —— 服务开在哪

```json
"host": "127.0.0.1",
"port": 8787
```

- 只自己用：保持 `127.0.0.1`，外面机器访问不到，最安全。
- 要给局域网同事用：改成 `0.0.0.0`，同时**必须配 `accessKeys`**（否则裸奔，启动时红字警告）。
- `port` 被占用了就换一个（比如 `8788`）。

### `proxyApiKey`（旧版，一般不用）

```json
"proxyApiKey": "my-secret"
```

配了之后，客户端必须带 `Authorization: Bearer my-secret` 才能调。这是早期「单一密码」的玩法，现在有 `accessKeys` 多用户方案后基本不用了。二者可同时存在：先校验 `accessKeys`，没配 `accessKeys` 才走 `proxyApiKey`。

### 调度与容错（几个 ms 参数）

| 参数 | 调大 | 调小 |
|---|---|---|
| `maxAttempts` | Key 多、想多试几个组合 | 想更快失败返回 |
| `waitForSlotMs` | 高峰想多排队等一会儿 | 想快速返回 503 |
| `cooldownMs` / `maxCooldownMs` | 给被限流的 Key 更长恢复时间 | 更快重试 |
| `serverErrorCooldownMs` | 上游 5xx 时更保守 | 更快重试 |

一般**默认值就是甜点，不用动**。只有明确遇到「排队太久」或「重试太慢」时才调。

### `strategy` —— 怎么挑 Key

```json
"strategy": "round-robin"
```

- `round-robin`：轮流用，每个 Key 均分请求。**默认，推荐**。
- `least-used`：优先挑当前并发最少的 Key。Key 性能差异大时用它能更均衡，但弱 Key 会「永远最闲」被反复选。

### 调度增强（2026-09-02 新增）：连坐冷却 / 半开探活 / 模型熔断

三个开关默认全开，值是「免费 API 场景」下的甜点，一般不用动；调参只为贴合自己上游的真实脾气。

**① `groupCooldownOn429` —— 同组 429 连坐冷却**

```json
"groupCooldownOn429": true
```

背景：同账号分组的多个 Key 共享账号级配额（商汤 8 Key 同账号、英伟达同账号 40 RPM）。账号配额被打满时，**任何一个** Key 都会 429——老逻辑只冷却撞墙的那一个 Key，结果同组 8 个 Key 逐个被 429「白试」一遍才肯放弃，又慢又浪费额度。

开启后：组内任一 Key 撞 429，**整组一起进入冷却**（时长按组内连续失败次数指数退避），请求直接换去别的平台/等冷却，不再逐个白试。单 Key 成功会把组内失败计数清零（上游恢复后能尽快回到正常节奏）。

- 没配分组（Key 不带 `@标签`）时此开关不生效，各 Key 独立冷却，不受影响。
- 可**按平台覆盖**：provider 里写 `"groupCooldownOn429": false` 可为单个平台单独关掉连坐（适合「单 Key 限流」而非「账号级限流」的上游），优先级高于全局开关。

**② `halfOpen` —— 半开探活：冷却/下线 Key 先验证再回池**

```json
"halfOpen": {
  "enabled": true,          // false = 关掉，回到「冷却到期直接用」的旧行为
  "probeIntervalMs": 15000, // 后台探活节拍：每隔多久扫一批到期 Key
  "probeTimeoutMs": 10000,  // 单次探活请求超时
  "probeMaxPerTick": 2,     // 每个节拍最多并发探活几个 Key（防探测风暴）
  "reviveDead": true,       // 401/403 永久下线的 Key 是否允许周期探活自动复活
  "reviveDelayMs": 600000,  // 下线后等多久才允许复活探活（默认 10 分钟）
  "probePath": "models",    // 探活路径，相对 baseUrl；OpenAI 兼容上游都有 /models
  "failBackoffMs": 30000    // 探活失败后多久再探（防对已死 Key 高频探测）
}
```

解决的问题：
- **冷却到期 ≠ 上游已恢复**。旧逻辑冷却一结束 Key 直接回池，第一个真实请求又撞 429/5xx → 再冷却 → 再咬一次……「半开」让冷却到期的 Key 先停留在「待探活」状态，后台用 `GET {baseUrl}/models`（免费、不消耗 chat 额度）验证一次：`2xx` 才回池，失败就继续冷却并退避。坏 Key 不再反复咬真实请求。
- **401/403 下线的 Key 可能只是临时风控**。`reviveDead: true` 时，下线的 Key 会在 `reviveDelayMs` 后被周期探活；探活通过自动复活，探活仍 401/403 则保持下线（并按 `failBackoffMs` 退避，不会高频骚扰上游）。
- 请求排队期间也会顺带促发一次探活，让「只差验证」的 Key 尽快回池，而不是干等后台节拍。

**③ `breaker` —— 模型级熔断：连败模型秒回 503**

```json
"breaker": {
  "enabled": true,
  "failThreshold": 3,   // 连续多少次「真实上游尝试全败」触发熔断
  "openMs": 30000,      // 熔断窗口：期间该模型直接秒回 503
  "pruneTtlMs": 600000  // 未达阈值的陈年失败计数多久清理（防内存无界增长）
}
```

解决的问题：某模型在所有候选 Key 上都打不通时（上游该模型临时不可用 / 被账号风控），老逻辑每次请求都完整走完「全部 Key 试一遍 + 排队 20s」才报错——客户端傻等，上游反复被骚扰。

开启后：某模型连续 `failThreshold` 次**真实上游尝试全部失败**（401/403/429/5xx 等）→ 熔断该模型 `openMs` 毫秒；熔断期内新请求**秒回** `503`（`type: circuit_open`，带 `retryAfterMs`），不去上游试错也不排队。窗口到期后自动放行一个试探请求，成功即解除熔断。

> **纯排队超时不计数**：高峰期全部 Key 并发占满导致的排队超时（一次上游都没打出去）**不会**触发熔断——那属于「忙」不是「坏」，熔断只针对模型真的打不通。

> **熔断粒度是客户端传入的 `model` 字符串**：别名 `auto` 与透传原名 `deepseek-v4-flash` 各自独立熔断、不共享。同一批坏 Key，客户端统一用别名请求才会共享同一个熔断器。建议客户端一律填别名（见[六](#六模型别名models详解)）。

> 区别理解：连坐冷却管「Key 层」、半开探活管「Key 恢复」、模型熔断管「模型层快速失败」——三层叠起来，免费 API 那些「偶尔抽搐、偶尔风控」的脾气基本都被兜住了。启动日志与 `/stats`（`scheduler` / `breakers` 字段）能看到各自状态。

### `logLevel` —— 日志多详细

```json
"logLevel": "info"
```

- `debug`：每次调度的细节，排查疑难用
- `info`：启动、重载、限流、换 Key 等关键事件（默认）
- `warn`：只看异常
- `silent`：完全不打印

### `adminToken` —— 操作台管理密码

```json
"adminToken": ""
```

控制谁可以打开操作台（`http://127.0.0.1:8787/admin`）：

- **留空（默认）**：只有本机能打开操作台，局域网/远程打不开 —— 单人自用最省心。
- **填一个密码**：任何位置（含本机）打开 `/admin` 都要输入这个密码，适合放到服务器上远程管理。同时 `/stats` 与 `/`（仪表盘）也会要求该鉴权（本机免密 / 远程 Bearer）；`daily-report.js`、`test.js` 记得用 `POOL_ADMIN_TOKEN` 环境变量传入。

> 这个密码在操作台「全局设置」页里也能直接改，改完保存即生效。

> 🔒 **跨站来源防护（2026-09-02 新增）**：管理接口（`/admin/*`、`/stats`、`/`）会校验浏览器的 `Origin` 头——外部网站来源一律 403，且不返回 CORS 头；无 Origin 的脚本/Node 客户端、本机或同源浏览器正常放行。作用：防止恶意网页在浏览器里读取本机配置（内含全部上游明文 Key）与统计（DNS rebinding 攻击链）。代理接口 `/v1/*` 仍允许任意跨域（中转站客户端 SDK 需要，不受影响）。

### `exposePassthrough` —— `/v1/models` 是否列出透传占位项

```json
"exposePassthrough": false
```

默认 `false`。设为 `true` 时，`GET /v1/models` 除了别名表外，还会为每个平台列出一个 `平台名:__passthrough__` 占位项。

- **为什么默认关**：`__passthrough__` 只是「用原始模型名打该平台」的提示项，**本身不可调用**。客户端（桌面 App 等）在模型列表里看到它可能会误选，导致请求报错。
- 什么时候开：客户端必须依赖 `/v1/models` 列表才能用，且你想让它感知「有哪些平台」时。

---

## 四、平台（providers）详解

`providers` 是一个数组，每个元素代表一个上游平台。**至少要有 `name` 和 `baseUrl`**，程序才会加载它。

```json
"providers": [
  {
    "name": "sensenova",
    "baseUrl": "https://token.sensenova.cn/v1",
    "chatPath": "/chat/completions",
    "rpmPerKey": 20,
    "rpmPerAccount": 0,
    "maxConcurrencyPerKey": 2,
    "keys": [
      "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "sk-yyyyyyyyyyyyyyyyyyyyyyyyyyyy"
    ]
  }
]
```

### 继承链：`defaults` → 平台

`rpmPerKey` / `maxConcurrencyPerKey` 这两个值如果平台没写，就取全局 `defaults`；`defaults` 也没有，就是 `0`（不限）。

```json
"defaults": {
  "rpmPerKey": 35,
  "maxConcurrencyPerKey": 2
}
```

这样每个平台不用重复写限流，只对特殊平台单独覆盖即可。

### 平台专属覆盖冷却参数

冷却相关（`cooldownMs` / `maxCooldownMs` / `serverErrorCooldownMs`）可以按平台覆盖，写在平台对象里即可，不写就继承全局。

### 常见平台的 `baseUrl`

| 平台 | 地址 | Key 前缀 |
|---|---|---|
| 商汤 SenseNova | `https://token.sensenova.cn/v1`（或 `https://api.sensenova.cn/v1`） | `sk-` |
| 英伟达 NIM | `https://integrate.api.nvidia.com/v1` | `nvapi-` |

> 商汤报 404/401 时，优先换另一个地址试试。

---

## 五、Key 的三种写法

`keys` 数组里每一条都支持三种形式，可以混用：

### 1. 明文直写

```json
"keys": [ "nvapi-aaaaaaaaaaaaaaaa", "nvapi-bbbbbbbbbbbbbbbb" ]
```

### 2. 分组：`key@账号标签`

```json
"keys": [ "nvapi-aaa@账号1", "nvapi-bbb@账号1", "nvapi-ccc@账号2" ]
```

`@` 后面的标签随便起，**标签相同的 Key 算同一个账号**，共享 `rpmPerAccount` 的配额。这是应对「同一账号多 Key 不叠加额度」的关键写法，详见[场景三](#场景-3同一账号多-key)。

### 3. 从环境变量读：`env:变量名`

```json
"keys": [ "env:SENSENOVA_KEY_1", "env:SENSENOVA_KEY_2" ]
```

启动前把 Key 写进系统环境变量，`config.json` 里就不出现明文。适合不想在文件里留 Key 的场景。

### 4. 从文件读：`keysFile`

```json
{
  "name": "sensenova",
  "baseUrl": "https://token.sensenova.cn/v1",
  "keysFile": "keys-sensenova.txt"
}
```

`keys-sensenova.txt` 一行一个 Key，`#` 开头是注释。文件放在 `api-key-pool` 目录下（也可以写绝对路径）。

> 所有形式里，以 `#` 或 `//` 开头的行都会被忽略，可以留着当注释。

---

## 六、模型别名（models）详解

`models` 把「好记的别名」映射到「真实平台 + 模型」。客户端请求时 `model` 填别名。

**⚠️ 候选列表的调度语义（重要，2026-09-02 修正）**：

- **普通候选 = 轮询均分流量**。`[A, B, C]` 三个候选会轮流被使用（第 1 次打 A、第 2 次打 B、第 3 次打 C……），**不是**「A 挂了才用 B」。所以别把慢速上游（比如冷启动要 1~2 分钟的英伟达 NIM）当普通候选排进去——它会被按比例分走正常流量。
- **`fallback: true` 的候选 = 兜底梯队**。只有普通候选（主力）全部不可用（冷却 / 限流 / 占满）时才会启用。商汤健康时兜底零流量。

```json
"models": {
  "auto": [
    { "provider": "sensenova", "model": "deepseek-v4-flash" },
    { "provider": "sensenova", "model": "deepseek-v4-pro" },
    { "provider": "nvidia", "model": "deepseek-ai/deepseek-v4-pro-0813", "fallback": true }
  ],
  "pro": [
    { "provider": "sensenova", "model": "deepseek-v4-pro" },
    { "provider": "nvidia", "model": "deepseek-ai/deepseek-v4-pro-0813", "fallback": true }
  ],
  "flash": [ { "provider": "sensenova", "model": "deepseek-v4-flash" } ],
  "kimi":  [ { "provider": "sensenova", "model": "kimi-k3" } ]
}
```

上面的例子：`auto` 平时只在商汤的 flash / pro 之间轮询；商汤 8 个 Key 全部限流冷却时，才自动切英伟达兜底（那次请求可能要等 1~2 分钟——NIM 免费额度冷启动实测首字节 56~113 秒）。

### 候选列表的两种写法

| 写法 | 例子 | 说明 |
|---|---|---|
| 对象 | `{ "provider": "sensenova", "model": "deepseek-v4-pro" }` | 最清晰，推荐 |
| 对象+兜底 | `{ "provider": "nvidia", "model": "...", "fallback": true }` | 兜底梯队，主力全挂才启用 |
| 字符串 | `"sensenova/deepseek-v4-pro"` | `平台/模型` 简写，等价于上面 |

### 请求时指定模型，有 4 种方式

| 客户端填的 `model` | 行为 |
|---|---|
| `auto` / `pro` / `flash` / `kimi` | 命中别名，主力轮询 + 兜底梯队 |
| `sensenova:deepseek-v4-pro` | 强制走商汤的这个模型，不降级 |
| `deepseek-v4-pro@sensenova` | 同上，另一种写法 |
| `deepseek-v4-flash` | 别名表里没有 → 拿这个名字去**所有平台**挨个试 |

⚠️ 最后一行有坑：透传的模型名如果上游不认识（比如把英伟达的 `deepseek-ai/...` 名字传给商汤），上游可能**不报错也不返回**，请求一直挂到超时。所以客户端一律填别名，别填完整模型名；确要指定平台用 `模型名@平台` 写法。

### 注意事项

- 以 `_` 开头的别名会被当成注释跳过（如 `"_note"`）。
- 别名指向的平台必须在 `providers` 里真实存在，否则该候选被忽略。
- 模型 ID 会随平台更新而变化，报 `unknown model` 时去平台官网抄最新 ID。

---

## 七、分发鉴权（accessKeys）详解

`accessKeys` 是「中转站」模式的核心：把代理池开放给别人用时，每人发一把不同的 Key，各自限流、各自记账。

```json
"accessKeys": {
  "sk-pool-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx": { "name": "同事甲", "rpm": 10, "daily": 300 },
  "sk-pool-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx": "同事乙"
}
```

### 两种写法

| 写法 | 说明 |
|---|---|
| `"key": "用户名"` | 只记名字，不限流 |
| `"key": { "name": "用户名", "rpm": 10, "daily": 300 }` | 限流：`rpm`=每分钟上限，`daily`=每天上限，`0`/缺省=不限 |

对象写法里还能加一个 `enabled` 字段：`"key": { "name": "同事甲", "enabled": false }` 表示**禁用**这把 Key（调用方返回 401，但仍保留在配置里方便以后重新启用）。默认 `enabled` 为 `true`。

### 规则

- **不写 `accessKeys`（或留 `{}`）= 不做鉴权**，谁都能调。只建议单机自用时这么干。
- 配了 `accessKeys` 后，**所有调用都必须带 `Authorization: Bearer <分发 Key>`**，包括本机 `127.0.0.1`，否则返回 401。
- 每个分发 Key 的调用量、限流情况实时显示在状态面板「接入用户」表；响应头 `x-pool-user` 会标注本次是哪个用户（`user-1`、`user-2`…）。
- 分发 Key 建议用 `sk-pool-` 前缀，方便和上游 `sk-`/`nvapi-` 区分。
- 以 `#` 或 `_` 开头的 key 会被忽略（可当注释）。

### 配额口径（两个细节）

- **`rpm` 与 `daily` 只统计对话请求**（`/v1/chat/completions`）；`GET /v1/models` 这类查询只做鉴权、**不消耗**配额，客户端频繁刷模型列表不会把额度用光。
- **`daily` 按北京时间（UTC+8）零点重置**，不是 UTC 零点（那会是北京早 8 点就重置）。

---

## 八、常见配置场景

### 场景 1：单机自用（最简单）

```json
"host": "127.0.0.1",
"accessKeys": {}
```

只填 `providers` 的 Key 和 `models`，其余全默认。客户端本机调用，`apiKey` 随便填个英文即可。

### 场景 2：中转站（给局域网/公网的人用）

```json
"host": "0.0.0.0",
"accessKeys": {
  "sk-pool-发给同事甲的key": { "name": "同事甲", "rpm": 10, "daily": 300 }
}
```

两步走：① 改 `host` + 配 `accessKeys`；② 防火墙放行端口（`firewall-open.bat` 管理员运行）。

> 强烈建议给每个分发 Key 设 `rpm`/`daily` 上限，防止某个人把免费额度打爆。

### 场景 3：同一账号多 Key

英伟达、商汤的免费额度是**账号级**，同一账号开多个 Key **不叠加**。这时必须分组：

```json
{
  "name": "nvidia",
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "rpmPerKey": 0,
  "rpmPerAccount": 38,
  "keys": [
    "nvapi-aaa@账号1",
    "nvapi-bbb@账号1",
    "nvapi-ccc@账号2"
  ]
}
```

`rpmPerKey` 关掉（改 0），`rpmPerAccount` 设成略低于平台账号限额（如 40 的账号限额设 38 留余量），`@标签` 相同的 Key 归一组共享额度。

### 场景 4：不想在文件里留明文 Key

```json
"keys": [ "env:SENSENOVA_KEY_1", "env:SENSENOVA_KEY_2" ]
```

配合系统环境变量 + `keysFile` 文件，`config.json` 里可以完全不出现真实 Key，方便提交到 Git。

---

## 九、一份完整示例

```json
{
  "_说明": "保存即自动生效，无需重启。_ 开头的字段是注释",

  "host": "0.0.0.0",
  "port": 8787,
  "proxyApiKey": "",
  "adminToken": "",            // 留空=仅本机可管理操作台；填了则 /admin、/stats、/ 都要 Bearer 鉴权
  "exposePassthrough": false,  // 是否在 /v1/models 列出 平台名:__passthrough__ 占位项（默认关）
  "accessKeys": {
    "sk-pool-发给同事甲的key": { "name": "同事甲", "rpm": 10, "daily": 300 }
  },

  "requestTimeoutMs": 120000,
  "streamIdleTimeoutMs": 90000,
  "maxAttempts": 8,
  "waitForSlotMs": 20000,
  "cooldownMs": 60000,
  "maxCooldownMs": 600000,
  "serverErrorCooldownMs": 8000,

  "strategy": "round-robin",
  "logLevel": "info",

  "groupCooldownOn429": true,   // 连坐：同账号分组内一个 Key 429 → 整组冷却（默认开）
  "halfOpen": {                 // 半开探活：冷却/下线 Key 先验证再回池（默认开）
    "enabled": true,
    "probeIntervalMs": 15000,
    "probeTimeoutMs": 10000,
    "probeMaxPerTick": 2,
    "reviveDead": true,
    "reviveDelayMs": 600000,
    "probePath": "models",
    "failBackoffMs": 30000
  },
  "breaker": {                  // 模型级熔断：连败模型秒回 503（默认开）
    "enabled": true,
    "failThreshold": 3,
    "openMs": 30000
  },

  "defaults": {
    "rpmPerKey": 35,
    "maxConcurrencyPerKey": 2
  },

  "providers": [
    {
      "name": "sensenova",
      "baseUrl": "https://token.sensenova.cn/v1",
      "rpmPerKey": 20,
      "maxConcurrencyPerKey": 2,
      "keys": [
        "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "sk-yyyyyyyyyyyyyyyyyyyyyyyyyyyy"
      ]
    }
  ],

  "models": {
    "auto": [
      { "provider": "sensenova", "model": "deepseek-v4-flash" },
      { "provider": "sensenova", "model": "deepseek-v4-pro" }
    ],
    "pro": [ { "provider": "sensenova", "model": "deepseek-v4-pro" } ],
    "flash": [ { "provider": "sensenova", "model": "deepseek-v4-flash" } ],
    "kimi": [ { "provider": "sensenova", "model": "kimi-k3" } ]
  }
}
```

---

## 十、改完怎么验证

改完 `config.json`，两步确认没配错：

### 1. 静态检查（不联网、不耗额度）

```bash
node check-config.js          # 只看 JSON 合法、Key 数量/前缀、别名引用的平台是否存在等
node check-config.js --live   # 额外真实调用每个 Key 验证可用性
```

双击 `check-config.bat` 也行。

### 2. 端到端自检（会消耗少量真实额度）

```bash
POOL_KEY=sk-pool-xxx node test.js                  # 分发 Key 从 config.json 的 accessKeys 挑一个
POOL_KEY=sk-pool-xxx node test.js 3 pro            # 指定并发数与模型别名
POOL_ADMIN_TOKEN=xxx node test.js                  # 设了 adminToken 后，读 /stats 需加这个
```

输出会画出每个 Key 各分到多少请求，一眼看出轮询是否生效。

### 3. 看面板

浏览器打开 `http://127.0.0.1:8787/`，确认每个 Key 都是绿色「可用」、模型别名列表正确。

---

## 附：排查速记

| 症状 | 先看哪 |
|---|---|
| 改完没生效 | 面板/日志里是否有「config.json 解析失败」；确认是合法 JSON |
| 某个 Key 变红「已下线」 | 返回了 401/403，Key 抄错/过期，改好保存自动恢复 |
| 一片橙色「冷却中」 | 真被限流了，降 `rpmPerKey` 或加 Key |
| 返回 503 `no_available_key` | 候选 Key 全在冷却/占满，调大 `waitForSlotMs` 或等一会儿 |
| 调用返回 401「无效的访问 Key」 | 开了 `accessKeys` 却没带 `Authorization: Bearer <分发 Key>` |
| `/stats` 返回 401 | 设了 `adminToken` 后 `/stats` 也要鉴权：本机免密，脚本用 `POOL_ADMIN_TOKEN=xxx` 传入 |
| 模型报 `unknown model` | 模型 ID 变了，去平台官网抄最新 ID 填进 `models` |

---

## 十一、监控告警（邮件通知）

代理池在三种情况会自动发邮件告警到指定 QQ 邮箱：

| 触发条件 | 说明 |
|---|---|
| **全部 Key 永久下线** | 所有上游 Key 都因 401/403 被判死，代理池无法服务。边沿触发：从「有可用 Key」到「全死」才发一次，有 Key 复活就复位 |
| **上游连续 429** | 某平台连续撞限流达到阈值（默认 5 次），可能额度耗尽或限流过严 |
| **用户当日配额用尽** | 某把分发 Key 的 `daily` 配额用完，后续请求会 429。按用户分别防抖 |

### 配置

```json
"alert": {
  "enabled": true,
  "email": { "to": "your@qq.com", "from": "代理池监控", "account": "you@qq.com", "authCode": "" },
  "cooldownMs": 1800000,
  "allKeysDead": true,
  "on429Streak": 5,
  "onUserDailyExhausted": true
}
```

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `email.to` | `""` | 收件人（QQ 邮箱）。留空=不发送，只在 `/stats` 的 `alerts` 里记录 |
| `email.from` | `代理池监控` | 发件**显示名**（`MAIL FROM` 固定用发件账号，这里只影响显示名） |
| `email.account` | `""` | 发件账号（QQ 邮箱）。留空则回退环境变量 `QQ_EMAIL_ACCOUNT` |
| `email.authCode` | `""` | 授权码。留空则回退环境变量 `QQ_EMAIL_AUTH_CODE` |
| `cooldownMs` | `1800000` | 同一告警主体的防抖间隔（30 分钟不重复发） |
| `allKeysDead` | `true` | 是否启用「全部 Key 下线」告警 |
| `on429Streak` | `5` | 连续 429 达到几次才告警，`0`=关闭 |
| `onUserDailyExhausted` | `true` | 是否启用「用户配额用尽」告警 |

### 发信凭据（后台填写，或环境变量）

发信用 QQ 邮箱 SMTP。**推荐直接在操作台「全局设置 → 监控告警」里填发件账号和授权码**，保存即生效；授权码以密码框遮罩显示，且接口只返回 `__SET__` 占位符、不泄露明文（保存时留空=不修改已存值）。

**授权码不是登录密码**，去 QQ 邮箱「设置 → 账户 → POP3/IMAP/SMTP 服务」开启并获取 16 位授权码。

也可以不改配置、改用环境变量（后台留空时回退到这两个环境变量）：

```
QQ_EMAIL_ACCOUNT=你的QQ号@qq.com
QQ_EMAIL_AUTH_CODE=16位授权码
```

Windows 设置环境变量的方式见 README「启动」一节。告警发送失败只记日志、不影响代理池运行，可在 `/stats` 的 `alerts` 里看每条告警的 `sent` / `error` 排查。

---

## 附：排查速记

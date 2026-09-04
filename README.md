# API Key 代理池

把多个免费 API 的 Key 聚合成**一个 OpenAI 兼容地址**。业务代码里只改 `base_url`，剩下的调度、重试、容灾全部由代理池接管。

零第三方依赖，Node.js 18+ 即可运行（推荐 20/22）。

---

## 它替你做了什么

| 能力 | 说明 |
|---|---|
| **统一入口** | 英伟达、商汤等不同平台合成一个地址，用模型别名调用，不用关心背后是谁 |
| **轮流调用** | 多个 Key 轮询分摊请求，不会揪着一个薅 |
| **429 自动换 Key** | 撞上限流立刻换下一个 Key 重试，客户端完全无感 |
| **冷却与退避** | 被限流的 Key 进冷却期；连续被限流则指数退避（60s → 2min → … → 10min 封顶） |
| **无效 Key 自动踢出** | 401/403 的 Key 永久下线，不再浪费尝试次数 |
| **主动限流** | 每个 Key 可设 RPM 上限与并发上限，在触发 429 **之前**就把流量摊开 |
| **同账号共享配额** | 英伟达 40 RPM 是按**账号**算的，同账号多 Key 不叠加额度 —— 本池支持按账号分组计数 |
| **忙时排队** | 所有 Key 都满时请求会排队等待（默认最多 20 秒），而不是直接报错 |
| **连坐冷却** | 同账号分组内一个 Key 撞 429，整组一起冷却退避，不再同组逐个白试 |
| **半开探活** | 冷却/下线到期的 Key 先用免费 `GET /models` 验证再回池；被临时风控下线的 Key 可自动复活 |
| **模型级熔断** | 某模型连续多次全败自动熔断，期间秒回 503 带重试时间，不反复试错 |
| **调用日志** | 每次调用落盘 `logs/usage/`（按天 JSONL，脱敏），操作台可查日志、看用量趋势 |
| **监控告警** | 全 Key 下线 / 连续 429 / 用户配额用尽时自动发邮件到 QQ 邮箱（零依赖 SMTP） |
| **流式透传** | SSE 流式响应原样转发，支持打字机效果 |
| **热重载** | 改完 `config.json` 保存即生效，不用重启 |

---

## 三分钟上手

### 1. 填 Key

打开 `config.json`，找到 `providers`，把 Key 粘进 `keys` 数组，一行一个：

```json
{
  "name": "nvidia",
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "rpmPerKey": 35,
  "maxConcurrencyPerKey": 2,
  "keys": [
    "nvapi-aaaaaaaaaaaaaaaa",
    "nvapi-bbbbbbbbbbbbbbbb",
    "nvapi-cccccccccccccccc"
  ]
}
```

商汤的同理，粘到 `sensenova` 那一节的 `keys` 里。

> 以 `#` 开头的行会被忽略，可以留着当注释。也可以删掉 `keys` 数组，改用 `"keysFile": "keys-nvidia.txt"` 从外部文件读取（一行一个 Key）。

### 2. 启动

**傻瓜方式（推荐）**：双击桌面上的「**API代理池**」图标 —— 自动启动服务 + 自动打开管理页，全程不用记网址、不用输地址。

- 桌面没有图标？双击项目目录里的 **`start-bg.vbs`**（后台静默启动 + 自动打开管理页）
- 想前台看启动日志：双击 `start.bat`（会弹一个黑窗口显示日志）
- 停止服务：**`stop.bat`**，或直接关掉黑窗口

> 拿不准 Key 有没有填对？双击 **`check-config.bat`** 先体检一下，见文末「配置体检」。

### 3. 接入

> ⚠️ **当前 `config.json` 已开启中转站鉴权**（配了 `accessKeys`），所以**所有调用都要带分发 Key**——包括本机 `127.0.0.1`。如果只是自己单机用、不需要鉴权，把 `config.json` 里的 `accessKeys` 删成 `{}` 保存即可恢复「随便填」的旧行为。分发 Key 见 `config.json` 的 `accessKeys`，下面示例用的是其中一个：

把原来代码里的平台地址换成代理池地址，`apiKey` 换成分发 Key：

```js
// Node.js / OpenAI SDK
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',   // ← 只改这一行
  apiKey: 'sk-pool-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',  // ← 分发 Key（config.json 的 accessKeys）
});
const r = await client.chat.completions.create({
  model: 'auto',                          // ← 用别名，见下方模型表
  messages: [{ role: 'user', content: '你好' }],
});
```

```python
# Python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-pool-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
r = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "你好"}])
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-pool-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}]}'
```

**桌面客户端**（Chatbox / Cherry Studio / NextChat / LobeChat 等）：新建 OpenAI 类型的渠道，API 地址填 `http://127.0.0.1:8787/v1`，密钥填分发 Key（见 `config.json` 的 `accessKeys`；不要写中文，HTTP 头不支持），模型名填 `auto`。

**Claude Code / Cursor / Cline 类工具**：在其 OpenAI 兼容配置项里填同一个地址即可。

---

## 模型别名

请求时 `model` 填别名。**注意调度语义：普通候选之间是轮询均分流量，不是"前面挂了才用后面"；只有标了 `fallback: true` 的候选才是兜底**（主力全部限流/冷却时才启用）：

| 别名 | 主力 | 兜底（fallback） | 说明 |
|---|---|---|---|
| `auto` | 商汤 `deepseek-v4-flash` / `deepseek-v4-pro` 轮询 | 英伟达 `deepseek-v4-pro-0813` | 默认；商汤全限流时才等 1~2 分钟走兜底 |
| `pro` | 商汤 `deepseek-v4-pro` | 英伟达 `deepseek-v4-pro-0813` | DeepSeek 旗舰推理 |
| `flash` | 商汤 `deepseek-v4-flash` | — | 快速版，日常问答 |
| `kimi` | 商汤 `kimi-k3` | — | Kimi K3，支持图片输入；英伟达侧 kimi-k3 实测完全调度不出来（2026-09-02 验证，参数无关） |

> ⚠️ **别把慢速上游当普通候选**：候选数组是轮询均分，夹一个冷启动 1~2 分钟的英伟达进去，1/3 的请求就会集体变慢。慢上游必须标 `fallback: true`。

两种精确指定写法：

- `"sensenova:deepseek-v4-pro"` 或 `"deepseek-v4-pro@sensenova"` —— 强制走指定平台，不轮询不兜底
- 直接填平台原生模型名 —— 别名表里没有就**透传给所有平台**挨个试；⚠️ 上游不认识的名字可能不报错也不返回（挂到超时），所以客户端一律填别名

> 三款都是「思考模型」，默认会附带 `reasoning_content`（思考过程），`content` 才是最终答案。想省 token、只要干净答案，请求里加 `"reasoning_effort": "none"` 关闭思考（实测能去掉 reasoning_content、直接出 content）。客户端 `max_tokens` 建议 ≥ 1024，太小会被思考过程吃光导致正文为空。

---

## ⚠️ 同一账号的多个 Key 不叠加额度

这是最容易踩的坑：**英伟达的 40 RPM 是账号级限制，不是 Key 级**。同一个账号开 8 个 Key，总额度还是 40 RPM；商汤的「每 5 小时 1500 次」同理，按账号算。

所以：

- **8 个 Key 来自 8 个不同账号** → 现在这样就行，什么都不用改，`rpmPerKey: 35` 正好卡在 40 的安全线下。
- **有同账号的多个 Key** → 必须分组，否则那几个 Key 会一起被限流，白白浪费重试次数：

```json
{
  "name": "nvidia",
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "rpmPerKey": 0,          // 关掉按 Key 计数
  "rpmPerAccount": 38,     // 改成按账号计数（略低于 40 留余量）
  "maxConcurrencyPerKey": 2,
  "keys": [
    "nvapi-aaa@账号1",      // @后面是账号标签，随便起，一样的算同一组
    "nvapi-bbb@账号1",
    "nvapi-ccc@账号2",
    "nvapi-ddd@账号2"
  ]
}
```

这样「账号1」和「账号2」各自独立按 38 RPM 计数，互不干扰。

---

## 参数说明

> 📘 每个字段的完整讲解、默认值、四种「怎么改」的场景示例，见 **[`CONFIG.md`](./CONFIG.md) 配置文档教程**。下面是最常用的速查。

### 全局参数

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 只监听本机，外网访问不到。要当中转站改成 `0.0.0.0`（必须同时配 `accessKeys`，否则裸奔） |
| `port` | `8787` | 端口。被占用就换一个 |
| `proxyApiKey` | 空 | 旧版单 Key 鉴权：客户端必须带 `Authorization: Bearer <这个值>`。新项目建议用下面的 `accessKeys` |
| `accessKeys` | `{}` | 中转站分发 Key：`{ "分发的Key": "用户名" }` 或 `{ "分发的Key": { "name": "用户名", "rpm": 10, "daily": 300 } }`。`rpm`=每分钟上限、`daily`=每天上限，0/缺省=不限。每日配额按**北京时间**（UTC+8）零点重置；`GET /v1/models` 只做鉴权、**不消耗**用户的 rpm/daily 次数 |
| `strategy` | `round-robin` | `round-robin` 轮流；`least-used` 优先挑用得最少的 |
| `maxAttempts` | `8` | 单次请求最多尝试多少个「模型 + Key」组合。Key 多、容忍度高可以调大 |
| `waitForSlotMs` | `20000` | 全部 Key 都忙时，最长排队等待多久再报 503 |
| `cooldownMs` | `60000` | 触发 429 后的基础冷却时长（会指数退避） |
| `maxCooldownMs` | `600000` | 冷却时长上限，10 分钟 |
| `requestTimeoutMs` | `120000` | 单个上游请求超时（全局默认值；各平台可用 `requestTimeoutMs` 覆盖，见下表） |
| `logLevel` | `info` | `debug` 最啰嗦，`warn` 只看异常，`silent` 不打印 |
| `adminToken` | 空 | 操作台管理密码。留空=仅本机可打开操作台；设置后访问 `/admin` 需输入该密码 |
| `exposePassthrough` | `false` | `/v1/models` 是否列出 `平台名:__passthrough__` 占位项（默认关：它不可调用，客户端误选会报错） |
| `groupCooldownOn429` | `true` | **连坐冷却**：同账号分组内一个 Key 撞 429，整组一起冷却（账号级限流，避免同组 8 个 Key 逐个白试） |
| `halfOpen` | 见下 | **半开探活**：冷却/下线到期的 Key 先用 `GET /models` 免费探活，通过才回池，坏 Key 不再反复咬真实请求 |
| `breaker` | 见下 | **模型级熔断**：某模型连续多次全败 → 熔断窗口内秒回 503，不反复试错、不让客户端傻等排队 |

### 每个平台的参数

| 字段 | 说明 |
|---|---|
| `name` | 平台代号，用于 `provider:model` 语法和日志标识 |
| `baseUrl` | 平台的 OpenAI 兼容地址 |
| `keys` | Key 数组，支持 `"key@账号标签"` 和 `"env:环境变量名"` 写法 |
| `keysFile` | 可选，从外部 txt 读 Key（一行一个，`#` 开头为注释） |
| `rpmPerKey` | 每个 Key 每分钟最多发多少次。`0` = 不限 |
| `rpmPerAccount` | 每个账号分组每分钟最多发多少次。仅在 Key 带 `@标签` 时生效，`0` = 不限 |
| `maxConcurrencyPerKey` | 每个 Key 同时最多几个在途请求。`0` = 不限 |
| `requestTimeoutMs` | **平台级请求超时**，覆盖全局值。慢平台调大（NIM 冷启动 113s → `180000`），快平台调小（商汤 1~6s → `60000`，故障时快速失败换 Key），`0` = 用全局 |
| `probePath` | 平台级探活路径覆盖（半开探活用），默认跟随全局 `halfOpen.probePath` = `models` |
| `extraHeaders` | 额外请求头，如 `{"HTTP-Referer": "xxx"}` |

---

## 看运行状态

浏览器打开 **http://127.0.0.1:8787/** ，每 5 秒自动刷新：

- **绿色 可用** / **蓝色 忙碌** / **橙色 冷却中（带剩余秒数，组连坐会标 `组Ns`）** / **紫色 待探活**（冷却到期等探活验证）/ **红色 已下线**（或「待复活」= 进入复活探活周期）
- 每个 Key 的并发数、RPM 用量、成功/失败/429 次数、最近耗时、最近错误

其他接口：

| 接口 | 用途 |
|---|---|
| `GET /health` | 健康检查，`{"status":"ok","keys":8}` |
| `GET /stats` | JSON 版全量统计，可接自己的监控。设了 `adminToken` 后需带 `Authorization: Bearer <adminToken>`（本机免密） |
| `GET /v1/models` | 模型别名列表，给客户端列模型用（只鉴权、不消耗调用配额） |

响应头里还带了调度信息，排查问题时很有用：`x-pool-key`（命中的 Key 编号）、`x-pool-provider`、`x-pool-model`、`x-pool-attempt`（第几次尝试才成功）。

---

## 操作台（可视化管理，无需手改配置）

双击桌面「**API代理池**」图标（或浏览器打开 **http://127.0.0.1:8787/admin**）进入管理台。打开后先看到一个**傻瓜首页**——健康状态一眼看清，大图标点哪进哪，非专业者也能上手：

| 页签 | 能做什么 |
|---|---|
| **🏠 首页** | 健康状态卡 + 大图标导航，点图标进入对应功能 |
| **运行状态** | Key 状态、用量、接入用户实时看板（自动刷新） |
| **密钥管理** | 增删平台、改 baseUrl/限流参数、增删 Key（一行一个）、账号分组 |
| **模型** | 增删别名、编辑候选降级链 |
| **对接密钥** | 增删分发 Key、改 RPM/每日限流、一键生成随机 Key |
| **使用记录** | 查询调用日志（谁用了、用了多少） |
| **用量统计** | 用量趋势图表（每天用了多少次） |
| **设置** | strategy、logLevel、限流参数、管理密码、监控告警等 |
| **试一下** | 界面里直接发一条消息，验证配置与模型 |

改完点右上角「**保存配置**」，自动写回 `config.json` 并**热重载生效**（不用重启）。改动 `host`/`port` 需重启服务才生效。

### 操作台鉴权

- 默认（`adminToken` 留空）：**只有本机**能打开操作台，局域网/远程打不开。
- 想远程也能管理：在操作台「全局设置」里填一个 `adminToken`（管理密码），保存后访问 `/admin` 需输入该密码。

> 操作台只改 `config.json`，不改服务逻辑；误操作可随时恢复。所有改动都通过带鉴权的管理接口，本机免密 / 远程需 adminToken。

> 🔒 **跨站来源防护**：管理接口（`/admin/*`、`/stats`、`/`）只对「无 Origin 的客户端（脚本/Node）」和「本机或同源浏览器」开放；带外部网站 Origin 的浏览器请求一律 403，且这些接口不返回 CORS 头——防止恶意网页在浏览器里读取你的配置与统计（DNS rebinding / 跨站窃取 Key）。代理接口 `/v1/*` 不受影响，仍允许任意跨域（中转站客户端 SDK 需要）。

---

## 常见问题

**启动报「端口 8787 已被占用」**
先跑 `stop.bat`，或改 `config.json` 里的 `port`。

**全是 429 / 面板上一片橙色冷却**
真被限流了。要么降低 `rpmPerKey`，要么加 Key。如果是同账号多 Key，看上面「同一账号多 Key」那一节。

**某个 Key 变红「已下线」**
返回了 401/403，多半是 Key 抄错了、过期了或被平台吊销。改好 `config.json` 保存，会自动重新启用。

**商汤报 404 / 401**
官方给的兼容地址有两个，优先用 `https://token.sensenova.cn/v1`；如果你的账号开通的是另一套，换成 `https://api.sensenova.cn/v1` 试试（改 `config.json` 里 `sensenova` 的 `baseUrl`，保存即生效）。

**模型不支持 / 报 unknown model**
各平台的模型 ID 会变。去平台官网的模型页抄最新的 ID，填到 `config.json` 的 `models` 里。

**返回 503 `no_available_key`**
本次候选的 Key 全在冷却或占满。等一会儿重试，或者把 `waitForSlotMs` 调大让它多排队一会儿。

---

## 配置体检

填完 Key 先体检一遍，不用等业务报错：

```bash
node check-config.js          # 只做静态检查，不联网、不消耗额度
node check-config.js --live   # 额外真实调用每个 Key 验证可用性
```

Windows 直接双击 **`check-config.bat`** 就跑静态检查。

**静态检查**会看：JSON 是否合法、平台地址格式、每个平台的 Key 数量与前缀（`nvapi-` / `sk-`）、
有没有重复 Key、同账号分组有没有配对、`models` 别名引用的平台是否真实存在、
限流参数是否合理、对外暴露时有没有设密码。

**`--live`** 会用每个 Key 真实发一次最小请求（`max_tokens=16`），逐个报告：

```
  ✗ 401     nvidia nvapi-9f3a...x7Q2 @账号1     312ms   无效，请更换
  ✓ 可用    nvidia nvapi-2b1c...m4K8 @账号2    1420ms
  ! 429     sensenova sk-7d2e...p9Lz            280ms   额度用尽，稍后自动恢复
```

一眼看出哪个 Key 是坏的、哪个平台地址填错了。

## 自检

填好 Key 后跑一下，验证是否真的分散到了多个 Key（会真实消耗少量额度）：

```bash
POOL_KEY=sk-pool-xxx node test.js        # 健康检查 + 单次调用 + 12 并发 + 流式
POOL_KEY=sk-pool-xxx node test.js 30     # 并发改成 30
POOL_KEY=sk-pool-xxx node test.js 12 pro # 指定模型别名
```

> 中转站鉴权已开启时，脚本用 `POOL_KEY` 环境变量传入分发 Key（config.json 的 `accessKeys` 里挑一个）；设了 `adminToken` 再看 `/stats` 需加 `POOL_ADMIN_TOKEN=xxx`。

输出会画出每个 Key 各分到多少请求，一眼看出轮询是否生效。

不想消耗真实额度，可以跑本地模拟上游的纯逻辑验证（不联网）：

```bash
node tests/mock-upstream.js          # 终端 1：模拟上游（含 401/429/慢节点）
POOL_CONFIG=tests/config.test.json node server.js   # 终端 2：测试用代理池
node tests/verify.js                 # 终端 3：14 项断言
```

---

## 开机自启（可选）

想让代理池开机后自动在后台跑起来：

- 双击 **`install-autostart.bat`** —— 加入开机启动项
- 双击 **`uninstall-autostart.bat`** —— 取消

开机后是静默后台运行（不弹黑窗口），会自动打开状态面板。它只是往系统的「启动」文件夹放一个
指向 `start-bg.vbs` 的快捷方式，随时可以取消，不写注册表、不改系统设置。

## 变身中转站（让局域网/公网的人调用）

默认只监听本机。改成中转站只需两步：

**① 改 config.json 顶部：**

```json
"host": "0.0.0.0",          // 监听所有网卡，局域网可访问
"accessKeys": {
  "sk-发给同事甲的key": "同事甲",                                  // 简单版：只记名字
  "sk-发给同事乙的key": { "name": "同事乙", "rpm": 10, "daily": 300 }  // 限流版：rpm=每分钟上限，daily=每天上限
}
```

- 不写 `accessKeys`（或留 `{}`）= 不校验调用方身份，**不要配合 `0.0.0.0` 使用**
- 保存即热重载，无需重启
- 每个 Key 的调用量、限流情况实时显示在状态面板「接入用户」表

**② 放行防火墙端口（一次性）：** 右键 `firewall-open.bat` → 以管理员身份运行。

之后别人这样调用：

```bash
curl http://你的IP:8787/v1/chat/completions \
  -H "authorization: Bearer sk-发给他的key" \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}]}'
```

查你的局域网 IP：`ipconfig` 里 IPv4 地址（如 `192.168.137.83`）。

**三种接入范围：**

| 场景 | 接入地址 | 说明 |
|---|---|---|
| 同一局域网 | `http://192.168.x.x:8787/v1` | 改 host + 防火墙放行即可 |
| 跨网络公网 | 内网穿透（cpolar/花生壳/ngrok）或云服务器反代 | 免费穿透域名一般带 HTTPS |
| 跨网络且要安全 | Tailscale/ZeroTier 组虚拟局域网 | 最省心，IP 不变也能访问 |

> 中转模式强烈建议配合 `rpm`/`daily` 限流，防止某个人把你的免费额度打爆。`x-pool-user` 响应头会标注本次是哪个分发 Key 在调用（`user-1`、`user-2`…），方便排查。

## 文件清单

```
api-key-pool/
├── server.js                  代理池主服务（唯一核心文件）
├── config.json                配置：Key、平台、模型别名、限流参数
├── admin.html                 操作台（图形化管理界面，访问 /admin）
├── start.bat                  启动（前台，看日志）
├── start-bg.vbs               启动（后台静默 + 自动开面板）
├── stop.bat                   停止
├── check-config.bat           配置体检（双击，不消耗额度）
├── check-config.js            配置体检脚本
├── test.bat                   自检（双击，会消耗少量真实额度）
├── test.js                    自检脚本
├── install-autostart.bat      加入开机自启（可选）
├── uninstall-autostart.bat    取消开机自启
├── firewall-open.bat          放行 8787 端口供局域网访问（需管理员）
├── firewall-close.bat         撤销端口放行
├── daily-report.js            每日用量报表（node daily-report.js，生成 reports/）
├── reports/                   日报输出目录（每日一份 HTML）
├── tests/                     本地模拟验证（不联网、不消耗额度）
│   ├── mock-upstream.js       模拟上游 API（BAD1/RATE1/RATE2/RATE2B/ALWAYS429/REVIVE1/SLOW1）
│   ├── verify.js              端到端回归（14 项：下线/轮询/429/并发/SSE/分组配额）
│   ├── verify-scheduler.js    调度增强专项（连坐冷却 + 模型熔断 + 排队不熔断，12 项）
│   ├── verify-halfopen.js     调度增强专项（半开探活回池 + 死 Key 复活，7 项）
│   └── config*.test.json      各专项用的代理池配置
└── logs/                      start-bg.vbs 的日志目录（运行后自动创建）
```

> 服务遇到任何异常（包括漏网的未捕获异常）都只记录日志、不退出进程，会持续常驻。

---

## 每日用量报表

想看「今天谁用了多少、Key 还健康吗」，不用翻面板：

```bash
node daily-report.js          # 默认连 http://127.0.0.1:8787
POOL_BASE=http://127.0.0.1:8787 node daily-report.js
POOL_ADMIN_TOKEN=xxx node daily-report.js   # 设了 adminToken 后需要
```

生成 `reports/YYYY-MM-DD.html`，包含：
- 每个接入用户的今日调用 / 累计 / 最近调用时间
- 每个上游 Key 的状态（可用 / 冷却 / 下线）、成功 / 失败 / 429 数、最近错误
- 汇总卡片：Key 总数、累计成功 / 失败 / 429、服务运行时长

报表只读 `/stats` 接口，**不消耗上游额度**。也可以配成每天自动生成（WorkBuddy 定时任务），或者加个 Windows 计划任务双击即用。

---

## 安全提醒

- `config.json` 里是**明文 Key**，别传到网盘、GitHub 或发给别人。已附 `.gitignore`。
- 默认只监听 `127.0.0.1`，外部机器访问不到。改成 `0.0.0.0` 供局域网/公网使用时，**必须配置 `accessKeys`（或 `proxyApiKey`）**，否则任何人都能白嫖你的额度 —— 启动时会红字警告。
- 分发给别人的 Key 不要用 `sk-` 前缀（和上游 Key 混淆），用 `sk-pool-xxx` 之类，方便从日志里区分。
- 也可以不在文件里写明文：把 Key 存进系统环境变量，`config.json` 里写 `"env:NVIDIA_KEY_1"`，代理池启动时自动读取。

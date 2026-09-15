# api-key-pool Web 层重构蓝图:new-api 式单页应用

> 目标:参照 new-api 的架构(SPA + 统一 API 层 + 角色路由),把现有 admin.html/home.html/portal.html 三张拼凑 HTML 替换为一个单页应用。**保持零依赖**(纯原生 JS,无构建步骤——new-api 用 React+rsbuild,我们不用,因为项目铁律是零第三方依赖;SPA 的骨架模式照搬,实现方式原生化)。
> 单端口 8787 单站点:页面 + API 同源同端口(与 new-api 的 `go:embed web/dist` + NoRoute fallback 同构)。

## 架构决策(已定,不可逆)

| 决策 | 选择 | 理由 |
|---|---|---|
| 前端形态 | **原生 JS SPA**(hash 路由),单文件 `app.html` 内嵌全部代码 | 零依赖铁律;无构建;单文件部署=现在 scp 流程不变 |
| 路由 | hash 路由(`#/login` `#/console/...`),服务端只需 1 个入口 | 服务端 NoRoute fallback 逻辑最小化;刷新不 404 |
| 服务端 | **API 层全部保持不变**(16 个端点已稳定),只改 2 处:①`/` 与 SPA fallback 返回 app.html ②删三个旧页面路由 | API 已被三个角色前端验证过,重写前端不改后端 = 风险减半 |
| 样式 | 一套内嵌 CSS 变量(design tokens),浅色为主,布局抄 new-api(左侧栏+顶栏+内容区) | 三张旧页面风格已在演进中趋同,统一成一套 |
| 认证 | cookie 会话(`/api/auth/*`)为主;adminToken/collabToken Bearer 作为 API 兼容层保留 | 已完成的双通道鉴权(server.js 1cc17d8)原样复用 |
| 数据获取 | 前端统一 `api()` 封装(fetch + 401 统一跳登录) | 三张旧页面各有一份 fetch 封装,收敛成一个 |
| 兼容 | `/admin` `/portal` `/home` `/dashboard` 301 到 SPA 对应 hash 路由 | 旧链接不 404 |

## 页面清单(对标 new-api,按我们角色裁剪)

```text
#/login            登录(用户名密码+验证码;管理员填 Token 当密码——已有逻辑)
#/register         注册
#/                 公开首页(hero/特性/接入示例)           角色:所有人
#/console          控制台(登录后)
  ├─ dashboard     运行状态(Key健康/调用统计)              admin
  ├─ keys          上游密钥管理(平台/Key/限流)             admin
  ├─ models        模型别名管理                            admin
  ├─ tokens        分发 Key 管理(增删改/启停/复制)          admin+collab(collab 只见自己创建的)
  ├─ logs          调用日志                                admin(collab 只见自己的)
  ├─ usage         用量统计(图表)                          admin
  ├─ settings      系统设置(调度参数/告警/adminToken)       admin
  ├─ playground    试一下(对话测试)                        admin+collab
  └─ profile       个人中心(改密码/我的Key/我的用量)         全部角色(用户只看得到 profile)
```

**角色可见性**:user(普通注册用户)只见 `profile`;collab 见 `profile + keys(放Key) + tokens(生成/列表) + playground`;admin 全部。实现:路由表带 `roles` 字段,渲染前检查,无权→跳 profile。

## 文件产出

```text
app.html        # SPA 单文件(HTML+CSS+JS 全内嵌,预计 1500~2000 行)——唯一新文件
server.js       # 改 3 处:①新增 GET /app 与 SPA fallback ②旧页面路由 301 ③旧静态文件引用清理
(删除提交)      # home.html/portal.html/admin.html 在新 SPA 验收通过后单独 commit 删除(可回滚)
```

## 步骤(每步可独立验收,任何 agent 可冷启动执行)

### Step 1: 服务端 SPA 骨架(fallback + 兼容跳转)
**任务**:
1. server.js 新增路由:`GET /app`(及 `GET /console`、`GET /login`、`GET /register`)返回 `app.html`;`GET /` 返回 app.html(SPA 自己按 hash 决定首页内容);
2. 旧路径 301:`/admin`→`/app#/console/dashboard`, `/portal`→`/app#/console/profile`, `/home`→`/app#/`, `/dashboard`→`/app#/console/dashboard`;
3. `readFileSync app.html` 缺失时报 500(同现有 handleAdminPage 模式);
4. **不删** home/portal/admin.html(第三步再删)。
**验收**: `curl /app` 200;`curl -L /admin` 落到 app.html 内容;`curl /health /v1/models` 不受影响。
**回滚**: git revert 单文件。

### Step 2: app.html 骨架——布局 + hash 路由 + 会话
**任务**:
1. design tokens(变量与旧页面一致:--brand #5b5ff1 等);布局:公开页无侧栏;登录后左侧栏(菜单按角色过滤)+顶栏(用户名/角色徽章/退出)+内容区;
2. hash 路由器:`routes = [{path, title, roles, render}]`;`navigate()`,`guard()`(未登录→#/login;角色不符→#/console/profile);`window.onhashchange`;
3. `api()` 封装:fetch + credentials:'include' + 401 统一跳 `#/login`;`me()`(GET /api/auth/me)缓存登录态与角色;
4. 登录页(验证码流程照搬 home.html 的:GET captcha→x-captcha-id→注册/登录;成功按 role 跳转)与注册页;
5. 首页(hero 三卡 + 代码示例,内容照搬 home.html);
6. `mustChangePassword` 强制改密弹层(照搬 portal.html 的 showChangePwd)。
**验收**: 浏览器手动:未登录访问 /app → 首页;点登录→验证码→admin 登录→落到 /#/console/dashboard;F5 刷新各 hash 页面均正常(hash 路由天然刷新安全)。
**回滚**: app.html 还没接路由前 revert server.js 即回到旧版。

### Step 3: 六个功能页移植(从三张旧 HTML 搬逻辑,不是重写)
**任务**(每页 = 一个 render 函数,数据源 API 不变):
1. `dashboard`(自 admin.html renderHome+renderOverview:健康卡+Key 状态表,5s 自动刷新);
2. `keys`(自 renderProviders:平台卡片/Key textarea/限流字段;**保留防呆校验 validateConfig 全量搬入**);
3. `models`(自 renderModels:别名/候选/兜底勾选);
4. `tokens`(自 renderAccess:分发 Key 表+生成/启停;collab 角色改调 /admin/api/collab/* 三个接口——它原来就是这样);
5. `logs` + `usage`(自 renderLogs/renderUsage:筛选器+表格+SVG 柱图);
6. `settings`(自 renderSettings:调度参数含 ms 换算提示+告警邮箱+adminToken/collabTokens 管理);
7. `playground`(自 renderPlayground:选模型发消息看流式);
8. `profile`(自 portal.html:我的 Key/近 7 天趋势/模型分布/最近调用/改密码——user 角色的唯一页面)。
**验收**: 逐页点一遍与旧版对照功能无缺失;防呆校验故意造错(重复Key/非法别名)确认弹窗;collab 账号登录只见 3 页;普通 user 只见 profile。
**回滚**: 单 commit revert。

### Step 4: 切换 + 清理 + 上线
**任务**:
1. 手工验收通过后,git rm home.html portal.html admin.html(单独 commit,信息注明"回滚点");
2. server.js 里三个旧 handle*Page 函数与相关静态引用删除;
3. 部署云端:scp app.html server.js → restart → 公网冒烟(登录/dashboard/tokens/playground);
4. README「操作台」章节更新为 SPA 说明;commit+push。
**验收**: 云端公网全流程走通;`git log` 显示删除独立成 commit。
**回滚**: revert 删除 commit + scp 旧三张 HTML。

## 不变量(每步之后必须全绿)

```bash
node --check server.js
# 四套离线回归(不联网):
node tests/mock-upstream.js &  # 8899
POOL_CONFIG=tests/config.test.json node server.js &  # 8890
node tests/verify.js; node tests/verify-stream-normalization.js
POOL_CONFIG=tests/config.scheduler.json ... node tests/verify-scheduler.js
POOL_CONFIG=tests/config.halfopen.json ... node tests/verify-halfopen.js
# /v1 API 与 /health 与 /stats 行为与重构前一致(核心:前端重构不许碰调度/代理逻辑)
```

## 反模式清单(评审重点)

- ❌ 在前端重写调度/限流逻辑(只许消费现有 API)
- ❌ 引入任何 npm 依赖/CDN 脚本(零依赖铁律)
- ❌ 三张旧页面与 SPA 长期并存(Step 4 必须删,防双源漂移)
- ❌ 把 adminToken 渲染进普通用户可见的 DOM
- ❌ hash 路由未做角色 guard(直接输 URL 越权——前端 guard 只是体验层,后端 API 鉴权才是真墙,两者都要有)
- ❌ 删除 tests/ 或改变测试端口约定

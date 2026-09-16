'use strict';
/* ============================================================
 * API Key 代理池 · 单页应用
 * 零依赖原生 JS + hash 路由,页面与 API 同源同端口(8787)
 * 角色:user(个人中心) / collab(放Key·生成Key) / admin(全部)
 * ============================================================ */

/* ================= 全局状态 ================= */
let ME = null;                 // 会话身份 {name,role,mustChangePassword}
let cfg = null;                // 配置副本(仅 admin 拉取)
let stats = null;
let token = localStorage.getItem('akp_admin_token') || '';   // Bearer 兼容(API 直调场景)
let role = 'user';
let dirty = false;
let currentPage = '';
let accessRows = [];           // 分发 Key 编辑中间层
let statsTimer = null;
let logsFilter = { days: 2, limit: 100, caller: '', status: '' };
let usageFilter = { days: 7, caller: '' };
let usageView = 'daily';
let collabProviders = [];
let myKeysCache = null;
let providerModels = {};       // 平台 → { loading, ok, models[], error }（模型列表,供下拉选择）

const $shell = document.getElementById('shell');
const $toast = document.getElementById('toast');

/* ================= 工具 ================= */
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function getByPath(o, p){ return p.split('.').reduce((x,k)=> x==null?undefined:x[k], o); }
function setByPath(o, p, v){
  const ks = p.split('.'); let x = o;
  for(let i=0;i<ks.length-1;i++){ const k=ks[i]; if(x[k]==null) x[k] = /^\d+$/.test(ks[i+1])?[]:{}; x = x[k]; }
  x[ks[ks.length-1]] = v;
}
function toast(msg, kind){
  const t = document.createElement('div');
  t.className = 'toast ' + (kind||'');
  t.textContent = msg;
  $toast.appendChild(t);
  requestAnimationFrame(()=> t.classList.add('show'));
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=> t.remove(), 300); }, 2600);
}
function markDirty(){ dirty = true; const d=document.getElementById('dirty-dot'); if(d) d.classList.add('show'); }
function fmtUptime(sec){ sec=Math.floor(sec||0); const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60; return h?`${h}h${m}m`:(m?`${m}m${s}s`:`${s}s`); }
function fmtTime(ts){ return ts ? new Date(ts).toLocaleString('zh-CN',{hour12:false}) : '—'; }
function fmtDay(ts){ return new Date(ts + 8*3600000).toISOString().slice(0,10); }
function roleLabel(r){ return r==='admin' ? '管理员' : (r==='collab' ? '协同管理员' : '用户'); }

/* ================= 统一 API ================= */
async function api(method, path, body){
  const headers = {};
  if (token) headers['authorization'] = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const resp = await fetch(path, { method, headers, credentials:'include', body: body===undefined?undefined:JSON.stringify(body) });
  let data = null;
  try { data = await resp.json(); } catch(_) {}
  if (resp.status === 401 && data && data.needAuth && !ME) { navigate('#/login'); throw new Error('NEED_AUTH'); }
  return { status: resp.status, ok: resp.ok, data };
}

/* ================= 会话 ================= */
async function fetchMe(){
  try {
    const r = await fetch('/api/auth/me', { credentials:'include' });
    if (r.status !== 200) { ME = null; role = 'user'; return null; }
    ME = await r.json();
    role = ME.role || 'user';
    return ME;
  } catch(_) { ME = null; role = 'user'; return null; }
}

/* ================= 侧栏 & 顶栏 ================= */
const MENU = [
  { hash:'#/console/dashboard',  icon:'pulse',  text:'运行状态',   roles:['admin'] },
  { hash:'#/console/keys',       icon:'key',    text:'密钥管理',   roles:['admin'] },
  { hash:'#/console/models',     icon:'layers', text:'模型',       roles:['admin'] },
  { hash:'#/console/tokens',     icon:'link',   text:'分发密钥',   roles:['admin','collab'] },
  { hash:'#/console/logs',       icon:'list',   text:'使用记录',   roles:['admin'] },
  { hash:'#/console/usage',      icon:'chart',  text:'用量统计',   roles:['admin'] },
  { hash:'#/console/playground', icon:'zap',    text:'试一下',     roles:['admin','collab'] },
  { hash:'#/console/settings',   icon:'gear',   text:'设置',       roles:['admin'] },
  { hash:'#/console/profile',    icon:'user',   text:'个人中心',   roles:['admin','collab','user'] },
];
const PAGE_TITLES = {
  '#/console/dashboard':'运行状态', '#/console/keys':'密钥管理', '#/console/models':'模型',
  '#/console/tokens':'分发密钥', '#/console/logs':'使用记录', '#/console/usage':'用量统计',
  '#/console/playground':'试一下', '#/console/settings':'设置', '#/console/profile':'个人中心',
};

function renderShell(title, contentHTML, opts){
  opts = opts || {};
  const items = MENU.filter(m => m.roles.includes(role));
  const showSave = role === 'admin';
  $shell.innerHTML = `
  <aside id="sidebar">
    <div class="brand">
      <div class="brand-logo"><svg class="ic"><use href="#i-zap"/></svg></div>
      <div class="brand-name">API 代理池<span>控制台</span></div>
    </div>
    <nav class="menu" id="nav">
      ${items.map(m=>`<button data-hash="${m.hash}" class="${currentHash()===m.hash?'active':''}"><svg class="ic"><use href="#i-${m.icon}"/></svg><span>${m.text}</span></button>`).join('')}
    </nav>
    <div class="sidebar-user">
      <b>${esc(ME?ME.name:'未登录')}</b>
      <span class="role">${roleLabel(role)}</span>
      <button id="btn-logout">退出登录</button>
    </div>
  </aside>
  <div class="layout">
    <header class="topbar">
      <div class="page-title">${esc(title)}</div>
      <div class="spacer"></div>
      ${opts.hideAddr?'':`<div class="addr hide-sm">服务 <code>${esc(location.host)}</code></div>`}
      ${showSave?`<button class="btn ghost" id="btn-reload" title="放弃未保存修改,重新读取">重新加载</button>
      <button class="btn primary" id="btn-save"><span class="dirty-dot" id="dirty-dot"></span>保存配置</button>`:''}
    </header>
    <main id="main">${contentHTML||''}</main>
  </div>`;
  const nav = document.getElementById('nav');
  if (nav) nav.addEventListener('click', e=>{
    const b = e.target.closest('[data-hash]'); if(!b) return;
    navigate(b.dataset.hash);
  });
  const lo = document.getElementById('btn-logout');
  if (lo) lo.addEventListener('click', async ()=>{ await fetch('/api/auth/logout',{method:'POST',credentials:'include'}); localStorage.removeItem('akp_admin_token'); token=''; ME=null; navigate('#/'); });
  const sv = document.getElementById('btn-save');
  if (sv) sv.addEventListener('click', save);
  const rl = document.getElementById('btn-reload');
  if (rl) rl.addEventListener('click', ()=>{ dirty=false; loadConfig(); loadStats(); toast('已重新加载'); });
}

/* ================= 路由 ================= */
const ROUTES = [
  { path:'#/',            view: viewHome,      public:true },
  { path:'#/login',       view: viewAuth,      public:true, mode:'login' },
  { path:'#/register',    view: viewAuth,      public:true, mode:'register' },
  { path:'#/console/dashboard',  view: pageDashboard, roles:['admin'] },
  { path:'#/console/keys',       view: pageKeys,      roles:['admin'] },
  { path:'#/console/models',     view: pageModels,    roles:['admin'] },
  { path:'#/console/tokens',     view: pageTokens,    roles:['admin','collab'] },
  { path:'#/console/logs',       view: pageLogs,      roles:['admin'] },
  { path:'#/console/usage',      view: pageUsage,     roles:['admin'] },
  { path:'#/console/settings',   view: pageSettings,  roles:['admin'] },
  { path:'#/console/playground', view: pagePlayground,roles:['admin','collab'] },
  { path:'#/console/profile',    view: pageProfile,   roles:['admin','collab','user'] },
];
function currentHash(){ return location.hash || '#/'; }
function navigate(hash){ if (location.hash === hash) route(); else location.hash = hash; }
function defaultLanding(){ return (role==='admin'||role==='collab') ? '#/console/dashboard' : '#/console/profile'; }

async function route(){
  if (statsTimer){ clearInterval(statsTimer); statsTimer = null; }
  const h = currentHash();
  let r = ROUTES.find(x => x.path === h);
  if (!r){
    if (h === '#/console' || h.startsWith('#/console/')) r = ROUTES.find(x=>x.path===defaultLanding());
    else r = ROUTES.find(x=>x.path==='#/');
  }
  if (r.public && r.mode && ME && (ME.role==='admin'||ME.role==='collab')) { navigate(defaultLanding()); return; }
  if (!r.public){
    if (!ME){ navigate('#/login'); return; }
    if (r.roles && !r.roles.includes(role)){ toast('无权访问该页面','err'); navigate('#/console/profile'); return; }
  }
  currentPage = r.path;
  // 管理页需要配置数据:首次进入时先拉配置
  if (role === 'admin' && !cfg && !r.public){ try { await loadConfig(); } catch(_) {} }
  await r.view(r);
  if (r.path === '#/console/dashboard'){ loadStats(); statsTimer = setInterval(loadStats, 5000); }
  if (r.path === '#/console/logs') loadLogs();
  if (r.path === '#/console/usage') loadUsage();
}
window.addEventListener('hashchange', route);

/* ================= 首页(公开) ================= */
function viewHome(){
  document.title = 'API Key 代理池';
  const base = location.protocol + '//' + location.host;
  $shell.innerHTML = `
  <div style="max-width:960px;margin:0 auto;padding:0 20px;width:100%">
    <header style="display:flex;align-items:center;justify-content:space-between;padding:18px 0">
      <div class="brand" style="padding:0">
        <div class="brand-logo" style="background:linear-gradient(135deg,#5b5ff1,#8b5ff1)"><svg class="ic"><use href="#i-zap"/></svg></div>
        <div class="brand-name" style="color:var(--text)">API 代理池<span>免费 AI 额度聚合网关</span></div>
      </div>
      <nav style="display:flex;gap:16px;font-size:14px;align-items:center">
        ${ME ? `<a href="${defaultLanding()}" class="btn primary" style="color:#fff">进入控制台</a>`
             : `<a href="#/login">登录</a><a href="#/register" class="btn primary" style="color:#fff">免费注册</a>`}
      </nav>
    </header>
    <section style="padding:56px 0 36px;text-align:center">
      <h1 style="font-size:38px;line-height:1.25;letter-spacing:-.5px;margin:0">多个免费 AI 额度<br>聚合成<span style="background:linear-gradient(120deg,#5b5ff1,#a55ff1);-webkit-background-clip:text;background-clip:text;color:transparent">一个接口</span></h1>
      <p style="color:var(--muted);font-size:16px;margin:18px auto 28px;max-width:580px">把商汤、英伟达、ModelScope、OpenRouter 等多个平台的免费 Key 打成一块。轮询分摊、限流自动切换 Key、额度用尽智能冷却——你只需要改一行 base_url。</p>
      <div style="display:flex;gap:12px;justify-content:center">
        <button class="btn primary" onclick="navigate('${ME?'#/console/profile':'#/register'}')">${ME?'进入控制台':'免费注册'}</button>
        <button class="btn" onclick="navigate('#/login')">已有账号登录</button>
      </div>
    </section>
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:36px 0">
      <div class="card"><h3>统一入口</h3><p style="font-size:13px;color:var(--muted)">OpenAI 兼容协议,一个地址、一个 Key。模型别名随取:auto / pro / flash / kimi / qwen。</p></div>
      <div class="card"><h3>限流自愈</h3><p style="font-size:13px;color:var(--muted)">撞 429 自动换 Key 重试;额度用尽按平台重置周期冷却;半开探活自动复活误伤的 Key。</p></div>
      <div class="card"><h3>用量透明</h3><p style="font-size:13px;color:var(--muted)">每个账号的调用次数、配额余量、模型分布实时可查,密钥自主管理。</p></div>
    </section>
    <div class="card" style="background:#14161f;border-color:#14161f">
      <pre class="mono" style="color:#d6dcff;font-size:13px;line-height:1.8;margin:0;overflow:auto"><span style="color:#7e85a8"># 任何 OpenAI SDK,只改 base_url</span>
client = OpenAI(
    base_url="${esc(base)}/v1",
    api_key="你的分发 Key",   <span style="color:#7e85a8"># 注册后在个人中心查看</span>
)
r = client.chat.completions.create(
    model="auto", messages=[{"role":"user","content":"你好"}])</pre>
    </div>
    <footer style="border-top:1px solid var(--border);padding:24px 0 40px;color:var(--muted);font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div>API Key 代理池 · 零依赖 · OpenAI 兼容</div>
      <div><a href="#/login">管理入口</a></div>
    </footer>
  </div>`;
}

/* ================= 登录 / 注册 ================= */
let pageCaptchaId = '';
async function refreshCaptcha(boxId, imgId){
  try {
    const r = await fetch('/api/auth/captcha');
    pageCaptchaId = r.headers.get('x-captcha-id') || '';
    const svg = await r.text();
    const img = document.getElementById(imgId);
    if (img) img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    const inp = document.getElementById(boxId); if (inp) inp.value = '';
  } catch(_) {}
}
function viewAuth(route){
  const isLogin = route.mode === 'login';
  document.title = isLogin ? '登录' : '注册';
  $shell.innerHTML = `
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;width:100%">
    <div style="width:390px;max-width:92vw">
      <div style="text-align:center;margin-bottom:20px">
        <div class="brand-logo" style="width:48px;height:48px;margin:0 auto 10px;border-radius:14px"><svg class="ic"><use href="#i-zap"/></svg></div>
        <div style="font-size:20px;font-weight:600">${isLogin?'登录':'注册账号'}</div>
        <div style="font-size:13px;color:var(--muted);margin-top:6px;line-height:1.6">${isLogin?'普通用户填密码<br>管理员 / 协同管理员在密码栏填自己的 Token':'注册后可查看个人中心;调用 Key 请联系管理员开通'}</div>
      </div>
      <div class="card" style="padding:24px">
        <div id="auth-err" style="display:none;color:var(--red);font-size:13px;margin-bottom:10px"></div>
        ${isLogin?'':`<div class="field"><label>用户名</label><input class="f" id="auth-name" maxlength="24" autocomplete="username" placeholder="2~24 个字符"></div>`}
        <div class="field"><label>密码${isLogin?'（管理员填 Token）':''}</label><input class="f" type="password" id="auth-pass" autocomplete="current-password" placeholder="${isLogin?'':'至少 6 位'}"></div>
        ${isLogin?'':`<div class="field"><label>确认密码</label><input class="f" type="password" id="auth-pass2"></div>`}
        <div class="field"><label>验证码（点击图片刷新）</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="f" id="auth-cap" maxlength="4" style="flex:1" placeholder="不分大小写">
            <img id="auth-capimg" style="height:42px;border-radius:8px;cursor:pointer;border:1px solid var(--border)" alt="验证码">
          </div>
        </div>
        <button class="btn primary" id="auth-ok" style="width:100%;justify-content:center;margin-top:4px">${isLogin?'登录':'注册'}</button>
        <div style="font-size:13px;color:var(--muted);text-align:center;margin-top:12px">${isLogin?'没有账号? <a href="#/register">去注册</a>':'已有账号? <a href="#/login">去登录</a>'}</div>
      </div>
      <div style="text-align:center;margin-top:14px"><a href="#/" style="font-size:13px">← 返回首页</a></div>
    </div>
  </div>`;
  refreshCaptcha('auth-cap','auth-capimg');
  const ok = document.getElementById('auth-ok');
  ok.addEventListener('click', ()=>doAuth(isLogin));
  ['auth-name','auth-pass','auth-pass2','auth-cap'].forEach(id=>{
    const el = document.getElementById(id); if (el) el.addEventListener('keydown', e=>{ if(e.key==='Enter') ok.click(); });
  });
  document.getElementById('auth-capimg').addEventListener('click', ()=>refreshCaptcha('auth-cap','auth-capimg'));
  const n = document.getElementById('auth-name'); if (n) n.focus(); else document.getElementById('auth-pass').focus();
}
async function doAuth(isLogin){
  const errBox = document.getElementById('auth-err');
  const showErr = m => { errBox.textContent = m; errBox.style.display='block'; };
  const nameEl = document.getElementById('auth-name');
  const name = nameEl ? nameEl.value.trim() : '';
  const password = document.getElementById('auth-pass').value;
  const captchaText = document.getElementById('auth-cap').value.trim();
  if (!password || !captchaText) return showErr('请填写完整');
  if (!isLogin){
    if (!name) return showErr('请填写用户名');
    if (password.length < 6) return showErr('密码至少 6 位');
    if (password !== document.getElementById('auth-pass2').value) return showErr('两次密码不一致');
  }
  errBox.style.display = 'none';
  try {
    const r = await fetch('/api/auth/' + (isLogin?'login':'register'), {
      method:'POST', headers:{'content-type':'application/json'}, credentials:'include',
      body: JSON.stringify({ name, password, captchaId: pageCaptchaId, captchaText }),
    });
    const d = await r.json().catch(()=>({}));
    if (!r.ok){ showErr((d.error && d.error.message) || ('失败 ' + r.status)); refreshCaptcha('auth-cap','auth-capimg'); return; }
    if (d.role === 'admin' || d.role === 'collab') localStorage.removeItem('akp_admin_token');
    token = '';
    await fetchMe();
    toast('登录成功，欢迎 ' + ME.name, 'ok');
    navigate(defaultLanding());
    if (ME.mustChangePassword) setTimeout(()=> showChangePwd('你正在使用预设密码,为了安全请立即修改'), 600);
  } catch(e){ showErr('网络异常: ' + e.message); }
}

/* ================= 改密码弹层 ================= */
function showChangePwd(reason){
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="box">
    <h3>修改密码</h3>
    <div class="sub" style="color:var(--orange)">${esc(reason||'')}</div>
    <div class="field"><label>当前密码</label><input class="f" type="password" id="cp-old"></div>
    <div class="field"><label>新密码（至少 6 位）</label><input class="f" type="password" id="cp-new"></div>
    <div id="cp-err" style="display:none;color:var(--red);font-size:13px;margin-bottom:8px"></div>
    <div class="row"><button class="btn" id="cp-cancel">稍后</button><button class="btn primary" id="cp-ok" style="flex:1">确认修改</button></div>
  </div>`;
  document.body.appendChild(mask);
  mask.querySelector('#cp-cancel').onclick = ()=> mask.remove();
  mask.querySelector('#cp-ok').onclick = async ()=>{
    const oldPassword = mask.querySelector('#cp-old').value;
    const newPassword = mask.querySelector('#cp-new').value;
    const err = mask.querySelector('#cp-err');
    const r = await fetch('/api/auth/password', { method:'POST', headers:{'content-type':'application/json'}, credentials:'include', body: JSON.stringify({ oldPassword, newPassword }) });
    const d = await r.json().catch(()=>({}));
    if (!r.ok){ err.textContent = (d.error && d.error.message) || '修改失败'; err.style.display='block'; return; }
    mask.remove();
    toast('密码已修改', 'ok');
    if (ME) ME.mustChangePassword = false;
  };
}

/* ================= 加载数据 ================= */
async function loadConfig(){
  if (role !== 'admin') return;
  const r = await api('GET', '/admin/api/config');
  if (r.status === 200){
    cfg = r.data.config;
    initAccessRows();
    dirty = false;
    const d = document.getElementById('dirty-dot'); if (d) d.classList.remove('show');
    render();
  }
}
async function loadStats(){
  try {
    const headers = {};
    if (token) headers['authorization'] = 'Bearer ' + token;
    const resp = await fetch('/stats', { headers, credentials:'include' });
    if (!resp.ok) return;
    stats = await resp.json();
    if (currentPage === '#/console/dashboard') renderDashboard();
    if (currentPage === '#/console/profile') renderProfile();
  } catch(_) {}
}
function render(){
  if (currentPage === '#/console/dashboard') renderDashboard();
  else if (currentPage === '#/console/keys') renderKeys();
  else if (currentPage === '#/console/models') renderModels();
  else if (currentPage === '#/console/tokens') renderTokens();
  else if (currentPage === '#/console/settings') renderSettings();
  else if (currentPage === '#/console/playground') renderPlayground();
}

/* ================= 统计卡 / 徽章 ================= */
function statCard(ic,bg,color,label,val){ return `<div class="stat"><div class="stat-ic" style="background:${bg};color:${color}"><svg class="ic"><use href="#i-${ic}"/></svg></div><div><div class="k">${label}</div><div class="v">${val}</div></div></div>`; }
function stateBadge(k){
  const s = k.state;
  if (s==='ready') return '<span class="badge badge-ok"><span class="dot"></span>可用</span>';
  if (s==='busy') return '<span class="badge badge-blue"><span class="dot"></span>忙碌</span>';
  if (s==='cooling') return `<span class="badge badge-warn"><span class="dot"></span>冷却 ${Math.ceil(k.cooldownRemainMs/1000)}s</span>`;
  if (s==='verify') return '<span class="badge badge-purple"><span class="dot"></span>待探活</span>';
  return '<span class="badge badge-err"><span class="dot"></span>已下线</span>';
}

/* ================= 页面:运行状态 ================= */
function pageDashboard(){
  document.title = '运行状态 · API 代理池';
  renderShell('运行状态', '<div class="empty">加载中…</div>');
  renderDashboard();
}
function renderDashboard(){
  const s = stats || { summary:{}, keys:[], users:[], alerts:[], uptimeSec:0 };
  const sum = s.summary || {};
  const total = sum.total||0, ready = sum.ready||0, dead = sum.dead||0, cooling = sum.cooling||0;
  const alerts = s.alerts || [];
  let stText, stColor, stBg, stIcon;
  if (total===0){ stText='还没有配置任何上游密钥'; stColor='#64748b'; stBg='#f1f5f9'; stIcon='tool'; }
  else if (ready===0){ stText='密钥全部不可用，需要尽快处理'; stColor='#ef4444'; stBg='#fef2f2'; stIcon='warn'; }
  else if (dead>0){ stText='基本正常，但有个别密钥已下线'; stColor='#f59e0b'; stBg='#fffbeb'; stIcon='warn'; }
  else { stText='运行正常，可以放心使用'; stColor='#10b981'; stBg='#ecfdf5'; stIcon='check'; }
  const sub = total>0 ? `共 ${total} 个密钥 · ${ready} 可用 · ${dead} 下线${cooling?' · '+cooling+' 冷却中':''}` : '去「密钥管理」添加上游密钥';
  const keyRows = (s.keys||[]).map(k=>{
    const rpm = k.group ? `${k.groupRpmUsed}/${k.groupRpmLimit||'∞'} (组)` : `${k.rpmUsed}/${k.rpmLimit||'∞'}`;
    return `<tr>
      <td><code>${esc(k.id)}</code></td><td><code>${esc(k.key)}</code></td><td><code>${esc(k.provider)}</code></td>
      <td>${k.group?`<code>${esc(k.group)}</code>`:'-'}</td><td>${stateBadge(k)}</td><td>${k.inflight}</td><td>${rpm}</td>
      <td>${k.stats.ok}</td><td>${k.stats.fail}</td><td>${k.stats.limited}</td><td>${k.stats.lastLatencyMs||'-'}</td>
      <td class="err" title="${esc(k.deadReason||k.stats.lastError||'')}">${esc((k.deadReason||k.stats.lastError||'').toString().slice(0,40))}</td>
    </tr>`;
  }).join('');
  const userRows = (s.users||[]).map(u=>`<tr><td><code>${esc(u.key)}</code></td><td>${esc(u.name)}</td>
    <td>${u.rpm||'∞'}/min</td><td>${u.daily?`${u.todayCalls}/${u.daily}`:u.todayCalls}${u.daily?'':'（不限）'}</td>
    <td>${u.totalCalls}</td><td>${u.lastCallAt?fmtTime(u.lastCallAt):'—'}</td></tr>`).join('');
  const main = document.getElementById('main');
  if (!main) return;
  main.innerHTML = `
    <div class="home-hero">
      <div class="home-hero-icon" style="background:${stBg};color:${stColor}"><svg class="ic"><use href="#i-${stIcon}"/></svg></div>
      <div><div class="home-hero-title">${esc(stText)}</div><div class="home-hero-sub">${esc(sub)} · 已运行 ${fmtUptime(s.uptimeSec)}</div></div>
      <div class="home-hero-stats hide-sm">
        <div class="home-hero-stat"><div class="k">可用</div><div class="v" style="color:#10b981">${ready}</div></div>
        <div class="home-hero-stat"><div class="k">冷却</div><div class="v" style="color:#f59e0b">${cooling}</div></div>
        <div class="home-hero-stat"><div class="k">下线</div><div class="v" style="color:#ef4444">${dead}</div></div>
      </div>
    </div>
    <div class="cards">
      ${statCard('key','#eff6ff','#3b82f6','Key 总数',total)}
      ${statCard('check','#ecfdf5','#10b981','累计成功',sum.ok||0)}
      ${statCard('x','#fef2f2','#ef4444','累计失败',sum.fail||0)}
      ${statCard('warn','#fffbeb','#f59e0b','429 限流',sum.limited||0)}
      ${statCard('clock','#eff6ff','#3b82f6','运行时长',fmtUptime(s.uptimeSec))}
    </div>
    ${(s.breakers||[]).length?`<div class="card"><h3>熔断中的模型 <span class="tag">连续失败自动熔断，到期恢复</span></h3>
      <div class="tbl-wrap"><table><thead><tr><th>模型</th><th>剩余</th></tr></thead><tbody>
      ${(s.breakers||[]).map(b=>`<tr><td><code>${esc(b.model)}</code></td><td style="color:var(--orange)">${Math.ceil(b.openRemainMs/1000)}s 后重试</td></tr>`).join('')}
      </tbody></table></div></div>`:''}
    ${alerts.length?`<div class="card"><h3>最近告警 <span class="tag">${alerts.length} 条</span></h3>
      <div class="tbl-wrap"><table><thead><tr><th>时间</th><th>标题</th><th>详情</th><th>发送</th></tr></thead><tbody>
      ${alerts.map(a=>`<tr><td class="mono" style="white-space:nowrap;font-size:12px">${fmtTime(a.at)}</td><td style="white-space:nowrap">${esc(a.title)}</td>
        <td class="faint">${esc(a.detail)}</td><td>${a.sent?'<span style="color:var(--green)">已发</span>':`<span style="color:var(--orange)" title="${esc(a.error||'')}">${a.error?'失败':'待发'}</span>`}</td></tr>`).join('')}
      </tbody></table></div></div>`:''}
    <div class="card"><h3>上游 Key 状态 <span class="tag">每 5 秒自动刷新</span></h3>
      <div class="tbl-wrap"><table><thead><tr><th>Key</th><th>值</th><th>平台</th><th>账号组</th><th>状态</th><th>并发</th><th>RPM(60s)</th><th>成功</th><th>失败</th><th>429</th><th>耗时(ms)</th><th>最近错误</th></tr></thead>
      <tbody>${keyRows||'<tr><td colspan="12" class="faint">尚未配置 Key</td></tr>'}</tbody></table></div></div>
    ${(s.users||[]).length?`<div class="card"><h3>接入用户（${s.users.length}）</h3>
      <div class="tbl-wrap"><table><thead><tr><th>分发的 Key</th><th>用户</th><th>RPM</th><th>今日用量</th><th>累计调用</th><th>最近调用</th></tr></thead><tbody>${userRows}</tbody></table></div></div>`:''}`;
}

/* ================= 页面:密钥管理(平台) ================= */
function pageKeys(){
  document.title = '密钥管理 · API 代理池';
  renderShell('密钥管理', '<div class="empty">加载中…</div>');
  if (cfg) renderKeys();
}
function renderKeys(){
  const main = document.getElementById('main'); if (!main || !cfg) return;
  const list = (cfg.providers||[]).map((p,i)=>{
    const keysText = (p.keys||[]).filter(k=>!String(k).startsWith('#')).join('\n');
    return `<div class="card">
      <div class="pv-head">
        <input class="f" data-set="providers.${i}.name" value="${esc(p.name)}" placeholder="平台名（如 sensenseva）">
        <button class="btn danger sm" data-action="delProvider" data-idx="${i}">删除平台</button>
      </div>
      <div class="field"><label>baseUrl（OpenAI 兼容地址）</label>
        <input class="f mono" data-set="providers.${i}.baseUrl" value="${esc(p.baseUrl)}" placeholder="https://token.sensenova.cn/v1"></div>
      <div class="grid2">
        <div class="field"><label>chatPath（一般留空）</label>
          <input class="f mono" data-set="providers.${i}.chatPath" value="${esc(p.chatPath||'')}" placeholder="/chat/completions"></div>
        <div class="field"><label>extraHeaders（JSON，可选）</label>
          <input class="f mono" data-set="providers.${i}.extraHeadersJson" value="${esc(p.extraHeaders?JSON.stringify(p.extraHeaders):'')}" placeholder='{"HTTP-Referer":"xxx"}'></div>
      </div>
      <div class="grid3">
        <div class="field"><label>RPM / Key（0=不限）</label><input class="f" type="number" data-set="providers.${i}.rpmPerKey" value="${p.rpmPerKey==null?0:p.rpmPerKey}"></div>
        <div class="field"><label>RPM / 账号（0=不限）</label><input class="f" type="number" data-set="providers.${i}.rpmPerAccount" value="${p.rpmPerAccount==null?0:p.rpmPerAccount}"></div>
        <div class="field"><label>并发 / Key（0=不限）</label><input class="f" type="number" data-set="providers.${i}.maxConcurrencyPerKey" value="${p.maxConcurrencyPerKey==null?0:p.maxConcurrencyPerKey}"></div>
      </div>
      <div class="field keys-label"><label>Key（一行一个，支持 <code>key@账号分组</code> / <code>env:变量名</code>）</label>
        <textarea class="f mono" data-keys="providers.${i}" rows="5" placeholder="sk-xxxxxx&#10;sk-yyyyyy@账号1">${esc(keysText)}</textarea></div>
    </div>`;
  }).join('');
  main.innerHTML = `<div class="toolbar">
      <button class="btn" data-action="addProvider">+ 添加平台</button>
      <span class="hint">改完点右上角「保存配置」热重载生效；带 @ 的 Key 属同一账号,请在平台里设「RPM / 账号」</span>
    </div>${list || '<div class="empty">还没有平台，点「+ 添加平台」开始</div>'}`;
}

/* ================= 页面:模型别名 ================= */
function pageModels(){
  document.title = '模型 · API 代理池';
  renderShell('模型别名', '<div class="empty">加载中…</div>');
  if (cfg){
    renderModels();
    loadAllProviderModels(false);   // 进页面预取各平台模型列表
  }
}
/** 批量拉取需要的平台模型列表（有缓存则跳过），完成后统一重渲染 */
async function loadAllProviderModels(force){
  if (!cfg) return;
  const names = [...new Set((cfg.providers||[]).map(p=>p.name).filter(Boolean))];
  const todo = names.filter(n => {
    if (force) return true;
    const st = providerModels[n];
    if (!st) return true;
    if (st.loading) return false;
    if (st.ok) return false;                                   // 已有成功结果,1 小时内不重拉
    return Date.now() - (st.at||0) > 60000;                    // 失败后 1 分钟内不重试
  });
  if (!todo.length) return;
  todo.forEach(n => { providerModels[n] = { loading:true, models:[] }; });
  renderModels();
  await Promise.all(todo.map(async n => {
    try {
      const r = await api('GET', '/admin/api/provider-models?provider=' + encodeURIComponent(n) + (force?'&refresh=1':''));
      const d = r.data || {};
      providerModels[n] = { loading:false, ok:!!d.ok, models:d.models||[], error:d.error||'', at:Date.now() };
    } catch(e){
      providerModels[n] = { loading:false, ok:false, models:[], error:e.message, at:Date.now() };
    }
  }));
  if (currentPage === '#/console/models') renderModels();
}
/** 单个平台拉取模型列表(切换平台时用) */
async function ensureProviderModels(name, force){
  if (!name) return;
  const st = providerModels[name];
  if (!force){
    if (st && (st.loading || st.ok)) return;
    if (st && !st.ok && Date.now() - (st.at||0) < 60000) return;
  }
  providerModels[name] = { loading:true, models:[] };
  if (currentPage === '#/console/models') renderModels();
  try {
    const r = await api('GET', '/admin/api/provider-models?provider=' + encodeURIComponent(name) + (force?'&refresh=1':''));
    const d = r.data || {};
    providerModels[name] = { loading:false, ok:!!d.ok, models:d.models||[], error:d.error||'', at:Date.now() };
  } catch(e){
    providerModels[name] = { loading:false, ok:false, models:[], error:e.message, at:Date.now() };
  }
  if (currentPage === '#/console/models') renderModels();
}
/** 生成某个平台模型选择控件：
 *  列表可用 → datalist（可下拉选、也能打字过滤——OpenRouter 有 400+ 模型，纯 select 太长）
 *  列表不可用 → 手填并说明原因 */
function modelFieldHtml(alias, i, providerName, current){
  const st = providerModels[providerName];
  const path = `models.${alias}.${i}.model`;
  if (!providerName) return `<input class="f mono" style="flex:1" data-set="${path}" value="${esc(current)}" placeholder="先选平台">`;
  if (st && st.loading) return `<input class="f mono" style="flex:1" disabled value="加载模型列表…">`;
  if (st && st.ok && st.models.length){
    return `<input class="f mono" style="flex:1" list="dl-${esc(providerName)}" data-set="${path}" value="${esc(current)}"
      placeholder="点选或输入关键字过滤（该平台 ${st.models.length} 个模型）">`;
  }
  const why = st && st.error ? `（列表不可用：${esc(st.error)}）` : '（未获取到列表）';
  return `<input class="f mono" style="flex:1" data-set="${path}" value="${esc(current)}" placeholder="手动填模型 ID ${why}">`;
}
function renderModels(){
  const main = document.getElementById('main'); if (!main || !cfg) return;
  const entries = Object.keys(cfg.models||{}).filter(a=>!a.startsWith('_'));
  const providers = (cfg.providers||[]).map(p=>p.name);
  const list = entries.map(alias=>{
    const arr = Array.isArray(cfg.models[alias]) ? cfg.models[alias] : [cfg.models[alias]];
    const rows = arr.map((t,i)=>{
      const pn = typeof t === 'string' ? (t.split('/')[0]||'') : (t && t.provider) || '';
      const mn = typeof t === 'string' ? (t.split('/').slice(1).join('/')) : (t && t.model) || '';
      const opts = providers.map(p=>`<option value="${esc(p)}" ${p===pn?'selected':''}>${esc(p)}</option>`).join('')
        + (pn && !providers.includes(pn) ? `<option value="${esc(pn)}" selected>${esc(pn)}</option>` : '');
      return `<div class="sub-row">
        <select class="f" style="flex:0 0 150px" data-set="models.${alias}.${i}.provider" data-refresh-models="1">${opts}</select>
        ${modelFieldHtml(alias, i, pn, mn)}
        <input class="f" type="number" step="0.1" min="0" style="flex:0 0 88px" data-set="models.${alias}.${i}.cost"
          value="${t && t.cost != null ? t.cost : ''}" placeholder="成本" title="省钱策略用：数字越小越优先使用（留空=1）">
        <label style="flex:0 0 auto;display:flex;align-items:center;gap:4px;font-size:12px" title="兜底候选:主力全部限流/冷却时才会启用"><input type="checkbox" data-set="models.${alias}.${i}.fallback" ${t&&t.fallback?'checked':''}>兜底</label>
        <button class="btn danger sm" data-action="delModelCandidate" data-alias="${esc(alias)}" data-idx="${i}">删</button>
      </div>`;
    }).join('');
    return `<div class="card">
      <div class="pv-head">
        <input class="f" data-alias-name="${esc(alias)}" value="${esc(alias)}" placeholder="别名，如 auto" style="flex:0 0 180px">
        <span class="hint" style="flex:1">普通候选轮询分摊流量；勾「兜底」的只在主力全部不可用时启用</span>
        <button class="btn sm" data-action="addModelCandidate" data-alias="${esc(alias)}">+ 候选</button>
        <button class="btn danger sm" data-action="delModel" data-alias="${esc(alias)}">删除别名</button>
      </div>${rows || '<div class="empty" style="padding:12px 0">暂无候选</div>'}</div>`;
  }).join('');
  const anyLoading = Object.values(providerModels).some(v=>v && v.loading);
  // 每个平台一份 datalist(共用,避免几百个 option 重复渲染)
  const datalists = [...new Set(providers)].map(n=>{
    const st = providerModels[n];
    if (!st || !st.ok || !st.models.length) return '';
    return `<datalist id="dl-${esc(n)}">${st.models.map(m=>`<option value="${esc(m)}"></option>`).join('')}</datalist>`;
  }).join('');
  main.innerHTML = `<div class="toolbar">
      <button class="btn" data-action="addModel">+ 添加别名</button>
      <button class="btn" data-action="refreshModels" ${anyLoading?'disabled':''}>${anyLoading?'拉取中…':'刷新平台模型列表'}</button>
      <span class="hint">模型名从平台自动获取（每平台一份下拉列表，可输入过滤）；拉不到时才需手填</span>
    </div>${list || '<div class="empty">还没有模型别名，点「+ 添加别名」开始</div>'}${datalists}`;
}

/* ================= 页面:分发密钥 ================= */
function pageTokens(){
  document.title = '分发密钥 · API 代理池';
  if (role === 'collab'){ renderShell('分发密钥', '<div class="empty">加载中…</div>'); renderCollabTokens(); return; }
  renderShell('分发密钥', '<div class="empty">加载中…</div>');
  if (cfg) renderTokens();
}
function initAccessRows(){
  const ak = cfg.accessKeys||{};
  accessRows = Object.keys(ak).filter(k=>!k.startsWith('_')&&!k.startsWith('#')).map(key=>{
    const spec = ak[key];
    const o = typeof spec === 'string' ? {name:spec,rpm:0,daily:0} : Object.assign({name:'',rpm:0,daily:0}, spec||{});
    return { key, name:o.name, rpm:o.rpm||0, daily:o.daily||0, enabled: o.enabled !== false };
  });
}
function renderTokens(){
  const main = document.getElementById('main'); if (!main || !cfg) return;
  const rows = accessRows.map((r,i)=>`<tr>
    <td><input class="f mono" data-access="${i}.key" value="${esc(r.key)}" placeholder="sk-pool-..."></td>
    <td><input class="f" data-access="${i}.name" value="${esc(r.name)}" placeholder="用户/备注"></td>
    <td><input class="f" type="number" data-access="${i}.rpm" value="${r.rpm}" title="每分钟上限,0=不限"></td>
    <td><input class="f" type="number" data-access="${i}.daily" value="${r.daily}" title="每天上限,0=不限"></td>
    <td style="text-align:center"><input type="checkbox" data-access="${i}.enabled" ${r.enabled?'checked':''} title="取消勾选=禁用"></td>
    <td><button class="btn danger sm" data-action="delAccess" data-idx="${i}">删除</button></td>
  </tr>`).join('');
  main.innerHTML = `<div class="toolbar">
      <button class="btn" data-action="addAccess">+ 添加</button>
      <button class="btn" data-action="genAccess">生成随机 Key</button>
      <button class="btn" data-action="genAccessBatch">批量生成 5 个</button>
      <span class="hint">把 Key 发给使用者；名称建议与注册用户名一致,对方就能在个人中心看到自己的用量</span>
    </div>
    <div class="card"><h3>分发 Key（accessKeys）</h3>
    <div class="tbl-wrap"><table><thead><tr><th>分发的 Key</th><th>名称/备注</th><th>RPM 上限</th><th>每日上限</th><th>启用</th><th></th></tr></thead>
    <tbody>${rows||'<tr><td colspan="6" class="faint">未配置分发 Key（当前无鉴权）</td></tr>'}</tbody></table></div>
    <div class="hint" style="margin-top:10px">0 = 不限；取消「启用」勾选后该 Key 立即失效（需点保存生效）。</div></div>`;
}
function genKey(){
  return 'sk-pool-' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'') : Math.random().toString(36).slice(2)+Date.now().toString(36)).slice(0,32);
}
function syncAccessToCfg(){
  const ak = {};
  for (const r of accessRows){
    if (!r.key) continue;
    const parts = {};
    if (r.name) parts.name = r.name;
    if (r.rpm > 0) parts.rpm = r.rpm;
    if (r.daily > 0) parts.daily = r.daily;
    if (r.enabled === false) parts.enabled = false;
    const ks = Object.keys(parts);
    if (ks.length === 0) ak[r.key] = '未命名';
    else if (ks.length === 1 && parts.name) ak[r.key] = parts.name;
    else ak[r.key] = parts;
  }
  cfg.accessKeys = ak;
}

/* ================= 协同管理员:分发密钥 ================= */
async function renderCollabTokens(){
  const main = document.getElementById('main'); if (!main) return;
  main.innerHTML = `
  <div class="tip">你是协同管理员：可以创建分发 Key、往池子里放上游 Key。配置类改动请联系管理员。</div>
  <div class="card"><h3>生成用户 Key</h3>
    <div class="grid4">
      <div class="field"><label>用户名</label><input class="f" id="ca-name" value="用户" placeholder="显示在用量统计里"></div>
      <div class="field"><label>每分钟上限</label><input class="f" type="number" id="ca-rpm" value="10"></div>
      <div class="field"><label>每天上限</label><input class="f" type="number" id="ca-daily" value="300"></div>
      <div class="field"><label>生成数量</label><input class="f" type="number" id="ca-count" value="1" min="1" max="20"></div>
    </div>
    <button class="btn primary" id="ca-submit">生成</button>
    <div id="ca-result" style="margin-top:14px"></div>
  </div>
  <div class="card"><h3>我创建的分发 Key</h3><div id="cl-body"><div class="faint">加载中…</div></div></div>`;
  document.getElementById('ca-submit').addEventListener('click', async ()=>{
    const body = {
      name: document.getElementById('ca-name').value.trim() || '用户',
      rpm: parseInt(document.getElementById('ca-rpm').value,10) || 10,
      daily: parseInt(document.getElementById('ca-daily').value,10) || 300,
      count: parseInt(document.getElementById('ca-count').value,10) || 1,
    };
    try {
      const r = await api('POST', '/admin/api/collab/accessKeys', body);
      if (!r.ok) throw new Error((r.data && r.data.error && r.data.error.message) || ('HTTP ' + r.status));
      document.getElementById('ca-result').innerHTML = r.data.created.map(c=>
        `<div class="card" style="margin:8px 0;padding:14px"><div class="mono" style="user-select:all;word-break:break-all">${esc(c.key)}</div>
         <div class="hint">${esc(c.name)} · ${c.rpm} RPM / 日 ${c.daily} 次</div></div>`).join('');
      toast('已生成 ' + r.data.created.length + ' 个 Key', 'ok');
      loadCollabList();
    } catch(e){ toast('失败：' + e.message, 'err'); }
  });
  loadCollabList();
}
async function loadCollabList(){
  const body = document.getElementById('cl-body'); if (!body) return;
  try {
    const r = await api('GET', '/admin/api/collab/listAccessKeys');
    if (!r.ok) throw new Error((r.data && r.data.error && r.data.error.message) || ('HTTP '+r.status));
    const keys = r.data.keys || [];
    if (!keys.length){ body.innerHTML = '<div class="faint">还没有创建过。</div>'; return; }
    body.innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Key</th><th>用户名</th><th>限额</th><th>今日</th><th>累计</th></tr></thead><tbody>'
      + keys.map(k=>`<tr><td class="mono" style="user-select:all;word-break:break-all;font-size:12px">${esc(k.key)}</td>
        <td>${esc(k.name)}</td><td>${k.rpm||'∞'} RPM / 日 ${k.daily||'∞'}</td><td><b>${k.today||0}</b></td><td>${k.total||0}</td></tr>`).join('')
      + '</tbody></table></div>';
  } catch(e){ body.innerHTML = '<div class="faint">加载失败：' + esc(e.message) + '</div>'; }
}

/* ================= 页面:使用记录 ================= */
function pageLogs(){
  document.title = '使用记录 · API 代理池';
  renderShell('使用记录', '<div class="empty">加载中…</div>');
  renderLogs();
}
function collectCallerNames(){
  const set = new Set();
  const ak = (cfg && cfg.accessKeys) || {};
  for (const k of Object.keys(ak)){
    if (k.startsWith('_')||k.startsWith('#')) continue;
    const spec = ak[k];
    const name = typeof spec === 'string' ? spec : (spec && spec.name) || '';
    if (name) set.add(name);
  }
  return [...set].sort();
}
function renderLogs(){
  const main = document.getElementById('main'); if (!main) return;
  const callers = collectCallerNames();
  main.innerHTML = `
  <div class="card"><h3>调用日志 <span class="tag">倒序展示最近 ${logsFilter.limit} 条</span></h3>
    <div class="toolbar">
      <label style="margin:0;font-size:12px">分发用户
        <select class="f" id="log-caller" style="width:auto;margin:0"><option value="">全部</option>
        ${callers.map(c=>`<option value="${esc(c)}" ${logsFilter.caller===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
      <label style="margin:0;font-size:12px">状态
        <select class="f" id="log-status" style="width:auto;margin:0"><option value="">全部</option>
        <option value="200" ${logsFilter.status==='200'?'selected':''}>成功 200</option>
        <option value="401" ${logsFilter.status==='401'?'selected':''}>鉴权失败 401</option>
        <option value="429" ${logsFilter.status==='429'?'selected':''}>限流 429</option>
        <option value="503" ${logsFilter.status==='503'?'selected':''}>不可用 503</option></select></label>
      <label style="margin:0;font-size:12px">天数
        <select class="f" id="log-days" style="width:auto;margin:0">
          <option value="1" ${logsFilter.days===1?'selected':''}>今天</option>
          <option value="2" ${logsFilter.days===2?'selected':''}>近 2 天</option>
          <option value="7" ${logsFilter.days===7?'selected':''}>近 7 天</option></select></label>
      <button class="btn sm" id="log-refresh">刷新</button><span class="hint" id="log-count"></span>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>时间</th><th>调用方</th><th>模型</th><th>平台 / Key</th><th>状态</th><th>耗时</th><th>tokens</th><th>类型</th></tr></thead>
    <tbody id="logs-tbody"><tr><td colspan="8" class="faint">加载中…</td></tr></tbody></table></div></div>`;
  document.getElementById('log-caller').addEventListener('change', e=>{ logsFilter.caller=e.target.value; loadLogs(); });
  document.getElementById('log-status').addEventListener('change', e=>{ logsFilter.status=e.target.value; loadLogs(); });
  document.getElementById('log-days').addEventListener('change', e=>{ logsFilter.days=Number(e.target.value); loadLogs(); });
  document.getElementById('log-refresh').addEventListener('click', loadLogs);
  loadLogs();
}
function errorTypeLabel(t){
  if (!t) return '<span class="faint">—</span>';
  const map = { auth_fail:'鉴权失败', quota_exceeded:'配额超限', circuit_open:'熔断', no_available_key:'Key不可用', queue_timeout:'排队超时', client_abort:'客户端中断', no_target:'无目标', fatal:'上游错误' };
  return `<span class="faint">${esc(map[t]||t)}</span>`;
}
async function loadLogs(){
  const q = new URLSearchParams();
  q.set('days', logsFilter.days); q.set('limit', logsFilter.limit);
  if (logsFilter.caller) q.set('caller', logsFilter.caller);
  if (logsFilter.status) q.set('status', logsFilter.status);
  const r = await api('GET', '/admin/api/logs?' + q.toString());
  const tb = document.getElementById('logs-tbody'); if (!tb) return;
  if (r.status !== 200){ tb.innerHTML = `<tr><td colspan="8" class="faint">加载失败（${r.status}）</td></tr>`; return; }
  const entries = r.data.entries || [];
  tb.innerHTML = entries.map(e=>{
    const st = e.status;
    const stHtml = st==null ? '<span class="badge badge-muted"><span class="dot"></span>中断</span>'
      : `<span class="badge ${st<400?'badge-ok':(st<500?'badge-warn':'badge-err')}"><span class="dot"></span>${st}</span>`;
    return `<tr><td class="mono" style="white-space:nowrap;font-size:12px">${fmtTime(e.ts)}</td>
      <td>${esc(e.callerName || (e.caller!=null?'#'+e.caller:'—'))}</td>
      <td><code>${esc(e.model||'—')}</code></td>
      <td class="mono" style="font-size:12px">${esc(e.provider?e.provider+(e.keyId?(' / '+e.keyId):''):'—')}</td>
      <td>${stHtml}</td><td>${e.latencyMs!=null?e.latencyMs+'ms':'—'}</td>
      <td>${e.tokens?(e.tokens.total==null?'-':e.tokens.total):'—'}</td><td>${errorTypeLabel(e.errorType)}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="faint">暂无调用日志</td></tr>';
  const cnt = document.getElementById('log-count');
  if (cnt) cnt.textContent = `共 ${r.data.total} 条`;
}

/* ================= 页面:用量统计 ================= */
function pageUsage(){
  document.title = '用量统计 · API 代理池';
  renderShell('用量统计', '<div class="empty">加载中…</div>');
  renderUsage();
}
function renderUsage(){
  const main = document.getElementById('main'); if (!main) return;
  const callers = collectCallerNames();
  main.innerHTML = `
  <div class="toolbar">
    <label style="margin:0;font-size:12px">分发用户
      <select class="f" id="usage-caller" style="width:auto;margin:0"><option value="">全部</option>
      ${callers.map(c=>`<option value="${esc(c)}" ${usageFilter.caller===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
    <label style="margin:0;font-size:12px">天数
      <select class="f" id="usage-days" style="width:auto;margin:0">
        <option value="7" ${usageFilter.days===7?'selected':''}>近 7 天</option>
        <option value="30" ${usageFilter.days===30?'selected':''}>近 30 天</option></select></label>
    <label style="margin:0;font-size:12px">粒度
      <select class="f" id="usage-view" style="width:auto;margin:0">
        <option value="daily" ${usageView==='daily'?'selected':''}>天级</option>
        <option value="hourly" ${usageView==='hourly'?'selected':''}>今天小时级</option></select></label>
    <span class="hint">token 仅统计非流式请求</span>
  </div>
  <div id="usage-body"><div class="empty">加载中…</div></div>`;
  document.getElementById('usage-caller').addEventListener('change', e=>{ usageFilter.caller=e.target.value; loadUsage(); });
  document.getElementById('usage-days').addEventListener('change', e=>{ usageFilter.days=Number(e.target.value); loadUsage(); });
  document.getElementById('usage-view').addEventListener('change', e=>{ usageView=e.target.value; loadUsage(); });
  loadUsage();
}
function chartSVG(items){
  if (!items || !items.length) return '<div class="empty">暂无数据</div>';
  const W=680,H=220,padL=46,padB=30,padT=20,padR=16;
  const cw=W-padL-padR, ch=H-padT-padB;
  const maxCalls = Math.max(1, ...items.map(d=>(d.ok||0)+(d.fail||0)));
  const n=items.length, step=cw/n, barW=Math.max(3,Math.min(36,step*0.62));
  const y = v => padT + ch - (v/maxCalls)*ch;
  let grid='';
  for (let g=0; g<=4; g++){
    const v=maxCalls*g/4, yy=y(v);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W-padR}" y2="${yy.toFixed(1)}" stroke="#eef0f2"/>`
      + `<text x="${padL-6}" y="${(yy+4).toFixed(1)}" text-anchor="end" font-size="10" fill="#6b7280">${Math.round(v)}</text>`;
  }
  let bars='', labels='';
  items.forEach((d,i)=>{
    const cx=padL+step*i+step/2, x=cx-barW/2;
    const okH=(d.ok||0)/maxCalls*ch, failH=(d.fail||0)/maxCalls*ch;
    const okY=padT+ch-okH-failH, failY=padT+ch-failH;
    bars += `<rect x="${x.toFixed(1)}" y="${failY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0,failH).toFixed(1)}" fill="#ef4444"/>`;
    bars += `<rect x="${x.toFixed(1)}" y="${okY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0,okH).toFixed(1)}" fill="#10b981"/>`;
    if ((d.total||0)>0) bars += `<text x="${cx.toFixed(1)}" y="${(Math.min(okY,failY)-4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#6b7280">${d.total}</text>`;
    labels += `<text x="${cx.toFixed(1)}" y="${H-10}" text-anchor="middle" font-size="10" fill="#6b7280">${esc(d.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-width:100%;display:block">${grid}${bars}${labels}</svg>`;
}
async function loadUsage(){
  const q = new URLSearchParams();
  q.set('days', usageFilter.days);
  if (usageFilter.caller) q.set('caller', usageFilter.caller);
  const r = await api('GET', '/admin/api/usage?' + q.toString());
  const body = document.getElementById('usage-body'); if (!body) return;
  if (r.status !== 200){ body.innerHTML = `<div class="empty">加载失败（${r.status}）</div>`; return; }
  const data = r.data;
  const totalTokens = (data.byCaller||[]).reduce((s,c)=>s+(c.total||0),0);
  const items = usageView==='hourly'
    ? (data.hours||[]).map(h=>({ label:h.hour+'时', ok:h.ok, fail:h.fail, total:h.total }))
    : (data.daily||[]).map(d=>({ label:(d.date||'').slice(5), ok:d.ok, fail:d.fail, total:d.total }));
  const callerRows = (data.byCaller||[]).map(c=>`<tr><td>${esc(c.name)}</td><td>${c.calls}</td><td style="color:#10b981">${c.ok}</td><td style="color:#ef4444">${c.fail}</td><td>${c.total||0}</td></tr>`).join('');
  const modelRows = (data.byModel||[]).map(m=>`<tr><td><code>${esc(m.model)}</code></td><td>${m.calls}</td><td style="color:#10b981">${m.ok}</td><td style="color:#ef4444">${m.fail}</td><td>${m.total||0}</td></tr>`).join('');
  body.innerHTML = `
    <div class="cards">
      ${statCard('chart','#eff6ff','#3b82f6',`总调用（近 ${data.days} 天）`,data.totalCalls||0)}
      ${statCard('zap','#f5f3ff','#8b5cf6','总 tokens',totalTokens||0)}
      ${statCard('check','#ecfdf5','#10b981','成功',(data.byCaller||[]).reduce((s,c)=>s+c.ok,0))}
      ${statCard('x','#fef2f2','#ef4444','失败',(data.byCaller||[]).reduce((s,c)=>s+c.fail,0))}
    </div>
    <div class="card"><h3>${usageView==='hourly'?'今天小时级调用':'每日调用'} <span class="tag">绿=成功 · 红=失败 · 柱顶数字=tokens</span></h3>${chartSVG(items)}</div>
    ${(data.byCaller||[]).length?`<div class="card"><h3>按分发用户</h3><div class="tbl-wrap"><table><thead><tr><th>用户</th><th>调用</th><th>成功</th><th>失败</th><th>tokens</th></tr></thead><tbody>${callerRows}</tbody></table></div></div>`:''}
    ${(data.byModel||[]).length?`<div class="card"><h3>按模型</h3><div class="tbl-wrap"><table><thead><tr><th>模型</th><th>调用</th><th>成功</th><th>失败</th><th>tokens</th></tr></thead><tbody>${modelRows}</tbody></table></div></div>`:''}`;
}

/* ================= 页面:设置 ================= */
function pageSettings(){
  document.title = '设置 · API 代理池';
  renderShell('设置', '<div class="empty">加载中…</div>');
  if (cfg) renderSettings();
}
function renderSettings(){
  const main = document.getElementById('main'); if (!main || !cfg) return;
  const al = (cfg.alert||{}).email || {};
  const authCodeSet = al.authCode === '__SET__';
  const msHuman = ms => {
    if (ms==null||ms==='') return '';
    if (ms>=86400000) return '当前: '+(ms/86400000).toFixed(1).replace(/\.0$/,'')+' 天';
    if (ms>=3600000) return '当前: '+(ms/3600000).toFixed(1).replace(/\.0$/,'')+' 小时';
    if (ms>=60000) return '当前: '+(ms/60000).toFixed(1).replace(/\.0$/,'')+' 分钟';
    if (ms>=1000) return '当前: '+(ms/1000).toFixed(1).replace(/\.0$/,'')+' 秒';
    return '当前: '+ms+' 毫秒';
  };
  const num = (k,label,ph,note)=>`<div class="field"><label>${label}</label>
    <input class="f" type="number" data-set="${k}" value="${getByPath(cfg,k)??''}" placeholder="${ph}"><div class="hint">${note}</div></div>`;
  const msNum = (k,label,ph,note)=>`<div class="field"><label>${label}</label>
    <input class="f" type="number" data-set="${k}" value="${getByPath(cfg,k)??''}" placeholder="${ph}"><div class="hint">${note} · ${msHuman(getByPath(cfg,k))}</div></div>`;
  main.innerHTML = `
  <div class="card"><h3>调度与容错</h3>
    <div class="grid3">
      <div class="field"><label>调度策略 strategy</label>
        <select class="f" data-set="strategy">
          <option value="round-robin" ${cfg.strategy==='round-robin'?'selected':''}>round-robin（轮流均分）</option>
          <option value="least-used" ${cfg.strategy==='least-used'?'selected':''}>least-used（最闲优先）</option>
          <option value="latency-first" ${cfg.strategy==='latency-first'?'selected':''}>latency-first（快优先）</option>
          <option value="cost-first" ${cfg.strategy==='cost-first'?'selected':''}>cost-first（省钱优先）</option>
        </select>
        <div class="hint">快优先=按实测延迟排（谁快用谁）；省钱优先=按候选标注的 cost 排（越小越先用，未标注按 1）</div></div>
      <div class="field"><label>日志级别 logLevel</label>
        <select class="f" data-set="logLevel">
          ${['debug','info','warn','error','silent'].map(x=>`<option value="${x}" ${cfg.logLevel===x?'selected':''}>${x}</option>`).join('')}
        </select></div>
      ${num('maxAttempts','最大尝试次数 maxAttempts','8','单次请求最多试多少个「模型+Key」组合')}
    </div>
    <div class="grid3">
      ${msNum('waitForSlotMs','排队等待 waitForSlotMs','20000','全忙时最多排队多久(毫秒)')}
      ${msNum('cooldownMs','429 冷却 cooldownMs','60000','撞限流后的基础冷却(毫秒)')}
      ${msNum('maxCooldownMs','冷却上限 maxCooldownMs','600000','指数退避封顶(毫秒)')}
    </div>
    <div class="grid3">
      ${msNum('serverErrorCooldownMs','5xx 冷却(ms)','8000','上游报错后短暂冷却')}
      ${msNum('requestTimeoutMs','请求超时(ms)','120000','单个上游请求超时')}
      ${msNum('streamIdleTimeoutMs','流式空闲超时(ms)','90000','流式多久没数据就断')}
    </div>
  </div>
  <div class="card"><h3>调度增强 <span class="tag">连坐冷却 · 半开探活 · 模型熔断</span></h3>
    <div class="field" style="display:flex;align-items:center;gap:8px">
      <label style="margin:0;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text)">
        <input type="checkbox" data-set="groupCooldownOn429" ${cfg.groupCooldownOn429!==false?'checked':''}> 同组 429 连坐冷却（默认开）</label>
      <span class="hint">同账号分组内一个 Key 撞 429 → 整组一起冷却</span>
    </div>
    <div class="grid3">
      <div class="field" style="display:flex;align-items:center;gap:8px"><label style="margin:0;font-size:13px;color:var(--text);display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-set="halfOpen.enabled" ${(cfg.halfOpen||{}).enabled!==false?'checked':''}> 半开探活（默认开）</label>
        <span class="hint">冷却/下线 Key 先探活再回池</span></div>
      ${msNum('halfOpen.probeIntervalMs','探活节拍(ms)','15000','每隔多久扫一批到期 Key')}
      ${msNum('halfOpen.probeTimeoutMs','探活超时(ms)','10000','单次探活请求超时')}
    </div>
    <div class="grid3">
      ${num('halfOpen.probeMaxPerTick','每批探活数','2','防探测风暴')}
      <div class="field" style="display:flex;align-items:center;gap:8px"><label style="margin:0;font-size:13px;color:var(--text);display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-set="halfOpen.reviveDead" ${(cfg.halfOpen||{}).reviveDead!==false?'checked':''}> 下线 Key 自动复活（默认开）</label>
        <span class="hint">探活通过即复活</span></div>
      ${msNum('halfOpen.reviveDelayMs','复活等待(ms)','600000','下线后多久允许探活复活 · 10分钟=600000')}
    </div>
    <div class="grid3">
      <div class="field" style="display:flex;align-items:center;gap:8px"><label style="margin:0;font-size:13px;color:var(--text);display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-set="breaker.enabled" ${(cfg.breaker||{}).enabled!==false?'checked':''}> 模型熔断（默认开）</label>
        <span class="hint">连败模型秒回 503</span></div>
      ${num('breaker.failThreshold','熔断阈值(次)','3','连续几次全败触发')}
      ${msNum('breaker.openMs','熔断时长(ms)','30000','期间该模型秒回 503')}
    </div>
  </div>
  <div class="card"><h3>默认限流（平台未单独设置时生效）</h3>
    <div class="grid3">
      ${num('defaults.rpmPerKey','默认 RPM/Key','35','0=不限')}
      ${num('defaults.maxConcurrencyPerKey','默认并发/Key','2','0=不限')}
    </div>
  </div>
  <div class="card"><h3>访问控制</h3>
    <div class="grid2">
      <div class="field"><label>监听地址 host</label><input class="f mono" value="${esc(cfg.host)}" disabled><div class="hint">改 host/port 需重启服务</div></div>
      <div class="field"><label>端口 port</label><input class="f mono" value="${esc(cfg.port)}" disabled></div>
    </div>
    <div class="grid2">
      <div class="field"><label>旧版单 Key 鉴权 proxyApiKey（一般留空）</label>
        <input class="f mono" data-set="proxyApiKey" value="${esc(cfg.proxyApiKey||'')}" placeholder="留空=不使用"></div>
      <div class="field"><label>管理密码 adminToken</label>
        <input class="f mono" type="password" data-set="adminToken" value="${esc(cfg.adminToken||'')}" placeholder="留空=仅本机可管理">
        <div class="hint">管理台登录用;也是 API 直调凭证</div></div>
    </div>
    <div class="field"><label>协同管理员 collabTokens（JSON：{"token":"名字"}）</label>
      <textarea class="f mono" id="collab-json" rows="3" placeholder='{"collab-xxxx":"张三"}'>${esc(JSON.stringify(cfg.collabTokens||{},null,2))}</textarea>
      <div class="hint">协同管理员可放上游 Key、生成分发 Key;不能改其他配置</div></div>
  </div>
  <div class="card"><h3>监控告警 <span class="tag">邮件通知（QQ 邮箱）</span></h3>
    <div class="field" style="display:flex;align-items:center;gap:8px">
      <label style="margin:0;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text)">
        <input type="checkbox" data-set="alert.enabled" ${(cfg.alert||{}).enabled!==false?'checked':''}> 启用告警</label>
    </div>
    <div class="grid2">
      <div class="field"><label>收件人 alert.email.to</label><input class="f mono" data-set="alert.email.to" value="${esc(((cfg.alert||{}).email||{}).to||'')}" placeholder="your@qq.com"></div>
      <div class="field"><label>发件显示名</label><input class="f" data-set="alert.email.from" value="${esc(al.from||'代理池监控')}"></div>
      <div class="field"><label>发件账号 alert.email.account</label><input class="f mono" data-set="alert.email.account" value="${esc(al.account||'')}" placeholder="you@qq.com"><div class="hint">留空回退环境变量</div></div>
      <div class="field"><label>授权码 authCode</label><input class="f mono" type="password" data-set="alert.email.authCode" value="" placeholder="${authCodeSet?'已设置（留空不修改）':'16 位授权码'}"></div>
    </div>
    <div class="grid3">
      ${num('alert.cooldownMs','防抖间隔(ms)','1800000','同一告警多久内不重发')}
      ${num('alert.on429Streak','连续429告警阈值','5','0=关')}
    </div>
    <div class="field" style="display:flex;align-items:center;gap:20px">
      <label style="margin:0;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text)">
        <input type="checkbox" data-set="alert.allKeysDead" ${(cfg.alert||{}).allKeysDead!==false?'checked':''}> 全部 Key 下线告警</label>
      <label style="margin:0;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text)">
        <input type="checkbox" data-set="alert.onUserDailyExhausted" ${(cfg.alert||{}).onUserDailyExhausted!==false?'checked':''}> 用户配额用尽告警</label>
    </div>
  </div>
  <div class="hint" style="margin-bottom:16px">改完点右上角「保存配置」；保存前会做一次配置体检，明显的问题会被拦下。</div>`;
  const cj = document.getElementById('collab-json');
  if (cj) cj.addEventListener('input', ()=>{
    try { cfg.collabTokens = cj.value.trim() ? JSON.parse(cj.value) : {}; markDirty(); cj.style.borderColor=''; }
    catch(_) { cj.style.borderColor='var(--red)'; }
  });
}

/* ================= 页面:试一下 ================= */
function pagePlayground(){
  document.title = '试一下 · API 代理池';
  renderShell('试一下', `
  <div class="card"><h3>发一条测试消息 <span class="tag">验证当前配置与模型是否正常</span></h3>
    <div class="grid2">
      <div class="field"><label>模型（别名或 平台:模型）</label><input class="f mono" id="pg-model" value="auto" placeholder="auto / pro / flash / kimi / qwen"></div>
      <div class="field"><label>max_tokens</label><input class="f" type="number" id="pg-maxt" value="512"></div>
    </div>
    <div class="field"><label>消息内容</label><textarea class="f" id="pg-msg" rows="4">你好，用一句话介绍你自己</textarea></div>
    <div class="toolbar" style="margin-bottom:0">
      <label style="margin:0;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text)">
        <input type="checkbox" id="pg-stream" checked> 流式输出</label>
      <button class="btn primary" id="pg-run">发送</button>
      <span class="hint" id="pg-auth-hint"></span>
    </div>
    <div id="pg-out"></div>
  </div>`);
  const hint = document.getElementById('pg-auth-hint');
  if (hint) hint.textContent = '调用将消耗一次分发密钥额度';
  document.getElementById('pg-run').addEventListener('click', runTest);
}
async function runTest(){
  const model = document.getElementById('pg-model').value.trim() || 'auto';
  const content = document.getElementById('pg-msg').value;
  const maxTokens = Number(document.getElementById('pg-maxt').value) || 512;
  const stream = document.getElementById('pg-stream').checked;
  const out = document.getElementById('pg-out');
  const headers = { 'content-type':'application/json' };
  let key = '';
  if (cfg && cfg.accessKeys){
    for (const k of Object.keys(cfg.accessKeys)){
      if (k.startsWith('_')||k.startsWith('#')) continue;
      const spec = cfg.accessKeys[k];
      if (spec && spec.enabled === false) continue;
      key = k; break;
    }
  }
  if (key) headers['authorization'] = 'Bearer ' + key;
  else if (cfg && cfg.proxyApiKey) headers['authorization'] = 'Bearer ' + cfg.proxyApiKey;
  const body = { model, messages:[{role:'user', content}], max_tokens:maxTokens };
  if (stream) body.stream = true;
  const t0 = Date.now();
  out.innerHTML = '<div class="hint">请求中…</div>';
  try {
    if (stream){
      const resp = await fetch('/v1/chat/completions', { method:'POST', headers, body: JSON.stringify(body) });
      if (!resp.ok){ out.innerHTML = `<div class="box"><pre>HTTP ${resp.status}\n${esc(await resp.text())}</pre></div>`; return; }
      const reader = resp.body.getReader();
      const dec = new TextDecoder(); let full='', reasoning='', buf='';
      while(true){
        const {done, value} = await reader.read(); if (done) break;
        buf += dec.decode(value, {stream:true});
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines){
          const l = line.trim(); if (!l.startsWith('data:')) continue;
          const d = l.slice(5).trim(); if (d === '[DONE]') continue;
          try { const j = JSON.parse(d); const dt = (j.choices && j.choices[0] && j.choices[0].delta) || {};
            if (dt.content) full += dt.content;
            if (dt.reasoning_content) reasoning += dt.reasoning_content; } catch(_) {}
        }
      }
      out.innerHTML = resultBox({ content: full, reasoning, ms: Date.now()-t0, model, stream: true });
    } else {
      const resp = await fetch('/v1/chat/completions', { method:'POST', headers, body: JSON.stringify(body) });
      const j = await resp.json();
      if (!resp.ok || j.error){ out.innerHTML = `<div class="box"><pre>HTTP ${resp.status}\n${esc(JSON.stringify(j.error||j, null, 2))}</pre></div>`; return; }
      const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
      out.innerHTML = resultBox({ content: m.content||'', reasoning: m.reasoning_content||'', usage: j.usage, ms: Date.now()-t0, model });
    }
  } catch(e){ out.innerHTML = `<div class="box"><pre>请求异常：${esc(e.message)}</pre></div>`; }
}
function resultBox(r){
  const reasoning = r.reasoning ? `<div class="reasoning"><b>思考过程（reasoning_content）</b><pre>${esc(r.reasoning)}</pre></div>` : '';
  const usage = r.usage ? `<div class="meta">tokens: ${r.usage.prompt_tokens}+${r.usage.completion_tokens}=${r.usage.total_tokens||'-'}</div>` : '';
  return `<div class="box"><div class="meta">model: ${esc(r.model)} · 耗时 ${r.ms}ms${r.stream?'（流式）':''}</div>
    <pre>${esc(r.content||'(内容为空——可能 max_tokens 太小被思考过程吃光,试试调大)')}</pre>${reasoning}${usage}</div>`;
}

/* ================= 页面:个人中心 ================= */
function pageProfile(){
  document.title = '个人中心 · API Key 代理池';
  renderShell('个人中心', '<div class="empty">加载中…</div>');
  renderProfile();
}
async function renderProfile(){
  const main = document.getElementById('main'); if (!main) return;
  let d = null;
  try {
    const r = await fetch('/api/portal/mykeys', { credentials:'include' });
    if (r.status === 401){ navigate('#/login'); return; }
    d = await r.json();
  } catch(_) {}
  const base = location.protocol + '//' + location.host;
  const u = (d && d.usage) || { today:0, total:0, lastCallAt:null };
  const keys = (d && d.keys) || [];
  const quota = keys.reduce((m,k)=>Math.max(m, k.daily||0), 0);
  const pct = quota ? Math.min(100, Math.round((u.today||0)/quota*100)) : 0;
  const daily = (d && d.daily) || [];
  const byModel = (d && d.byModel) || [];
  const recent = (d && d.recent) || [];
  const maxDaily = Math.max(1, ...daily.map(x=>x.calls));
  const maxModel = Math.max(1, ...byModel.map(x=>x.calls));
  main.innerHTML = `
    ${ME && ME.mustChangePassword ? `<div class="tip" style="background:var(--orange-bg);border-color:#fde68a;color:#92400e">
      你正在使用预设密码，建议 <a href="#" id="pf-chpwd" style="color:#92400e;text-decoration:underline">立即修改</a>。</div>` : ''}
    <div class="cards">
      ${statCard('zap','#eff6ff','#3b82f6','今日调用',u.today||0)}
      ${statCard('chart','#f5f3ff','#8b5cf6','累计调用',u.total||0)}
      ${statCard('clock','#ecfdf5','#10b981','每日配额',quota||'不限')}
      ${statCard('clock','#fffbeb','#f59e0b','最近调用',u.lastCallAt?fmtTime(u.lastCallAt).slice(5):'—')}
    </div>
    ${quota?`<div class="card"><h3>今日配额使用 <span class="tag">${u.today||0} / ${quota}（${pct}%）</span></h3>
      <div class="bar"><i style="width:${pct}%;${pct>90?'background:linear-gradient(90deg,#f59e0b,#ef4444)':''}"></i></div></div>`:''}
    <div class="card"><h3>我的调用密钥</h3>
      <div id="pf-keys">${keys.length ? keys.map(k=>`<div class="keyline">
          <span class="k">${esc(k.key)}</span>
          <span class="badge badge-ok"><span class="dot"></span>可用</span>
          <span class="badge badge-muted">${k.rpm||'∞'} RPM</span>
          <span class="badge badge-muted">日 ${k.daily||'∞'}</span>
        </div>`).join('') : '<div class="empty">还没有分配给你的 Key —— 请联系管理员，把分发 Key 的名称设为你的用户名「'+esc(ME?ME.name:'')+'」</div>'}
      </div>
      <div class="hint" style="margin-top:10px">密钥即代码里的 <b>api_key</b>,请妥善保管;泄露后请联系管理员重置。</div>
    </div>
    <div class="card"><h3>接入方式</h3>
      <div class="grid2">
        <div class="field"><label>接口地址 base_url</label><input class="f mono" value="${esc(base)}/v1" readonly onclick="this.select()"></div>
        <div class="field"><label>模型名</label><input class="f mono" value="auto" readonly onclick="this.select()"><div class="hint">也可用 pro / flash / kimi / qwen</div></div>
      </div>
      <div class="hint">客户端里地址若要求填「不带 /v1 的根地址」,就填 ${esc(base)}（否则会出现 /v1/v1 双写）。</div>
    </div>
    <div class="card"><h3>近 7 天调用</h3>
      ${daily.length ? `<div class="tbl-wrap"><table><thead><tr><th>日期</th><th>调用</th><th>成功</th><th>失败</th><th style="width:35%">分布</th></tr></thead><tbody>
        ${daily.map(x=>`<tr><td>${esc(x.date)}</td><td><b>${x.calls}</b></td><td style="color:#10b981">${x.ok}</td><td style="color:#ef4444">${x.fail}</td>
          <td><div class="bar"><i style="width:${Math.round(x.calls/maxDaily*100)}%"></i></div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">近 7 天还没有调用记录</div>'}
    </div>
    ${byModel.length?`<div class="card"><h3>模型分布</h3>
      <div class="tbl-wrap"><table><thead><tr><th>模型</th><th>调用</th><th>成功</th><th>失败</th><th style="width:35%">占比</th></tr></thead><tbody>
      ${byModel.map(x=>`<tr><td><code>${esc(x.model)}</code></td><td>${x.calls}</td><td style="color:#10b981">${x.ok}</td><td style="color:#ef4444">${x.fail}</td>
        <td><div class="bar"><i style="width:${Math.round(x.calls/maxModel*100)}%"></i></div></td></tr>`).join('')}
      </tbody></table></div></div>`:''}
    ${recent.length?`<div class="card"><h3>最近调用记录</h3>
      <div class="tbl-wrap"><table><thead><tr><th>时间</th><th>模型</th><th>状态</th><th>耗时</th><th>方式</th></tr></thead><tbody>
      ${recent.map(e=>`<tr><td class="mono" style="font-size:12px;white-space:nowrap">${fmtTime(e.ts)}</td><td><code>${esc(e.model||'—')}</code></td>
        <td>${e.status==null?'<span class="badge badge-muted"><span class="dot"></span>中断</span>':`<span class="badge ${e.status<400?'badge-ok':'badge-err'}"><span class="dot"></span>${e.status}</span>`}</td>
        <td>${e.latencyMs||0}ms</td><td>${e.stream?'流式':'普通'}</td></tr>`).join('')}
      </tbody></table></div></div>`:''}
    <div class="card"><h3>账号</h3>
      <div class="grid2">
        <div class="field"><label>用户名</label><input class="f" value="${esc(ME?ME.name:'')}" readonly></div>
        <div class="field"><label>角色</label><input class="f" value="${roleLabel(role)}" readonly></div>
      </div>
      <button class="btn" id="pf-chpwd-btn">修改密码</button>
    </div>`;
  const a = document.getElementById('pf-chpwd'); if (a) a.addEventListener('click', e=>{ e.preventDefault(); showChangePwd('修改登录密码'); });
  const b = document.getElementById('pf-chpwd-btn'); if (b) b.addEventListener('click', ()=> showChangePwd('修改登录密码'));
}

/* ================= 配置体检(保存前防呆) ================= */
function validateConfig(){
  const problems = [], warnings = [];
  const providers = cfg.providers || [];
  const pnames = new Set();
  for (const p of providers){
    if (!p.name) problems.push('有平台没填名称');
    else if (pnames.has(p.name)) problems.push('平台名重复:' + p.name);
    pnames.add(p.name);
    if (!p.baseUrl) problems.push(`平台「${p.name||'?'}」没填 baseUrl`);
    else if (!/^https?:\/\//.test(p.baseUrl)) problems.push(`平台「${p.name}」的 baseUrl 要以 http(s):// 开头`);
    else if (p.baseUrl.endsWith('/')) warnings.push(`平台「${p.name}」的 baseUrl 以 / 结尾（建议去掉）`);
    const liveKeys = (p.keys||[]).filter(k=>!k.startsWith('#') && !k.startsWith('env:'));
    if (!p.keys || !p.keys.length) warnings.push(`平台「${p.name}」没有任何 Key`);
    const expectPrefix = { nvidia:'nvapi-', sensenova:'sk-', openrouter:'sk-or-', modelscope:'ms-', deepseek:'sk-', moonshot:'sk-' };
    const want = expectPrefix[(p.name||'').toLowerCase()];
    if (want){
      const bad = liveKeys.filter(k=>!k.startsWith(want));
      if (bad.length) warnings.push(`平台「${p.name}」有 ${bad.length} 个 Key 不以 ${want} 开头（确认是否拿对平台的 Key）`);
    }
    const seen = new Set(), dups = [];
    for (const k of liveKeys){ const base = k.split('@')[0]; if (seen.has(base)) dups.push(base.slice(0,10)+'…'); seen.add(base); }
    if (dups.length) warnings.push(`平台「${p.name}」有重复 Key:${dups.join('、')}`);
    const grouped = (p.keys||[]).some(k=>k.includes('@'));
    if (grouped && (p.rpmPerAccount||0)===0 && (p.rpmPerKey||0)>0)
      warnings.push(`平台「${p.name}」用了 @账号分组 却没设 rpmPerAccount（同账号多 Key 不叠加额度）`);
  }
  for (const [alias, cands] of Object.entries(cfg.models||{})){
    if (alias.startsWith('_')) continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(alias)) problems.push(`别名「${alias}」含特殊字符（客户端要填它，只用英文数字-_）`);
    if (!Array.isArray(cands) || !cands.length){ problems.push(`别名「${alias}」没有候选，等于调不通`); continue; }
    for (const t of cands){
      if (!t.provider || !pnames.has(t.provider)) problems.push(`别名「${alias}」引用了不存在的平台「${t.provider||'(空)'}」`);
      if (!t.model) problems.push(`别名「${alias}」有候选没填模型 ID`);
      // 模型名对照平台真实列表（仅在已成功拉取到列表时检查）
      const st = providerModels[t.provider];
      if (st && st.ok && st.models.length && t.model && !st.models.includes(t.model)){
        warnings.push(`别名「${alias}」的模型「${t.model}」不在平台「${t.provider}」的模型列表中——可能拼错，去「模型」页下拉重选`);
      }
    }
    if (!cands.some(t=>!t.fallback)) warnings.push(`别名「${alias}」所有候选都是兜底——没有主力可走`);
  }
  for (const r of accessRows){
    if (!r.key) problems.push('有分发 Key 没填 Key 值');
    else if (!r.key.startsWith('sk-pool-')) warnings.push(`分发 Key「${r.key.slice(0,12)}…」不是 sk-pool- 前缀`);
    if (r.rpm>0 && r.rpm>200) warnings.push(`「${r.name||r.key.slice(0,10)}」RPM 上限 ${r.rpm} 异常大`);
    if (r.daily>0 && r.daily>50000) warnings.push(`「${r.name||r.key.slice(0,10)}」日配额 ${r.daily} 异常大`);
  }
  const timeChecks = [
    ['waitForSlotMs',500,300000,'排队等待'], ['cooldownMs',1000,3600000,'429冷却'],
    ['maxCooldownMs',10000,86400000,'冷却上限'], ['requestTimeoutMs',3000,600000,'请求超时'],
    ['halfOpen.probeIntervalMs',1000,300000,'探活节拍'], ['halfOpen.reviveDelayMs',10000,86400000,'复活等待'],
    ['breaker.openMs',1000,1800000,'熔断时长'],
  ];
  const human = ms => ms>=3600000 ? (ms/3600000)+'小时' : (ms>=60000 ? (ms/60000)+'分钟' : (ms/1000)+'秒');
  for (const [k,min,max,label] of timeChecks){
    const v = getByPath(cfg, k);
    if (v==null || v===0) continue;
    if (v<min) warnings.push(`${label}=${v}ms 太小（${human(min)}≈${min}ms）`);
    if (v>max) warnings.push(`${label}=${v}ms 异常大（${human(v)}）`);
  }
  if (problems.length) throw new Error(problems.slice(0,6).join('\n'));
  return warnings.length ? warnings.slice(0,8).join('\n') : null;
}
async function save(){
  if (!cfg) return;
  syncAccessToCfg();
  let vMsg = null;
  try { vMsg = validateConfig(); }
  catch(e){
    const lines = e.message.split('\n');
    toast('保存被拦下：' + lines[0] + (lines.length>1 ? `（共 ${lines.length} 处）` : ''), 'err');
    alert('配置有必须修改的问题：\n\n' + e.message);
    return;
  }
  if (vMsg && !confirm('发现以下可疑之处（确认无误可继续保存）：\n\n' + vMsg)) return;
  const oldToken = cfg.adminToken;
  const r = await api('PUT', '/admin/api/config', cfg);
  if (r.status === 200){
    dirty = false;
    const d = document.getElementById('dirty-dot'); if (d) d.classList.remove('show');
    if (cfg.adminToken) token = localStorage['akp_admin_token'] = cfg.adminToken;
    else if (oldToken) token = localStorage['akp_admin_token'] = '';
    toast('已保存并热重载生效', 'ok');
    if (r.data.warnings && r.data.warnings.length) toast(r.data.warnings.join('；'), 'err');
    await loadConfig(); loadStats();
  } else {
    toast((r.data && r.data.error && r.data.error.message) || '保存失败', 'err');
  }
}

/* ================= 事件委托(表单/按钮) ================= */
document.addEventListener('input', e=>{
  const el = e.target;
  // 平台选择变了 → 拉取该平台的模型列表(供模型名下拉)
  if (el.dataset && el.dataset.refreshModels && el.value && cfg){
    ensureProviderModels(el.value, false);
  }
  if (el.dataset && el.dataset.set != null){
    let v = el.value;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') v = v==='' ? 0 : Number(v);
    if (el.dataset.set.endsWith('extraHeadersJson')){
      const base = el.dataset.set.replace(/extraHeadersJson$/,'extraHeaders');
      try { setByPath(cfg, base, v.trim()?JSON.parse(v):undefined); } catch(_) {}
    } else setByPath(cfg, el.dataset.set, v);
    markDirty(); return;
  }
  if (el.dataset && el.dataset.keys != null){
    const p = getByPath(cfg, el.dataset.keys);
    if (p){ p.keys = el.value.split('\n').map(s=>s.trim()).filter(Boolean); markDirty(); }
    return;
  }
  if (el.dataset && el.dataset.access != null){
    const [idx, field] = el.dataset.access.split('.');
    if (!accessRows[idx]) accessRows[idx] = { key:'', name:'', rpm:0, daily:0, enabled:true };
    let v = el.value;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') v = v==='' ? 0 : Number(v);
    accessRows[idx][field] = v; markDirty(); return;
  }
  if (el.dataset && el.dataset.aliasName != null){
    const old = el.dataset.aliasName, nv = el.value.trim();
    if (nv && nv !== old && !nv.includes('.') && cfg.models[old] !== undefined){
      cfg.models[nv] = cfg.models[old]; delete cfg.models[old]; el.dataset.aliasName = nv;
    }
    markDirty();
  }
});
document.addEventListener('click', e=>{
  const btn = e.target.closest('[data-action]'); if (!btn || !cfg) return;
  const act = btn.dataset.action;
  const idx = Number(btn.dataset.idx);
  if (act === 'addProvider'){ cfg.providers = cfg.providers||[]; cfg.providers.push({name:'',baseUrl:'',chatPath:'',rpmPerKey:0,rpmPerAccount:0,maxConcurrencyPerKey:0,keys:[]}); renderKeys(); markDirty(); }
  else if (act === 'delProvider'){ if(confirm('删除该平台及其所有 Key？')){ cfg.providers.splice(idx,1); renderKeys(); markDirty(); } }
  else if (act === 'addModel'){ let n='new', i=2; while(cfg.models && cfg.models[n]) n='new'+(i++); cfg.models=cfg.models||{}; cfg.models[n]=[{provider:(cfg.providers[0]||{}).name||'',model:''}]; renderModels(); markDirty(); }
  else if (act === 'delModel'){ if(confirm('删除别名「'+btn.dataset.alias+'」？')){ delete cfg.models[btn.dataset.alias]; renderModels(); markDirty(); } }
  else if (act === 'addModelCandidate'){ const a=btn.dataset.alias; const arr = cfg.models[a] = (Array.isArray(cfg.models[a])?cfg.models[a]:[cfg.models[a]]); arr.push({provider:(cfg.providers[0]||{}).name||'',model:''}); renderModels(); markDirty(); }
  else if (act === 'delModelCandidate'){ const a=btn.dataset.alias; const arr=cfg.models[a]; arr.splice(idx,1); if(!arr.length) delete cfg.models[a]; renderModels(); markDirty(); }
  else if (act === 'addAccess'){ accessRows.push({key:'',name:'',rpm:0,daily:0,enabled:true}); renderTokens(); markDirty(); }
  else if (act === 'genAccess'){ accessRows.push({key:genKey(),name:'新用户',rpm:10,daily:300,enabled:true}); renderTokens(); markDirty(); }
  else if (act === 'genAccessBatch'){ for(let n=0;n<5;n++) accessRows.push({key:genKey(),name:'新用户'+(accessRows.length+1),rpm:10,daily:300,enabled:true}); renderTokens(); markDirty(); toast('已生成 5 个随机 Key，记得保存','ok'); }
  else if (act === 'delAccess'){ accessRows.splice(idx,1); renderTokens(); markDirty(); }
  else if (act === 'refreshModels'){ toast('正在拉取各平台模型列表…'); loadAllProviderModels(true); }
});

/* ================= 启动 ================= */
(async function init(){
  await fetchMe();
  if (!location.hash) location.hash = ME ? defaultLanding() : '#/';
  await route();
})();

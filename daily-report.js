#!/usr/bin/env node
/**
 * 每日用量报表 —— 从运行中的代理池拉取 /stats 生成 HTML 报表
 *
 * 用法：
 *   node daily-report.js                默认连 http://127.0.0.1:8787，报表存 reports/
 *   POOL_BASE=http://127.0.0.1:8787 node daily-report.js
 *
 * 输出：
 *   reports/YYYY-MM-DD.html             当日报表（可直接用浏览器打开 / 发给别人）
 *   控制台打印一行摘要
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.POOL_BASE || 'http://127.0.0.1:8787';
// 设了 adminToken 后 /stats 需要管理鉴权：用 POOL_ADMIN_TOKEN 传入，否则本机免密
const ADMIN_TOKEN = process.env.POOL_ADMIN_TOKEN || '';

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(ts) {
  const d = ts ? new Date(ts) : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main() {
  const headers = {};
  if (ADMIN_TOKEN) headers['authorization'] = 'Bearer ' + ADMIN_TOKEN;
  const res = await fetch(`${BASE}/stats`, { signal: AbortSignal.timeout(8000), headers });
  if (!res.ok) throw new Error(`/stats 返回 ${res.status}（设了 adminToken 的话请用 POOL_ADMIN_TOKEN 传入）`);
  const d = await res.json();

  const today = fmtDate();
  const now = new Date();
  const { summary, keys, users } = d;

  // ---- 用户行 ----
  const userRows = (users || []).map((u) => `
    <tr>
      <td>${esc(u.name)}</td>
      <td><code>${esc(u.key)}</code></td>
      <td>${u.rpm || '∞'}</td>
      <td>${u.daily || '∞'}</td>
      <td class="num">${u.todayCalls ?? 0}</td>
      <td class="num">${u.totalCalls ?? 0}</td>
      <td>${fmtTime(u.lastCallAt)}</td>
    </tr>`).join('');
  const userBlock = (users || []).length
    ? `<table><thead><tr><th>用户</th><th>分发 Key</th><th>RPM</th><th>日限</th><th>今日调用</th><th>累计</th><th>最近调用</th></tr></thead><tbody>${userRows}</tbody></table>`
    : `<div class="empty">尚未配置分发用户（config.json → accessKeys）</div>`;

  // ---- Key 健康行 ----
  const stateBadge = (k) => {
    const map = {
      ready: ['<span class="badge ok">可用</span>', '#16a34a'],
      busy: ['<span class="badge busy">忙</span>', '#2563eb'],
      cooling: ['<span class="badge warn">冷却</span>', '#d97706'],
      verify: ['<span class="badge verify">待探活</span>', '#7c3aed'],
      dead: ['<span class="badge bad">下线</span>', '#dc2626'],
    };
    return (map[k.state] || [esc(k.state), '#64748b'])[0];
  };
  const stateExplain = (k) => {
    if (k.state === 'dead') return esc(k.deadReason || '');
    if (k.state === 'verify') return '冷却到期，等探活验证回池';
    if (k.cooldownRemainMs > 0 || k.groupCooldownRemainMs > 0) {
      const parts = [];
      if (k.groupCooldownRemainMs > 0) parts.push(`组冷却剩余 ${(k.groupCooldownRemainMs / 1000).toFixed(0)}s`);
      if (k.cooldownRemainMs > 0) parts.push(`Key 冷却剩余 ${(k.cooldownRemainMs / 1000).toFixed(0)}s`);
      return parts.join(' · ');
    }
    return '-';
  };
  const keyRows = (keys || []).map((k) => `
    <tr>
      <td><code>${esc(k.id)}</code></td>
      <td>${stateBadge(k)}</td>
      <td>${stateExplain(k)}</td>
      <td class="num">${k.stats?.ok ?? 0}</td>
      <td class="num">${k.stats?.fail ?? 0}</td>
      <td class="num">${k.stats?.limited ?? 0}</td>
      <td class="num">${k.stats?.lastLatencyMs ?? '-'}</td>
      <td>${esc(k.stats?.lastError || '-')}</td>
    </tr>`).join('');
  const keyBlock = (keys || []).length
    ? `<table><thead><tr><th>Key</th><th>状态</th><th>说明</th><th>成功</th><th>失败</th><th>429</th><th>最近耗时(ms)</th><th>最近错误</th></tr></thead><tbody>${keyRows}</tbody></table>`
    : `<div class="empty">尚未配置上游 Key</div>`;

  // ---- 熔断中的模型（若有）----
  const breakers = (d.breakers || []).filter((b) => b.openRemainMs > 0);
  const breakerBlock = breakers.length
    ? `<table><thead><tr><th>模型</th><th>剩余熔断</th></tr></thead><tbody>
      ${breakers.map((b) => `<tr><td><code>${esc(b.model)}</code></td><td>${(b.openRemainMs / 1000).toFixed(0)}s（秒回 503，到期自动试探恢复）</td></tr>`).join('')}
    </tbody></table>`
    : `<div class="empty">无模型处于熔断状态（模型连续失败会自动熔断，避免反复试错）</div>`;

  // ---- 汇总卡片 ----
  const cards = [
    ['上游 Key 总数', summary.total, '#2563eb'],
    ['可用 / 待探活 / 冷却 / 下线', `${summary.ready} / ${summary.verify || 0} / ${summary.cooling} / ${summary.dead}`, '#64748b'],
    ['熔断中模型', (d.breakers || []).filter((b) => b.openRemainMs > 0).length, '#dc2626'],
    ['累计成功', summary.ok, '#16a34a'],
    ['累计失败', summary.fail, '#dc2626'],
    ['累计 429', summary.limited, '#d97706'],
    ['服务已运行', `${Math.floor(d.uptimeSec / 3600)}h${Math.floor((d.uptimeSec % 3600) / 60)}m`, '#7c3aed'],
  ].map(([label, val, color]) => `
    <div class="card"><div class="card-label">${label}</div><div class="card-val" style="color:${color}">${val}</div></div>`).join('');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>代理池日报 ${today}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Microsoft YaHei", -apple-system, sans-serif; background: #f1f5f9; color: #0f172a; padding: 24px; }
  .wrap { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #64748b; font-size: 13px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .card-label { font-size: 12px; color: #64748b; margin-bottom: 6px; }
  .card-val { font-size: 22px; font-weight: 700; }
  h2 { font-size: 16px; margin: 24px 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  th, td { padding: 9px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #e2e8f0; }
  th { background: #f8fafc; color: #475569; font-weight: 600; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: #f1f5f9; border-radius: 4px; padding: 1px 5px; font-size: 12px; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; color: #fff; }
  .badge.ok { background: #16a34a; } .badge.busy { background: #2563eb; } .badge.warn { background: #d97706; } .badge.verify { background: #7c3aed; } .badge.bad { background: #dc2626; }
  .empty { background: #fff; border-radius: 10px; padding: 24px; text-align: center; color: #94a3b8; font-size: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .foot { margin-top: 24px; color: #94a3b8; font-size: 12px; text-align: center; }
</style></head><body><div class="wrap">
  <h1>⛵ API 代理池日报</h1>
  <div class="sub">生成时间 ${now.toLocaleString('zh-CN')} · 数据源 ${esc(BASE)} · 报表只读，不消耗上游额度</div>
  <div class="cards">${cards}</div>
  <h2>接入用户用量</h2>
  ${userBlock}
  <h2>上游 Key 健康度</h2>
  ${keyBlock}
  <h2>模型熔断状态</h2>
  ${breakerBlock}
  <div class="foot">由 api-key-pool / daily-report.js 生成</div>
</div></body></html>`;

  const dir = path.join(__dirname, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${today}.html`);
  fs.writeFileSync(file, html, 'utf-8');

  const userSummary = (users || []).map((u) => `${u.name}:${u.todayCalls ?? 0}`).join(' ');
  const brkCount = (d.breakers || []).filter((b) => b.openRemainMs > 0).length;
  console.log(`✅ 日报已生成: ${file}`);
  console.log(`   用户调用 -> ${userSummary || '无'}`);
  console.log(`   Key 状态 -> 总${summary.total} 可用${summary.ready} 待探活${summary.verify || 0} 冷却${summary.cooling} 下线${summary.dead} | 成功${summary.ok} 失败${summary.fail} 429×${summary.limited} | 熔断模型 ${brkCount}`);
}

main().catch((e) => {
  console.error(`❌ 日报生成失败: ${e.message}`);
  console.error(`   请确认代理池正在运行（${BASE}）`);
  process.exit(1);
});

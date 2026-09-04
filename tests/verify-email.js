// 验证授权码后台接口：GET 脱敏（__SET__）+ PUT 保留旧值 + PUT 更新新值
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8897;
const CFG_PATH = path.join(__dirname, 'config.email.json');

function req(method, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'content-type': 'application/json', 'content-length': payload ? Buffer.byteLength(payload) : 0 } }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}
function diskAuthCode() {
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  return raw && raw.alert && raw.alert.email ? raw.alert.email.authCode : undefined;
}

const INITIAL = diskAuthCode(); // 运行前初始值，保证脚本可重复执行

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra != null ? JSON.stringify(extra) : ''); }
}

(async () => {
  // 1. GET 脱敏：authCode 应返回 __SET__ 而非明文
  const g1 = await req('GET', '/admin/api/config');
  const c1 = g1.body.config;
  ok('GET 脱敏：authCode 返回 __SET__', c1.alert.email.authCode === '__SET__', c1.alert.email.authCode);
  ok('GET 脱敏：不泄露明文初始值', JSON.stringify(g1.body).indexOf(INITIAL) === -1);
  ok('GET：account 明文可读', c1.alert.email.account === 'monitor@qq.com', c1.alert.email.account);

  // 2. PUT 保留：模拟前端未修改，authCode 传回 __SET__，磁盘应保留初始值
  const put1 = { ...c1, alert: { ...c1.alert, email: { ...c1.alert.email, authCode: '__SET__' } } };
  const r1 = await req('PUT', '/admin/api/config', put1);
  ok('PUT(__SET__) 返回 ok', r1.status === 200 && r1.body.ok, r1.status);
  ok('PUT(__SET__) 磁盘保留旧值', diskAuthCode() === INITIAL, diskAuthCode());

  // 3. PUT 更新：authCode 传新值，磁盘应更新
  const NEW = 'newcode456';
  const put2 = { ...c1, alert: { ...c1.alert, email: { ...c1.alert.email, authCode: NEW } } };
  const r2 = await req('PUT', '/admin/api/config', put2);
  ok('PUT(新值) 返回 ok', r2.status === 200 && r2.body.ok, r2.status);
  ok('PUT(新值) 磁盘更新为 ' + NEW, diskAuthCode() === NEW, diskAuthCode());

  // 4. 再次 GET：应仍脱敏
  const g2 = await req('GET', '/admin/api/config');
  ok('再次 GET：authCode 仍 __SET__', g2.body.config.alert.email.authCode === '__SET__', g2.body.config.alert.email.authCode);
  ok('再次 GET：不泄露新值 ' + NEW, JSON.stringify(g2.body).indexOf(NEW) === -1);

  // 5. PUT 空值：模拟清空，磁盘应保留（不删除）
  const put3 = { ...g2.body.config, alert: { ...g2.body.config.alert, email: { ...g2.body.config.alert.email, authCode: '' } } };
  const r3 = await req('PUT', '/admin/api/config', put3);
  ok('PUT(空) 磁盘保留 ' + NEW + '（空值不删）', diskAuthCode() === NEW, diskAuthCode());

  // 6. 收尾：恢复磁盘初始值，保证可重复运行
  const put4 = { ...g2.body.config, alert: { ...g2.body.config.alert, email: { ...g2.body.config.alert.email, authCode: INITIAL } } };
  await req('PUT', '/admin/api/config', put4);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

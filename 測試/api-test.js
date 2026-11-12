// 後端規則測試：node 測試\api-test.js（全部 ✔ 才能上線）
'use strict';
const { makeEnv } = require('./sim-server.js');
const env = makeEnv();
let pass = 0, fail = 0;
const call = q => JSON.parse(env.doPost({ postData: { contents: JSON.stringify(q) } }).s);
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('✘ ' + msg); } }
const okCall = (q, msg) => { const r = call(q); ok(r.ok && !r.conflict, msg + ' → ' + (r.err || '')); return r; };
const badCall = (q, msg) => { const r = call(q); ok(!r.ok || r.conflict, msg + '（應該被擋）'); return r; };

// 帳號
ok(call({ action: 'hasUsers' }).has === false, '一開始沒有帳號');
badCall({ action: 'setupFirst', user: 'ab', name: '王', pass: '123' }, '密碼太短');
const A = okCall({ action: 'setupFirst', user: 'Boss', name: '王後台', pass: 'test-pass-1' }, '建第一個後台');
ok(A.me && A.me.role === 'admin' && A.me.user === 'boss', '第一個帳號是後台');
badCall({ action: 'setupFirst', user: 'x2', name: '二', pass: 'test-pass-1' }, '第二次 setupFirst');
const ta = A.token;
okCall({ action: 'saveUser', token: ta, isNew: true, user: 'insp1', name: '李驗屋', role: 'inspector', pass: 'test-pass-2' }, '新增驗屋人員');
badCall({ action: 'saveUser', token: ta, isNew: true, user: 'insp1', name: '重複', role: 'inspector', pass: 'test-pass-2' }, '重複帳號');
badCall({ action: 'login', user: 'insp1', pass: 'wrong-pass' }, '密碼錯');
const B = okCall({ action: 'login', user: 'INSP1', pass: 'test-pass-2' }, '驗屋人員登入');
const tb = B.token;
ok(B.me.role === 'inspector', '角色是驗屋人員');
badCall({ action: 'list', token: 'x.y' }, '亂給 token');
badCall({ action: 'listUsers', token: tb }, '驗屋人員看帳號清單');
badCall({ action: 'saveUser', token: ta, user: 'boss', name: '王後台', role: 'inspector' }, '自己拿掉自己的後台');

// 建案（只有後台）
const P = { id: 'proj001', name: '測試建案', addr: '', layouts: { A: { beds: 2, baths: 2, balc: 2, common: false } },
  floors: [{ id: 'fl0001', name: '2F', units: [{ id: 'un0001', name: 'A', layout: { beds: 2, baths: 2, balc: 2, common: false } }, { id: 'un0002', name: 'B', layout: { beds: 2, baths: 2, balc: 2, common: false } }] }] };
badCall({ action: 'saveProject', token: tb, project: P, baseV: 0 }, '驗屋人員建建案');
const r1 = okCall({ action: 'saveProject', token: ta, project: P, baseV: 0 }, '後台建建案');
ok(r1.v === 1, '建案版本 1');
badCall({ action: 'saveProject', token: ta, project: P, baseV: 0 }, '舊版本覆蓋建案');
const L = okCall({ action: 'list', token: tb }, '驗屋人員讀資料');
ok(L.projects.length === 1 && L.projects[0].floors[0].units.length === 2, '看得到建案');

// 驗屋流程
const locs = ['客廳', '主臥室'];
const def = (id, r, extra) => Object.assign({ id, k: 'tile', cat: '空心', r, type: '', subs: ['地磚'], loc: '客廳', note: '', photos: [], fixed: false }, extra);
let I = { date: '2026-11-12', inspector: '李驗屋', owner: '', phone: '', round: 1, common: false, locs, checked: {}, defs: [def('d1', 1)] };
let v = okCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: I, baseV: 0 }, '開始交屋部初驗').v;
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: I, baseV: 0 }, '舊版本覆蓋戶別');
// 照片
const img = 'data:image/jpeg;base64,' + Buffer.from('fakejpeg').toString('base64');
okCall({ action: 'uploadPhoto', token: tb, id: 'ph0001', data: img }, '上傳照片');
I = JSON.parse(JSON.stringify(I)); I.defs[0].photos = ['ph0001'];
v = okCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: I, baseV: v }, '缺失加照片').v;
ok(okCall({ action: 'getPhotos', token: tb, ids: ['ph0001'] }, '讀照片').photos.ph0001 === img, '照片內容一樣');
// 驗屋人員不能改位置
let J = JSON.parse(JSON.stringify(I)); J.locs = ['客廳'];
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: J, baseV: v }, '驗屋人員改位置');
// 完成初驗
I = JSON.parse(JSON.stringify(I)); I.done = { 1: '2026-11-12' };
v = okCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: I, baseV: v }, '完成交屋部初驗').v;
J = JSON.parse(JSON.stringify(I)); J.defs[0].note = '偷改';
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: J, baseV: v }, '驗屋人員改已完成的缺失');
J = JSON.parse(JSON.stringify(I)); J.defs = [];
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: J, baseV: v }, '驗屋人員刪已完成的缺失');
J = JSON.parse(JSON.stringify(I)); J.done = {};
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: J, baseV: v }, '驗屋人員取消已完成');
J = JSON.parse(JSON.stringify(I)); J.defs.push(def('d2', 1));
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: J, baseV: v }, '已完成階段再加缺失');
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: null, baseV: v }, '驗屋人員清除紀錄');
// 後台修正已完成的缺失
J = JSON.parse(JSON.stringify(I)); J.defs[0].note = '後台修正';
v = okCall({ action: 'saveUnit', token: ta, pid: 'proj001', uid: 'un0001', insp: J, baseV: v }, '後台修正已完成的缺失').v;
I = J;
// 進屋主初驗
I = JSON.parse(JSON.stringify(I)); I.round = 2; I.checked = {}; I.defs.push(def('d2', 2)); I.defs[0].fixed = true;
v = okCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: I, baseV: v }, '屋主初驗加缺失、標已改善').v;
J = JSON.parse(JSON.stringify(I)); J.round = 4;
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: J, baseV: v }, '跳兩個階段');
J = JSON.parse(JSON.stringify(I)); J.round = 3;
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0001', insp: J, baseV: v }, '沒完成就進複驗');
// 新戶直接屋主初驗
okCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0002', insp: { round: 2, common: false, locs, checked: {}, defs: [] }, baseV: 0 }, '直接開始屋主初驗');
badCall({ action: 'saveUnit', token: tb, pid: 'proj001', uid: 'un0002', insp: { round: 2, common: false, locs, checked: {}, defs: [] }, baseV: 0 }, '同戶又重開');
// 刪戶別：照片丟垃圾桶
const P2 = JSON.parse(JSON.stringify(P)); P2.floors[0].units = P2.floors[0].units.slice(1);
badCall({ action: 'saveProject', token: ta, project: P2, baseV: 1 }, '沒指定就刪掉有紀錄的戶');
okCall({ action: 'saveProject', token: ta, project: P2, baseV: 1, drop: ['un0001'] }, '後台刪 A 戶');
badCall({ action: 'saveUser', token: ta, user: 'insp1', name: '李驗屋', role: 'admin', pass: '123' }, '重設密碼太短');
ok(call({ action: 'listUsers', token: ta }).users.find(x => x.user === 'insp1').role === 'inspector', '密碼太短時角色沒被改');
ok(env._files.find(f => f.name === 'ph0001.jpg').trashed, '刪戶別後照片進垃圾桶');
ok(call({ action: 'list', token: ta }).units.length === 1, '只剩 B 戶紀錄');
// 大資料切塊
const big = { round: 1, common: false, locs, checked: {}, defs: Array.from({ length: 600 }, (_, i) => def('x' + i, 1, { note: '很長的說明'.repeat(20) })) };
const bv = okCall({ action: 'saveUnit', token: ta, pid: 'proj001', uid: 'un0002', insp: big, baseV: 1 }, '存很大的戶別').v;
ok(call({ action: 'list', token: ta }).units.find(u => u.uid === 'un0002').insp.defs.length === 600, '大資料讀回來完整');
big.defs = big.defs.slice(0, 2);
okCall({ action: 'saveUnit', token: ta, pid: 'proj001', uid: 'un0002', insp: big, baseV: bv }, '變小後再存');
ok(call({ action: 'list', token: ta }).units.find(u => u.uid === 'un0002').insp.defs.length === 2, '變小後沒殘留舊資料');
// 停用、改密碼
okCall({ action: 'saveUser', token: ta, user: 'insp1', name: '李驗屋', role: 'inspector', disabled: true }, '停用驗屋人員');
badCall({ action: 'list', token: tb }, '停用後舊登入失效');
badCall({ action: 'login', user: 'insp1', pass: 'test-pass-2' }, '停用後不能登入');
const C = okCall({ action: 'changePass', token: ta, old: 'test-pass-1', pass: 'test-pass-9' }, '改自己密碼');
badCall({ action: 'list', token: ta }, '改密碼後舊登入失效');
okCall({ action: 'list', token: C.token }, '新登入可用');
// 刪建案
okCall({ action: 'deleteProject', token: C.token, pid: 'proj001' }, '刪建案');
ok(call({ action: 'list', token: C.token }).units.length === 0, '刪建案後戶別也刪');
badCall({ action: 'saveUnit', token: C.token, pid: 'proj001', uid: 'un0002', insp: big, baseV: 0 }, '已刪建案存戶別');

console.log(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);

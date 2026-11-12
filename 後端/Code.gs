// ══════════════════════════════════════════════════════
// 小棒槌 驗屋系統 後端（Google Apps Script 網頁應用程式）
// 資料：Google 試算表「驗屋系統資料庫」（帳號、建案、戶別）
// 照片：雲端硬碟「驗屋系統\照片」資料夾
// 第一次使用：在 Apps Script 編輯器執行「初始化」並授權。
// ══════════════════════════════════════════════════════

const CHUNK = 40000;          // 一格最多 5 萬字，JSON 切成 4 萬字一格
const TOKEN_DAYS = 30;        // 登入有效天數
const ROLES = { admin: '後台', inspector: '驗屋人員' };

function props_() { return PropertiesService.getScriptProperties(); }
const now_ = () => Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');

// ── 初始化：建試算表、照片資料夾、簽章密鑰 ─────────────
function 初始化() {
  const p = props_();
  if (!p.getProperty('ROOT_ID')) p.setProperty('ROOT_ID', DriveApp.createFolder('驗屋系統').getId());
  const root = DriveApp.getFolderById(p.getProperty('ROOT_ID'));
  if (!p.getProperty('FOLDER_ID')) p.setProperty('FOLDER_ID', root.createFolder('照片').getId());
  if (!p.getProperty('SS_ID')) {
    const ss = SpreadsheetApp.create('驗屋系統資料庫');
    const s0 = ss.getSheets()[0];
    s0.setName('帳號'); s0.appendRow(['帳號', '姓名', '角色', '鹽', '雜湊', '停用', '建立時間']);
    ss.insertSheet('建案').appendRow(['建案id', '名稱', '版本', '更新時間', '更新者', '資料']);
    ss.insertSheet('戶別').appendRow(['建案id', '戶別id', '戶別', '版本', '更新時間', '更新者', '資料']);
    DriveApp.getFileById(ss.getId()).moveTo(root);
    p.setProperty('SS_ID', ss.getId());
  }
  if (!p.getProperty('SECRET')) p.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('初始化完成，資料在雲端硬碟「驗屋系統」資料夾');
}

function sheet_(name) { return SpreadsheetApp.openById(props_().getProperty('SS_ID')).getSheetByName(name); }
function photoFolder_() { return DriveApp.getFolderById(props_().getProperty('FOLDER_ID')); }

// ── 入口 ─────────────────────────────────────
function doGet() { return ContentService.createTextOutput('驗屋系統後端運作中'); }
function doPost(e) {
  let out;
  try { out = handle_(JSON.parse(e.postData.contents)); }
  catch (err) { out = { ok: false, err: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

const PUBLIC_ = { hasUsers: hasUsers_, setupFirst: setupFirst_, login: login_ };
const USER_ = { me: me_, list: list_, saveUnit: saveUnit_, uploadPhoto: uploadPhoto_, getPhotos: getPhotos_, changePass: changePass_ };
const ADMIN_ = { saveProject: saveProject_, deleteProject: deleteProject_, listUsers: listUsers_, saveUser: saveUser_ };

function handle_(q) {
  if (!props_().getProperty('SS_ID')) 初始化();
  const a = q && q.action;
  if (PUBLIC_[a]) return Object.assign({ ok: true }, PUBLIC_[a](q));
  const user = auth_(q.token);
  if (!user) return { ok: false, auth: true, err: '請重新登入' };
  if (USER_[a]) return Object.assign({ ok: true }, USER_[a](q, user));
  if (ADMIN_[a]) {
    if (user.role !== 'admin') throw new Error('只有後台帳號能做這件事');
    return Object.assign({ ok: true }, ADMIN_[a](q, user));
  }
  throw new Error('不認得的動作：' + a);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ── 帳號 ─────────────────────────────────────
function users_() {
  const sh = sheet_('帳號'), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 7).getValues().map((r, i) => ({
    row: i + 2, user: String(r[0]).toLowerCase(), name: String(r[1]), role: r[2] === '後台' ? 'admin' : 'inspector',
    salt: String(r[3]), hash: String(r[4]), disabled: r[5] === '是' }));
}
const pub_ = u => ({ user: u.user, name: u.name, role: u.role, disabled: u.disabled });
function hash_(pass, salt) {
  let h = salt + '|' + pass;
  for (let i = 0; i < 300; i++) h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  return h;
}
function sign_(s) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, props_().getProperty('SECRET'))); }
function token_(u) {
  const payload = [u.user, Date.now() + TOKEN_DAYS * 864e5, u.hash.slice(0, 10)].join('|');
  return Utilities.base64EncodeWebSafe(payload, Utilities.Charset.UTF_8) + '.' + sign_(payload);
}
function auth_(token) {
  if (!token || typeof token !== 'string') return null;
  const [b, sig] = token.split('.');
  let payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(b)).getDataAsString('UTF-8'); } catch (e) { return null; }
  if (sign_(payload) !== sig) return null;
  const [user, exp, h] = payload.split('|');
  if (Date.now() > Number(exp)) return null;
  const u = users_().find(x => x.user === user);
  // 停用或改過密碼 → 舊的登入失效
  if (!u || u.disabled || u.hash.slice(0, 10) !== h) return null;
  return u;
}
const cleanUser_ = s => String(s || '').trim().toLowerCase();
function checkNewUser_(user, name, pass) {
  if (!/^[a-z0-9_.-]{2,30}$/.test(user)) throw new Error('帳號只能用英文、數字（2～30 字）');
  if (!String(name || '').trim()) throw new Error('請填姓名');
  if (pass != null && String(pass).length < 6) throw new Error('密碼至少 6 個字');
}
function addUser_(user, name, role, pass) {
  const salt = Utilities.getUuid();
  sheet_('帳號').appendRow([user, String(name).trim(), ROLES[role] || '驗屋人員', salt, hash_(String(pass), salt), '', now_()]);
}
function hasUsers_() { return { has: users_().length > 0 }; }
// 第一次使用：還沒有任何帳號時，建立第一個後台帳號
function setupFirst_(q) {
  return withLock_(() => {
    if (users_().length) throw new Error('已經有帳號了，請用帳號登入');
    const user = cleanUser_(q.user);
    checkNewUser_(user, q.name, q.pass);
    addUser_(user, q.name, 'admin', q.pass);
    return login_({ user, pass: q.pass });
  });
}
function login_(q) {
  const user = cleanUser_(q.user), cache = CacheService.getScriptCache(), ck = 'fail_' + user;
  const fails = Number(cache.get(ck) || 0);
  if (fails >= 8) throw new Error('密碼錯太多次，請 15 分鐘後再試');
  const u = users_().find(x => x.user === user);
  if (!u || u.hash !== hash_(String(q.pass || ''), u.salt)) {
    cache.put(ck, String(fails + 1), 900);
    throw new Error('帳號或密碼不對');
  }
  if (u.disabled) throw new Error('這個帳號已停用，請找後台人員');
  cache.remove(ck);
  return { token: token_(u), me: pub_(u) };
}
function me_(q, u) { return { me: pub_(u) }; }
function changePass_(q, u) {
  return withLock_(() => {
    if (u.hash !== hash_(String(q.old || ''), u.salt)) throw new Error('舊密碼不對');
    checkNewUser_(u.user, u.name, q.pass);
    const salt = Utilities.getUuid(), h = hash_(String(q.pass), salt);
    sheet_('帳號').getRange(u.row, 4, 1, 2).setValues([[salt, h]]);
    return login_({ user: u.user, pass: q.pass });
  });
}
function listUsers_() { return { users: users_().map(pub_) }; }
function saveUser_(q, me) {
  return withLock_(() => {
    const user = cleanUser_(q.user), all = users_(), u = all.find(x => x.user === user);
    const role = q.role === 'admin' ? 'admin' : 'inspector';
    if (q.isNew) {
      if (u) throw new Error('這個帳號已經有人用了');
      checkNewUser_(user, q.name, q.pass);
      addUser_(user, q.name, role, q.pass);
      return {};
    }
    if (!u) throw new Error('找不到帳號');
    if (u.user === me.user && (role !== 'admin' || q.disabled)) throw new Error('不能停用自己或拿掉自己的後台權限');
    checkNewUser_(user, q.name, q.pass || null);
    const sh = sheet_('帳號');
    sh.getRange(u.row, 2, 1, 2).setValues([[String(q.name).trim(), ROLES[role]]]);
    sh.getRange(u.row, 6).setValue(q.disabled ? '是' : '');
    if (q.pass) {
      const salt = Utilities.getUuid();
      sh.getRange(u.row, 4, 1, 2).setValues([[salt, hash_(String(q.pass), salt)]]);
    }
    return {};
  });
}

// ── 資料列（JSON 切塊存，前面加 ~ 避免被試算表當成數字或公式）──
function rows_(name) {
  const sh = sheet_(name), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues().map((r, i) => ({ row: i + 2, r }));
}
function readJson_(r, from) {
  let s = '';
  for (let i = from; i < r.length; i++) if (r[i] !== '') s += String(r[i]).slice(1);
  return s ? JSON.parse(s) : null;
}
function writeRow_(sh, row, head, obj) {
  const s = JSON.stringify(obj), parts = [];
  for (let i = 0; i < s.length; i += CHUNK) parts.push('~' + s.slice(i, i + CHUNK));
  const need = head.length + parts.length;
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  if (row > sh.getLastRow()) row = sh.getLastRow() + 1;
  else sh.getRange(row, 1, 1, sh.getMaxColumns()).clearContent();
  sh.getRange(row, 1, 1, need).setValues([head.concat(parts)]);
}
function deleteRows_(sh, rows) { rows.sort((a, b) => b - a).forEach(r => sh.deleteRow(r)); }

// ── 讀全部資料 ───────────────────────────────
function list_() {
  const projects = rows_('建案').map(({ r }) => Object.assign(readJson_(r, 5), { v: Number(r[2]) || 0, at: String(r[3]), by: String(r[4]) }));
  const units = rows_('戶別').map(({ r }) => ({ pid: String(r[0]), uid: String(r[1]), v: Number(r[3]) || 0, at: String(r[4]), by: String(r[5]), insp: readJson_(r, 6) }));
  return { projects, units };
}

// ── 建案結構（只有後台能改：樓層、戶別、屋型）────────
function saveProject_(q, u) {
  return withLock_(() => {
    const p = q.project;
    if (!p || !p.id || !p.name || !Array.isArray(p.floors)) throw new Error('建案資料不完整');
    const sh = sheet_('建案'), hit = rows_('建案').find(x => String(x.r[0]) === p.id);
    const oldV = hit ? Number(hit.r[2]) || 0 : 0;
    if ((q.baseV || 0) !== oldV) return { ok: false, conflict: true, err: `這個建案剛被 ${hit ? hit.r[4] : '別人'} 改過，已載入最新的，請再改一次` };
    const v = oldV + 1, data = Object.assign({}, p);
    delete data.v; delete data.at; delete data.by;
    data.floors = p.floors.map(f => ({ id: f.id, name: f.name, units: f.units.map(x => ({ id: x.id, name: x.name, layout: x.layout })) }));
    // 結構裡拿掉的戶別：只刪後台明確說要刪的（q.drop）；別人剛開始驗的戶不能被舊畫面誤刪
    const keep = {}, drop = {};
    data.floors.forEach(f => f.units.forEach(x => { keep[x.id] = 1; }));
    (q.drop || []).forEach(id => { drop[id] = 1; });
    const gone = rows_('戶別').filter(x => String(x.r[0]) === p.id && !keep[String(x.r[1])]);
    const stuck = gone.filter(x => !drop[String(x.r[1])]);
    if (stuck.length) return { ok: false, conflict: true, err: `${stuck.map(x => x.r[2]).join('、')} 已經有驗屋紀錄，不能刪；已載入最新資料，請再改一次` };
    writeRow_(sh, hit ? hit.row : 1e9, [p.id, p.name, v, now_(), u.name], data);
    dropUnits_(x => String(x.r[0]) === p.id && !keep[String(x.r[1])]);
    return { v };
  });
}
function deleteProject_(q) {
  return withLock_(() => {
    const sh = sheet_('建案');
    deleteRows_(sh, rows_('建案').filter(x => String(x.r[0]) === q.pid).map(x => x.row));
    dropUnits_(x => String(x.r[0]) === q.pid);
    return {};
  });
}
function dropUnits_(match) {
  const hits = rows_('戶別').filter(match);
  hits.forEach(x => { const I = readJson_(x.r, 6); if (I) trashPhotos_(photosOf_(I)); });
  deleteRows_(sheet_('戶別'), hits.map(x => x.row));
}

// ── 戶別驗屋紀錄 ───────────────────────────────
const photosOf_ = I => [].concat.apply([], (I.defs || []).map(d => d.photos || []));
function saveUnit_(q, u) {
  return withLock_(() => {
    if (!rows_('建案').some(x => String(x.r[0]) === q.pid)) return { ok: false, gone: true, err: '這個建案已被刪除' };
    const sh = sheet_('戶別'), hit = rows_('戶別').find(x => String(x.r[1]) === q.uid);
    const oldV = hit ? Number(hit.r[3]) || 0 : 0, old = hit ? readJson_(hit.r, 6) : null;
    if ((q.baseV || 0) !== oldV) return { ok: false, conflict: true, v: oldV, insp: old, err: `這一戶剛被 ${hit ? hit.r[5] : '別人'} 改過，已載入最新的` };
    const I = q.insp;
    if (u.role !== 'admin') checkInspector_(old, I);
    if (I && (!Array.isArray(I.defs) || !Array.isArray(I.locs) || !(I.round >= 1))) throw new Error('驗屋資料不完整');
    // 拿掉的照片丟垃圾桶（30 天內可從雲端硬碟救回）
    if (old) { const keep = {}; if (I) photosOf_(I).forEach(id => { keep[id] = 1; }); trashPhotos_(photosOf_(old).filter(id => !keep[id])); }
    if (!I) { if (hit) deleteRows_(sh, [hit.row]); return { v: 0 }; }
    const v = oldV + 1;
    writeRow_(sh, hit ? hit.row : 1e9, [q.pid, q.uid, String(q.label || ''), v, now_(), u.name], I);
    return { v };
  });
}
// 驗屋人員的限制：屋型／位置不能改；已完成階段不能取消；已完成階段的缺失只能標「已改善」
function canon_(o) {
  if (Array.isArray(o)) return '[' + o.map(canon_).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canon_(o[k])).join(',') + '}';
  return JSON.stringify(o === undefined ? null : o);
}
function checkInspector_(old, I) {
  const no = m => { throw new Error(m); };
  if (!I) no('只有後台帳號能清除驗屋紀錄');
  const d0 = (old && old.done) || {}, d1 = I.done || {};
  if (!old) {
    if (I.round !== 1 && I.round !== 2) no('驗屋階段不對');
    if ((I.defs || []).some(d => d.r !== I.round)) no('缺失的階段不對');
    return;
  }
  if (canon_(old.locs) !== canon_(I.locs) || !!old.common !== !!I.common) no('只有後台帳號能調整屋型與位置');
  if (I.round < old.round || I.round > old.round + 1) no('驗屋階段不對');
  if (I.round > old.round && !d0[old.round]) no('要先完成這一階段才能進下一階段');
  Object.keys(d0).forEach(k => { if (d1[k] !== d0[k]) no('已完成的階段只有後台帳號能取消'); });
  Object.keys(d1).forEach(k => { if (!d0[k] && Number(k) !== I.round) no('驗屋階段不對'); });
  const strip = d => { const c = Object.assign({}, d); delete c.fixed; return canon_(c); };
  const now = {}; (I.defs || []).forEach(d => { now[d.id] = d; });
  const was = {}; (old.defs || []).forEach(d => { was[d.id] = d; });
  (old.defs || []).forEach(d => {
    if (d0[d.r || 1] && (!now[d.id] || strip(now[d.id]) !== strip(d))) no('已完成階段的缺失只有後台帳號能修改');
  });
  (I.defs || []).forEach(d => {
    if (!was[d.id] && (d.r !== I.round || d0[I.round])) no('這個階段已完成，不能再加缺失');
  });
}

// ── 照片 ─────────────────────────────────────
const okId_ = id => /^[a-z0-9]{6,30}$/.test(String(id));
function findPhoto_(id) {
  const it = photoFolder_().getFilesByName(id + '.jpg');
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return null;
}
function uploadPhoto_(q) {
  if (!okId_(q.id)) throw new Error('照片編號不對');
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(q.data || ''));
  if (!m) throw new Error('照片格式不對');
  if (!findPhoto_(q.id)) photoFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(m[1]), 'image/jpeg', q.id + '.jpg'));
  return {};
}
function getPhotos_(q) {
  const out = {};
  (q.ids || []).slice(0, 10).filter(okId_).forEach(id => {
    const f = findPhoto_(id);
    if (f) out[id] = 'data:image/jpeg;base64,' + Utilities.base64Encode(f.getBlob().getBytes());
  });
  return { photos: out };
}
function trashPhotos_(ids) { ids.filter(okId_).forEach(id => { const f = findPhoto_(id); if (f) f.setTrashed(true); }); }

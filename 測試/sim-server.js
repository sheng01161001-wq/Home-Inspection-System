// 本機模擬後端：把 後端\Code.gs 放進假的 Apps Script 環境跑，給本機預覽測試用（不連 Google）。
// 執行：node 測試\sim-server.js   → http://localhost:8768/
// 前端開 http://localhost:8767/?api=http://localhost:8768/ 就會連到這裡。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), crypto = require('crypto');

function makeEnv() {
  const toBytes = s => Array.from(Buffer.from(s, 'utf8')).map(b => (b > 127 ? b - 256 : b));
  const toBuf = x => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map(b => b & 255)));
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
    computeHmacSha256Signature: (s, k) => Array.from(crypto.createHmac('sha256', k).update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
    base64Encode: x => toBuf(x).toString('base64'),
    base64EncodeWebSafe: x => toBuf(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: s => Array.from(Buffer.from(s, 'base64')).map(b => (b > 127 ? b - 256 : b)),
    base64DecodeWebSafe: s => { if (!/^[A-Za-z0-9_=-]*$/.test(s)) throw new Error('bad'); return Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).map(b => (b > 127 ? b - 256 : b)); },
    newBlob: (bytes, type, name) => ({ getBytes: () => bytes, getDataAsString: () => toBuf(bytes).toString('utf8'), name }),
    getUuid: () => crypto.randomUUID(),
    formatDate: d => d.toISOString().slice(0, 16).replace('T', ' '),
  };
  // 試算表
  const sheets = {};
  function makeSheet(name) {
    const rows = []; let maxCols = 26;
    const sh = {
      rows, setName(n) { delete sheets[name]; name = n; sheets[n] = sh; },
      appendRow(a) { rows.push(a.slice()); },
      getLastRow: () => rows.length,
      getLastColumn: () => Math.max(1, ...rows.map(r => { let k = r.length; while (k && (r[k - 1] === '' || r[k - 1] == null)) k--; return k; })),
      getMaxColumns: () => maxCols,
      insertColumnsAfter(c, n) { maxCols += n; },
      deleteRow(r) { rows.splice(r - 1, 1); },
      getRange(r, c, nr = 1, nc = 1) {
        return {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (rows[r - 1 + i] || [])[c - 1 + j]; return v == null ? '' : v; })),
          setValues(v) {
            if (c - 1 + nc > maxCols) throw new Error('超出欄數');
            v.forEach((row, i) => { if (row.length !== nc) throw new Error('欄數不符'); while (rows.length < r + i) rows.push([]); row.forEach((x, j) => { if (typeof x === 'string' && x.length > 50000) throw new Error('超過 5 萬字'); rows[r - 1 + i][c - 1 + j] = x; }); });
          },
          setValue(x) { this.setValues([[x]]); },
          clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (rows[r - 1 + i]) rows[r - 1 + i][c - 1 + j] = ''; },
        };
      },
    };
    sheets[name] = sh; return sh;
  }
  const ss = { getId: () => 'SS1', getUrl: () => 'sim://ss', getSheets: () => Object.values(sheets), insertSheet: n => makeSheet(n), getSheetByName: n => sheets[n] };
  const SpreadsheetApp = { create: () => { makeSheet('工作表1'); return ss; }, openById: () => ss };
  // 雲端硬碟
  const folders = {}, files = [];
  function makeFolder(name) {
    const id = 'F' + Object.keys(folders).length;
    const f = {
      getId: () => id, createFolder: n => makeFolder(n),
      createFile(blob) { const file = { id: 'f' + files.length, name: blob.name, bytes: blob.getBytes(), trashed: false, folder: id }; file.getBlob = () => ({ getBytes: () => file.bytes }); file.isTrashed = () => file.trashed; file.setTrashed = t => { file.trashed = t; }; files.push(file); return file; },
      getFilesByName(n) { const hit = files.filter(x => x.folder === id && x.name === n); let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; },
    };
    folders[id] = f; return f;
  }
  const DriveApp = { createFolder: makeFolder, getFolderById: id => folders[id], getFileById: () => ({ moveTo() {} }) };
  const store = {}, cache = {};
  const ctx = {
    Utilities, SpreadsheetApp, DriveApp, console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
    Logger: { log: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '後端', 'Code.gs'), 'utf8'), ctx);
  ctx._sheets = sheets; ctx._files = files;
  return ctx;
}
module.exports = { makeEnv };

if (require.main === module) {
  const env = makeEnv(), port = Number(process.argv[2]) || 8768;
  http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') { res.end('驗屋系統模擬後端'); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const out = env.doPost({ postData: { contents: body } });
      setTimeout(() => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(out.s); }, 150); // 模擬網路延遲
    });
  }).listen(port, () => console.log('模擬後端 http://localhost:' + port + '/'));
}

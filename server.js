#!/usr/bin/env node
'use strict';

/* EXIF Frame —— 本地服务
 *
 * 与 public/app.js 的调用约定一一对应：
 *   GET  /                 静态托管 public/（index.html + app.js + vendor/*）
 *   GET  /api/brands       扫 camera_brand_logo/ 得到品牌目录 → [{ file, name }]
 *   GET  /logo/:base.png   用 sharp 把同名 SVG 光栅化成 PNG，?h= 指定高度（默认 512）
 *   GET  /api/fonts        解析本机字体文件的 name 表 → { fonts: [{ family, zh, aliases }] }
 *   POST /api/shutdown     优雅关闭（终端里 Ctrl+C 亦可，SIGINT 走同一条路径）
 *
 * 前端在 file:// 下有完整的降级路径（内嵌 PNG + 内置字体候选清单），
 * 所以本服务不可用时页面仍能打开，只是拿不到「本机全部字体」。
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const sharp = require('sharp');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const LOGO_DIR = path.join(ROOT, 'camera_brand_logo');

const LOGO_MAX_H = 2048;   // ?h= 上限，防止一次请求把内存拉爆
const LOGO_DEFAULT_H = 512;

const app = express();

/* 品牌目录里只有 SVG；app.js 的 baseName() 也只剥 .svg 后缀，
   喂给它别的格式会算出 "foo.png.png" 这种取不到的 base，所以这里只认 .svg。 */
const BRAND_EXT = '.svg';

/* 与 app.js 的 BRAND_DISPLAY_NAMES 保持一致：同一份资产两边显示名必须相同，
   否则会出现「直开时叫 RICOH、连服务时叫 PENTAX」这种不一致。 */
const BRAND_DISPLAY_NAMES = {
  apple: 'Apple', canon: 'Canon', casio: 'Casio', fujifilm: 'FUJIFILM',
  hasselblad: 'Hasselblad', leica: 'Leica', nikon: 'Nikon',
  olympus: 'OLYMPUS', om: 'OM System', panasonic: 'Panasonic',
  pentax: 'RICOH', ricoh: 'RICOH', samsung: 'SAMSUNG', sony: 'Sony',
  huawei: 'HUAWEI', xiaomi: 'Xiaomi', oppo: 'OPPO', vivo: 'vivo',
  gopro: 'GoPro', dji: 'DJI', zebra: 'ZEBRA',
};

function displayNameOf(base) {
  return BRAND_DISPLAY_NAMES[base] || base.toUpperCase();
}

/* ---------------------------- 品牌目录 ---------------------------- */

app.get('/api/brands', async (req, res) => {
  try {
    const files = await fs.promises.readdir(LOGO_DIR);
    const brands = files
      .filter((f) => path.extname(f).toLowerCase() === BRAND_EXT)
      .map((f) => ({ file: f, name: displayNameOf(path.basename(f, path.extname(f))) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(brands);
  } catch (e) {
    console.error('[brands] 读取品牌目录失败:', e.message);
    res.status(500).json({ error: '读取品牌目录失败' });
  }
});

/* ------------------------- Logo 光栅化 ---------------------------- */

/* sharp 默认按 72dpi 渲染 SVG，此时 1 viewBox 单位 = 1px。
   想拿到目标高度，就按 目标高/原始高 放大 density，最后再 resize 兜一次精确尺寸。 */
function naturalHeight(svg) {
  const head = svg.subarray(0, 4096).toString('latin1');
  const h = head.match(/\bheight\s*=\s*"([\d.]+)/i);
  if (h && Number(h[1]) > 0) return Number(h[1]);
  const vb = head.match(/\bviewBox\s*=\s*"[\d.+-]+[\s,]+[\d.+-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb && Number(vb[2]) > 0) return Number(vb[2]);
  return 0;
}

/* 同一张 logo 在一次会话里会被反复请求（boot 时预载 + 每次重绘），
   光栅化不便宜，所以按 base:height 缓存住。 */
const logoCache = new Map();

async function renderLogoPng(file, targetH) {
  const key = `${path.basename(file, BRAND_EXT).toLowerCase()}:${targetH}`;
  const hit = logoCache.get(key);
  if (hit) return hit;

  const buf = await fs.promises.readFile(path.join(LOGO_DIR, file));
  const ext = path.extname(file).toLowerCase();

  let png;
  if (ext === BRAND_EXT) {
    const natural = naturalHeight(buf);
    const density = natural
      ? Math.min(1200, Math.max(1, Math.round((72 * targetH) / natural)))
      : 300;
    png = await sharp(buf, { density })
      .resize({ height: targetH, fit: 'inside' })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } else {
    // 目录里混进 PNG/JPG 时直接缩放，不用走 SVG 那条路
    png = await sharp(buf).resize({ height: targetH, fit: 'inside' }).png().toBuffer();
  }

  logoCache.set(key, png);
  return png;
}

app.get('/logo/:file', async (req, res) => {
  const raw = path.basename(String(req.params.file || ''));
  if (!/^[a-z0-9._-]+$/i.test(raw)) return res.status(400).end();

  const base = raw.replace(/\.png$/i, '');   // app.js 请求的是 "<base>.png"
  if (!base) return res.status(400).end();

  const hRaw = Number(req.query.h);
  const targetH = Number.isFinite(hRaw) && hRaw > 0
    ? Math.min(LOGO_MAX_H, Math.round(hRaw))
    : LOGO_DEFAULT_H;

  for (const ext of [BRAND_EXT, '.png', '.jpg', '.jpeg', '.webp']) {
    const candidate = base + ext;
    try {
      await fs.promises.access(path.join(LOGO_DIR, candidate));
    } catch (e) {
      continue;
    }
    try {
      const png = await renderLogoPng(candidate, targetH);
      res.set('Content-Type', 'image/png');
      // logo 是静态资产，长缓存；前端要在换图时用 ?v= 破缓存
      res.set('Cache-Control', 'public, max-age=86400');
      return res.end(png);
    } catch (e) {
      console.error(`[logo] ${candidate} 光栅化失败:`, e.message);
      return res.status(500).end();
    }
  }
  res.status(404).end();
});

/* --------------------------- 字体枚举 ----------------------------- */

/* app.js 要的是「Word / PS 里显示的那个族名」，所以 family 取 nameID 1 而不是 16：
   16 是排印学上的归并名（Segoe UI Light 会归成 "Segoe UI"），
   1 才是用户在 Word 里能选到的独立条目（"Segoe UI Light"），见 app.js 里那段注释。 */
/* 别名只收 nameID 1 的其它语言版本和 nameID 16。
   不收 nameID 4（Full name）：它是「族名+字重」的组合（arialbd.ttf 的 nameID 4 = "Arial Bold"），
   属于样式的名字而非族名，收了会把每个字重的全部语言变体灌进同一条目
   —— Arial 一条就能带出 60 个 "Arial Negreta / Arial tučné / Arial Полужирный"。 */
const NAME_IDS = { FAMILY: 1, TYPO_FAMILY: 16 };
const WANTED_NAME_IDS = new Set([NAME_IDS.FAMILY, NAME_IDS.TYPO_FAMILY]);
/* 中文语言码：简中优先，其次新加坡 / 繁中 / 港澳 */
const ZH_LANG_IDS = [0x0804, 0x1004, 0x0404, 0x0c04, 0x1404];

/* 必须用 FileHandle.read()：回调式 fs.read(fd, ...) 只接受数字 fd，
   传 FileHandle 会同步抛 ERR_INVALID_ARG_TYPE —— 一旦被吞掉，
   表现就是「扫到 255 个文件、解析出 0 个字体族」这种无声失败。 */
async function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/* name 表里的字符串按平台各自编码：Windows/Unicode 是 UTF-16BE，
   Mac 是各语言单字节编码。Mac 那部分只认纯 ASCII，
   否则 Shift-JIS 字节被当 latin1 解出来就是一堆乱码假名，反而污染别名表。 */
function decodeName(buf, platformID) {
  if (!buf.length) return '';
  if (platformID === 3 || platformID === 0) {
    const even = buf.subarray(0, buf.length - (buf.length % 2));
    const b = Buffer.from(even);
    b.swap16();
    return b.toString('utf16le').replace(/\0/g, '').trim();
  }
  if (platformID === 1) {
    const s = buf.toString('latin1').trim();
    return /^[\x20-\x7e]+$/.test(s) ? s : '';
  }
  return '';
}

/* 一个字体文件的 head 可能是 sfnt 本体，也可能是 ttc 集合（微软雅黑、宋体都是 ttc）。 */
async function collectFontEntries(fd) {
  const head = await readAt(fd, 0, 12);
  if (head.length < 12) return [];

  let offsets;
  if (head.readUInt32BE(0) === 0x74746366 /* 'ttcf' */) {
    const num = head.readUInt32BE(8);
    if (!num || num > 64) return [];
    const buf = await readAt(fd, 12, num * 4);
    offsets = [];
    for (let i = 0; i < num; i++) {
      if (buf.length >= i * 4 + 4) offsets.push(buf.readUInt32BE(i * 4));
    }
  } else {
    offsets = [0];
  }

  const out = [];
  for (const off of offsets) {
    const entry = await parseNameTable(fd, off).catch(() => null);
    if (entry) out.push(entry);
  }
  return out;
}

function pickName(records, ids, langID) {
  for (const id of ids) {
    const hit = records.find((r) => r.nameID === id && r.langID === langID);
    if (hit && hit.value) return hit.value;
  }
  return '';
}

async function parseNameTable(fd, off) {
  const hdr = await readAt(fd, off, 12);
  if (hdr.length < 12) return null;

  const tag = hdr.readUInt32BE(0);
  const isSfnt = tag === 0x00010000 || tag === 0x4f54544f /* OTTO */
    || tag === 0x74727565 /* true */ || tag === 0x74797031 /* typ1 */;
  if (!isSfnt) return null;

  const numTables = hdr.readUInt16BE(4);
  if (!numTables || numTables > 512) return null;

  const dir = await readAt(fd, off + 12, numTables * 16);
  let nameOff = -1;
  let nameLen = 0;
  for (let i = 0; i < numTables; i++) {
    const p = i * 16;
    if (dir.length < p + 16) break;
    if (dir.toString('latin1', p, p + 4) === 'name') {
      nameOff = dir.readUInt32BE(p + 8);
      nameLen = dir.readUInt32BE(p + 12);
      break;
    }
  }
  if (nameOff < 0 || !nameLen || nameLen > (1 << 20)) return null;

  const t = await readAt(fd, nameOff, nameLen);
  if (t.length < 6) return null;

  const count = t.readUInt16BE(2);
  const strBase = t.readUInt16BE(4);
  if (count > 4096) return null;

  const records = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    if (t.length < p + 12) break;

    const platformID = t.readUInt16BE(p);
    const langID = t.readUInt16BE(p + 4);
    const nameID = t.readUInt16BE(p + 6);
    if (!WANTED_NAME_IDS.has(nameID)) continue;

    const len = t.readUInt16BE(p + 8);
    const soff = t.readUInt16BE(p + 10);
    const start = strBase + soff;
    if (start + len > t.length) continue;

    const value = decodeName(t.subarray(start, start + len), platformID);
    if (value) records.push({ pc: platformID, langID, nameID, value });
  }
  if (!records.length) return null;

  // 英文族名：先找 en-US(0x409)，找不到就退到任意 Windows 记录，再退 Mac
  const win = records.filter((r) => r.pc === 3 || r.pc === 0);
  let family = pickName(win.length ? win : records, [NAME_IDS.FAMILY], 0x0409)
    || pickName(win.length ? win : records, [NAME_IDS.FAMILY], 0)
    || pickName(win.length ? win : records, [NAME_IDS.TYPO_FAMILY], 0x0409);
  if (!family) family = (records.find((r) => r.nameID === NAME_IDS.FAMILY)
    || records.find((r) => r.nameID === NAME_IDS.TYPO_FAMILY) || {}).value || '';
  if (!family) return null;
  // "@SimSun" 是竖排变体，不是用户能选的字体
  if (family.startsWith('@')) return null;

  let zh = '';
  for (const lang of ZH_LANG_IDS) {
    zh = pickName(records, [NAME_IDS.FAMILY], lang);
    if (zh) break;
  }

  const aliases = [];
  const seen = new Set([family.toLowerCase(), (zh || '').toLowerCase()]);
  for (const r of records) {
    if (r.nameID !== NAME_IDS.FAMILY && r.nameID !== NAME_IDS.TYPO_FAMILY) continue;
    const v = r.value.trim();
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    aliases.push(v);
  }

  return { family, zh, aliases };
}

/* 字体文件是「只读表头 + name 表」，没必要把 20MB 的 msyh.ttc 整个读进来，
   所以全程用 fd 定点读。 */
async function parseFontFile(filePath) {
  let fd;
  try {
    fd = await fs.promises.open(filePath, 'r');
  } catch (e) {
    return [];
  }
  try {
    return await collectFontEntries(fd);
  } catch (e) {
    return [];
  } finally {
    await fd.close().catch(() => {});
  }
}

const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc']);

function isFontFile(f) {
  return FONT_EXT.has(path.extname(f).toLowerCase());
}

/* 注册表里带的是「显示名 → 文件名」，比直接扫目录更全
   （能覆盖 %LOCALAPPDATA% 下的用户字体，且天然排除 .fon 点阵字体）。 */
function queryRegistry(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key], { windowsHide: true, maxBuffer: 1 << 22 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const out = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^\s{4}(.+?)\s{4,}REG_SZ\s{4,}(.+?)\s*$/);
        if (m) out.push(m[2]);
      }
      resolve(out);
    });
  });
}

async function walkFonts(dir, acc, depth) {
  if (depth > 4) return;
  let items;
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) await walkFonts(full, acc, depth + 1);
    else if (it.isFile() && isFontFile(it.name)) acc.push(full);
  }
}

async function collectFontFiles() {
  const files = new Set();

  if (process.platform === 'win32') {
    const windir = process.env.WINDIR || 'C:\\Windows';
    const fontsDir = path.join(windir, 'Fonts');
    const keys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    ];
    const names = (await Promise.all(keys.map(queryRegistry))).flat();
    for (const n of names) {
      const bare = String(n).trim();
      const full = path.isAbsolute(bare) ? bare : path.join(fontsDir, bare);
      if (isFontFile(full)) files.add(path.normalize(full));
    }
    // 注册表读不到（权限 / 非标准环境）时退回扫目录
    if (!files.size) {
      const acc = [];
      await walkFonts(fontsDir, acc, 0);
      for (const f of acc) files.add(f);
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const acc = [];
      await walkFonts(path.join(localAppData, 'Microsoft', 'Windows', 'Fonts'), acc, 0);
      for (const f of acc) files.add(f);
    }
  } else {
    // 非 Windows：扫常见字体目录（容器/CI 里也能跑）
    const acc = [];
    for (const d of ['/usr/share/fonts', '/usr/local/share/fonts', '/Library/Fonts', '/System/Library/Fonts']) {
      await walkFonts(d, acc, 0);
    }
    const home = process.env.HOME;
    if (home) await walkFonts(path.join(home, '.fonts'), acc, 0);
    for (const f of acc) files.add(f);
  }

  return [...files].slice(0, 2000);
}

/* 并发度别开太大：字体目录动辄几百个文件，一次全开容易撞 EMFILE。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

let fontsCache = null;
let fontsInflight = null;

async function enumerateFonts() {
  const files = await collectFontFiles();
  const parsed = await mapLimit(files, 8, parseFontFile);
  const failed = parsed.filter((p) => !p.length).length;

  const byFamily = new Map();
  for (const entry of parsed.flat()) {
    if (!entry || !entry.family) continue;
    const key = entry.family.toLowerCase();
    const hit = byFamily.get(key);
    if (!hit) {
      byFamily.set(key, { family: entry.family, zh: entry.zh || '', aliases: entry.aliases.slice() });
      continue;
    }
    // 同一族名的多个字重文件（arial.ttf / arialbd.ttf）合并成一条
    if (!hit.zh && entry.zh) hit.zh = entry.zh;
    const seen = new Set([hit.family.toLowerCase(), hit.zh.toLowerCase(), ...hit.aliases.map((a) => a.toLowerCase())]);
    for (const a of entry.aliases) {
      if (!seen.has(a.toLowerCase())) {
        seen.add(a.toLowerCase());
        hit.aliases.push(a);
      }
    }
  }

  const fonts = [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family));
  // 解析失败数单列出来：全 0 或大面积失败说明读取逻辑坏了，别让它静默过去
  console.log(`[fonts] 扫描 ${files.length} 个字体文件，解析出 ${fonts.length} 个字体族`
    + (failed ? `（${failed} 个文件未解析出字体）` : ''));
  return fonts;
}

app.get('/api/fonts', async (req, res) => {
  try {
    if (!fontsCache) {
      if (!fontsInflight) fontsInflight = enumerateFonts().finally(() => { fontsInflight = null; });
      fontsCache = await fontsInflight;
    }
    res.json({ fonts: fontsCache });
  } catch (e) {
    console.error('[fonts] 枚举字体失败:', e.message);
    // 拿不到就返回空表：前端会自动退回内置候选清单，页面照常可用
    res.json({ fonts: [] });
  }
});

/* ---------------------------- 启停 -------------------------------- */

app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n正在关闭服务（${reason}）...`);
  server.close(() => process.exit(0));
  // keep-alive 连接可能挂着不放手，兜一个强制退出
  setTimeout(() => process.exit(0), 1500).unref();
}

app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true });
  setTimeout(() => shutdown('收到关闭请求'), 150);   // 先把响应发出去，再断连接
});

const server = app.listen(PORT, () => {
  console.log(`EXIF Frame 已启动: http://localhost:${PORT}`);
  console.log('（首次打开会枚举本机字体，稍等几秒）');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[!] 端口 ${PORT} 已被占用。先关掉占用它的程序，或换端口启动：`);
    console.error(`    set PORT=3001 && node server.js`);
  } else {
    console.error('[!] 服务启动失败:', e.message);
  }
  process.exit(1);
});

process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('终止信号'));

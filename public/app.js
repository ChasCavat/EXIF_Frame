'use strict';

/* ============================== 工具 ============================== */

/* 未指定字体时的兜底字体栈（系统字体缺失的字形也回退到这里），不在列表中作为一个选项出现 */
const FONT_FALLBACK = '"Segoe UI", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmt(n, digits) {
  const r = Number(n.toFixed(digits));
  return String(r);
}

/* ============================== 状态 ============================== */

const state = {
  photo: null,          // HTMLImageElement
  fileName: '',
  exifBytes: null,      // ArrayBuffer 原始文件
  jpegExif: null,       // 源为 JPEG 时的完整 piexif 对象（用于原样保留 EXIF）
  exifObj: null,        // exifr 解析结果
  brands: [],           // [{ file, name, url }]
  logoCache: {},        // fileBase -> HTMLImageElement | null
  brandBase: '',        // 当前品牌（文件名 base，空 = 未选择）
  brandName: '',        // 当前品牌显示名
  template: 'a',
  logoMode: 'white',    // 深色模板下的图标着色：'white' 全白（默认）| 'original' 保持原色
  format: 'image/jpeg',
  /* 各字段是否画进水印。只影响绘制，不影响输入框里的值和写出的 EXIF ——
     「不显示型号」是排版选择，没理由把照片的 EXIF Model 一并抹掉。 */
  show: { brand: true, model: true, focal: true, aperture: true, shutter: true, iso: true, time: true },
  customBrands: [],        // 用户自添加品牌 [{ base, file, name, dataUrl }]
  fontId: '',              // 当前字体：'' = 未指定，'sys:<字体名>' 或 'custom:<内部族名>'
  fontName: '',            // 当前字体显示名
  fontStack: FONT_FALLBACK, // 当前字体栈（画布绘制用）
  systemFonts: [],         // 探测到的本机字体 [{ name, aliases, chain }]
  customFonts: [],         // 用户上传的字体 [{ name, internal, fileName, dataUrl }]
  fontsReady: false,       // 系统字体枚举是否已完成（决定提示文案）
  fontsFromServer: false,  // 字体清单是否来自本机服务（否则为内置候选清单）
  brandSearch: false,      // 品牌输入框是否处于「用户正在输入」状态
  fontSearch: false,       // 字体输入框是否处于「用户正在输入」状态
};

const CUSTOM_BRANDS_KEY = 'exifframe_custom_brands';

function saveCustomBrands() {
  try { localStorage.setItem(CUSTOM_BRANDS_KEY, JSON.stringify(state.customBrands)); } catch (e) { /* 存储不可用则仅本次会话有效 */ }
}

function loadCustomBrands() {
  try {
    const raw = localStorage.getItem(CUSTOM_BRANDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

/* ============================== 品牌机制 ============================== */

const BRAND_DISPLAY_NAMES = {
  apple: 'Apple', canon: 'Canon', casio: 'Casio', fujifilm: 'FUJIFILM',
  hasselblad: 'Hasselblad', leica: 'Leica', nikon: 'Nikon',
  olympus: 'OLYMPUS', om: 'OM System', panasonic: 'Panasonic',
  pentax: 'RICOH', ricoh: 'RICOH', samsung: 'SAMSUNG', sony: 'Sony',
  huawei: 'HUAWEI', xiaomi: 'Xiaomi', oppo: 'OPPO', vivo: 'vivo',
  gopro: 'GoPro', dji: 'DJI', zebra: 'ZEBRA'
};

const MAKE_ALIASES = {
  'NIKON CORPORATION': 'nikon', 'NIKON': 'nikon',
  'FUJIFILM': 'fujifilm',
  'Canon': 'canon', 'CANON': 'canon', 'Canon Inc.': 'canon',
  'SONY': 'sony', 'Sony': 'sony', 'Sony Corporation': 'sony',
  'Panasonic': 'panasonic', 'Panasonic Corporation': 'panasonic',
  'CASIO': 'casio', 'CASIO COMPUTER CO.,LTD.': 'casio',
  'HASSELBLAD': 'hasselblad', 'Hasselblad': 'hasselblad',
  'LEICA CAMERA AG': 'leica', 'LEICA': 'leica', 'LEICA CAMERA': 'leica',
  'RICOH': 'ricoh', 'RICOH IMAGING COMPANY, LTD.': 'ricoh',
  'PENTAX': 'pentax', 'PENTAX Corporation': 'pentax',
  'Apple': 'apple', 'Apple Inc.': 'apple',
  /* DJI 的机身（Mavic / Air / Mini / Osmo / Pocket）EXIF Make 基本都是 "DJI"。
     只写这一条就够：下面的子串匹配会兜住 "SZ DJI TECHNOLOGY CO., LTD." 之类的长写法。 */
  'DJI': 'dji',
  'Google': 'google', 'SAMSUNG': 'samsung', 'HUAWEI': 'huawei', 'XIAOMI': 'xiaomi'
};

function baseName(file) { return file.replace(/\.svg$/i, '').toLowerCase(); }
function displayNameOf(base) { return BRAND_DISPLAY_NAMES[base] || base.toUpperCase(); }

/* 直开页面（file://）时的品牌目录，走 brands-data.js 里的内嵌 PNG。
   联网/本地服务模式下这份不用 —— 那时品牌列表由 /api/brands 扫 camera_brand_logo/ 得到。
   两边都得有 dji，缺了任一份都会出现「服务下能选、直开时列表里没有」。 */
const BUILTIN_BRANDS = [
  'canon', 'casio', 'dji', 'fujifilm', 'hasselblad', 'leica', 'nikon', 'panasonic', 'sony'
].map((base) => ({ file: base + '.svg', name: displayNameOf(base) }));

function isFileProtocol() { return typeof location !== 'undefined' && location.protocol === 'file:'; }

function logoSrc(b) {
  const base = baseName(b.file);
  if (isFileProtocol()) {
    const d = (typeof window !== 'undefined' && window.BRAND_DATA && window.BRAND_DATA[base]) || '';
    if (d) return d;
    return '../camera_brand_logo/' + encodeURIComponent(b.file);
  }
  return `/logo/${encodeURIComponent(base)}.png?h=512`;
}

function brandFromMake(make) {
  if (!make) return null;
  const key = String(make).trim();
  const alias = MAKE_ALIASES[key] || MAKE_ALIASES[key.toUpperCase()];
  if (alias) return alias;
  for (const [k, v] of Object.entries(MAKE_ALIASES)) {
    if (key.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return null;
}

function loadLogoImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function brandLogoSrc(b) {
  if (b.dataUrl) return b.dataUrl;
  return logoSrc(b);
}

async function preloadBrandLogos() {
  const jobs = state.brands.map((b) =>
    loadLogoImage(brandLogoSrc(b)).then((img) => {
      state.logoCache[baseName(b.file)] = img;
    })
  );
  await Promise.all(jobs);
  renderBrandInput();
}

function renderBrandInput() {
  $('brandInput').value = state.brandName;
  renderBrandIcon();
}

/* 选中的品牌在输入框里带一个 Logo（下拉里显示的是同一张图，两处观感一致）。
   Logo 是异步加载的：preloadOneLogo 加载完会回调 renderBrandInput，所以这里拿不到图
   就先不显示，下一帧自然补上；加载失败的条目在 logoCache 里是 null，同样落到「不显示」这一支。
   只有真正匹配到某个品牌（brandBase 有值）才显示 —— 自由输入的文字不伪造图标，
   updateBrandFromText 已经把那种情况归为 brandBase = ''。 */
function renderBrandIcon() {
  const img = state.brandBase ? state.logoCache[state.brandBase] : null;
  const el = $('brandIcon');
  const ok = !!(img && img.src);
  if (ok) {
    if (el.getAttribute('src') !== img.src) el.src = img.src;
  } else {
    el.removeAttribute('src');
  }
  $('brandCombo').classList.toggle('has-icon', ok);
}

function matchBrand(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return '';
  for (const b of state.brands) {
    const base = baseName(b.file);
    if (base === t) return base;
    if (String(b.name).toLowerCase() === t) return base;
  }
  return '';
}

function updateBrandFromText(text) {
  const base = matchBrand(text);
  if (base) {
    state.brandBase = base;
    state.brandName = displayNameOf(base);
  } else {
    state.brandBase = '';
    state.brandName = String(text || '').trim();
  }
  render();
}

/* 输入框平时显示的是「当前选中项」，只有用户真的在打字时才拿它当过滤词。
   否则打开下拉会被缩成只剩当前这一条（列表里其他字体全被滤掉）。 */
function menuFilter(inputEl, searching) {
  if (!searching) return '';
  return ($(inputEl).value || '').trim().toLowerCase();
}

function renderBrandMenu() {
  const menu = $('brandMenu');
  const filter = menuFilter('brandInput', state.brandSearch);
  menu.innerHTML = state.brands
    .filter((b) => !filter || baseName(b.file).indexOf(filter) >= 0 || b.name.toLowerCase().indexOf(filter) >= 0)
    .map((b) => {
      const base = baseName(b.file);
      const img = state.logoCache[base];
      const selected = base === state.brandBase ? ' selected' : '';
      const thumb = img
        ? `<span class="brand-thumb"><img src="${img.src}" alt=""></span>`
        : `<span class="brand-thumb"><span class="brand-thumb-fallback">${b.name.slice(0, 6)}</span></span>`;
      const remove = b.dataUrl ? `<button class="brand-remove" data-remove="${base}" type="button" title="移除该品牌">×</button>` : '';
      return `<li data-brand="${base}" class="${selected}">${thumb}<span>${b.name}</span>${remove}</li>`;
    }).join('') || '<li class="empty">未找到匹配的品牌</li>';
  menu.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      state.brandBase = li.dataset.brand;
      state.brandName = displayNameOf(li.dataset.brand);
      renderBrandInput();
      closeBrandMenu();
      render();
    });
  });
  menu.querySelectorAll('.brand-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeCustomBrand(btn.dataset.remove);
    });
  });
}

function openBrandMenu() {
  renderBrandMenu();
  const sel = $('brandSelect');
  sel.classList.add('open');
  placeSelectMenu(sel, $('brandInput'));
  revealSelected($('brandMenu'));
}
function closeBrandMenu() { $('brandSelect').classList.remove('open'); }

/* ---------- 自添加品牌 ---------- */

function fixLogoDataMime(result, fileName) {
  if (typeof result !== 'string' || !result.startsWith('data:')) return result;
  const ext = (String(fileName || '').split('.').pop() || '').toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml'
    : ext === 'webp' ? 'image/webp'
    : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : 'image/png';
  return result.replace(/^data:[^;,]*/, `data:${mime}`);
}

function readLogoDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fixLogoDataMime(fr.result, file.name));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function uniqueBrandBase(name) {
  let base = String(name || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'brand';
  const existing = new Set(state.brands.map((b) => baseName(b.file)));
  let i = 1;
  while (existing.has(base)) base = base + (i++);
  return base;
}

function addCustomBrand(name, dataUrl) {
  const base = uniqueBrandBase(name);
  const entry = { base, file: base + '.svg', name, dataUrl };
  state.customBrands.push(entry);
  state.brands.push(entry);
  saveCustomBrands();
  loadLogoImage(dataUrl).then((img) => {
    state.logoCache[base] = img;
    renderBrandMenu();
  });
  state.brandBase = base;
  state.brandName = name;
  renderBrandInput();
  renderBrandMenu();
  render();
}

function removeCustomBrand(base) {
  state.customBrands = state.customBrands.filter((b) => baseName(b.file) !== base);
  state.brands = state.brands.filter((b) => baseName(b.file) !== base);
  delete state.logoCache[base];
  saveCustomBrands();
  if (state.brandBase === base) {
    state.brandBase = '';
    state.brandName = '';
    renderBrandInput();
  }
  renderBrandMenu();
  render();
}

/* ============================== 字体机制 ============================== */

/* 直接用本机已安装的字体：canvas / CSS 的 font-family 本来就支持系统字体，
   唯一缺的是「浏览器不提供字体列表」，所以下面靠探测 + 可选 API 拿到候选清单。
   用户上传的字体文件则走 FontFace 注册进 document.fonts，同样能被 canvas 用上。 */

const CUSTOM_FONT_ID_PREFIX = 'custom:';   // 字体列表里自定义字体的 id 前缀
const CUSTOM_FONT_FACE_PREFIX = 'EXIFCustom-'; // 内部族名前缀，避免与系统字体重名

function cssQuote(name) { return '"' + String(name).replace(/["\\]/g, '') + '"'; }

/* 常见系统字体候选（仅在未连服务时兜底）；带 aliases 的写法用于给出中文显示名与别名搜索。
   有 aliases 写法的字体不要再在裸字符串里写一遍，否则会出现同名两条。 */
const SYSTEM_FONT_CANDIDATES = [
  /* --- Windows 自带 --- */
  'Arial', 'Arial Black', 'Arial Narrow', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara',
  'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima',
  'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Gill Sans MT', 'Impact',
  'Ink Free', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic',
  'Meiryo', 'Microsoft Sans Serif', 'MS Gothic',
  'MS PGothic', 'MS UI Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype',
  'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Symbol',
  /* Segoe UI 的各个字重在 Word 里是独立条目，这里也得单列 */
  'Segoe UI Light', 'Segoe UI Semilight', 'Segoe UI Semibold', 'Segoe UI Black',
  'Sitka Text', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  'Yu Gothic', 'Yu Mincho',
  { name: 'Microsoft YaHei', aliases: ['微软雅黑'] },
  { name: 'Microsoft YaHei Light', aliases: ['微软雅黑 Light'] },
  { name: 'Microsoft JhengHei', aliases: ['微软正黑体'] },
  { name: 'SimSun', aliases: ['宋体'] },
  { name: 'NSimSun', aliases: ['新宋体'] },
  { name: 'SimHei', aliases: ['黑体'] },
  { name: 'KaiTi', aliases: ['楷体'] },
  { name: 'FangSong', aliases: ['仿宋'] },
  { name: 'DengXian', aliases: ['等线'] },
  { name: 'DengXian Light', aliases: ['等线 Light'] },
  { name: 'YouYuan', aliases: ['幼圆'] },
  { name: 'LiSu', aliases: ['隶书'] },
  { name: 'STXihei', aliases: ['华文细黑'] },
  { name: 'STKaiti', aliases: ['华文楷体'] },
  { name: 'STZhongsong', aliases: ['华文中宋'] },
  { name: 'STFangsong', aliases: ['华文仿宋'] },
  { name: 'FZShuTi', aliases: ['方正舒体'] },
  { name: 'FZYaoti', aliases: ['方正姚体'] },
  /* --- macOS 自带 --- */
  'American Typewriter', 'Andale Mono', 'Apple Chancery', 'Avenir', 'Avenir Next',
  'Baskerville', 'Chalkboard', 'Cochin', 'Copperplate', 'Didot', 'Futura', 'Geneva',
  'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Herculanum', 'Hiragino Sans',
  'Hoefler Text', 'Lucida Grande', 'Luminari', 'Marker Felt', 'Menlo', 'Monaco',
  'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Skia', 'Snell Roundhand',
  { name: 'PingFang SC', aliases: ['苹方', '苹方-简'] },
  { name: 'Songti SC', aliases: ['宋体-简'] },
  { name: 'Heiti SC', aliases: ['黑体-简'] },
  { name: 'Kaiti SC', aliases: ['楷体-简'] },
  { name: 'Yuanti SC', aliases: ['圆体-简'] },
  { name: 'Hiragino Sans GB', aliases: ['冬青黑体'] },
  /* --- Linux 常见 --- */
  'Cantarell', 'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'FreeSans', 'FreeSerif',
  'Liberation Mono', 'Liberation Sans', 'Liberation Serif', 'Nimbus Sans', 'Noto Sans',
  'Noto Sans Mono', 'Noto Serif', 'Ubuntu', 'Ubuntu Mono',
  'WenQuanYi Micro Hei', 'AR PL UMing CN', 'AR PL UKai CN',
  /* --- 常见第三方 / 思源系列 --- */
  'Noto Sans SC', 'Noto Serif SC',
  'Noto Sans CJK SC', 'Noto Serif CJK SC', 'Alibaba PuHuiTi',
  { name: 'Source Han Sans SC', aliases: ['思源黑体'] },
  { name: 'Source Han Serif SC', aliases: ['思源宋体'] },
  { name: 'HarmonyOS Sans SC', aliases: ['鸿蒙字体'] },
];

function normalizeFont(c) {
  return typeof c === 'string' ? { name: c, aliases: [] } : { name: c.name, aliases: c.aliases || [] };
}

/* 逐字符宽度比对：同一串文字在 "<字体名>, monospace" 与 "monospace" 下宽度不同，
   即说明浏览器认得这个字体族名（字体已安装）。用来校验服务端给出的族名。 */
function browserFontProbe() {
  const ctx = document.createElement('canvas').getContext('2d');
  const probe = 'mmmwwliiMW@#';
  const generics = ['monospace', 'sans-serif', 'serif'];
  const base = generics.map((g) => {
    ctx.font = `72px ${g}`;
    return ctx.measureText(probe).width;
  });
  return (name) => {
    if (!name) return false;
    const q = cssQuote(name);
    return generics.some((g, i) => {
      ctx.font = `72px ${q}, ${g}`;
      return ctx.measureText(probe).width !== base[i];
    });
  };
}

/* 一个字体族可能有多个名字（英文名 + 本地化名），全部串进字体栈，
   浏览器按顺序取第一个认得的，这样不依赖任何探测结果也能正确渲染 */
function stackOf(chain) {
  const seen = new Set();
  const out = [];
  for (const raw of chain) {
    const k = String(raw || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(raw);
  }
  return out.map(cssQuote).join(', ') + ', ' + FONT_FALLBACK;
}

function allFonts() {
  return state.customFonts.map((f) => ({
    id: CUSTOM_FONT_ID_PREFIX + f.internal,
    name: f.name,
    group: '自定义',
    aliases: [],
    stack: stackOf([f.internal]),
  })).concat(state.systemFonts.map((f) => ({
    id: 'sys:' + f.name,
    name: f.name,
    group: '系统字体',
    aliases: f.aliases,
    stack: stackOf([f.name].concat(f.chain || [])),
  })));
}

/* 画布绘制时取当前字体栈；系统字体缺失的字形自动回退到 FONT_FALLBACK */
function fontStack() { return state.fontStack; }

/* 回到「未指定字体」状态（列表里没有这一项，用兜底字体栈绘制） */
function clearFont() {
  state.fontId = '';
  state.fontName = '';
  state.fontStack = FONT_FALLBACK;
  renderFontInput();
  renderFontMenu();
  render();
}

function selectFont(id) {
  const hit = allFonts().find((f) => f.id === id);
  if (!hit) { clearFont(); return; }
  state.fontId = hit.id;
  state.fontName = hit.name;
  state.fontStack = hit.stack;
  renderFontInput();
  renderFontMenu();
  render();
}

function renderFontInput() { $('fontInput').value = state.fontName; }

function renderFontMenu() {
  const menu = $('fontMenu');
  const filter = menuFilter('fontInput', state.fontSearch);
  const list = allFonts().filter((f) => {
    if (!filter) return true;
    return (f.name + ' ' + f.aliases.join(' ')).toLowerCase().indexOf(filter) >= 0;
  });
  let lastGroup = null;
  menu.innerHTML = list.map((f) => {
    let head = '';
    if (!filter && f.group !== lastGroup) {
      head = `<li class="group-title">${esc(f.group)}</li>`;
      lastGroup = f.group;
    }
    const thumb = `<span class="font-preview" style="font-family:${esc(f.stack)}">Aa</span>`;
    const remove = f.id.startsWith(CUSTOM_FONT_ID_PREFIX)
      ? `<button class="brand-remove" data-remove="${esc(f.id)}" type="button" title="移除该字体">×</button>`
      : '';
    return `${head}<li data-font="${esc(f.id)}" class="${f.id === state.fontId ? 'selected' : ''}">${thumb}<span>${esc(f.name)}</span>${remove}</li>`;
  }).join('') || `<li class="empty">${state.fontsReady ? '未找到匹配的字体' : '正在枚举本机字体…'}</li>`;
  menu.querySelectorAll('li[data-font]').forEach((li) => {
    li.addEventListener('click', () => {
      selectFont(li.dataset.font);
      closeFontMenu();
    });
  });
  menu.querySelectorAll('.brand-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeCustomFont(btn.dataset.remove.slice(CUSTOM_FONT_ID_PREFIX.length));
    });
  });
}

/* 由本地服务端枚举系统已安装字体（解析字体文件 name 表拿真实族名） */
async function fetchServerFonts() {
  if (isFileProtocol()) return [];
  try {
    const res = await fetch('/api/fonts');
    if (!res.ok) return [];
    const data = await res.json();
    return (data && data.fonts) || [];
  } catch (e) {
    return [];
  }
}

/* 中文字体的字体表里同时有英文名（SimSun）和本地化名（宋体），Word / PS 给用户看的是中文名。
   优先显示中文名——否则用户按「宋体」根本找不到，会以为字体没装。
   允许带样式后缀（"等线 Light" 在 Word 里就是独立条目），只排除日文名（含假名，如 游ゴシック）。 */
function isChineseName(s) {
  /* 一-鿿 中日韩统一表意文字；぀-ヿ 平假名/片假名 */
  return /[一-鿿]/.test(s) && !/[぀-ヿ]/.test(s);
}

/* 汇总系统字体：服务端清单为准，未连服务时退回内置候选清单的探测结果。
   探针只用来在几个名字里挑一个浏览器认得的当显示名，渲染不依赖它。 */
async function buildSystemFonts() {
  const serverList = await fetchServerFonts();
  const resolves = browserFontProbe();

  const entries = [];
  const seen = new Set();
  const add = (name, names) => {
    const key = String(name || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    entries.push({
      name,
      aliases: names.filter((n) => n && n.toLowerCase() !== key),
      chain: names,
    });
  };

  if (serverList.length) {
    /* 服务端已经按 nameID 成对给出英文名与中文名，直接用；探测只用来确认浏览器认得中文名 */
    for (const f of serverList) {
      if (!f || !f.family) continue;
      const names = [f.zh, f.family].concat(f.aliases || []).filter(Boolean);
      add(f.zh && resolves(f.zh) ? f.zh : f.family, names);
    }
  }

  /* 服务端清单已经覆盖的字体不再补一遍：内置清单里的中文名是硬编码的，未必等于字体
     自报的本地化名（Microsoft JhengHei 自报「微軟正黑體」，内置写的是「微软正黑体」），
     补进去只会多出一条同字体、不同显示的项。内置清单只用来兜住服务端没枚举到的字体。 */
  const covered = new Set();
  for (const e of entries) for (const n of e.chain) covered.add(String(n).toLowerCase());

  for (const raw of SYSTEM_FONT_CANDIDATES) {
    const f = normalizeFont(raw);
    if (!resolves(f.name)) continue;
    const zh = f.aliases.find(isChineseName);   // 内置清单里中文名就写在 aliases 里
    const names = [zh, f.name].concat(f.aliases).filter(Boolean);
    if (names.some((n) => covered.has(String(n).toLowerCase()))) continue;
    add(zh || f.name, names);
  }

  return { fonts: entries.sort((a, b) => a.name.localeCompare(b.name)), fromServer: serverList.length };
}

/* ---------- 自定义字体（上传字体文件） ---------- */

const CUSTOM_FONTS_KEY = 'exifframe_custom_fonts';
const customFaces = new Map(); // internal 族名 -> 已注册的 FontFace（移除时要注销）

function saveCustomFonts() {
  try {
    localStorage.setItem(CUSTOM_FONTS_KEY, JSON.stringify(state.customFonts));
    return true;
  } catch (e) {
    return false; // 字体文件体积大时容易超出 localStorage 配额，此时仅本次会话有效
  }
}

function loadCustomFonts() {
  try {
    const raw = localStorage.getItem(CUSTOM_FONTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function fontMimeFor(fileName) {
  const ext = (String(fileName || '').split('.').pop() || '').toLowerCase();
  if (ext === 'otf' || ext === 'otc') return 'font/otf';
  if (ext === 'woff') return 'font/woff';
  if (ext === 'woff2') return 'font/woff2';
  if (ext === 'ttc') return 'font/collection';
  return 'font/ttf';
}

function readFontDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^;,]*/, `data:${fontMimeFor(file.name)}`));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

/* 读 TTF/OTF/TTC 的 name 表拿真实字体族名（与 server.js 同一套解析思路，这里走 DataView）。
   WOFF/WOFF2 是压缩容器，字体表不可直接读，返回空串由调用方退回文件名。 */
function fontFamilyFromBuffer(buf) {
  const dv = new DataView(buf);
  const tagAt = (o) => String.fromCharCode(
    dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (buf.byteLength < 12) return '';
  let base = 0;
  const head = tagAt(0);
  if (head === 'ttcf') base = dv.getUint32(12);                       // 字体集合取第一个字体
  else if (head !== '\x00\x01\x00\x00' && head !== 'OTTO' && head !== 'true') return '';
  if (base + 12 > buf.byteLength) return '';

  const numTables = dv.getUint16(base + 4);
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > buf.byteLength) break;
    if (tagAt(rec) !== 'name') continue;
    const off = dv.getUint32(rec + 8);
    const len = dv.getUint32(rec + 12);
    if (!len || len > 4 * 1024 * 1024 || off + len > buf.byteLength) return '';
    return familyFromNameTable(dv, off, len);
  }
  return '';
}

/* nameID 16 = 排版字体族（不含样式后缀），优先；退回 nameID 1 */
function familyFromNameTable(dv, start, len) {
  if (len < 6) return '';
  const count = dv.getUint16(start + 2);
  const storage = start + dv.getUint16(start + 4);
  const end = start + len;
  const found = { 1: [], 16: [] };
  for (let i = 0; i < count; i++) {
    const rec = start + 6 + i * 12;
    if (rec + 12 > end) break;
    const platformID = dv.getUint16(rec);
    const encodingID = dv.getUint16(rec + 2);
    const languageID = dv.getUint16(rec + 4);
    const nameID = dv.getUint16(rec + 6);
    if (nameID !== 1 && nameID !== 16) continue;
    const slen = dv.getUint16(rec + 8);
    const s = storage + dv.getUint16(rec + 10);
    if (s + slen > end) continue;
    let str = '';
    if (platformID === 3) {                                    // Windows：UTF-16BE
      for (let k = 0; k + 1 < slen; k += 2) str += String.fromCharCode(dv.getUint16(s + k));
    } else if (platformID === 1 && encodingID === 0) {         // Mac Roman
      for (let k = 0; k < slen; k++) str += String.fromCharCode(dv.getUint8(s + k));
    }
    str = str.replace(/\0/g, '').trim();
    if (str) found[nameID].push({ platformID, languageID, str });
  }
  const pick = (list) => {
    if (!list.length) return '';
    const hit = list.find((n) => n.platformID === 3 && n.languageID === 0x0409)   // 英文
      || list.find((n) => n.platformID === 3 && (n.languageID & 0x3ff) === 0x09) // 任意英文变体
      || list.find((n) => n.platformID === 3)
      || list[0];
    return hit.str;
  };
  return pick(found[16]) || pick(found[1]);
}

async function guessFontFamily(file) {
  if (!/\.(ttf|otf|ttc|otc)$/i.test(file.name)) return '';
  try {
    return fontFamilyFromBuffer(await file.arrayBuffer());
  } catch (e) {
    return '';
  }
}

function uniqueFontSlug(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'font';
  const used = new Set(state.customFonts.map((f) => f.internal));
  let internal = CUSTOM_FONT_FACE_PREFIX + slug;
  let i = 1;
  while (used.has(internal)) internal = CUSTOM_FONT_FACE_PREFIX + slug + (i++);
  return internal;
}

function registerCustomFont(entry) {
  const face = new FontFace(entry.internal, `url("${entry.dataUrl}")`);
  return face.load().then((loaded) => {
    const prev = customFaces.get(entry.internal);
    document.fonts.add(loaded);
    if (prev) document.fonts.delete(prev);  // 同名重加时注销旧 face，避免预览仍用旧字形
    customFaces.set(entry.internal, loaded);
  });
}

async function addCustomFont(name, dataUrl, fileName) {
  const entry = { name, internal: uniqueFontSlug(name), fileName, dataUrl };
  try {
    await registerCustomFont(entry);
  } catch (e) {
    toast('该字体文件无法解析，请换用 TTF / OTF / WOFF 格式');
    return false;
  }
  state.customFonts.push(entry);
  selectFont(CUSTOM_FONT_ID_PREFIX + entry.internal);
  if (saveCustomFonts()) toast(`已添加字体「${name}」`);
  else toast(`已添加字体「${name}」（文件较大，刷新后需重新添加）`);
  updateFontHint();
  return true;
}

function removeCustomFont(internal) {
  state.customFonts = state.customFonts.filter((f) => f.internal !== internal);
  const face = customFaces.get(internal);
  if (face) {
    try { document.fonts.delete(face); } catch (e) { /* 注销失败不影响列表 */ }
    customFaces.delete(internal);
  }
  saveCustomFonts();
  if (state.fontId === CUSTOM_FONT_ID_PREFIX + internal) clearFont();
  else { renderFontMenu(); render(); }
  updateFontHint();
}

/* 启动时恢复上次上传的字体；单个字体损坏就跳过，不影响其余 */
async function restoreCustomFonts() {
  state.customFonts = [];
  for (const f of loadCustomFonts()) {
    if (!f || !f.internal || !f.dataUrl || !f.name) continue;
    try {
      await registerCustomFont(f);
      state.customFonts.push(f);
    } catch (e) { /* 跳过损坏的字体 */ }
  }
  updateFontHint();
}

/* 枚举完成前保留「正在枚举…」文案，避免过早报出 0 个字体 */
function updateFontHint() {
  if (!state.fontsReady) return;
  const custom = state.customFonts.length ? `，另有 ${state.customFonts.length} 个自定义字体` : '';
  $('fontHint').textContent = state.fontsFromServer
    ? `已枚举本机 ${state.systemFonts.length} 个已安装字体${custom}，可直接选择`
    : `当前是直接打开网页文件的方式，只列出内置的 ${state.systemFonts.length} 个常见字体；`
      + `在项目目录执行 npm start 后用 http://localhost:3000 打开可读取本机全部字体${custom}`;
}

/* 字体列表上百条，选中项常在滚动区外，打开时把它滚进可视范围 */
/* 只滚菜单自己，不用 scrollIntoView：菜单在 DOM 上仍是面板的后代，
   scrollIntoView 会连带把面板也滚了 —— 而面板一滚我们就得收起 fixed 定位的菜单
   （见 init 里的面板 scroll 监听），等于刚打开就自己关掉。 */
function revealSelected(menuEl) {
  const sel = menuEl.querySelector('li.selected');
  if (!sel) return;
  menuEl.scrollTop = Math.max(0, sel.offsetTop - (menuEl.clientHeight - sel.offsetHeight) / 2);
}

const MENU_GAP = 6;

/* CSS 的 max-height 只是「希望值」，一旦被 placeSelectMenu 写上行内样式就读不回来了，
   所以在第一次覆盖前把它记在 dataset 上。 */
function menuMaxCap(menuEl) {
  if (!menuEl.dataset.maxCap) {
    menuEl.dataset.maxCap = String(parseFloat(getComputedStyle(menuEl).maxHeight) || 300);
  }
  return parseFloat(menuEl.dataset.maxCap);
}

/* 下拉是 fixed 定位（面板会滚动，绝对定位的下拉会被裁剪），所以坐标得在这里
   按输入框的视口位置算出来，再夹进视口：下方放不下就翻到上方，两边都不够时取大的那边。 */
function placeSelectMenu(selectEl, anchorEl) {
  const menuEl = selectEl.querySelector('.select-menu');
  if (!menuEl) return;
  const box = anchorEl.getBoundingClientRect();
  const below = window.innerHeight - box.bottom - MENU_GAP * 2;
  const above = box.top - MENU_GAP * 2;
  const dropUp = below < 200 && above > below;
  /* 不给下限：宁可菜单矮一点，也不能让 maxHeight 比可用空间还大 —— 那会把菜单顶出视口。
     输入框本身可见，所以 avail 实际不会小于几十像素。 */
  const avail = Math.max(dropUp ? above : below, 0);

  menuEl.style.width = box.width + 'px';
  menuEl.style.left = box.left + 'px';
  menuEl.style.maxHeight = Math.min(avail, menuMaxCap(menuEl)) + 'px';
  menuEl.style.top = dropUp ? 'auto' : (box.bottom + MENU_GAP) + 'px';
  menuEl.style.bottom = dropUp ? (window.innerHeight - box.top + MENU_GAP) + 'px' : 'auto';
}

function openFontMenu() {
  renderFontMenu();
  const sel = $('fontSelect');
  sel.classList.add('open');
  placeSelectMenu(sel, $('fontInput'));
  revealSelected($('fontMenu'));
}
function closeFontMenu() { $('fontSelect').classList.remove('open'); }

/* ============================== 参数格式化（方案五） ============================== */

function formatFocal(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const n = parseFloat(s);
  if (isNaN(n)) return s;
  return `${fmt(n, 2)}mm`;
}

function formatAperture(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const cleaned = s.replace(/^f\//i, '');
  const n = parseFloat(cleaned);
  if (isNaN(n)) return s;
  return `f/${fmt(n, 1)}`;
}

function shutterSeconds(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function formatShutter(v) {
  const secs = shutterSeconds(v);
  if (secs === null) return String(v == null ? '' : v).trim();
  if (secs >= 1) return `${fmt(secs, 2)}s`;
  const denom = Math.round(1 / secs);
  return `1/${denom}s`;
}

function formatISO(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return /^iso/i.test(s) ? s.toUpperCase() : `ISO${s}`;
}

function formatTimeFromExif(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}`;
  }
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (m) {
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    return m[4] ? `${date} ${m[4]}:${m[5]}` : date;
  }
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]} ${m2[4]}:${m2[5]}`;
  return s;
}

/* ============================== EXIF 解析与填充 ============================== */

async function parseExif(file) {
  try {
    return await exifr.parse(file, {
      reviveValues: false,
      pick: [
        'Make', 'Model', 'LensModel', 'FocalLength', 'FNumber', 'ExposureTime',
        'ISO', 'PhotographicSensitivity', 'ISOSpeedRatings', 'DateTimeOriginal'
      ]
    });
  } catch (e) {
    return null;
  }
}

function getExifString(exif, key) {
  const v = exif && exif[key];
  if (v == null || v === '') return '';
  return String(v);
}

function isJpeg(file) {
  return /\.jpe?g$/i.test(file.name) || file.type === 'image/jpeg';
}

function fillFormFromExif() {
  const exif = state.exifObj;
  const used = [];
  if (exif) {
    const make = getExifString(exif, 'Make');
    if (make) {
      const mapped = brandFromMake(make);
      if (mapped) {
        state.brandBase = mapped;
        state.brandName = displayNameOf(mapped);
        if (state.brandBase && state.logoCache[state.brandBase] === undefined) {
          preloadOneLogo(state.brandBase);
        }
        used.push('相机品牌');
      }
    }
    const model = getExifString(exif, 'Model');
    if (model) { $('inpModel').value = model; used.push('型号'); }

    const focal = exif && exif.FocalLength != null ? exif.FocalLength : '';
    if (focal !== '') { $('inpFocal').value = String(focal); used.push('焦距'); }

    const aperture = exif && exif.FNumber != null ? exif.FNumber : '';
    if (aperture !== '') { $('inpAperture').value = String(aperture); used.push('光圈'); }

    const shutter = exif && exif.ExposureTime != null ? exif.ExposureTime : '';
    if (shutter !== '') { $('inpShutter').value = String(shutter); used.push('快门'); }

    const iso = (exif && exif.ISO != null) ? exif.ISO
      : (exif && exif.PhotographicSensitivity != null) ? exif.PhotographicSensitivity
      : (exif && exif.ISOSpeedRatings != null ? exif.ISOSpeedRatings : '');
    if (iso !== '') { $('inpIso').value = String(iso); used.push('ISO'); }

    const dt = getExifString(exif, 'DateTimeOriginal');
    if (dt) { $('inpTime').value = formatTimeFromExif(dt); used.push('拍摄时间'); }
  }

  renderBrandInput();
  renderBrandMenu();

  if (used.length) {
    setStatus(`已从 EXIF 自动填充：${used.join('、')}。字段可继续手动修改。`);
  } else {
    setStatus('未检测到可用的 EXIF 信息，可手动填写后渲染。');
  }
}

async function preloadOneLogo(base) {
  const b = state.brands.find((x) => baseName(x.file) === base);
  if (!b) return;
  const img = await loadLogoImage(brandLogoSrc(b));
  state.logoCache[base] = img;
  renderBrandInput();
  render();
}

/* ============================== 绘制 ============================== */

function currentFields() {
  return {
    model: $('inpModel').value.trim(),
    time: $('inpTime').value.trim(),
    focal: formatFocal($('inpFocal').value),
    aperture: formatAperture($('inpAperture').value),
    shutter: formatShutter($('inpShutter').value),
    iso: formatISO($('inpIso').value),
  };
}

/* 关掉的字段一律置空 —— 下游的 hasModel / hasTime / currentParams 本来就把空串
   当作「没有这项」，所以只要在这里抹掉，两套模板的排版、居中和宽度分配会自动跟着让位，
   不需要在绘制处再加判断。 */
function applyShowFlags(f) {
  const s = state.show;
  const out = {};
  for (const key of Object.keys(f)) out[key] = s[key] === false ? '' : f[key];
  return out;
}

function currentParams(f) {
  const arr = [];
  for (const key of ['focal', 'aperture', 'shutter', 'iso']) {
    if (f[key]) arr.push(f[key]);
  }
  return arr;
}

function measure(ctx, text, font) {
  ctx.font = font;
  return ctx.measureText(text).width;
}

function font(weight, px) {
  return `${weight || 400} ${px}px ${fontStack()}`;
}

function pxOf(fnt) {
  const m = String(fnt).match(/([\d.]+)px/);
  return m ? parseFloat(m[1]) : 10;
}

/* 字形「基线以上」的高度。取 ascent 而不是 ascent+descent：
   降部（g/y/p，以及参数行里必有的斜杠）只在部分字符串里出现，
   算进盒高的话，行高与居中位置就会随文本内容漂移。 */
function textAscent(ctx, text, fnt) {
  ctx.font = fnt;
  const m = ctx.measureText(text);
  if (m && typeof m.actualBoundingBoxAscent === 'number') return m.actualBoundingBoxAscent;
  return pxOf(fnt) * 0.72;
}

function textGlyphHeight(ctx, text, fnt) {
  return textAscent(ctx, text, fnt);
}

/* 把字形带（基线以上）的中心对到 y。降部自然向下探出，
   这是视觉居中的常规做法 —— 图标的外框中心与文字的光学中心才对得上。
   与 textGlyphHeight 同源，所以「盒高的一半 == 这里的偏移」。 */
function drawTextCentered(ctx, text, x, y, fnt, align) {
  ctx.font = fnt;
  const m = ctx.measureText(text);
  const off = (m && typeof m.actualBoundingBoxAscent === 'number')
    ? m.actualBoundingBoxAscent / 2
    : pxOf(fnt) * 0.36;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = align;
  ctx.fillText(text, x, y + off);
}

function logoForBrand(base) {
  if (!base) return null;
  return state.logoCache[base] || null;
}

/* 品牌也受「显示」开关控制，而且它比文本字段多一层：品牌不是 currentFields() 里的
   文本字段，所以 applyShowFlags 那套空串语义盖不到它 —— Logo 图与品牌名是两条独立的
   路径，都得在这里堵掉。两套模板的测量段都从这里取，绘制段只读 measure 出来的结果。 */
function visibleBrand() {
  if (state.show.brand === false) return { img: null, name: '' };
  return { img: logoForBrand(state.brandBase), name: state.brandName || '' };
}

/* 图片可能是 <img>（naturalWidth）或 canvas（width） */
function imageW(img) { return img.naturalWidth || img.width || 0; }
function imageH(img) { return img.naturalHeight || img.height || 1; }
function logoAspect(img) { return imageW(img) / imageH(img); }

function drawLogo(ctx, img, x, y, h, align) {
  const w = h * logoAspect(img);
  const drawX = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.drawImage(img, drawX, y - h / 2, w, h);
  return { w, h };
}

/* ---------- 深色模板下的 Logo 可见性 ---------- */

/* 模板 B 的字幕文字是纯白，但内置 Logo 是品牌彩色的。压在 #181715 上时
   sony / hasselblad / fujifilm（纯黑）完全看不见，casio 藏青、canon 暗红也糊成一团。
   所以默认染成白色剪影 —— 和字幕同色，图形轮廓还在。

   代价要说清楚：leica 是红底白字、nikon 是黄底黑字，染白后会糊成一个纯白圆 /
   纯白方块，字反而没了。曾经试过按 Logo 亮度自动判断（亮色 Logo 保原色），
   但那套判据对用户不可见、结果又时对时不对，已按需求去掉；现在交给用户自己选。
   模板 A 是白底，品牌色本来就清楚，不经过这里。 */
const whiteLogoCache = new WeakMap();

/* source-in 把图形整体压成纯白，alpha 原样保留 —— 只换颜色，轮廓不变 */
function whiteLogo(img) {
  if (whiteLogoCache.has(img)) return whiteLogoCache.get(img);
  const w = imageW(img), h = imageH(img);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0, w, h);
  cx.globalCompositeOperation = 'source-in';
  cx.fillStyle = '#FFFFFF';
  cx.fillRect(0, 0, w, h);
  whiteLogoCache.set(img, c);
  return c;
}

/* 深色底下的取图。渲染与提示文案都走这一个函数，两者不会说法不一。
   默认 'white'：深色底上白字才看得见，而内置 Logo 里偏暗的是多数。 */
function logoForDarkBg(img) {
  if (!img) return null;
  return state.logoMode === 'original' ? img : whiteLogo(img);
}

/* ---------- 自动适配：内容装不下时整体等比缩小 ---------- */

/* fit 与 p、与照片像素尺寸都无关：内容高与可用高都 ∝ bandH，比值里 bandH 全约掉。
   FIT_MIN 现在纯粹是安全网：两个模板的 AVAIL 都只当溢出护栏用，留白由 A_CONTENT /
   B_CONTENT 给，所以正常滑块范围内 fit 基本停在 1.000，实测最坏也只有 ~0.90
   （模板 B 的「大 Logo + 最大字号」角落）。 */
const FIT_MIN = 0.50;
function fitScale(contentH, availH) {
  if (!(contentH > 0) || !(availH > 0)) return 1;   // 空内容 → 不缩放，防 0/0 = NaN
  return Math.min(1, Math.max(availH / contentH, FIT_MIN));
}

/* 先按 fit=1 量一次拿到内容高，定出 fit 后再量一次定稿。
   内容高严格正比于 fit（字号与 Logo 都乘同一个 fit），所以收敛极快 */
function fitMetrics(measureFn, availH) {
  let fit = 1;
  let m = measureFn(fit);
  for (let i = 0; i < 3; i++) {
    const next = fitScale(m.contentH, availH);
    if (next >= fit) break;
    fit = next;
    m = measureFn(fit);
  }
  return { fit, m };
}

/* ---------- 模板 A：经典（底部白条） ---------- */

const PAD_A = 0.08;                    // 抖动余量：内容超过 AVAIL_A 才触发 fit
const AVAIL_A = 1 - PAD_A * 2;

/* 内容占水印区的比例。留白与内容大小直接互斥 —— 水印区高固定时，想让上下留白变宽，
   只能把内容整体收小。0.78 把上下留白从 16.7% 提到 24%（band 60px 时 10px → 14.4px）。

   刻意不去调小 AVAIL_A 来达到同样效果：AVAIL_A 一压，k=100% 的 fit 就直接吃满，
   「字体大小」滑块在 100%→150% 之间将完全不动。保持 AVAIL_A=0.84 则滑块全程有效
   （contentH 要到 cfg.k≈1.61 才追上 AVAIL_A，而滑块上限是 1.5）。 */
const A_CONTENT = 0.78;

/* 测量与绘制共用：绘制段只读这里返回的字号，不再自己算 font()。
   fit 是唯一变量，其余全部由 bandH 派生。 */
function measureA(ctx, W, bandH, cfg, f, fit) {
  const k = cfg.k * fit * A_CONTENT;
  const modelPx = bandH * 0.40 * k;
  const timePx = bandH * 0.26 * k;
  const modelFont = font(700, modelPx);
  const timeFont = font(400, timePx);

  const hasModel = !!f.model;
  const hasTime = !!f.time;
  const modelH = hasModel ? textGlyphHeight(ctx, f.model, modelFont) : 0;
  const timeH = hasTime ? textGlyphHeight(ctx, f.time, timeFont) : 0;
  const lineGap = (hasModel && hasTime) ? Math.max(modelPx, timePx) * 0.5 : 0;
  const contentH = modelH + lineGap + timeH;

  let leftW = 0;
  if (hasModel) leftW = Math.max(leftW, measure(ctx, f.model, modelFont));
  if (hasTime) leftW = Math.max(leftW, measure(ctx, f.time, timeFont));

  const margin = bandH * 0.35;
  const brand = visibleBrand();
  const logoImg = brand.img;
  /* Logo 不乘 A_CONTENT：那个系数是给「文字内容」留白用的，Logo 是图形，
     本来就不在 contentH 里，跟着文字一起收没道理。模板 B 同样处理（见 measureB），
     两个模板都是 bandH * cfg.q * fit —— 默认 35% 就是边框高的 35%。
     高度只跟 bandH、滑块和整体缩放走，不跟竖线绑定 —— 换任何图标都是同一个比例。 */
  const logoH = bandH * cfg.q * fit;
  const brandFont = font(600, bandH * 0.30 * k);
  const logoW = logoImg ? logoH * logoAspect(logoImg)
    : brand.name ? measure(ctx, brand.name, brandFont) : 0;

  return {
    modelFont, timeFont, modelH, timeH, lineGap, contentH, leftW,
    logoImg, logoH, logoW, brandFont, brandText: brand.name, margin, hasModel, hasTime,
    sepGap: bandH * 0.25,
    sepH: bandH * 0.5,
    /* 线宽必须跟 bandH 一起缩放。整条水印的尺寸全由 bandH 派生，唯独这里原本写死 1：
       在 6000px 的导出图上只有 1/6000 宽，预览画布又被 CSS 缩到不足一个设备像素，
       看起来就「太淡」。系数调到 0.012 配 #BFBFBF：写死 1 + #E0E0E0 太淡、
       0.02 + #9A9A9A 太抢眼，这里取两者中间。嫌重就降系数或把颜色改浅。 */
    sepW: Math.max(1, Math.round(bandH * 0.012)),
    paramsFont: font(500, bandH * 0.34 * k),
  };
}

function drawTemplateA(ctx, W, imgW, imgH, cfg, f) {
  const H = imgH;
  const bandH = H * cfg.p;             // 水印区高 = 白条高（占照片高的 p）
  const totalH = H + bandH;
  ctx.canvas.width = W;
  ctx.canvas.height = totalH;

  ctx.clearRect(0, 0, W, totalH);
  ctx.drawImage(state.photo, 0, 0, W, H);

  const barY = H;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, barY, W, bandH);

  const m = fitMetrics((fit) => measureA(ctx, W, bandH, cfg, f, fit), bandH * AVAIL_A).m;
  const centerY = barY + bandH / 2;

  /* ---- 左：型号 + 时间（两行，整体垂直居中） ---- */
  const blockTop = centerY - m.contentH / 2;
  if (m.hasModel) {
    ctx.fillStyle = '#1A1A1A';
    drawTextCentered(ctx, f.model, m.margin, blockTop + m.modelH / 2, m.modelFont, 'left');
  }
  if (m.hasTime) {
    ctx.fillStyle = '#9A9A9A';
    drawTextCentered(ctx, f.time, m.margin, blockTop + m.modelH + m.lineGap + m.timeH / 2, m.timeFont, 'left');
  }

  /* ---- 右：Logo + 分隔线 + 参数（与左侧共用 centerY） ---- */
  const paramsArr = currentParams(f);
  const paramsFont = m.paramsFont;
  const rightX = W - m.margin;
  const gapBetween = bandH * 0.5;
  const availRight = rightX - (m.leftW > 0 ? m.margin + m.leftW + gapBetween : m.margin);
  let availParams = Math.max(availRight - (m.logoW > 0 ? m.logoW + m.sepGap * 2 + m.sepW : 0), 0);

  let shown = paramsArr.slice();
  while (shown.length > 1 && measure(ctx, shown.join('\u2003'), paramsFont) > Math.max(availParams, 0)) {
    shown.pop();
  }
  let paramsText = shown.join('\u2003');
  const paramsW0 = paramsText ? measure(ctx, paramsText, paramsFont) : 0;
  if (paramsW0 > availParams) {
    paramsText = ellipsis(ctx, paramsText, Math.max(availParams, 0), paramsFont);
  }
  const paramsW = paramsText ? measure(ctx, paramsText, paramsFont) : 0;

  if (paramsText) {
    ctx.fillStyle = '#1A1A1A';
    drawTextCentered(ctx, paramsText, rightX, centerY, paramsFont, 'right');
  }

  if (m.logoW > 0) {
    const sepX = rightX - paramsW - m.sepGap - m.sepW;
    // 介于原来的 #E0E0E0（太白看不见）和 #9A9A9A（过重）之间的中性灰
    ctx.fillStyle = '#BFBFBF';
    ctx.fillRect(sepX, centerY - m.sepH / 2, m.sepW, m.sepH);
    const logoRight = sepX - m.sepGap;
    if (m.logoImg) {
      drawLogo(ctx, m.logoImg, logoRight, centerY, m.logoH, 'right');
    } else {
      ctx.fillStyle = '#1A1A1A';
      drawTextCentered(ctx, m.brandText, logoRight, centerY, m.brandFont, 'right');
    }
  }
  return totalH;
}

/* ---------- 模板 B：模糊（深色氛围） ---------- */

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* 水印区内的空余空间按 上:下 = 0.20 : 0.24 分配（下面略多，字才不像贴在上沿）。
   注意这两个数只是「怎么分空余」，不等于实际留白 —— 实际留白取决于内容占多高。 */
const SLACK_TOP_B = 0.20;
const SLACK_BOTTOM_B = 0.24;

/* 溢出护栏：内容最多占水印区的 80%。和模板 A 的 AVAIL_A 同性质，只管「别溢出」，
   留白不靠它给。之前把留白直接写进 AVAIL_B（压到 0.56）是错的 —— 那等于逼 fit
   在 k=100% 就吃满，cfg.k 从 1.0 拉到 1.5 时 eff(=k*fit) 只从 0.88 动到 0.88，
   滑块上三分之一完全无效。 */
const AVAIL_B = 0.80;

/* 内容基础占比，作用同模板 A 的 A_CONTENT：想留白宽就得把内容整体收小。
   0.75 让 k=100%、q=35% 时文字内容占 0.58 bandH（解析估算），上下留白 ~20% / ~23%。
   注意：现在第一行的高度由「型号文字」定（图标缩到与文字等高，见 measureB），
   所以加载进 contentH 的第一行不再是过去的 bandH * q，而是文字高度 ——
   q 拉大时它会跟着涨（line1H = 文字高 * max(q / 默认q, 1)），护栏 AVAIL_B 仍兜得住。
   如果发现「大 Logo 时文字被压得比预期狠」，优先调这里的 0.75，而不是动 logoH。 */
const B_CONTENT = 0.75;

/* 第一行（品牌 + 型号）相对第二行（参数）的字号倍数。第一行是同级的两个元素并排，
   小一号会显得像附注，所以比第二行大。只作用于第一行，两者共用 line1Font，
   改这里品牌名与型号同时生效 —— 这是「等高」的前提，别为了单独放大某一方而拆开。
   图标也锚在这个字号上（见 measureB），所以调大它，图标跟着一起大，两者始终等高。
   上限约束是 AVAIL_B：q 拉到 60% 时 contentH 已接近 0.80，再往上会开始触发 fit 压缩。 */
const B_LINE1_BOOST = 1.35;

/* 测量与绘制共用（同 measureA）。水印区 = 照片以下那条区域，高 bandH = H * p。
   fit 是唯一变量，其余全部由 bandH 派生。 */
function measureB(ctx, W, bandH, cfg, f, fit) {
  const sf = fit * B_CONTENT;
  const k = cfg.k * sf;
  const line1Px = bandH * 0.34 * k * B_LINE1_BOOST;
  const line2Px = bandH * 0.30 * k;
  const line1Font = font(600, line1Px);
  const line2Font = font(500, line2Px);

  /* 第 1 行 = 图标位（Logo 图 或 品牌名）+ 型号 */
  const brand = visibleBrand();
  const logoImg = brand.img;
  const logoGap = bandH * 0.12 * sf;
  const leadIsLogo = !!logoImg;
  const leadText = leadIsLogo ? '' : brand.name;

  const modelText = f.model;
  /* 等高的基准 = 型号文字的字形高。先量它，图标再依据它定高，所以这两行顺序不能换。
     没有型号可量（隐藏了或为空）时退回大写 H 的高度：图标仍有约束，
     不会退化成「没人管它」而重新变得比文字大。 */
  const line1RefH = textGlyphHeight(ctx, modelText || 'H', line1Font);

  /* 图标高 = 型号文字高 * (q / 滑块默认值)：默认 35% 时两者严格等高，
     往上拖图标变大、往下拖变小 —— 滑块在 B 里仍然有效，只是基准从「边框高的百分比」
     换成了「文字高度的倍数」。不能用模板 A 的 bandH * cfg.q * fit：第一行是两个元素
     并排，绝对高度会让图标压过文字，那正是这里要修的问题。
     fit 隐含在 line1RefH 里（字号 = f(fit)），所以溢出护栏仍然作用于这个高度。 */
  const logoH = leadIsLogo ? line1RefH * (cfg.q / BRAND_SIZE_DEFAULT) : 0;

  const leadW = leadIsLogo ? logoH * logoAspect(logoImg)
    : leadText ? measure(ctx, leadText, line1Font) : 0;
  /* 行高按「实际画出来的东西」取：有 Logo 就按 Logo 高，否则才是品牌名的字形高 */
  const leadH = leadIsLogo ? logoH
    : leadText ? textGlyphHeight(ctx, leadText, line1Font) : 0;

  const modelW = modelText ? measure(ctx, modelText, line1Font) : 0;
  /* 复用上面量好的基准值，不再重算：图标高度算的就是它，重算一次等于给自己埋
     一个「同一次测量里两个值不同源」的坑（换字体 / 换型号字符串时结果会漂）。 */
  const modelH = modelText ? line1RefH : 0;
  const gap1 = (leadW > 0 && modelW > 0) ? logoGap : 0;

  const line1W = leadW + gap1 + modelW;
  const line1H = Math.max(leadH, modelH);
  const drawLine1 = line1W > 0;

  /* 第 2 行的行高按全部参数取：行高与后面截断剩几个参数无关 */
  const paramsArr = currentParams(f);
  const line2H = paramsArr.length
    ? textGlyphHeight(ctx, paramsArr.join('\u2003'), line2Font) : 0;
  const drawLine2 = paramsArr.length > 0;

  const lineGap = (drawLine1 && drawLine2) ? Math.max(line1Px, line2Px) * 0.5 : 0;
  const contentH = line1H + lineGap + line2H;

  return {
    line1Font, line2Font, line1W, line1H, leadIsLogo, leadText, leadW,
    logoImg, logoH, gap1, modelText, modelW, drawLine1,
    line2H, drawLine2, lineGap, contentH, paramsArr,
  };
}

function drawTemplateB(ctx, W, imgW, imgH, cfg, f) {
  const H = imgH;
  const bandH = H * cfg.p;             // 水印区高（占照片高的 p）
  /* 边框是「加」在原图外面的：原图 1:1 不缩放，画布向四周长出 frame。
     之前是把原图缩到 W-2*frame 塞进画布，导出时原图被降采样 5%。 */
  const frame = W * 0.025;
  const photoW = W;                    // 原图宽，1:1
  const photoH = imgH;                 // 原图高，1:1
  const photoX = frame;
  const photoY = frame;
  const canvasW = W + frame * 2;
  const bandTop = photoY + photoH;
  /* 下沿留白不小于左右边框，否则极宽幅照片下水印区会比边框还窄 */
  const bottomH = Math.max(bandH, frame);
  const totalH = bandTop + bottomH;

  const m = fitMetrics((fit) => measureB(ctx, W, bandH, cfg, f, fit), bandH * AVAIL_B).m;

  const line1Font = m.line1Font;
  const line2Font = m.line2Font;
  const modelText = m.modelText;

  const paramsArr = m.paramsArr;
  const paramsMaxW = photoW;
  let shown = paramsArr.slice();
  while (shown.length > 1 && measure(ctx, shown.join('\u2003'), line2Font) > paramsMaxW) {
    shown.pop();
  }
  let paramsText = shown.join('\u2003');
  if (paramsText && measure(ctx, paramsText, line2Font) > paramsMaxW) {
    paramsText = ellipsis(ctx, paramsText, paramsMaxW, line2Font);
  }
  ctx.canvas.width = canvasW;
  ctx.canvas.height = totalH;

  /* 背景：等比放大铺满 + 高斯模糊 + 压暗 */
  const bgScale = Math.max(canvasW / imgW, totalH / imgH);
  const bgW = imgW * bgScale;
  const bgH = imgH * bgScale;
  const bgX = (canvasW - bgW) / 2;
  const bgY = (totalH - bgH) / 2;
  const blur = Math.min(canvasW, totalH) * 0.03;
  ctx.filter = `blur(${blur}px) brightness(0.4)`;
  ctx.drawImage(state.photo, bgX, bgY, bgW, bgH);
  ctx.filter = 'none';

  /* 主体照片：圆角（跟着边距一起收，圆角不能大于留白） */
  const radius = W * 0.008;
  ctx.save();
  roundedRectPath(ctx, photoX, photoY, photoW, photoH, radius);
  ctx.clip();
  ctx.drawImage(state.photo, photoX, photoY, photoW, photoH);
  ctx.restore();

  /* 内容在水印区内摆位：空余空间按 SLACK_TOP_B : SLACK_BOTTOM_B 分配。
     内容越多留白越少 —— 拉大字号是先吃留白，吃到 AVAIL_B 才轮到 fit 介入。 */
  const slack = Math.max(bottomH - m.contentH, 0);
  const contentTop = bandTop + slack * (SLACK_TOP_B / (SLACK_TOP_B + SLACK_BOTTOM_B));
  const line1Center = contentTop + m.line1H / 2;
  const line2Center = contentTop + m.line1H + m.lineGap + m.line2H / 2;

  let cursor = canvasW / 2 - m.line1W / 2;
  if (m.drawLine1) {
    if (m.leadIsLogo) {
      drawLogo(ctx, logoForDarkBg(m.logoImg), cursor, line1Center, m.logoH, 'left');
      cursor += m.leadW;
    } else if (m.leadText) {
      ctx.fillStyle = '#FFFFFF';
      drawTextCentered(ctx, m.leadText, cursor, line1Center, line1Font, 'left');
      cursor += m.leadW;
    }
    if (modelText) {
      cursor += m.gap1;
      ctx.fillStyle = '#FFFFFF';
      drawTextCentered(ctx, modelText, cursor, line1Center, line1Font, 'left');
    }
  }

  if (paramsText) {
    ctx.fillStyle = '#FFFFFF';
    drawTextCentered(ctx, paramsText, canvasW / 2, line2Center, line2Font, 'center');
  }
  return totalH;
}

/* \u6309\u7801\u70b9\u5207\uff0c\u907f\u514d\u622a\u65ad\u70b9\u843d\u5728 UTF-16 \u4ee3\u7406\u5bf9\u4e2d\u95f4\u4ea7\u751f\u534a\u4e2a\u5b57\u7b26\uff08\u8c46\u8150\u5757\uff09\u3002
   BMP \u6587\u672c\uff08EXIF \u53c2\u6570\u884c\u3001\u578b\u53f7\u540d\uff09\u884c\u4e3a\u4e0e\u6309 code unit \u5207\u5b8c\u5168\u4e00\u81f4\u3002 */
function ellipsis(ctx, text, maxW, fnt) {
  if (maxW <= 0) return '';
  ctx.font = fnt;
  if (measure(ctx, text, fnt) <= maxW) return text;
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(ctx, chars.slice(0, mid).join('') + '\u2026', fnt) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('') + '\u2026';
}

function draw(ctx, W) {
  const imgW = state.photo.naturalWidth;
  const imgH = state.photo.naturalHeight;
  const scale = W / imgW;
  const cfg = {
    p: parseInt($('rngHeight').value, 10) / 100,
    q: parseInt($('rngBrandSize').value, 10) / 100,
    k: parseInt($('rngFontSize').value, 10) / 100,
  };
  const f = applyShowFlags(currentFields());
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const scaledW = W;
  const scaledH = imgH * scale;
  if (state.template === 'a') return drawTemplateA(ctx, scaledW, scaledW, scaledH, cfg, f);
  return drawTemplateB(ctx, scaledW, scaledW, scaledH, cfg, f);
}

/* ============================== 预览渲染 ============================== */

const canvas = $('previewCanvas');
const PREVIEW_MAX = 1600;
let renderTimer = null;

function render() {
  /* 放在 photo 守卫之前：没上传照片也能选品牌，提示文案和输入框里的 Logo 那时就该是准的。
     图标放这一处就够了 —— state.brandBase 的每条变更路径最后都会走到 render()。 */
  syncLogoInkUI();
  renderBrandIcon();
  if (!state.photo) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const scale = Math.min(1, PREVIEW_MAX / state.photo.naturalWidth);
    draw(canvas.getContext('2d'), Math.round(state.photo.naturalWidth * scale));
  }, 16);
}

/* ============================== 上传 ============================== */

function photoUrlFromFile(file) {
  return new Promise((resolve, reject) => {
    if (isFileProtocol()) {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    } else {
      resolve(URL.createObjectURL(file));
    }
  });
}

async function loadPhoto(file) {
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|tiff?|heic|heif)$/i.test(file.name)) {
    setStatus('不支持的图片格式。', true);
    return;
  }
  state.fileName = file.name;
  state.exifBytes = await file.arrayBuffer();
  state.exifObj = await parseExif(file);
  state.jpegExif = null;
  if (isJpeg(file) && state.exifBytes) {
    try { state.jpegExif = piexif.load(bytesToBinaryString(new Uint8Array(state.exifBytes))); } catch (e) { state.jpegExif = null; }
  }

  const url = await photoUrlFromFile(file);
  const img = new Image();
  img.onload = () => {
    state.photo = img;
    $('dropzone').classList.add('has-image');
    $('dzInner').classList.add('hidden');
    $('canvasWrap').classList.remove('hidden');
    $('btnExport').disabled = false;
    fillFormFromExif();
    render();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    const heic = /\.heic$/i.test(file.name);
    setStatus(heic
      ? '该浏览器不支持预览 HEIC 文件，请先转换为 JPG / PNG。'
      : '图片加载失败，请尝试其他文件。', true);
  };
  img.src = url;
}

/* ============================== 导出（保留 EXIF） ============================== */

function bytesToBinaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function binaryStringToUint8(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function rational(v) {
  const n = Math.round(v * 10000);
  return [n, 10000];
}

function buildMinimalExif() {
  const f = currentFields();
  const exif = {
    '0th': {},
    'Exif': {},
    'GPS': {},
    'Interop': {},
    '1st': {},
  };
  const source = state.exifObj || {};
  const dtRaw = source.DateTimeOriginal || '';
  const dt = String(dtRaw).trim().replace(/-/g, ':');
  if (state.brandName) exif['0th'][271] = state.brandName;          // Make
  if (f.model) exif['0th'][272] = f.model;                           // Model
  if (dt) {
    exif['0th'][306] = dt;                                           // DateTime
    exif['Exif'][36867] = dt;                                        // DateTimeOriginal
    exif['Exif'][36868] = dt;                                        // DateTimeDigitized
  }
  exif['0th'][274] = 1;                                              // Orientation

  const focal = parseFloat($('inpFocal').value);
  if (!isNaN(focal)) exif['Exif'][37386] = rational(focal);          // FocalLength
  const aperture = parseFloat($('inpAperture').value.replace(/^f\//i, ''));
  if (!isNaN(aperture)) exif['Exif'][33437] = rational(aperture);    // FNumber
  const secs = shutterSeconds($('inpShutter').value);
  if (secs !== null && !isNaN(secs)) exif['Exif'][33434] = rational(secs); // ExposureTime
  const iso = parseInt($('inpIso').value.replace(/\D/g, ''), 10);
  if (!isNaN(iso)) exif['Exif'][34855] = iso;                        // ISOSpeedRatings
  return exif;
}

function getExifBytesForExport() {
  let exifStr = null;
  if (state.jpegExif) {
    try { exifStr = piexif.dump(state.jpegExif); } catch (e) { exifStr = null; }
  }
  if (exifStr == null) {
    try { exifStr = piexif.dump(buildMinimalExif()); } catch (e) { exifStr = null; }
  }
  return exifStr ? binaryStringToUint8(exifStr) : null;
}

function insertPngExifAlt(png, exifBytes) {
  const out = [];
  out.push(...png.subarray(0, 8));
  const sig = [73, 72, 68, 82]; // IHDR
  const ihdrLen = new DataView(png.buffer, png.byteOffset + 8, 4).getUint32(0);
  const ihdrEnd = 8 + 4 + 4 + ihdrLen + 4;
  out.push(...png.subarray(8, ihdrEnd));

  const type = [0x65, 0x58, 0x49, 0x66]; // "eXIf"
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, exifBytes.length);
  out.push(...len, ...type, ...exifBytes);
  const crcBytes = new Uint8Array([...type, ...exifBytes]);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(crcBytes));
  out.push(...crc);
  out.push(...png.subarray(ihdrEnd));
  return new Uint8Array(out);
}

async function renderFullBlob() {
  const W = state.photo.naturalWidth;
  const oc = document.createElement('canvas');
  const ctx = oc.getContext('2d');
  draw(ctx, W);
  const quality = state.format === 'image/jpeg' ? 0.92 : undefined;
  const blob = await new Promise((res) => oc.toBlob(res, state.format, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportCurrent() {
  if (!state.photo) return;
  const base = state.fileName.replace(/\.[^.]+$/, '');
  const ext = state.format === 'image/jpeg' ? 'jpg' : 'png';
  setStatus('正在渲染导出…');
  try {
    let bytes = await renderFullBlob();
    const exifBytes = getExifBytesForExport();
    if (exifBytes) {
      if (state.format === 'image/jpeg') {
        bytes = binaryStringToUint8(piexif.insert(bytesToBinaryString(exifBytes), bytesToBinaryString(bytes)));
      } else {
        bytes = insertPngExifAlt(bytes, exifBytes);
      }
    }
    downloadBlob(new Blob([bytes], { type: state.format }), `${base}_frame.${ext}`);
    setStatus('导出完成：已保留原始 EXIF 信息。');
  } catch (e) {
    setStatus('导出失败：' + (e && e.message ? e.message : e), true);
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
}

/* ============================== 批量导出 ============================== */

async function handleBatch(files) {
  const imageFiles = Array.from(files).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|tiff?|heic|heif)$/i.test(f.name));
  if (!imageFiles.length) { toast('所选文件中没有图片。'); return; }
  $('batchHint').textContent = `正在处理 ${imageFiles.length} 张图片…`;
  const zip = new JSZip();
  const ext = state.format === 'image/jpeg' ? 'jpg' : 'png';

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    $('batchHint').textContent = `正在处理 ${i + 1}/${imageFiles.length}：${file.name}`;
    try {
      await loadPhotoSilent(file);
      let bytes = await renderFullBlob();
      const exifBytes = getExifBytesForExport();
      if (exifBytes) {
        if (state.format === 'image/jpeg') {
          bytes = binaryStringToUint8(piexif.insert(bytesToBinaryString(exifBytes), bytesToBinaryString(bytes)));
        } else {
          bytes = insertPngExifAlt(bytes, exifBytes);
        }
      }
      const base = file.name.replace(/\.[^.]+$/, '');
      zip.file(`${base}_frame.${ext}`, new Blob([bytes], { type: state.format }));
    } catch (e) {
      zip.file(`${file.name.replace(/\.[^.]+$/, '')}_frame.${ext}`, '导出失败');
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `watermark_batch_${stamp}.zip`);
  $('batchHint').textContent = `批量完成：${imageFiles.length} 张图片已导出为 ZIP。`;
  toast('批量导出完成');
}

async function loadPhotoSilent(file) {
  state.fileName = file.name;
  state.exifBytes = await file.arrayBuffer();
  state.exifObj = await parseExif(file);
  state.jpegExif = null;
  if (isJpeg(file) && state.exifBytes) {
    try { state.jpegExif = piexif.load(bytesToBinaryString(new Uint8Array(state.exifBytes))); } catch (e) { state.jpegExif = null; }
  }
  const url = await photoUrlFromFile(file);
  await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { state.photo = img; fillFormFromExifSilent(); resolve(); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
    img.src = url;
  });
}

function fillFormFromExifSilent() {
  const exif = state.exifObj;
  $('inpModel').value = '';
  $('inpFocal').value = '';
  $('inpAperture').value = '';
  $('inpShutter').value = '';
  $('inpIso').value = '';
  $('inpTime').value = '';
  state.brandBase = '';
  state.brandName = '';
  if (exif) {
    const make = getExifString(exif, 'Make');
    if (make) {
      const mapped = brandFromMake(make);
      if (mapped) {
        state.brandBase = mapped;
        state.brandName = displayNameOf(mapped);
        if (state.logoCache[mapped] === undefined) preloadOneLogo(mapped);
      }
    }
    const model = getExifString(exif, 'Model');
    if (model) $('inpModel').value = model;
    if (exif.FocalLength != null) $('inpFocal').value = String(exif.FocalLength);
    if (exif.FNumber != null) $('inpAperture').value = String(exif.FNumber);
    if (exif.ExposureTime != null) $('inpShutter').value = String(exif.ExposureTime);
    const iso = exif.ISO != null ? exif.ISO
      : exif.PhotographicSensitivity != null ? exif.PhotographicSensitivity
      : exif.ISOSpeedRatings != null ? exif.ISOSpeedRatings : null;
    if (iso != null) $('inpIso').value = String(iso);
    const dt = getExifString(exif, 'DateTimeOriginal');
    if (dt) $('inpTime').value = formatTimeFromExif(dt);
  }
  renderBrandInput();
}

/* ============================== UI 绑定 ============================== */

function setStatus(text, isError) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

let toastTimer = null;
function toast(text) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

const SLIDER_SPECS = [
  { id: 'rngHeight', out: 'outHeight', min: 4, max: 16, def: 8 },
  { id: 'rngBrandSize', out: 'outBrandSize', min: 15, max: 60, def: 35 },
  { id: 'rngFontSize', out: 'outFontSize', min: 50, max: 150, def: 100 },
];

/* 「品牌图片大小」滑块的默认值（0.35 = 35%），唯一来源是上面 rngBrandSize 的 def。
   从表里取而不是再写一遍 0.35：两处不一致时的症状是「复位之后图标高度不对」，
   很难一眼看出来，所以直接消掉这个可能。
   用途见 measureB —— 那里把图标高度锚在型号文字高度上，q 等于这个值时才严格等高。
   （boot() 在文件末尾调用，measureB 只在渲染时执行，晚于这里的求值。） */
const BRAND_SIZE_DEFAULT = SLIDER_SPECS.find((s) => s.id === 'rngBrandSize').def / 100;

function updateSlider(spec) {
  const input = $(spec.id);
  const v = parseInt(input.value, 10);
  $(spec.out).textContent = v;
  const pct = ((v - spec.min) / (spec.max - spec.min)) * 100;
  input.style.setProperty('--fill', pct + '%');
}

function initSliderFill() {
  for (const spec of SLIDER_SPECS) {
    $(spec.id).addEventListener('input', () => { updateSlider(spec); render(); });
    updateSlider(spec);
  }
}

function resetWatermark() {
  for (const spec of SLIDER_SPECS) {
    $(spec.id).value = String(spec.def);
    updateSlider(spec);
  }
  render();
  toast('水印设置已复位');
}

function setLogoMode(mode) {
  state.logoMode = mode;
  $('logoInkSeg').querySelectorAll('.seg-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.logoMode === mode));
  syncLogoInkUI();
  render();
}

/* 「图标颜色」只在深色模板下露出来：A 是白底白条，把 Logo 染白等于把它抹掉，
   与其让用户在 A 下选一个只会变糟的选项，不如收起来。

   提示文案点明「全白」的代价 —— 染白会把 leica 的圆、nikon 的方块压成一片纯白，
   字随之消失。不写清楚，用户会以为是渲染坏了。 */
function syncLogoInkUI() {
  const dark = state.template === 'b';
  $('logoInkField').classList.toggle('hidden', !dark);
  if (!dark) return;

  $('logoInkHint').textContent = state.logoMode === 'original'
    ? '保持素材原色；偏暗的图标在深色底上可能看不清。'
    : '图标统一显示为白色；本身是亮色底的图标（leica、nikon 等）会失去细节。';
}

/* 「显示项」开关：state.show 是唯一真相，这里只把它回灌成开关的外观和字段的压暗态 */
function syncShowUI() {
  document.querySelectorAll('.cb[data-show]').forEach((btn) => {
    const on = state.show[btn.dataset.show] !== false;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    const field = btn.closest('.field');
    if (field) field.classList.toggle('is-off', !on);
  });
}

function toggleShow(key) {
  state.show[key] = state.show[key] === false;
  syncShowUI();
  render();
}

function init() {
  initSliderFill();

  ['inpModel', 'inpFocal', 'inpAperture', 'inpShutter', 'inpIso', 'inpTime']
    .forEach((id) => $(id).addEventListener('input', render));

  /* 显示开关：形状与无障碍状态都从 state.show 推出来，点击只改 state 再回灌 UI，
     避免开关自身持有第二份状态。 */
  document.querySelectorAll('.cb[data-show]').forEach((btn) => {
    btn.addEventListener('click', () => toggleShow(btn.dataset.show));
  });
  syncShowUI();

  const brandInput = $('brandInput');
  brandInput.addEventListener('focus', () => { state.brandSearch = false; openBrandMenu(); });
  brandInput.addEventListener('input', () => {
    state.brandSearch = true;
    updateBrandFromText(brandInput.value);
    openBrandMenu();
  });
  brandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('brandMenu').querySelector('li[data-brand]');
      if (first) first.click();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      closeBrandMenu();
      brandInput.blur();
    }
  });
  $('brandChev').addEventListener('click', (e) => {
    e.stopPropagation();
    const sel = $('brandSelect');
    sel.classList.toggle('open');
    if (sel.classList.contains('open')) {
      state.brandSearch = false;
      renderBrandMenu();
      placeSelectMenu(sel, $('brandInput'));
      revealSelected($('brandMenu'));
    }
  });
  document.addEventListener('click', (e) => {
    if (!$('brandSelect').contains(e.target)) closeBrandMenu();
  });

  /* 添加自定义品牌 */
  const addPanel = $('addBrandPanel');
  const toggleAddPanel = (show) => {
    addPanel.classList.toggle('hidden', !show);
    if (show) $('addBrandName').focus();
  };
  $('btnAddBrand').addEventListener('click', () => {
    toggleAddPanel(addPanel.classList.contains('hidden'));
  });
  $('btnAddCancel').addEventListener('click', () => {
    toggleAddPanel(false);
    $('addBrandName').value = '';
    $('addBrandFile').value = '';
  });
  $('btnAddConfirm').addEventListener('click', async () => {
    const file = $('addBrandFile').files[0];
    if (!file) {
      toast('请先选择 Logo 文件');
      return;
    }
    let name = $('addBrandName').value.trim();
    if (!name) name = file.name.replace(/\.[^.]+$/, '');
    try {
      const dataUrl = await readLogoDataUrl(file);
      addCustomBrand(name, dataUrl);
      toggleAddPanel(false);
      $('addBrandName').value = '';
      $('addBrandFile').value = '';
      toast(`已添加品牌「${name}」`);
    } catch (e) {
      toast('读取 Logo 文件失败');
    }
  });

  /* 字体选择 */
  const fontInput = $('fontInput');
  renderFontInput();
  fontInput.addEventListener('focus', () => { state.fontSearch = false; openFontMenu(); });
  fontInput.addEventListener('input', () => { state.fontSearch = true; openFontMenu(); });
  fontInput.addEventListener('blur', () => {
    /* 清空输入框即回到「未指定字体」，这是列表之外唯一的复位方式 */
    if (!(fontInput.value || '').trim()) { clearFont(); return; }
    renderFontInput();
  });
  fontInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('fontMenu').querySelector('li[data-font]');
      if (first) first.click();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      closeFontMenu();
      fontInput.blur();
    }
  });
  $('fontChev').addEventListener('click', (e) => {
    e.stopPropagation();
    const sel = $('fontSelect');
    sel.classList.toggle('open');
    if (sel.classList.contains('open')) {
      state.fontSearch = false;
      renderFontMenu();
      placeSelectMenu(sel, $('fontInput'));
      revealSelected($('fontMenu'));
    }
  });
  document.addEventListener('click', (e) => {
    if (!$('fontSelect').contains(e.target)) closeFontMenu();
  });

  /* 下拉是 fixed 定位，不会跟着面板滚 —— 面板一动菜单就和输入框脱开了，直接收起来。
     菜单自己的内部滚动不冒泡到这里（scroll 事件不冒泡），所以不会误伤。
     视口尺寸变了同理：坐标是算出来的，重排一次不如让用户重新点开。 */
  $('panel').addEventListener('scroll', () => { closeBrandMenu(); closeFontMenu(); });
  window.addEventListener('resize', () => { closeBrandMenu(); closeFontMenu(); });

  /* 添加自定义字体 */
  const fontPanel = $('addFontPanel');
  const clearFontForm = () => { $('addFontName').value = ''; $('addFontFile').value = ''; };
  const toggleFontPanel = (show) => {
    fontPanel.classList.toggle('hidden', !show);
    if (show) $('addFontName').focus();
  };
  if (typeof FontFace === 'undefined') {
    $('btnAddFont').classList.add('hidden');   // 浏览器不支持 FontFace 时不提供该入口
  } else {
    $('btnAddFont').addEventListener('click', () => toggleFontPanel(fontPanel.classList.contains('hidden')));
    $('btnAddFontCancel').addEventListener('click', () => { toggleFontPanel(false); clearFontForm(); });
    $('btnAddFontConfirm').addEventListener('click', async () => {
      const file = $('addFontFile').files[0];
      if (!file) {
        toast('请先选择字体文件');
        return;
      }
      const btn = $('btnAddFontConfirm');
      btn.disabled = true;   // 大字体读取 + 注册需要一点时间
      try {
        const dataUrl = await readFontDataUrl(file);
        const typed = $('addFontName').value.trim();
        const name = typed || await guessFontFamily(file) || file.name.replace(/\.[^.]+$/, '');
        if (await addCustomFont(name, dataUrl, file.name)) {
          toggleFontPanel(false);
          clearFontForm();
        }
      } catch (e) {
        toast('读取字体文件失败');
      } finally {
        btn.disabled = false;
      }
    });
  }

  $('templateSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    $('templateSeg').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    state.template = btn.dataset.template;
    render();
  });

  $('formatSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    $('formatSeg').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    state.format = btn.dataset.format;
  });

  $('logoInkSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    setLogoMode(btn.dataset.logoMode);
  });

  $('btnResetWatermark').addEventListener('click', resetWatermark);

  window.addEventListener('beforeunload', (e) => {
    e.preventDefault();
    e.returnValue = '';
  });

  $('btnExport').addEventListener('click', exportCurrent);
  $('btnRefill').addEventListener('click', () => {
    if (state.photo) fillFormFromExif();
  });

  $('btnBatch').addEventListener('click', () => $('batchInput').click());
  $('batchInput').addEventListener('change', (e) => {
    handleBatch(e.target.files).catch((err) => {
      $('batchHint').textContent = '批量导出失败：' + (err && err.message ? err.message : err);
    });
    e.target.value = '';
  });

  const dz = $('dropzone');
  const fileInput = $('fileInput');
  const dzInner = $('dzInner');
  const canvasWrap = $('canvasWrap');

  const pickFile = () => fileInput.click();
  dzInner.addEventListener('click', pickFile);
  canvasWrap.addEventListener('click', pickFile);
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) loadPhoto(e.target.files[0]);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) loadPhoto(e.dataTransfer.files[0]);
  });

  setStatus('请上传一张照片开始。');
}

/* ============================== 启动 ============================== */

async function boot() {
  let serverBrands = null;
  try {
    const res = await fetch('/api/brands');
    serverBrands = await res.json();
  } catch (e) {
    serverBrands = null;
  }
  state.customBrands = loadCustomBrands();
  state.brands = [...(serverBrands && serverBrands.length ? serverBrands : BUILTIN_BRANDS), ...state.customBrands];
  await Promise.all([preloadBrandLogos(), restoreCustomFonts()]);
  renderBrandMenu();

  if (!serverBrands) {
    setStatus('未连接服务（直开页面）。品牌列表使用内置目录，Logo 已直接加载。');
  }
  init();

  /* 字体枚举可能耗时，放到 UI 就绪之后异步加载 */
  buildSystemFonts().then((sysFonts) => {
    state.systemFonts = sysFonts.fonts;
    state.fontsFromServer = sysFonts.fromServer;
    state.fontsReady = true;
    renderFontMenu();
    updateFontHint();
  });
}

boot();

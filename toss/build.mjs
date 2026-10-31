// 스플래쉬 맨 앱인토스 웹 번들 만들기 → dist/
// 사용: node build.mjs   (출시 빌드: 테스트 기능 숨김, 광고는 ads.config.json의 release 값이 있으면 그걸, 없으면 테스트 ID)
//       TOSS_DEV=1 node build.mjs   (개발 빌드: 테스트 기능 보임, 광고는 항상 테스트 ID)
// 하는 일
// 1. ../index.html(게임 원본)을 읽어 문서 뼈대(doctype·charset·viewport)를 붙여요.
// 2. 구글 폰트 링크를 빼고, 같은 폰트를 dist/fonts/에 넣어 앱 안에서 읽어요(토스 도메인 밖 리소스를 쓰지 않게).
// 3. 게임 스크립트를 dist/js/s0.js, s1.js…로 꺼내고, 그 앞에 SDK 연결층(dist/bridge.js)만 남겨요.
//    연결층이 저장 데이터를 불러온 다음 게임 스크립트를 순서대로 붙여요.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'index.html');
const OUT = path.join(HERE, 'dist');
const DEV = process.env.TOSS_DEV === '1';
const adsCfg = JSON.parse(fs.readFileSync(path.join(HERE, 'ads.config.json'), 'utf8'));
const pick = (k) => (!DEV && adsCfg.release[k]) ? adsCfg.release[k] : adsCfg.test[k];
const ADS = { interstitial: pick('interstitial'), rewarded: pick('rewarded'), banner: pick('banner') };
const iapCfg = JSON.parse(fs.readFileSync(path.join(HERE, 'iap.config.json'), 'utf8')).products;
const IAP_ITEMS = Object.fromEntries(Object.entries(iapCfg).map(([id, p]) => [id, { sku: p.sku, price: p.price, name: p.name }]));
const usingTestAds = Object.keys(ADS).some((k) => ADS[k] === adsCfg.test[k]);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });

let html = fs.readFileSync(SRC, 'utf8').replace(/^﻿/, '');

// --- fonts: local copies of the same Google Fonts families
const FONT_CSS = [
  ['@fontsource/jua', ['korean-400.css', 'latin-400.css']],
  ['@fontsource/black-han-sans', ['korean-400.css', 'latin-400.css']],
  ['@fontsource/noto-sans-kr', ['korean-500.css', 'latin-500.css', 'korean-700.css', 'latin-700.css', 'korean-900.css', 'latin-900.css']],
];
fs.mkdirSync(path.join(OUT, 'fonts', 'files'), { recursive: true });
let fontCss = ''; let fontFiles = 0;
for (const [pkg, files] of FONT_CSS) {
  const dir = path.join(HERE, 'node_modules', pkg);
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    let css = fs.readFileSync(p, 'utf8');
    css = css.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, ''); // woff2만 써요
    css = css.replace(/url\(\.\/files\/([^)]+\.woff2)\)/g, (m, name) => {
      const from = path.join(dir, 'files', name);
      const to = path.join(OUT, 'fonts', 'files', name);
      if (!fs.existsSync(to)) { fs.copyFileSync(from, to); fontFiles++; }
      return `url(files/${name})`;
    });
    fontCss += css + '\n';
  }
}
fs.writeFileSync(path.join(OUT, 'fonts', 'fonts.css'), fontCss);
const before = html.length;
html = html
  .replace(/<link rel="preconnect"[^>]*>\s*/g, '')
  .replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2[^"]*" rel="stylesheet">/, '<link rel="stylesheet" href="fonts/fonts.css">');
if (html.includes('fonts.googleapis.com')) throw new Error('구글 폰트 링크가 남아 있어요');
if (html.length === before) throw new Error('폰트 링크를 찾지 못했어요');

// --- 결제 금액 검사: 게임에 보이는 가격과 iap.config.json(콘솔에 등록할 가격)이 같아야 해요
for (const [id, p] of Object.entries(IAP_ITEMS)) {
  const m = id === 'rage' ? (html.includes("price:1500,once:true") ? ['', '1500'] : null) : html.match(new RegExp(`\\{id:'${id}',[^}]*?price:(\\d+)`));
  if (!m) throw new Error(`게임에서 상품 ${id}의 가격을 찾지 못했어요`);
  if (+m[1] !== p.price) throw new Error(`상품 ${id} 가격이 달라요: 게임 ${m[1]}원, iap.config.json ${p.price}원`);
}
// --- scripts → files
const scripts = [];
html = html.replace(/<script>([\s\S]*?)<\/script>/g, (m, code) => {
  const name = `js/s${scripts.length}.js`;
  fs.writeFileSync(path.join(OUT, name), code);
  scripts.push(name);
  return '';
});
if (scripts.length < 2) throw new Error(`게임 스크립트를 찾지 못했어요 (${scripts.length}개)`);
if (/<script[\s>]/.test(html)) throw new Error('꺼내지 못한 스크립트가 남아 있어요');

await build({
  entryPoints: [path.join(HERE, 'src', 'bridge.js')],
  bundle: true, format: 'iife', target: ['es2019'], minify: !DEV,
  outfile: path.join(OUT, 'bridge.js'),
  define: { __ADS__: JSON.stringify(ADS), __SCRIPTS__: JSON.stringify(scripts), __IAP__: JSON.stringify(IAP_ITEMS) },
  logLevel: 'warning',
});

const head = [
  '<!doctype html>', '<html lang="ko">', '<head>', '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">',
  '<meta name="theme-color" content="#1d2147">',
  '<style>body{margin:0}html{touch-action:manipulation}</style>',
  DEV ? '' : '<script>window.SF_RELEASE=true</script>',
].filter(Boolean).join('\n');
html = head + '\n' + html + '\n<script src="bridge.js"></script>\n</body></html>\n';
fs.writeFileSync(path.join(OUT, 'index.html'), html);
for (const f of ['icon-192.png', 'icon-512.png']) {
  const p = path.resolve(HERE, '..', f); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(OUT, f));
}

const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`dist/ 완료 · ${DEV ? '개발' : '출시'} 빌드 · 게임 스크립트 ${scripts.length}개 · 폰트 파일 ${fontFiles}개 · ${(size(OUT) / 1048576).toFixed(1)}MB`);
console.log(`광고 ID: ${usingTestAds ? '테스트 ID 사용 중' : '실제 ID'} ${JSON.stringify(ADS)}`);
if (!DEV && usingTestAds) console.log('주의: ads.config.json의 release 광고 ID가 비어 있어 테스트 ID로 만들었어요. 콘솔에서 광고 그룹을 만든 뒤 채워 주세요.');

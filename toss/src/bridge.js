// 스플래쉬 맨 ↔ 앱인토스 SDK 연결층.
// 게임 스크립트보다 먼저 실행돼서 window.SF_PLAT을 만들고, 저장 데이터를 불러온 뒤 게임 스크립트를 순서대로 붙여요.
// 게임 쪽 약속(index.html의 PLAT): name, interstitial(done), reward(done(ok)), banner(show, el), score(n),
// openLeaderboard(), haptic(type), exit(), userKey. 게임은 window.SF_GAME = { back(), save() }를 내놓아요.
import {
  loadFullScreenAd, showFullScreenAd, TossAds, Game, User, generateHapticFeedback,
  graniteEvent, Screen, SafeArea, Storage, setDeviceOrientation, IAP,
} from '@apps-in-toss/web-framework';

/* global __ADS__, __SCRIPTS__, __IAP__ */
const ADS = __ADS__;
const IAP_ITEMS = __IAP__; // 게임 상품 id → { sku, price, name }
const SCRIPTS = __SCRIPTS__;
// 토스 앱 안에서는 호스트가 상수를 미리 넣어 둬요. 일반 브라우저(개발 미리보기·자동 테스트)에서는 흉내 모드로 돌아가요.
const REAL = typeof window.__appsInTossConstants === 'object' && window.__appsInTossConstants !== null;
const log = (...a) => { try { console.log('[toss]', ...a); } catch (e) { /* noop */ } };
const tryRun = (f, fb) => { try { return f(); } catch (e) { log('error', e && e.message); return fb; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const timeout = (p, ms, fb) => Promise.race([p, wait(ms).then(() => fb)]);
// SDK 호출이 동기로 예외를 던져도 Promise 거절로 바꿔요(구버전 토스 앱·미지원 기능).
const call = (f) => { try { return Promise.resolve(f()); } catch (e) { return Promise.reject(e); } };

/* ---------- 전면·보상형 광고: 미리 불러 두고, 닫히면 다음 광고를 다시 불러요 ---------- */
function fullAd(id) {
  const st = { id, ready: false, loading: false, fails: 0 };
  st.load = () => {
    if (!REAL || !id || st.ready || st.loading) return;
    if (!tryRun(() => loadFullScreenAd.isSupported(), false)) return;
    st.loading = true;
    tryRun(() => loadFullScreenAd({
      options: { adGroupId: id },
      onEvent: (e) => { if (e.type === 'loaded') { st.ready = true; st.loading = false; st.fails = 0; } },
      onError: (err) => {
        st.loading = false; st.fails++; log('ad load failed', id, err && err.message);
        if (st.fails < 4) setTimeout(st.load, 4000 * st.fails); // 재시도 횟수와 간격 제한
      },
    }));
  };
  // done('reward' | 'shown' | 'fail')
  st.show = (done) => {
    if (!st.ready) { done('fail'); st.load(); return; }
    st.ready = false;
    let earned = false; let fin = false;
    const end = (r) => { if (fin) return; fin = true; done(r); setTimeout(st.load, 300); };
    try {
      showFullScreenAd({
        options: { adGroupId: id },
        onEvent: (e) => {
          if (e.type === 'userEarnedReward') earned = true;
          else if (e.type === 'dismissed') end(earned ? 'reward' : 'shown');
          else if (e.type === 'failedToShow') end('fail');
        },
        onError: () => end('fail'),
      });
    } catch (e) { end('fail'); }
  };
  return st;
}
const inter = fullAd(ADS.interstitial);
const reward = fullAd(ADS.rewarded);

/* ---------- 배너: 화면 맨 아래 띠에만 붙여요 ---------- */
let bannerInit = false; let bannerSlot = null;
function banner(show, el) {
  if (!REAL || !ADS.banner || !el) return;
  if (!show) { if (bannerSlot) { tryRun(() => bannerSlot.destroy()); bannerSlot = null; } return; }
  if (bannerSlot) return;
  if (!tryRun(() => TossAds.attachBanner.isSupported(), false)) return;
  if (!bannerInit) { bannerInit = true; tryRun(() => TossAds.initialize({})); }
  el.innerHTML = '';
  const box = document.createElement('div'); box.style.width = '100%'; el.appendChild(box);
  bannerSlot = tryRun(() => TossAds.attachBanner(ADS.banner, box, { theme: 'dark', variant: 'expanded' }), null);
}

/* ---------- 저장: 게임은 localStorage를 그대로 쓰고, 여기서 앱인토스 저장소에 함께 적어 둬요 ---------- */
const KEYS = 'sf_keys'; const TS = 'sf_ts';
const isGameKey = (k) => typeof k === 'string' && k.startsWith('snack');
const ls = window.localStorage;
const dirty = new Set(); let known = new Set(); let flushT = null;
async function flush() {
  flushT = null;
  if (!REAL || !dirty.size) return;
  const ks = [...dirty]; dirty.clear();
  const now = String(Date.now());
  try {
    for (const k of ks) {
      const v = ls.getItem(k);
      if (v === null) await call(() => Storage.removeItem(k)); else await call(() => Storage.setItem(k, v));
    }
    await call(() => Storage.setItem(KEYS, JSON.stringify([...known])));
    await call(() => Storage.setItem(TS, now));
    ls.setItem(TS, now);
  } catch (e) { log('storage write failed', e && e.message); ks.forEach((k) => dirty.add(k)); }
}
function mark(k, now) {
  if (!isGameKey(k)) return;
  dirty.add(k);
  if (now) { clearTimeout(flushT); flush(); return; }
  if (!flushT) flushT = setTimeout(flush, 800); // 짧은 시간에 저장소를 여러 번 부르지 않게 모아서 적어요
}
function mirrorWrites() {
  // localStorage.setItem = … 은 메서드를 바꾸지 못하고 'setItem'이라는 값을 저장해 버려서, 프로토타입에서 가로채요.
  const P = window.Storage.prototype; const set = P.setItem; const rm = P.removeItem;
  P.setItem = function (k, v) { set.call(this, k, v); if (this === ls && isGameKey(k)) { known.add(k); mark(k); } };
  P.removeItem = function (k) { rm.call(this, k); if (this === ls && isGameKey(k)) { known.delete(k); mark(k, true); } };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { tryRun(() => window.SF_GAME && window.SF_GAME.save()); clearTimeout(flushT); flush(); }
  });
}
async function hydrate() {
  if (!REAL) return;
  const raw = await timeout(call(() => Storage.getItem(KEYS)).catch(() => null), 2000, null);
  let keys = []; try { keys = JSON.parse(raw || '[]'); } catch (e) { keys = []; }
  known = new Set(keys);
  const remoteTs = +(await timeout(call(() => Storage.getItem(TS)).catch(() => null), 1500, null)) || 0;
  const localTs = +(ls.getItem(TS) || 0);
  if (remoteTs <= localTs && keys.every((k) => ls.getItem(k) !== null)) return; // 이 기기 데이터가 더 최신이에요
  for (const k of keys) {
    const v = await timeout(call(() => Storage.getItem(k)).catch(() => null), 1500, null);
    if (v !== null) ls.setItem(k, v);
  }
  if (remoteTs) ls.setItem(TS, String(remoteTs));
}

/* ---------- 흉내 모드(일반 브라우저): 광고는 1초 뒤 끝난 것으로, 나머지는 콘솔에만 남겨요 ---------- */
function mockAd(kind, done) {
  log('mock', kind);
  const d = document.createElement('div');
  d.id = 'tossMockAd';
  d.textContent = kind === 'pay' ? '토스 결제창 (앱인토스 흉내)' : (kind === 'reward' ? '보상형' : '전면') + ' 광고 (앱인토스 흉내)';
  d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:#111;color:#fff;font:700 20px sans-serif';
  document.body.appendChild(d);
  setTimeout(() => { d.remove(); done(kind === 'reward' ? 'reward' : 'shown'); }, 1000);
}

/* ---------- 인앱 결제: 결제창 → processProductGrant에서 게임이 지급 → 성공. 시작할 때 대기·완료·환불 주문을 맞춰요 ---------- */
const SKU2ID = Object.fromEntries(Object.entries(IAP_ITEMS).map(([id, p]) => [p.sku, id]));
const IAP_MSG = {
  PAYMENT_PENDING: '결제 승인을 기다리고 있어요. 잠시 뒤 다시 확인해 주세요.',
  NETWORK_ERROR: '잠시 문제가 생겼어요. 다시 시도해 주세요.',
  INTERNAL_ERROR: '잠시 문제가 생겼어요. 다시 시도해 주세요.',
  ITEM_ALREADY_OWNED: '이미 가지고 있는 상품이에요.',
  INVALID_PRODUCT_ID: '지금은 살 수 없는 상품이에요.',
  INVALID_USER_ENVIRONMENT: '이 기기나 계정에서는 살 수 없는 상품이에요.',
  KOREAN_ACCOUNT_ONLY: '한국 계정에서만 살 수 있어요.',
  APP_MARKET_VERIFICATION_FAILED: '결제는 됐지만 확인에 실패했어요. 게임을 다시 열면 지급돼요. 계속 안 되면 고객센터로 문의해 주세요.',
  TOSS_SERVER_VERIFICATION_FAILED: '결제는 됐지만 확인에 실패했어요. 게임을 다시 열면 지급돼요. 계속 안 되면 고객센터로 문의해 주세요.',
  PRODUCT_NOT_GRANTED_BY_PARTNER: '상품을 지급하지 못했어요. 게임을 다시 열면 다시 지급해요.',
  UNSUPPORTED_APP_VERSION: '토스 앱을 최신 버전으로 업데이트해 주세요.',
};
const prices = {};
function loadPrices() {
  if (!REAL || !tryRun(() => IAP.getProductItemList.isSupported(), false)) return;
  call(() => IAP.getProductItemList()).then((r) => {
    for (const p of (r && r.products) || []) { const id = SKU2ID[p.sku]; if (id && p.displayAmount) prices[id] = p.displayAmount; }
  }).catch((e) => log('product list failed', e && e.message));
}
let buying = false;
function iapBuy(id, grant, done) {
  const item = IAP_ITEMS[id];
  if (!item || buying) { done({ ok: false, msg: buying ? '결제가 진행 중이에요.' : '지금은 살 수 없는 상품이에요.' }); return; }
  if (!REAL) { // 흉내: 1초 뒤 결제 완료, 실제 앱과 같은 순서로 지급 → 성공
    buying = true; mockAd('pay', () => { buying = false; const orderId = 'mock-' + Date.now(); const ok = tryRun(() => grant(orderId), false); done(ok ? { ok: true, orderId } : { ok: false, code: 'PRODUCT_NOT_GRANTED_BY_PARTNER', msg: IAP_MSG.PRODUCT_NOT_GRANTED_BY_PARTNER }); });
    return;
  }
  if (!tryRun(() => IAP.createOneTimePurchaseOrder.isSupported(), false)) { done({ ok: false, code: 'UNSUPPORTED_APP_VERSION', msg: IAP_MSG.UNSUPPORTED_APP_VERSION }); return; }
  buying = true; let cleanup = null; let fin = false;
  const end = (r) => { if (fin) return; fin = true; buying = false; tryRun(() => cleanup && cleanup()); done(r); };
  try {
    cleanup = IAP.createOneTimePurchaseOrder({
      options: { sku: item.sku, processProductGrant: ({ orderId }) => !!tryRun(() => grant(orderId), false) },
      onEvent: (e) => { if (e && e.type === 'success') end({ ok: true, orderId: e.data && e.data.orderId }); },
      onError: (err) => { const code = err && (err.code || err.errorCode); log('purchase error', code); end({ ok: false, code, msg: IAP_MSG[code] || '결제하지 못했어요.' }); },
    });
  } catch (e) { const code = e && e.code; end({ ok: false, code, msg: IAP_MSG[code] || '결제하지 못했어요.' }); }
}
async function iapRestore({ grant, refund, known, done }) {
  const n = { granted: 0, refunded: 0 };
  if (!REAL) { // 흉내: window.__mockIap = { pending: [{orderId, sku}], history: [{orderId, sku, status}] } 로 복구 흐름을 시험해요
    const m = window.__mockIap || {};
    for (const o of m.pending || []) { const id = SKU2ID[o.sku]; const had = id && !!known()[o.orderId]; if (id && tryRun(() => grant(id, o.orderId, true), false) && !had) n.granted++; }
    for (const o of m.history || []) {
      const id = SKU2ID[o.sku]; if (!id) continue; const k = known();
      if (o.status === 'COMPLETED' && !k[o.orderId]) { if (tryRun(() => grant(id, o.orderId, true), false)) n.granted++; }
      else if (o.status === 'REFUNDED' && k[o.orderId] && k[o.orderId].st !== 'refund') { if (tryRun(() => refund(o.orderId), false)) n.refunded++; }
    }
    tryRun(() => done(n)); return;
  }
  // 1) 결제는 됐는데 지급하지 못한 주문 → 지급하고 완료 알림
  if (tryRun(() => IAP.getPendingOrders.isSupported(), false)) {
    const p = await call(() => IAP.getPendingOrders()).catch(() => null);
    for (const o of (p && p.orders) || []) {
      const id = SKU2ID[o.sku]; if (!id) continue;
      const had = !!known()[o.orderId];
      if (tryRun(() => grant(id, o.orderId, true), false)) {
        if (!had) n.granted++;
        await call(() => IAP.completeProductGrant({ params: { orderId: o.orderId } })).catch((e) => log('complete grant failed', e && e.message));
      }
    }
  }
  // 2) 완료·환불 내역: 이 기기에 없는 완료 주문은 다시 지급(기기 변경), 환불된 주문은 회수
  if (tryRun(() => IAP.getCompletedOrRefundedOrders.isSupported(), false)) {
    let key = null; let pages = 0;
    do {
      const r = await call(() => IAP.getCompletedOrRefundedOrders(key ? { key } : undefined)).catch(() => null);
      if (!r) break;
      for (const o of r.orders || []) {
        const id = SKU2ID[o.sku]; if (!id) continue;
        const k = known();
        if (o.status === 'COMPLETED' && !k[o.orderId]) { if (tryRun(() => grant(id, o.orderId, true), false)) n.granted++; }
        else if (o.status === 'REFUNDED' && k[o.orderId] && k[o.orderId].st !== 'refund') { if (tryRun(() => refund(o.orderId), false)) n.refunded++; }
      }
      key = r.hasNext ? r.nextKey : null;
    } while (key && ++pages < 20);
  }
  tryRun(() => done(n));
}
const IAP_ON = !REAL || tryRun(() => IAP.createOneTimePurchaseOrder.isSupported(), false);

window.SF_PLAT = {
  name: 'toss',
  real: REAL,
  userKey: null,
  interstitial(done) { const cb = () => tryRun(done); if (!REAL) { mockAd('inter', cb); return; } inter.show(cb); },
  reward(done) {
    if (!REAL) { mockAd('reward', (r) => tryRun(() => done(r === 'reward'))); return; }
    const go = () => reward.show((r) => tryRun(() => done(r === 'reward')));
    if (reward.ready) { go(); return; }
    reward.load();
    let n = 0; const iv = setInterval(() => { // 아직 안 불러졌으면 4초까지 기다려요
      if (reward.ready) { clearInterval(iv); go(); } else if (++n > 20) { clearInterval(iv); tryRun(() => done(false)); }
    }, 200);
  },
  banner,
  score(n) {
    const s = String(Math.max(0, Math.floor(+n || 0)));
    if (!REAL) { log('mock score', s); window.__tossScore = s; return; }
    if (!tryRun(() => Game.setLeaderboardScore.isSupported(), false)) return;
    call(() => Game.setLeaderboardScore({ score: s })).then((r) => log('score', s, r && r.statusCode)).catch((e) => log('score failed', e && e.message));
  },
  openLeaderboard() {
    if (!REAL) { log('mock leaderboard'); window.__tossBoard = (window.__tossBoard || 0) + 1; return; }
    if (!tryRun(() => Game.openLeaderboard.isSupported(), false)) throw new Error('unsupported');
    call(() => Game.openLeaderboard()).catch((e) => log('leaderboard failed', e && e.message));
  },
  haptic(type) { if (REAL) call(() => generateHapticFeedback({ type })).catch(() => {}); },
  iap: IAP_ON ? { buy: iapBuy, restore: iapRestore, price: (id) => prices[id] || null } : null,
  exit() { if (REAL) call(() => Screen.close()).catch(() => {}); else { log('mock exit'); window.__tossExit = 1; } },
};

function safeArea() {
  const apply = (i) => {
    if (!i) return;
    const r = document.documentElement.style;
    r.setProperty('--sat', (i.top || 0) + 'px'); r.setProperty('--sab', (i.bottom || 0) + 'px');
    r.setProperty('--sal', (i.left || 0) + 'px'); r.setProperty('--sar', (i.right || 0) + 'px');
  };
  if (!REAL) return;
  apply(tryRun(() => SafeArea.get(), null));
  tryRun(() => SafeArea.subscribe({ onEvent: apply }));
}

function loadScripts(list) {
  return list.reduce((p, src) => p.then(() => new Promise((res) => {
    const s = document.createElement('script'); s.src = src; s.async = false;
    s.onload = res; s.onerror = () => { log('script failed', src); res(); };
    document.body.appendChild(s);
  })), Promise.resolve());
}

let started = false;
function start() { if (started) return; started = true; tryRun(mirrorWrites); loadScripts(SCRIPTS).then(() => log('ready', REAL ? 'toss' : 'mock')); }
(async () => {
  tryRun(safeArea);
  if (REAL) {
    call(() => setDeviceOrientation({ type: 'portrait' })).catch(() => {});
    tryRun(() => graniteEvent.addEventListener('backEvent', {
      onEvent: () => { if (!(window.SF_GAME && window.SF_GAME.back())) window.SF_PLAT.exit(); },
      onError: (e) => log('back event error', e && e.message),
    }));
    call(() => User.getAnonymousKey()).then((r) => {
      if (r && r.hash) { window.SF_PLAT.userKey = r.hash; call(() => Storage.setItem('sf_userkey', r.hash)).catch(() => {}); }
    }).catch((e) => log('user key failed', e && e.message));
    tryRun(loadPrices);
    tryRun(inter.load);
    setTimeout(() => tryRun(reward.load), 1500); // 안드로이드 구버전은 광고를 하나씩 불러야 해요
  }
  setTimeout(start, 4000); // 저장소가 끝내 대답하지 않아도 4초 안에는 게임을 시작해요
  await timeout(hydrate().catch((e) => log('hydrate failed', e && e.message)), 3500, null);
  start();
})().catch((e) => { log('startup error', e && e.message); start(); });

/* =====================================================================
 *  バグるマネージ（公式アプリの中身を直す。2026-10-30 ko-dai さんの指示）
 *  ・公式アプリの「もと」は js/data.js。ここで直した分（もとと違うところだけ）を、受け口（予約ボードの受け口）に置く
 *    （appContent で読む・saveAppContent で保存。保存には台帳と同じ合言葉が要る）。公式アプリは起動したときに読んで重ねる（js/content.js）
 *  ・中身の形（content）は js/content.js の頭に書いてある。ここでは、もとと同じ値にしたものは消して、違うところだけを残す
 *  ・合言葉は、1度入れたらこの端末に覚える（localStorage の baguru.daicho.pin。予約ボード・Order受付と同じ置き場所。2026-11-01 ko-dai さんの指示：「T3Works と同じように」）。
 *    合言葉が変わったときは、また入れる画面が出る
 *  ・★この Mac で試すときは、にせの受け口（プレビュー「予約の受け口（試し）」）から ?test を付けて開く。本物の受け口に保存して試さない
 * ===================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
const pad = n => String(n).padStart(2, '0');
const todayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clone = o => JSON.parse(JSON.stringify(o ?? {}));
/** キーの順番をそろえた JSON（同じ中身なら同じ字になる。直したかどうかを見分けるため） */
const canon = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v));

/* ---- バグる Owner（オーナー用の入口）から開いたときだけ「🏠 ホーム」（公式アプリ・Order受付と同じ印。sessionStorage の bg.fromOwner） ---- */
const OWNER_HOME = 'https://t3dining.github.io/baguru-owner/';
const fromOwner = (() => {
  try {
    if (/[?&]from=owner\b/.test(location.search)) sessionStorage.setItem('bg.fromOwner', '1');
    return sessionStorage.getItem('bg.fromOwner') === '1';
  } catch (e) { return /[?&]from=owner\b/.test(location.search); }
})();
if (fromOwner) {
  $('#homeBtn').hidden = false;
  $('#homeBtn').onclick = () => { let to = ''; try { to = sessionStorage.getItem('bg.owner') || ''; } catch (e) {} location.href = to || OWNER_HOME; };
}

/* ---- 受け口（予約ボードの公開先の config.js・api.js を読む。公式アプリの baguruLib と同じ） ---- */
const LOADED = {};
const loadJs = src => (LOADED[src] ??= new Promise((ok, ng) => {
  const s = document.createElement('script');
  Object.assign(s, { src, onload: ok, onerror: () => { delete LOADED[src]; s.remove(); ng(Object.assign(new Error('offline'), { code: 'offline' })); } });
  document.head.append(s);
}));
const api = () => loadJs(SHOP.reserveBase + 'config.js').then(() => loadJs(SHOP.reserveBase + 'api.js'))
  .then(() => { if (!window.BaguruApi?.ready()) throw Object.assign(new Error('not_ready'), { code: 'not_ready' }); });
const post = payload => api().then(() => BaguruApi.post(payload));

const MSG = {
  bad_pin: '合言葉が違います。',
  locked: '何度も違ったため、しばらく使えません。時間を置いてから、もう一度お試しください。',
  not_setup: '受け口の準備（setup）がまだです。予約ボードのセッションの案内を見てください。',
  unknown_action: '受け口が、まだ新しい版になっていません。予約ボードのセッションの案内で、Google の受け口を入れ替えてください。',
  bad_image: 'この写真は読めませんでした。ほかの写真か、JPEG・PNG の写真を選んでください。',
  too_large: '写真が大きすぎて送れませんでした。ほかの写真を選んでください。',
  too_big: '中身が多すぎて保存できません。お知らせを減らしてください。',
  bad_input: '中身の形が違うため、保存できませんでした。',
  not_ready: '受け口の場所を読めませんでした。少し時間を置いてから、もう一度お試しください。',
  offline: 'つながりませんでした。電波の良い所で、もう一度お試しください。',
  no_answer: 'つながりませんでした。時間を置いて、もう一度お試しください。',
};
const message = e => MSG[e?.code] || MSG.no_answer;

/* ---- 状態 ---- */
const PIN_KEY = 'baguru.daicho.pin';
function pinGet() { try { return localStorage.getItem(PIN_KEY) || ''; } catch (e) { return ''; } }
function pinSet(v) { try { if (v) localStorage.setItem(PIN_KEY, v); else localStorage.removeItem(PIN_KEY); } catch (e) {} }
let pin = pinGet();
let server = null;   // 受け口にある中身 { content, v, at }
let draft = {};      // 直している中身（もとと違うところだけ）
let tab = 'notice';
let busy = false;
let loginErr = '';

const dirty = () => !!server && canon(draft) !== canon(server.content || {});
const appUrl = () => (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? `../index.html${/[?&]test\b/.test(location.search) ? '?test' : ''}` : SHOP.appUrl);
const whenText = iso => { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** draft の sec（items・choices・dine・rewards）の key の field を直す。val が undefined なら消す（空になった入れものも消す） */
function setOv(sec, key, field, val) {
  draft[sec] ??= {};
  const o = (draft[sec][key] ??= {});
  if (val === undefined) delete o[field]; else o[field] = val;
  if (!Object.keys(o).length) delete draft[sec][key];
  if (!Object.keys(draft[sec]).length) delete draft[sec];
}
const ov = (sec, key) => draft[sec]?.[key] || {};
const toNum = v => { const n = Number(String(v).replace(/[^\d]/g, '')); return String(v).trim() === '' || !Number.isInteger(n) || n > 99999 ? null : n; };
const lines = v => String(v).split('\n').map(x => x.trim()).filter(Boolean);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- 描く ---- */
const MEMBER_PLUS = !!STAMP.memberPlus || (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]test\b/.test(location.search));   // 公式アプリの js/stamp-api.js と同じ
const PHOTO_EDIT = !!SHOP.photoEdit || (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]test\b/.test(location.search));   // 受け口に savePhoto が入るまでは、この Mac の ?test だけ
const TABS = [
  ['notice', '一言'], ['news', 'お知らせ'], ['items', 'テイクアウト'], ['choices', '選ぶもの'], ['dine', '店内'], ['rewards', '特典'], ['texts', '文章'],
  ...(PHOTO_EDIT ? [['photos', '写真']] : []),
  ...(MEMBER_PLUS ? [['people', '客層']] : []),
];

function render() {
  const view = $('#view');
  $('#saveBtn').hidden = !server;
  if (!server) { view.innerHTML = loginHtml(); $('#foot').innerHTML = ''; editShow(); $('#bar').hidden = true; return $('#pin')?.focus(); }
  const y = window.scrollY;
  view.innerHTML = `
    <nav class="m-tabs">${TABS.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</nav>
    ${({ notice: noticeHtml, news: newsHtml, items: itemsHtml, choices: choicesHtml, dine: dineHtml, rewards: rewardsHtml, texts: textsHtml, photos: photosHtml, people: peopleHtml })[tab]()}`;
  // 下の字は #foot に（文章の「画面で直す」のときは、中のアプリの下に出る）
  $('#foot').innerHTML = `<p class="m-foot"><button class="m-link" data-act="forget">この端末の合言葉を消す</button><br><a href="${esc(appUrl())}" target="_blank" rel="noopener">公式アプリで見る ›</a><br>
      保存すると、公式アプリには数分のうちに出ます（開いている人は、開き直したときに）。値段はホームページには出ません（ホームページは別に直します）。</p>`;
  editShow();
  window.scrollTo(0, y);
  drawBar();
}

function drawBar() {
  const d = dirty();
  $('#saveBtn').disabled = !d || busy;
  $('#saveBtn').textContent = busy ? '保存中…' : '保存';
  const bar = $('#bar');
  bar.hidden = false;
  bar.className = 'm-bar' + (d ? ' is-dirty' : '');
  bar.innerHTML = `<span>${esc(d ? '保存していない直しがあります。' : `保存済み${server.at ? `（${whenText(server.at)}・版 ${server.v}）` : '（まだ何も直していません）'}`)}</span>
    <button class="m-see" data-act="see">アプリで見る</button>`;
}

/* ---- 客層：会員の性別と年代の集計（受け口の memberStats。スタンプ台帳の決めごと.md の13節）。★受け口は人数だけを返す。一人ずつの情報はここに来ない ---- */
let people = null, peopleErr = '';
async function loadPeople() {
  people = null; peopleErr = '';
  try {
    people = await post({ action: 'memberStats', pin });
  } catch (err) {
    peopleErr = message(err);
    if (err.code === 'bad_pin') { pin = ''; pinSet(''); server = null; }
  }
  if (tab === 'people' || !server) render();
}
const sum = list => list.reduce((a, b) => a + b, 0);
const cell = (age, g) => people.table?.[age]?.[g] || 0;
const peopleAges = () => [...people.ages, '未回答'], peopleGenders = () => [...people.genders, '未回答'];
const barsHtml = rows => {
  const top = Math.max(1, ...rows.map(r => r[1])), all = sum(rows.map(r => r[1]));
  return `<ul class="m-bars">${rows.map(([k, n]) => `<li><span>${esc(k)}</span><i style="width:${Math.round(n / top * 100)}%"></i><b>${n}人<small>${all ? Math.round(n / all * 100) : 0}%</small></b></li>`).join('')}</ul>`;
};
function peopleHtml() {
  if (peopleErr) return `<p class="m-err">${esc(peopleErr)}</p>`;
  if (!people) return '<p class="m-hint">読み込んでいます…</p>';
  const ages = peopleAges(), genders = peopleGenders();
  return `<section class="m-sec">
      <h2>客層</h2>
      <p class="m-hint">会員登録をした ${people.registered}人 の集計です。「未回答」は、この項目ができる前に登録した人や、入れ直して戻したあとに入れ直していない人です。</p>
      <button class="m-btn m-sub" data-act="people-csv">CSV で保存する</button>
    </section>
    <section class="m-sec"><h2>性別</h2>${barsHtml(genders.map(g => [g, sum(ages.map(a => cell(a, g)))]))}</section>
    <section class="m-sec"><h2>年代</h2>${barsHtml(ages.map(a => [a, sum(genders.map(g => cell(a, g)))]))}</section>
    <section class="m-sec"><h2>年代と性別</h2>
      <div class="m-scroll"><table class="m-table">
        <tr><th></th>${genders.map(g => `<th>${esc(g)}</th>`).join('')}<th>合計</th></tr>
        ${ages.map(a => `<tr><th>${esc(a)}</th>${genders.map(g => `<td>${cell(a, g)}</td>`).join('')}<td><b>${sum(genders.map(g => cell(a, g)))}</b></td></tr>`).join('')}
      </table></div>
    </section>`;
}
function savePeople() {
  const ages = peopleAges(), genders = peopleGenders();
  const rows = [['年代', ...genders, '合計'], ...ages.map(a => [a, ...genders.map(g => cell(a, g)), sum(genders.map(g => cell(a, g)))])];
  const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map(r => r.join(',')).join('\r\n') + '\r\n'], { type: 'text/csv' }));   // 頭の印は、Excel で文字化けしないように
  const a = Object.assign(document.createElement('a'), { href: url, download: `バグる客層_${todayKey()}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---- アプリで見る：保存する前の直しを入れた公式アプリを、画面の中に開く（改行などの見え方を確かめる）。★お客様には見えない ---- */
const SEE_SCREENS = [['join', '登録'], ['home', 'ホーム'], ['menu', 'メニュー'], ['cart', 'カート'], ['stamp', 'スタンプ'], ['shop', 'お店'], ['me', 'マイページ'], ['reserve', '予約']];
const SEE_TAB = { notice: 'home', news: 'home', items: 'menu', choices: 'menu', dine: 'shop', rewards: 'stamp', texts: 'home', photos: 'menu' };
const SEE_AT = {
  'ホーム': 'home', 'テイクアウトのメニュー': 'menu', 'テイクアウトのメニュー（名前と説明）': 'menu', '商品を選ぶ画面': 'menu', 'アレルギー': 'menu', 'カート': 'cart', '受け取りとお名前': 'checkout',
  '注文の様子': 'me', '配達・大量注文の申請': 'request', 'スタンプ': 'stamp', 'スタンプのQR': 'stamp', 'スタンプの決まり': 'stamp', 'お店の情報': 'shop', 'お店の情報（もとの設定）': 'shop',
  '店内のメニュー（名前と説明）': 'shop', 'ネット予約': 'reserve', 'マイページ': 'me',
};
const seeUrl = route => (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? `../index.html?${/[?&]test\b/.test(location.search) ? 'test&' : ''}preview#${route}`
  : `${SHOP.appUrl}index.html?preview#${route}`);

function openSee(route, focus = '') {
  try {
    sessionStorage.setItem('bg.preview', JSON.stringify(draft));
    sessionStorage.setItem('bg.previewFocus', focus);
  } catch (e) { return alert('この端末では、見え方を出せませんでした。'); }
  let box = $('#see');
  if (!box) {
    box = Object.assign(document.createElement('div'), { id: 'see', className: 'm-see-box' });
    document.body.append(box);
  }
  box.innerHTML = `<div class="m-see-top"><b>アプリでの見え方</b><button data-act="see-close">閉じる</button></div>
    <nav class="m-see-tabs">${SEE_SCREENS.map(([k, n]) => `<button data-act="see-go" data-route="${k}" class="${k === route ? 'on' : ''}">${n}</button>`).join('')}</nav>
    <p class="m-see-note" id="seeNote">${dirty() ? '保存前の直しが入っています。お客様にはまだ見えていません。' : 'お客様に見えている形です。'}</p>
    <div class="m-see-frame"><iframe src="${esc(seeUrl(route))}" title="アプリでの見え方"></iframe></div>`;
  document.body.classList.add('is-seeing');
}
const closeSee = () => { $('#see')?.remove(); document.body.classList.remove('is-seeing'); };
// 確かめている文が、開いた画面に無かったとき（商品を選ぶ画面など、押して開く所にある文）
window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.data?.type !== 'baguru-preview' || e.data.found) return;
  const n = $('#seeNote');
  if (n) n.textContent = 'この文は、今の画面には出ていません。下の画面を押して開くか、上で画面を切りかえて探してください。';
});

function loginHtml() {
  return `<form class="m-login" id="login">
      <h2>合言葉を入れてください</h2>
      <p>予約ボード・Order受付と同じ合言葉です。1度入れると、この端末では次から入れなくて済みます。</p>
      <input id="pin" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" maxlength="40" aria-label="合言葉">
      ${loginErr ? `<p class="m-err">${esc(loginErr)}</p>` : ''}
      <button class="m-btn" ${busy ? 'disabled' : ''}>${busy ? '確かめています…' : '開く'}</button>
    </form>`;
}

const priceIn = (f, v, base, label = '') => `<label class="m-price">${label ? `<em>${esc(label)}</em>` : ''}<span>¥</span>
    <input type="text" inputmode="numeric" data-f="${f}" value="${esc(v ?? base)}" aria-label="${esc(label || '値段')}">
    ${v != null && v !== base ? `<small>もと ${yen(base)}</small>` : ''}</label>`;
const flagIn = (f, on, label) => `<label class="m-flag ${on ? 'on' : ''}"><input type="checkbox" data-f="${f}" ${on ? 'checked' : ''}><span>${label}</span></label>`;

function noticeHtml() {
  const n = draft.notice || {};
  return `<section class="m-sec">
      <h2>お店からの一言</h2>
      <p class="m-hint">公式アプリのホームと、テイクアウトのメニューのいちばん上に出ます。例：「本日は貸切のため、18時からテイクアウトのみです」。空にすると出ません。</p>
      <textarea data-f="notice:text" rows="3" maxlength="200" placeholder="（出さない）">${esc(n.text || '')}</textarea>
      <label class="m-field"><span>いつまで出すか（空なら、消すまで）</span><input type="date" data-f="notice:until" value="${esc(n.until || '')}" min="${todayKey()}"></label>
      ${n.until && n.until < todayKey() ? '<p class="m-err">この日はもう過ぎているので、公式アプリには出ていません。</p>' : ''}
    </section>`;
}

const newsList = () => (draft.news ? draft.news : CONTENT_BASE.news.map(n => ({ date: n.date, title: n.title, body: n.body })));
function newsHtml() {
  const list = newsList();
  return `<section class="m-sec">
      <h2>お知らせ</h2>
      <p class="m-hint">公式アプリのホームの「お知らせ」に、上から順に出ます。タイトルは日付の下に1行で出ます（長いと字が小さくなり、それでも入らない分は「…」になります。スマホで25字くらいまで）。${draft.news ? '' : '今は data.js のままです。'}</p>
      <button class="m-btn m-sub" data-act="news-add">＋ お知らせを足す（いちばん上に）</button>
      ${list.map((n, i) => `<div class="m-news">
          <div class="m-news-top"><input type="date" data-f="news:date:${i}" value="${esc(n.date)}" aria-label="日付">
            <span class="m-move"><button data-act="news-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">↑</button><button data-act="news-down" data-i="${i}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="下へ">↓</button><button data-act="news-del" data-i="${i}" class="danger">削除</button></span></div>
          <input type="text" data-f="news:title:${i}" value="${esc(n.title)}" maxlength="80" placeholder="見出し">
          <textarea data-f="news:body:${i}" rows="3" maxlength="600" placeholder="中身">${esc(n.body)}</textarea>
        </div>`).join('')}
      ${draft.news ? '<button class="m-btn m-sub" data-act="news-reset">data.js のお知らせに戻す</button>' : ''}
    </section>`;
}

/* ---- 商品を足す・消す・並べる（2026-11-04 ko-dai さんの指示：「商品の追加や削除、同カテゴリー内での順番の入れ替え、カテゴリー自体の順番の入れ替え」） ----
 *  中身は draft.menu（形は ../js/content.js の applyMenu の頭）。並びは ↑↓ で入れかえる。data.js と同じ並びに戻ったら、その並びは消す（中身を小さく）。
 *  data.js の商品を消すと removed に入り、下の「消した商品」から戻せる。足した商品を消すと、その商品の写真・売り切れの直しも消す */
const menuDraft = () => draft.menu || {};
/** draft.menu の key に val を入れる。空・もとと同じなら消す */
function setMenu(key, val) {
  draft.menu ??= {};
  const empty = val == null || (Array.isArray(val) && !val.length) || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length);
  if (empty) delete draft.menu[key]; else draft.menu[key] = val;
  if (!Object.keys(draft.menu).length) delete draft.menu;
}
const newMenuId = head => head + '_' + [...crypto.getRandomValues(new Uint8Array(6))].map(b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
/** テイクアウトのカテゴリー（並べた順） */
const mCats = () => orderBy(CATEGORIES, c => c.id, menuDraft().cats);
/** そのカテゴリーの商品（並べた順。足した商品も。消したものは入れない）。足した商品は { add: 中身 } */
function mItems(catId, ordered = true) {   // ordered：false なら、data.js の順（足した商品は後ろ）
  const m = menuDraft(), removed = new Set(m.removed || []);
  const list = [...ITEMS.filter(i => i.cat === catId && !removed.has(i.id)), ...(m.added || []).filter(a => a.cat === catId).map(a => ({ id: a.id, add: a }))];
  return ordered ? orderBy(list, x => x.id, (m.order || {})[catId]) : list;
}
/** 並びの中で、key のものを dir（-1 上・1 下）へ動かした並びを返す */
function moved(keys, key, dir) {
  const list = keys.slice(), i = list.indexOf(key), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}
const moveBtns = (act, key, i, n, del = '') => `<span class="m-move"><button data-act="${act}" data-key="${esc(key)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="上へ">↑</button><button data-act="${act}" data-key="${esc(key)}" data-dir="1" ${i === n - 1 ? 'disabled' : ''} aria-label="下へ">↓</button>${del}</span>`;
// 足した商品の「選ぶもの」：data.js の商品の選ぶもの（サイズのある商品は、'acai' で）
const LIKE_OPTS = () => [['', '選ぶものなし'], ...ITEMS.filter(i => i.groups.length && !i.groups.some(g => g.id === 'size')).map(i => [i.id, `${i.full || i.name}と同じ`]), ['acai', 'アサイーボウルと同じ（サイズとトッピング）']];

function itemsHtml() {
  const cats = mCats(), m = menuDraft();
  const catRows = cats.map((c, i) => `<div class="m-order-row"><b>${esc(c.name)}</b>${moveBtns('cat-move', c.id, i, cats.length)}</div>`).join('');
  const removed = ITEMS.filter(i => (m.removed || []).includes(i.id));
  return `<section class="m-sec"><h2>カテゴリーの順番</h2><p class="m-hint">公式アプリのテイクアウトのメニューに、この順で出ます。</p>${catRows}</section>`
    + cats.map(cat => {
      const list = mItems(cat.id);
      return `<section class="m-sec">
      <h2>${esc(cat.name)}</h2>
      ${list.map((x, n) => {
        const o = ov('items', x.id), del = `<button data-act="item-del" data-key="${esc(x.id)}" class="danger">削除</button>`, mv = moveBtns('item-move', `${cat.id}|${x.id}`, n, list.length, del);
        if (x.add) {   // 足した商品：名前なども、ここで直す
          const a = x.add, acaiLike = a.like === 'acai';
          return `<div class="m-row m-added ${o.hidden ? 'is-hidden' : ''} ${o.soldOut ? 'is-out' : ''}">
              <div class="m-name m-name-row"><span class="m-new">足した商品</span>${mv}</div>
              <label class="m-field m-wide"><span>名前</span><input type="text" data-f="add:name:${esc(a.id)}" value="${esc(a.name)}" maxlength="60" placeholder="例：チーズハンバーグBOX"></label>
              <label class="m-field m-wide"><span>名前の下の小さな字（なくても構いません）</span><input type="text" data-f="add:sub:${esc(a.id)}" value="${esc(a.sub || '')}" maxlength="40" placeholder="例：ごはん付き"></label>
              <label class="m-field m-wide"><span>説明（なくても構いません）</span><input type="text" data-f="add:desc:${esc(a.id)}" value="${esc(a.desc || '')}" maxlength="120"></label>
              <label class="m-field m-wide"><span>選ぶもの（ソース・ご飯の量など）</span><select data-f="add:like:${esc(a.id)}">${LIKE_OPTS().map(([v, t]) => `<option value="${esc(v)}" ${(a.like || '') === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
              <div class="m-prices">${addPriceIn(`add:price:${a.id}`, a.price, acaiLike ? 'ミニ' : '')}${acaiLike ? addPriceIn(`add:regular:${a.id}`, a.regular, 'レギュラー') : ''}</div>
              <div class="m-flags">${flagIn(`item:soldOut:${a.id}`, o.soldOut, '売り切れ')}${flagIn(`item:hidden:${a.id}`, o.hidden, '出さない')}</div>
            </div>`;
        }
        const i = ITEM_BY_ID[x.id], b = CONTENT_BASE.items[ITEMS.indexOf(i)];
        return `<div class="m-row ${o.hidden ? 'is-hidden' : ''} ${o.soldOut ? 'is-out' : ''}">
            <div class="m-name m-name-row"><b>${esc(i.full || i.name)}</b>${mv}</div>
            <div class="m-prices">${b.regular != null
              ? priceIn(`item:price:${i.id}`, o.price, b.price, 'ミニ') + priceIn(`item:regular:${i.id}`, o.regular, b.regular, 'レギュラー')
              : priceIn(`item:price:${i.id}`, o.price, b.price)}</div>
            <div class="m-flags">${flagIn(`item:soldOut:${i.id}`, o.soldOut, '売り切れ')}${flagIn(`item:hidden:${i.id}`, o.hidden, '出さない')}</div>
          </div>`;
      }).join('')}
      <button class="m-btn m-sub" data-act="item-add" data-cat="${esc(cat.id)}">＋ ${esc(cat.name)}に商品を足す</button>
    </section>`;
    }).join('')
    + (removed.length ? `<section class="m-sec"><h2>消した商品</h2><p class="m-hint">公式アプリには出ません。「戻す」で、もとの場所に戻ります。</p>${removed.map(i => `<div class="m-order-row"><b>${esc(i.full || i.name)}</b><button class="m-btn m-sub m-back" data-act="item-back" data-key="${esc(i.id)}">戻す</button></div>`).join('')}</section>` : '')
    + '<p class="m-hint">「売り切れ」は、メニューに出したまま押せなくします。「出さない」は、メニューに並べません。どちらも、戻すまでそのままです。「削除」は、メニューから外します（data.js の商品は、下の「消した商品」から戻せます）。足した商品の写真は「写真」のタブで入れます。</p>';
}
/** 足した商品の値段の欄（もとの値段が無いので、直した印は付けない） */
const addPriceIn = (f, v, label = '') => `<label class="m-price">${label ? `<em>${esc(label)}</em>` : ''}<span>¥</span><input type="text" inputmode="numeric" data-f="${esc(f)}" value="${v ?? ''}" placeholder="0" aria-label="${label || '値段'}"></label>`;

function choicesHtml() {
  return `<p class="m-hint">ご飯の量・セット・トッピングなど、商品を選ぶ画面で選ぶものです。同じものを使う商品すべてに効きます。「なし」「普通」は直せません。</p>`
    + CONTENT_BASE.groups.map(({ g, ps }) => {
      const users = ITEMS.filter(i => i.groups.includes(g)).map(i => i.full || i.name);
      const rows = g.choices.map((c, k) => ({ c, base: ps[k] })).filter(({ c }) => !c.plain && !c.none);
      if (!rows.length) return '';
      return `<section class="m-sec">
          <h2>${esc(g.name)}</h2>
          <p class="m-hint">${esc(users.join('・'))}</p>
          ${rows.map(({ c, base }) => {
            const key = contentKey.choice(g, c), o = ov('choices', key);
            return `<div class="m-row ${o.soldOut ? 'is-out' : ''}">
                <b class="m-name">${esc(c.n)}</b>
                <div class="m-prices">${priceIn(`choice:p:${key}`, o.p, base, g.type === 'count' ? '1個' : '足す')}</div>
                <div class="m-flags">${flagIn(`choice:soldOut:${key}`, o.soldOut, '売り切れ')}</div>
              </div>`;
          }).join('')}
        </section>`;
    }).join('');
}

/** 店内のメニューの見出し（並べた順） */
const mDineCats = () => orderBy(DINE_IN, c => c.name, menuDraft().dineCats);
/** その見出しの品（並べた順。足した品も。消したものは入れない）。key は並びに使う字（data.js の品は名前、足した品は id） */
function mDine(cat, ordered = true) {
  const m = menuDraft(), removed = new Set(m.dineRemoved || []);
  const list = [...cat.items.filter(it => !removed.has(contentKey.dine(cat, it))).map(it => ({ key: it.n, it })), ...(m.dineAdded || []).filter(a => a.cat === cat.name).map(a => ({ key: a.id, add: a }))];
  return ordered ? orderBy(list, x => x.key, (m.dineOrder || {})[cat.name]) : list;
}
function dineHtml() {
  const cats = mDineCats(), m = menuDraft();
  const removed = DINE_IN.flatMap(cat => cat.items.filter(it => (m.dineRemoved || []).includes(contentKey.dine(cat, it))).map(it => ({ cat, it })));
  return '<p class="m-hint">お店の情報の「店内のメニュー」（見るだけのメニュー）です。</p>'
    + `<section class="m-sec"><h2>見出しの順番</h2>${cats.map((c, i) => `<div class="m-order-row"><b>${esc(c.name)}</b>${moveBtns('dcat-move', c.name, i, cats.length)}</div>`).join('')}</section>`
    + cats.map(cat => {
      const list = mDine(cat), a0 = DINE_IN.indexOf(cat);
      return `<section class="m-sec">
      <h2>${esc(cat.name)}</h2>
      ${list.map((x, n) => {
        const del = `<button data-act="dine-del" data-key="${esc(cat.name + '|' + x.key)}" class="danger">削除</button>`, mv = moveBtns('dine-move', `${cat.name}|${x.key}`, n, list.length, del);
        if (x.add) {
          const a = x.add, key = `${cat.name}/${a.n}`, o = ov('dine', key);
          return `<div class="m-row m-added ${o.hidden ? 'is-hidden' : ''}">
              <div class="m-name m-name-row"><span class="m-new">足した品</span>${mv}</div>
              <label class="m-field m-wide"><span>名前</span><input type="text" data-f="dadd:n:${esc(a.id)}" value="${esc(a.n)}" maxlength="60"></label>
              <label class="m-field m-wide"><span>説明（なくても構いません）</span><input type="text" data-f="dadd:d:${esc(a.id)}" value="${esc(a.d || '')}" maxlength="120"></label>
              <div class="m-prices">${addPriceIn(`dadd:p:${a.id}`, a.p)}</div>
              <div class="m-flags">${flagIn(`dine:hidden:${key}`, o.hidden, '出さない')}</div>
            </div>`;
        }
        const it = x.it, b = cat.items.indexOf(it), base = CONTENT_BASE.dine[a0][b], key = contentKey.dine(cat, it), o = ov('dine', key);
        const prices = base.sizes
          ? it.sizes.map((sz, k) => priceIn(`dine:size:${key}:${k}`, Array.isArray(o.sizes) ? o.sizes[k] ?? null : null, base.sizes[k], sz[0])).join('')
          : priceIn(`dine:p:${key}`, o.p, base.p);
        return `<div class="m-row ${o.hidden ? 'is-hidden' : ''}">
            <div class="m-name m-name-row"><b>${esc(it.n)}</b>${mv}</div>
            <div class="m-prices">${prices}</div>
            <div class="m-flags">${flagIn(`dine:hidden:${key}`, o.hidden, '出さない')}</div>
          </div>`;
      }).join('')}
      <button class="m-btn m-sub" data-act="dine-add" data-cat="${esc(cat.name)}">＋ ${esc(cat.name)}に品を足す</button>
    </section>`;
    }).join('')
    + (removed.length ? `<section class="m-sec"><h2>消した品</h2><p class="m-hint">公式アプリには出ません。「戻す」で、もとの場所に戻ります。</p>${removed.map(({ cat, it }) => `<div class="m-order-row"><b>${esc(cat.name)}：${esc(it.n)}</b><button class="m-btn m-sub m-back" data-act="dine-back" data-key="${esc(contentKey.dine(cat, it))}">戻す</button></div>`).join('')}</section>` : '');
}

function rewardsHtml() {
  return '<p class="m-hint">スタンプカードの特典です。選べるものは1行に1つずつ書いてください（お客さまは、使うときにどれか1つを選びます）。</p>'
    + STAMP.rewards.map((r, k) => {
      const b = CONTENT_BASE.rewards[k], o = ov('rewards', r.at);
      return `<section class="m-sec">
          <h2>${r.at}個${r.goal ? '（ゴール）' : ''}</h2>
          ${b.title !== undefined ? `<label class="m-field"><span>大きく出す名前</span><input type="text" data-f="reward:title:${r.at}" value="${esc(o.title ?? b.title)}" maxlength="40"></label>` : ''}
          <label class="m-field"><span>選べるもの（1行に1つ）</span><textarea data-f="reward:options:${r.at}" rows="${Math.max(2, (o.options || b.options).length)}">${esc((o.options || b.options).join('\n'))}</textarea></label>
          ${b.picks ? `<label class="m-field"><span>小さな札に出す短い名前（上と同じ順に、1行に1つ）</span><textarea data-f="reward:picks:${r.at}" rows="${(o.picks || b.picks).length}">${esc((o.picks || b.picks).join('\n'))}</textarea></label>` : ''}
          ${Object.keys(o).length ? `<button class="m-btn m-sub" data-act="reward-reset" data-at="${r.at}">もとに戻す</button>` : ''}
        </section>`;
    }).join('');
}

/* ---- 写真（2026-11-04 ko-dai さんの指示：「マネージで写真も変更できるように」） ----
 *  選んだ写真は、端末の中で長い辺を PHOTO_MAX まで縮めて JPEG にし、すぐ受け口の savePhoto へ送る（受け口が Google ドライブに置き、id を返す）。
 *  どの写真を使うかは、ほかの直しと同じく draft の photos（{ 場所: { id } }）に入れ、上の「保存」で公式アプリに出る（それまでは、お客様には見えない）。
 *  出すときの URL は、公式アプリの content.js の photoUrl（1か所だけ）。data.js の写真は img/menu/ の名前のまま */
const PHOTO_MAX = 1600, PHOTO_BYTES = 2 * 1024 * 1024;   // 受け口が受ける大きさは1枚 2MB まで（版 2026-11-04b）
let photoBusy = '', photoErr = {};
const PHOTO_MSG = {
  bad_type: 'この写真の種類は送れません。JPEG・PNG の写真を選んでください。',
  bad_input: 'この写真は送れませんでした。ほかの写真を選んでください。',
  too_big: '写真が大きすぎて送れませんでした。ほかの写真を選んでください。',
  busy: '写真を続けて送りすぎました。10分ほど待ってから、もう一度選んでください。',
  share_failed: 'Google ドライブで、写真をアプリに出せる形にできませんでした。予約ボードのセッションに知らせてください。',
  not_setup: '受け口の準備（setup）がまだです。予約ボードのセッションの案内で、setup を動かしてください。',
};
/** 写真の場所の一覧 { slot, name, base（data.js の写真。無ければ ''） } */
function photoSlots() {
  return [
    { head: 'お店の写真', rows: [{ slot: 'hero', name: 'ホームのいちばん上の大きな写真', base: CONTENT_BASE.photos.hero }, { slot: 'shop', name: 'お店の情報の写真', base: CONTENT_BASE.photos.shop }] },
    ...mCats().map(cat => ({ head: `テイクアウト：${cat.name}`, rows: mItems(cat.id).map(x => (x.add
      ? { slot: 'item:' + x.id, name: x.add.name || '（名前のない足した商品）', base: '' }
      : { slot: 'item:' + x.id, name: ITEM_BY_ID[x.id].full || ITEM_BY_ID[x.id].name, base: CONTENT_BASE.photos.items[ITEMS.indexOf(ITEM_BY_ID[x.id])].img })) })),
    ...mDineCats().map(cat => ({ head: `店内のメニュー：${cat.name}`, rows: mDine(cat).map(x => (x.add
      ? { slot: 'dine:' + `${cat.name}/${x.add.n}`, name: x.add.n || '（名前のない足した品）', base: '' }
      : { slot: 'dine:' + contentKey.dine(cat, x.it), name: x.it.n, base: CONTENT_BASE.photos.dine[DINE_IN.indexOf(cat)][cat.items.indexOf(x.it)] })) })),
  ].filter(g => g.rows.length);
}
/** data.js の写真の場所（公式アプリの公開先か、この Mac の ../） */
const appImg = img => !img ? '' : /^https:\/\//.test(img) ? img : (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '../' : SHOP.appUrl) + (img.startsWith('img/') ? img : 'img/menu/' + img);
const photoNow = slot => { const id = draft.photos?.[slot]?.id; return typeof id === 'string' && PHOTO_ID.test(id) ? photoUrl(id) : ''; };

function photosHtml() {
  return `<p class="m-hint">公式アプリの写真を入れかえます。「写真を選ぶ」で選んだ写真は、すぐ受け口（Google ドライブ）に送ります。お客様に見えるのは、上の「保存」を押してからです。写真の無い商品にも足せます。</p>
    <p class="m-hint">写真は、長い辺を${PHOTO_MAX}px までに縮めて送ります。商品の写真は、横長か正方形がきれいに出ます。</p>`
    + photoSlots().map(g => `<section class="m-sec"><h2>${esc(g.head)}</h2>${g.rows.map(r => {
      const now = photoNow(r.slot), src = now || appImg(r.base), busyHere = photoBusy === r.slot;
      return `<div class="m-photo ${now ? 'is-changed' : ''}">
          ${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : '<span class="m-photo-none">写真なし</span>'}
          <div class="m-photo-name"><b>${esc(r.name)}</b><small>${busyHere ? '送っています…' : now ? '入れかえた写真' : r.base ? 'もとの写真' : ''}</small>${photoErr[r.slot] ? `<small class="m-photo-err">${esc(photoErr[r.slot])}</small>` : ''}</div>
          <div class="m-photo-btns">
            <label class="m-btn m-sub ${busyHere || photoBusy ? 'is-off' : ''}">写真を選ぶ<input type="file" accept="image/*" data-photo="${esc(r.slot)}" ${photoBusy ? 'disabled' : ''} hidden></label>
            ${now ? `<button class="m-btn m-sub" data-act="photo-reset" data-slot="${esc(r.slot)}">もとに戻す</button>` : ''}
          </div>
        </div>`;
    }).join('')}</section>`).join('');
}
/** 写真を縮めて JPEG の base64 にする（iPhone の写真の向きは、ブラウザが直してから描く） */
async function shrinkPhoto(file) {
  const img = await new Promise((ok, ng) => {
    const u = URL.createObjectURL(file), im = new Image();
    im.onload = () => { URL.revokeObjectURL(u); ok(im); };
    im.onerror = () => { URL.revokeObjectURL(u); ng(Object.assign(new Error('bad_image'), { code: 'bad_image' })); };
    im.src = u;
  });
  // 2MB を超えるときは、すこしずつ縮める（ふつうの写真は、はじめの形で 1MB より小さい）
  for (const [side, q] of [[PHOTO_MAX, 0.82], [PHOTO_MAX, 0.7], [1280, 0.7], [1024, 0.6]]) {
    const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * k));
    cv.height = Math.max(1, Math.round(img.naturalHeight * k));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    const data = cv.toDataURL('image/jpeg', q).split(',')[1];
    if (data.length * 3 / 4 <= PHOTO_BYTES * 0.95) return data;
  }
  throw Object.assign(new Error('too_big'), { code: 'too_big' });
}
async function choosePhoto(input) {
  const slot = input.dataset.photo, file = input.files?.[0];
  input.value = '';
  if (!file || photoBusy || !server) return;
  photoBusy = slot;
  delete photoErr[slot];
  render();
  try {
    const data = await shrinkPhoto(file);
    const r = await post({ action: 'savePhoto', pin, slot, type: 'image/jpeg', data });
    if (typeof r.id !== 'string' || !PHOTO_ID.test(r.id)) throw Object.assign(new Error('no_answer'), { code: 'no_answer' });
    setOv('photos', slot, 'id', r.id);
  } catch (err) {
    photoErr[slot] = PHOTO_MSG[err.code] || message(err);
    if (err.code === 'bad_pin' || err.code === 'locked') { alert(message(err)); server = null; pin = ''; if (err.code === 'bad_pin') pinSet(''); }
  }
  photoBusy = '';
  render();
}

/* ---- 文章：アプリの画面に出る文を全部直せる（一覧は js/texts.js。道具/文章を集める.py が作る） ---- */
let textQuery = '', textOnly = false;
const textOpen = new Set();
const textRows = at => APP_TEXTS.filter(r => r.at === at);
const textAts = [...new Set(APP_TEXTS.map(r => r.at))];

function textRow(r) {
  const to = draft.texts?.[r.t]?.to;
  return `<div class="m-text ${to ? 'is-edited' : ''}">
      <div class="m-text-top"><small>${esc(r.t)}</small><button class="m-see" data-act="see-text" data-i="${APP_TEXTS.indexOf(r)}">アプリで見る</button></div>
      <textarea data-f="text:to:${APP_TEXTS.indexOf(r)}" rows="${Math.min(5, Math.ceil(r.t.length / 20) || 1)}" aria-label="直した文">${esc(to ?? r.t)}</textarea>
    </div>`;
}

/** 画面で枠ごと直した文（数字などが入る文。{1} などは ◯ で見せる）。ここでは元に戻すだけ。直すのは「画面で直す」で */
const frameKeys = () => Object.keys(draft.texts || {}).filter(k => draft.texts[k].x === 1 || !APP_KEYS.has(k));   // 枠ごとの形と、一覧に無い文をまるごと直したもの
function frameRow(k) {
  const show = t => esc(t.replace(/\{\d+\}/g, '◯'));
  return `<div class="m-text is-edited">
      <div class="m-text-top"><small>${draft.texts[k].x === 1 ? '枠ごと' : draft.texts[k].x === 2 ? '飾りの字ごと' : 'まるごと'}・元の文：${show(k)}</small><button class="m-ed-undo" data-act="frame-reset" data-k="${esc(k)}">元の文に戻す</button></div>
      <p class="m-frame-to">${show(draft.texts[k].to)}</p>
    </div>`;
}
function textListHtml() {
  const q = textQuery.trim(), hits = (q || textOnly) && APP_TEXTS.filter(r => (!q || r.t.includes(q) || draft.texts?.[r.t]?.to.includes(q)) && (!textOnly || draft.texts?.[r.t]));
  const frames = frameKeys().filter(k => !q || k.includes(q) || draft.texts[k].to.includes(q));
  const fnote = '<p class="m-hint">「枠ごと」は、画面で直す で、数字などが入る文をまるごと直したものです。◯ には、数字など、その時の字が入ります。「まるごと」は、この一覧に無い文を、画面で直す でまるごと直したものです。直すのは「画面で直す」でしてください。</p>';
  if (hits) {
    return `<p class="m-hint">${hits.length + frames.length}件${hits.length > 60 ? '（はじめの60件を出しています。言葉をしぼってください）' : ''}</p>${frames.length ? fnote + frames.map(frameRow).join('') : ''}${hits.slice(0, 60).map(textRow).join('')}`;
  }
  const all = frameKeys();
  return (all.length ? `<button class="m-group ${textOpen.has('*frames') ? 'on' : ''}" data-act="text-group" data-at="*frames"><b>画面で枠ごと・まるごと直した文</b><small>${all.length}件</small></button>
      ${textOpen.has('*frames') ? fnote + all.map(frameRow).join('') : ''}` : '') + textAts.map(at => {
    const rows = textRows(at), n = rows.filter(r => draft.texts?.[r.t]).length;
    return `<button class="m-group ${textOpen.has(at) ? 'on' : ''}" data-act="text-group" data-at="${esc(at)}"><b>${esc(at)}</b><small>${rows.length}件${n ? `・${n}件直しました` : ''}</small></button>
      ${textOpen.has(at) ? rows.map(textRow).join('') : ''}`;
  }).join('');
}

function textsHtml() {
  const sw = `<div class="m-switch">${[['screen', '画面で直す'], ['list', '一覧で直す']].map(([k, n]) => `<button data-act="text-mode" data-mode="${k}" class="${textMode === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  if (textMode === 'screen') {
    return `<section class="m-sec">
      <h2>アプリの文章</h2>
      ${sw}
      <p class="m-hint">点線の枠を押すと、その枠の文をまるごと、アプリの下の欄で直せます（欄の幅と字の形はアプリと同じなので、改行の場所も同じになります）。保存するまで、お客様には見えません。押して開く所（商品を選ぶ画面など）は「アプリを動かす」で開いてから、「文を押して直す」に戻して押します。</p>
    </section>`;
  }
  return `<section class="m-sec">
      <h2>アプリの文章</h2>
      ${sw}
      <p class="m-hint">公式アプリの画面に出る文を、全部ここで直せます。上の小さい字が元の文です。改行すると、アプリでも改行されます。「アプリで見る」で、保存する前に見え方を確かめられます。空にすると元の文に戻ります。下から見出しを開くか、言葉で探してください。</p>
      <p class="m-hint">数字などが間に入る文は、前後に分かれて出ます。お知らせ・値段・売り切れ・特典は、それぞれのタブで直してください。</p>
      <input id="textSearch" type="search" value="${esc(textQuery)}" placeholder="言葉で探す（例：受け取り）" aria-label="言葉で探す">
      <label class="m-only"><input id="textOnly" type="checkbox" ${textOnly ? 'checked' : ''}>直したものだけ出す（${Object.keys(draft.texts || {}).length}件）</label>
    </section>
    <div id="textList">${textListHtml()}</div>`;
}

/* ---- 文章の「画面で直す」（2026-11-03 ko-dai さんの指示：ホームページの管理画面のように、実際の画面を直しているような感じで文章を直す） ----
 *  本物の公式アプリを中に開き（?preview&edit。公式アプリの js/content.js の TEXT_EDIT）、点線の文を押すと、下の欄で直せる。打ったそばから画面に出る。
 *  保存は上の「保存」（ほかのタブと同じ）。お客様には、保存するまで見えない（「アプリで見る」と同じく、直しは sessionStorage の bg.preview で渡す）。
 *  中のアプリは、描き直しのたびに読み直さないよう、#view の外（#edit）に1回だけ作る。やりとりは同じ場所のページとだけ（postMessage） */
let textMode = 'screen';
let ed = null;      // { frame, route, on（文を押して直す）, cur（直している文。edCand の形。無ければ null）, cands（押した所の文。押す前は null）, base }
const ED_W = 390;   // 中のアプリの幅（スマホと同じ幅にして、改行の位置をそろえる）
const editUrl = route => seeUrl(route).replace('preview#', 'preview&edit#');
const edPost = msg => ed?.frame?.contentWindow?.postMessage({ type: 'baguru-manage', ...msg }, location.origin);
const notTexts = () => canon({ ...draft, texts: undefined });
const oneLine = t => String(t).replace(/\s+/g, ' ').trim();
const edKey = c => (c?.news ? { key: '', s: 0, x: 0, news: { i: c.ai, f: c.f } } : { key: c?.key || '', s: c?.s || 0, x: c?.x || 0 });
const tokens = t => [...String(t).matchAll(/\{(\d+)\}/g)].map(m => m[1]).join(',');

/* 枠ごとまるごと直す（2026-11-04 ko-dai さんの指示：「文章がすごく分割されてしまうので、アプリで表示されている枠を選択して、その枠内を全て編集できるように。改行の場所もアプリと全く同じに」）
 *  ・押した字のかたまり（点線の枠）が、文章の一覧の文と同じなら、その文を直す（今までと同じ）
 *  ・数字などが間に入る文は、枠ごとの形（js/texts.js の APP_FRAMES。'配達は{1}食以上…'）で直す。{1} などは「変わる字」として、直す欄では色を付けて出し、
 *    打てないようにする（消すことはできる）。保存は texts の { to, x: 1 }。公式アプリが {1} などに、画面のその時の字を入れて出す（content.js の tplText）
 *  ・直す欄は、アプリの枠と同じ幅・同じ字の形・同じ字の大きさにする（中のアプリが edStyle で知らせる）。だから改行の場所がアプリと同じになる
 *  ・どちらにも合わない字（一覧に無い文。data.js の長い説明など）も、点線の枠の文なら、字のかたまり全体をそのまま1つの文として直す（2026-11-04 ko-dai さんの指示：「まだ分割されている部分があるので、文章全体を」）。
 *    ★字のかたまり全体が同じときだけ置きかわる（s: 0）。点線の無い字（値段・数字・お客様が入れた字）は直さない
 *  ・お知らせのタイトルと本文は、お知らせのタブと同じもの（draft.news）を直す（文章の置きかえにはしない）。打つたびに、中のアプリへ中身ごと送って描き直す
 *  ・文の途中に飾りの字（太字・色の字など）が入る文は、飾りを {1} などの打てない字にして、文全体を1つの欄で直す（x: 2。content.js の runSig・runMark）。
 *    飾りは消せない（消したり順を入れかえたりすると、保存せずに知らせる）。地の字に数字がある文（お客様ごとに変わる）は、前のとおり分けて直す */
const APP_KEYS = new Map(APP_TEXTS.map((r, i) => [r.t, i]));
const FRAMES = APP_FRAMES.map(f => ({ ...f, ...tplRe(f.t), lit: f.t.replace(/\{\d+\}/g, '').length }));
/** 枠ごとの形の一覧（js/texts.js のものと、前に直したけれど今の一覧に無いもの） */
const frameList = () => [...FRAMES, ...Object.entries(draft.texts || {}).filter(([k, v]) => v.x === 1 && !FRAMES.some(f => f.t === k))
  .map(([k]) => ({ at: '画面で枠ごと直した文', t: k, ...tplRe(k), lit: k.replace(/\{\d+\}/g, '').length }))];
/** 押した字のかたまり（{ t: 元の字, st: 並び方 }）から、直す文を決める。合うものが無ければ null */
function edCand(it) {
  const t = String(it?.t || '').trim(), st = it?.st && typeof it.st === 'object' ? it.st : null;
  if (!t) return null;
  if (APP_KEYS.has(t)) { const r = APP_TEXTS[APP_KEYS.get(t)]; return { key: t, s: r.s, x: 0, at: r.at, st }; }
  const f = frameList().filter(x => x.re.test(t)).sort((a, b) => b.lit - a.lit)[0];
  if (!f || f.lit < 4) return null;   // 「◯ポイント」のように、変わらない字が少ない形では直さない（ほかの文まで変わるため）
  const m = t.match(f.re), vals = {};
  f.nums.forEach((n, i) => { vals[n] = m[i + 1]; });
  return { key: f.t, s: 0, x: 1, at: f.at, st, vals };
}
/** 文の一部として入る文（前からの形）。並び方は付けない（枠の一部だけなので、幅をそろえても改行は合わない） */
const edPartCands = t => edRows([t]).map(i => ({ key: APP_TEXTS[i].t, s: APP_TEXTS[i].s, x: 0, at: APP_TEXTS[i].at, st: null }));
/** 文の一部の直し（s: 1）を、枠ごとの形の変わらない字に入れる（直す欄のはじめの字。今アプリに出ている字と同じになる） */
function edPartial(t) {
  const m = new Map(Object.entries(draft.texts || {}).filter(([, v]) => v.s && v.x !== 1).map(([k, v]) => [k, v.to]));
  if (!m.size) return t;
  return t.replace(new RegExp([...m.keys()].sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), x => m.get(x));
}
/** 中のアプリのお知らせの番号 → newsList の番号（日付かタイトルの無いものは、アプリに出ないので数えない。content.js の applyContent と同じ） */
const newsAt = ai => newsList().map((n, k) => [n, k]).filter(([n]) => /^\d{4}-\d{2}-\d{2}$/.test(n.date) && String(n.title || '').trim())[ai]?.[1];
/** 直す文の、今の字（{1} などはそのまま） */
const edNow = c => (c.news ? String(newsList()[c.i]?.[c.f] ?? '') : draft.texts?.[c.key]?.to ?? (c.x ? edPartial(c.key) : c.key));
/** 画面に出る形（{1} などに、押した所の字を入れる） */
const edShow = c => edNow(c).replace(/\{(\d+)\}/g, (m, n) => c.vals?.[n] ?? '◯');

function editStore() {
  try { sessionStorage.setItem('bg.preview', JSON.stringify(draft)); sessionStorage.setItem('bg.previewFocus', ''); } catch (e) { /* 出せないだけ */ }
}
/** 文章のタブで「画面で直す」のときだけ出す。ほかのタブで直した分（値段など）があれば、入れて開き直す */
function editShow() {
  const box = $('#edit'), on = !!server && tab === 'texts' && textMode === 'screen';
  box.hidden = !on;
  if (!on) return;
  if (!ed) editBuild(box);
  else if (ed.base !== notTexts()) { ed.base = notTexts(); editStore(); ed.frame.contentWindow?.location.reload(); }
  else edSend();
  editFit();
}
function editBuild(box) {
  editStore();
  ed = { route: 'home', on: true, cur: null, cands: null, base: notTexts(), frame: null };
  box.innerHTML = `
    <nav class="m-ed-tabs" aria-label="画面">${SEE_SCREENS.map(([k, n]) => `<button data-act="ed-go" data-route="${k}" class="${k === ed.route ? 'on' : ''}">${n}</button>`).join('')}</nav>
    <div class="m-ed-mode" role="group" aria-label="押したときの動き"><button data-act="ed-mode" data-on="1" class="on">文を押して直す</button><button data-act="ed-mode" data-on="0">アプリを動かす</button></div>
    <div class="m-ed-frame"><iframe title="公式アプリの画面" src="${esc(editUrl(ed.route))}"></iframe></div>
    <div id="edPanel" class="m-ed-panel"></div>`;
  ed.frame = $('iframe', box);
  edPanel();
}
/** 中のアプリを、スマホの幅のまま、枠に合わせて縮める */
function editFit() {
  if (!ed || $('#edit').hidden) return;
  const pv = ed.frame.parentNode, s = Math.min(1, pv.clientWidth / ED_W);
  Object.assign(ed.frame.style, {
    width: ED_W + 'px', height: Math.ceil(pv.clientHeight / s) + 'px', transform: `scale(${s})`,
    left: Math.max(0, Math.round((pv.clientWidth - ED_W * s) / 2)) + 'px',
  });
}
addEventListener('resize', editFit);

/** 直した文を、中のアプリに送る（開き直したときのために sessionStorage にも置く） */
function edSend() {
  if (!ed) return;
  editStore();
  edPost({ kind: 'texts', texts: draft.texts || {} });
}

/** 直す欄の上（どこの文か・元の文・元の文に戻す）。打っているあいだは、ここだけ描き直す */
function edHeadHtml() {
  const c = ed.cur;
  if (c.news) return `<div class="m-text-top"><small>お知らせの${c.f === 'title' ? 'タイトル' : '本文'}（「お知らせ」のタブと同じものを直します）</small></div>`;
  const edited = !!draft.texts?.[c.key], show = t => esc(t.replace(/\{(\d+)\}/g, (m, n) => c.vals?.[n] ?? '◯'));
  return `<div class="m-text-top"><small>${esc(c.at)}${c.x === 1 ? '・枠ごと' : c.x === 2 ? '・飾りの字ごと' : ''}${edited ? `<br>元の文：${show(c.key)}` : ''}</small>${edited ? '<button class="m-ed-undo" data-act="ed-undo">元の文に戻す</button>' : ''}</div>`;
}
function edPanelHtml() {
  if (!ed || !ed.cur) {
    if (ed?.cands?.length) {
      return `<p class="m-ed-q">ここには、直せる文が${ed.cands.length}つあります。どれを直しますか？</p>
        ${ed.cands.map((c, i) => `<button class="m-ed-cand" data-act="ed-cand" data-i="${i}"><b>${esc(oneLine(edShow(c)))}</b><small>${esc(c.at)}${c.x === 1 ? '・枠ごと' : c.x === 2 ? '・文全体' : c.only ? '・その字だけ' : ''}</small></button>`).join('')}`;
    }
    if (ed?.cands) return '<p class="m-ed-q">この字は、ここでは直せません。</p><p class="m-hint">値段・売り切れ・お知らせ・一言・特典の中身は、それぞれのタブで直します。数字や、お客様が入れた字は直せません。</p>';
    return '<p class="m-ed-q">上の画面で、直したい文（点線で囲んだ文）を押してください。</p>';
  }
  const c = ed.cur;
  // 直す欄。{1} などは、色を付けた打てない字（m-chip）にする。字の形と幅は、あとで edMirror がアプリの枠に合わせる
  const body = edNow(c).split(/\{(\d+)\}/).map((p, i) => (i % 2 ? (c.vals?.[p] !== undefined ? `<span class="m-chip" contenteditable="false" data-k="${p}">${esc(c.vals[p])}</span>` : '') : esc(p))).join('');
  return `<div class="m-text ${!c.news && draft.texts?.[c.key] ? 'is-edited' : ''}">
      <div id="edHead">${edHeadHtml()}</div>
      <div class="m-ed-wrap"><div id="edMirror" class="m-ed-mirror ${c.st ? 'is-same' : ''}" role="textbox" aria-multiline="true" aria-label="直した文">${body}</div></div>
      <p class="m-hint">${c.st ? 'この欄は、アプリの枠と同じ幅・同じ字の大きさです。改行の場所も、アプリと同じになります。' : ''}打ったそばから、上の画面の字が変わります。${c.news && c.f === 'title' ? 'タイトルは1行で出ます（長いと字が小さくなります）。' : '改行すると、アプリでも改行されます。'}${c.news ? '' : '全部消すと元の文に戻ります。'}${c.x === 1 ? '<br>色の付いた字（数字など）は、お店の設定やお客様ごとに変わる字です。打ち直せません（消すことはできます）。' : c.x === 2 ? '<br>色の付いた字は、アプリで太字などになっている字です。ここでは打ち直せず、消すこともできません（その字だけを直すときは、上の画面でその字を押して「その字だけ」を選びます）。' : ''}</p>
    </div>`;
}
/** 直す欄を、アプリの枠と同じ幅・同じ字の形にする（値は CSSOM で入れるので、変な値は入らない） */
function edMirror() {
  const el = $('#edMirror');
  if (!el) return;
  el.contentEditable = 'plaintext-only';
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';   // 古いブラウザ
  // 飾りの字（x: 2）は、アプリと同じ字の形・大きさ・すき間にする（幅がそろわないと、改行の場所がずれる）
  if (ed.cur?.cst) $$('.m-chip', el).forEach(ch => {
    const cs = ed.cur.cst[ch.dataset.k];
    if (cs && typeof cs === 'object') for (const [k, v] of Object.entries(cs)) if (typeof v === 'string' && v.length < 300 && k in ch.style) ch.style[k] = v;
  });
  const st = ed.cur?.st;
  if (!st) return;
  const w = Number(st.w), ind = Number(st.indent), max = Number(st.max);
  if (st.fit) {   // 字の長さに合わせて縮む枠（ボタンなど）：打った字に合わせて、アプリの枠が広がれる所まで広げる
    if (w >= 1 && w <= 2000) el.style.minWidth = w + 'px';
    el.style.width = 'max-content';
    if (max >= w && max <= 2000) el.style.maxWidth = max + 'px';
  } else if (w >= 10 && w <= 2000) el.style.width = (w + 0.02) + 'px';   // 0.02：小数の誤差で1字だけ折り返さないように
  if (ind > 0 && ind < w) el.style.textIndent = ind + 'px';
  for (const [k, v] of Object.entries({ fontFamily: st.fontFamily, fontSize: st.fontSize, fontWeight: st.fontWeight, fontStyle: st.fontStyle, letterSpacing: st.letterSpacing,
    lineHeight: st.lineHeight, wordBreak: st.wordBreak, overflowWrap: st.overflowWrap, lineBreak: st.lineBreak, fontFeatureSettings: st.fontFeatureSettings,
    textTransform: st.textTransform, textAlign: st.align, color: st.color })) if (typeof v === 'string' && v.length < 300) el.style[k] = v;
  if (/^(nowrap|pre)$/.test(st.whiteSpace)) el.style.whiteSpace = 'pre';
}
/** 直す欄の字を、保存する形にする（{1} などはそのまま。改行は \n） */
function edSerial(el) {
  let out = '';
  const walk = node => node.childNodes.forEach(x => {
    if (x.nodeType === 3) out += x.nodeValue;
    else if (x.dataset?.k) out += `{${x.dataset.k}}`;
    else if (x.nodeName === 'BR') out += '\n';
    else { if (/^(DIV|P)$/.test(x.nodeName) && out && !out.endsWith('\n')) out += '\n'; walk(x); }
  });
  walk(el);
  return out.replace(/ /g, ' ');
}
/** 直す欄で打ったとき：draft に写し、中のアプリの字を変える */
function edTyped(el) {
  const c = ed?.cur;
  if (!c || !server) return;
  if (c.news) {   // お知らせ：お知らせのタブと同じく draft.news に写し、中のアプリへ中身ごと送る
    const list = newsList().map(n => ({ ...n })), v = edSerial(el).replace(/\n+$/, '');
    list[c.i] = { ...list[c.i], [c.f]: c.f === 'title' ? v.replace(/\s*\n\s*/g, ' ') : v };
    draft.news = list;
    drawBar();
    editStore();
    ed.base = notTexts();   // 文章のタブに戻ったときに、中のアプリを開き直さないように
    return edPost({ kind: 'content', content: draft });
  }
  const to = edSerial(el).replace(/\n+$/, '').trim();
  if (c.x === 2 && to && tokens(to) !== tokens(c.key)) {   // 飾りを消した・順を変えた：保存しない
    $('#edHead').innerHTML = edHeadHtml() + '<p class="m-ed-warn">色の付いた字（太字などの飾り）は消せません。打つ前に戻す（元に戻す操作）か、「元の文に戻す」を押してください。</p>';
    return;
  }
  draft.texts ??= {};
  if (!to || to === c.key) delete draft.texts[c.key]; else draft.texts[c.key] = c.x === 2 ? { to, x: 2 } : c.x ? { to, x: 1 } : { to, s: c.s };
  if (!Object.keys(draft.texts).length) delete draft.texts;
  el.closest('.m-text').classList.toggle('is-edited', !!draft.texts?.[c.key]);
  $('#edHead').innerHTML = edHeadHtml();
  drawBar();
  edSend();
}
const edPanel = () => { const p = $('#edPanel'); if (p) { p.innerHTML = edPanelHtml(); edMirror(); } };
const edTabs = () => $$('[data-act="ed-go"]').forEach(x => x.classList.toggle('on', x.dataset.route === ed.route));

/** 押した所の字（元の字）から、文章の一覧の文を探す。全体が同じ文を先に、無ければ文の一部として入るもの（s: 1）を長い順に */
function edRows(list) {
  const out = [];
  for (const raw of list) {
    const t = String(raw).trim();
    if (!t) continue;
    const same = APP_TEXTS.flatMap((r, i) => (r.t === t ? [i] : []));
    out.push(...(same.length ? same : APP_TEXTS.flatMap((r, i) => (r.s && t.includes(r.t) ? [i] : [])).sort((a, b) => APP_TEXTS[b].t.length - APP_TEXTS[a].t.length)));
  }
  const seen = new Set();
  return out.filter(i => !seen.has(APP_TEXTS[i].t) && seen.add(APP_TEXTS[i].t));
}
/** 中のアプリで文を押したとき。押した枠の文を、まるごと直す。いくつかあれば選んでもらう */
function edOnPick(d) {
  const items = v => (Array.isArray(v) ? v.filter(x => x && typeof x.t === 'string' && x.t.length <= 2000).slice(0, 20) : []);
  const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 2000).slice(0, 20) : []);
  // 一覧の文 → 枠ごとの形 → どちらにも合わない点線の文は、字のかたまり全体を1つの文として（前は、文の一部ごとに分かれて出ていた）
  const whole = it => (it.mark && String(it.t).trim() ? [{ key: String(it.t).trim(), s: 0, x: 0, at: '画面の文（まるごと）', st: it.st && typeof it.st === 'object' ? it.st : null }] : edPartCands(it.t));
  const pick = list => list.flatMap(it => { const c = edCand(it); return c ? [c] : whole(it); });
  const main = items(d.main), nw = d.news, k = nw && Number.isInteger(nw.i) ? newsAt(nw.i) : undefined;
  if (k !== undefined && (nw.f === 'title' || nw.f === 'body')) {   // お知らせのタイトル・本文
    ed.cands = [{ news: true, ai: nw.i, i: k, f: nw.f, key: `news:${k}:${nw.f}`, at: 'お知らせ', st: nw.st && typeof nw.st === 'object' ? nw.st : null }];
    ed.cur = ed.cands[0];
    edPanel();
    return edPost({ kind: 'pick', ...edKey(ed.cur) });
  }
  const run = d.run && typeof d.run.key === 'string' && d.run.key.length <= 800 && /\{\d+\}/.test(d.run.key) ? d.run : null;
  let cands = run ? [{ key: run.key, s: 0, x: 2, at: '画面の文（まるごと）', vals: run.vals && typeof run.vals === 'object' ? run.vals : {}, cst: run.cst && typeof run.cst === 'object' ? run.cst : null, st: run.st && typeof run.st === 'object' ? run.st : null }] : pick(main);
  if (run?.inner) cands.push(...pick(main).map(c => ({ ...c, only: true })));   // 太字などの字そのものを押したときは、その字だけも選べる
  if (!cands.length) cands = pick(items(d.more));   // 字のない所（枠の余白など）を押したときは、まわりの字から
  cands.push(...edRows(strs(d.attrs)).map(i => ({ key: APP_TEXTS[i].t, s: APP_TEXTS[i].s, x: 0, at: APP_TEXTS[i].at, st: null })));
  const seen = new Set();
  cands = cands.filter(c => !seen.has(c.key) && seen.add(c.key)).slice(0, 8);
  ed.cands = cands;
  ed.cur = cands.length === 1 ? cands[0] : null;
  edPanel();
  edPost({ kind: 'pick', ...edKey(ed.cur) });
  // 中のアプリと直す欄が、いっしょに見えるところへ（上の帯とタブの下から）
  const top = $('#edit').getBoundingClientRect().top, under = $('.m-tabs')?.getBoundingClientRect().bottom || 0;
  if (Math.abs(top - under - 8) > 40) window.scrollTo({ top: window.scrollY + top - under - 8, behavior: 'smooth' });
}
function edAct(b) {
  if (!ed) return;
  const act = b.dataset.act;
  if (act === 'ed-go') { ed.route = b.dataset.route; edTabs(); return edPost({ kind: 'go', route: ed.route }); }
  if (act === 'ed-mode') {
    ed.on = b.dataset.on === '1';
    $$('[data-act="ed-mode"]').forEach(x => x.classList.toggle('on', x === b));
    return edPost({ kind: 'mode', on: ed.on });
  }
  if (act === 'ed-cand') { ed.cur = ed.cands?.[Number(b.dataset.i)] || null; edPanel(); return edPost({ kind: 'pick', ...edKey(ed.cur) }); }
  if (act === 'ed-undo' && ed.cur) {
    if (draft.texts) { delete draft.texts[ed.cur.key]; if (!Object.keys(draft.texts).length) delete draft.texts; }
    drawBar();
    edSend();
    edPanel();
  }
}
addEventListener('message', e => {
  if (!ed || e.source !== ed.frame?.contentWindow || e.origin !== location.origin) return;
  const d = e.data || {};
  if (d.type !== 'baguru-edit') return;
  if (d.kind === 'ready') {   // 中のアプリが開いた（開き直した）とき：直せる文の一覧・押したときの動き・直した文・直している文を渡す
    edPost({ kind: 'keys', exact: APP_TEXTS.map(r => r.t), part: APP_TEXTS.filter(r => r.s).map(r => r.t), frames: frameList().filter(f => f.lit >= 4).map(f => f.t) });
    edPost({ kind: 'mode', on: ed.on });
    edSend();
    edPost({ kind: 'pick', ...edKey(ed.cur) });
  }
  if ((d.kind === 'ready' || d.kind === 'route') && typeof d.route === 'string') { ed.route = d.route; edTabs(); }
  if (d.kind === 'pick') edOnPick(d);
});

/** 商品を並べる・足す・消す・戻すボタン。動いたら true */
function menuAct(b) {
  const act = b.dataset.act, key = b.dataset.key || '', dir = Number(b.dataset.dir), m = menuDraft();
  if (act === 'cat-move') { const ids = moved(mCats().map(c => c.id), key, dir); setMenu('cats', canon(ids) === canon(CATEGORIES.map(c => c.id)) ? null : ids); return true; }
  if (act === 'dcat-move') { const ns = moved(mDineCats().map(c => c.name), key, dir); setMenu('dineCats', canon(ns) === canon(DINE_IN.map(c => c.name)) ? null : ns); return true; }
  if (act === 'item-move') {   // data.js の順（足した商品は後ろ）に戻ったら、並びは消す
    const [cat, id] = key.split('|'), ids = moved(mItems(cat).map(x => x.id), id, dir), order = { ...(m.order || {}) };
    if (canon(ids) === canon(mItems(cat, false).map(x => x.id))) delete order[cat]; else order[cat] = ids;
    setMenu('order', order);
    return true;
  }
  if (act === 'dine-move') {
    const i = key.indexOf('|'), cat = DINE_IN.find(c => c.name === key.slice(0, i)), k = key.slice(i + 1), keys = moved(mDine(cat).map(x => x.key), k, dir), order = { ...(m.dineOrder || {}) };
    if (canon(keys) === canon(mDine(cat, false).map(x => x.key))) delete order[cat.name]; else order[cat.name] = keys;
    setMenu('dineOrder', order);
    return true;
  }
  if (act === 'item-add') {
    setMenu('added', [...(m.added || []), { id: newMenuId('n'), cat: b.dataset.cat, name: '', price: null, like: '' }]);   // 値段は入れてもらう（空のままでは保存しない）
    return true;
  }
  if (act === 'dine-add') {
    setMenu('dineAdded', [...(m.dineAdded || []), { id: newMenuId('m'), cat: b.dataset.cat, n: '', p: null }]);
    return true;
  }
  if (act === 'item-del') {
    const a = (m.added || []).find(x => x.id === key), name = a ? a.name || '（名前のない商品）' : ITEM_BY_ID[key]?.full || ITEM_BY_ID[key]?.name;
    if (!confirm(`「${name}」をメニューから削除します。${a ? '足した商品なので、もとには戻せません。' : '下の「消した商品」から戻せます。'}よろしいですか？`)) return true;
    if (a) {
      setMenu('added', (m.added || []).filter(x => x.id !== key));
      setOv('items', key, 'soldOut', undefined); setOv('items', key, 'hidden', undefined);
      if (draft.photos) { delete draft.photos['item:' + key]; if (!Object.keys(draft.photos).length) delete draft.photos; }
    } else setMenu('removed', [...(m.removed || []), key]);
    const order = { ...(m.order || {}) };
    Object.keys(order).forEach(c => { order[c] = order[c].filter(x => x !== key); if (!order[c].length) delete order[c]; });
    setMenu('order', order);
    return true;
  }
  if (act === 'item-back') { setMenu('removed', (m.removed || []).filter(x => x !== key)); return true; }
  if (act === 'dine-del') {
    const i = key.indexOf('|'), catName = key.slice(0, i), k = key.slice(i + 1), a = (m.dineAdded || []).find(x => x.id === k);
    if (!confirm(`「${a ? a.n || '（名前のない品）' : k}」を店内のメニューから削除します。${a ? '足した品なので、もとには戻せません。' : '下の「消した品」から戻せます。'}よろしいですか？`)) return true;
    if (a) {
      setMenu('dineAdded', (m.dineAdded || []).filter(x => x.id !== k));
      const dk = `${catName}/${a.n}`;
      if (draft.dine?.[dk]) { delete draft.dine[dk]; if (!Object.keys(draft.dine).length) delete draft.dine; }
      if (draft.photos) { delete draft.photos['dine:' + dk]; if (!Object.keys(draft.photos).length) delete draft.photos; }
    } else setMenu('dineRemoved', [...(m.dineRemoved || []), `${catName}/${k}`]);
    const order = { ...(m.dineOrder || {}) };
    if (order[catName]) { order[catName] = order[catName].filter(x => x !== k); if (!order[catName].length) delete order[catName]; }
    setMenu('dineOrder', order);
    return true;
  }
  if (act === 'dine-back') { setMenu('dineRemoved', (m.dineRemoved || []).filter(x => x !== key)); return true; }
  return false;
}
/* ---- 直す ---- */

/** 入れた値を draft に写す。値段は、もとと同じなら消す。チェックは、外したら消す */
function take(el) {
  const [kind, field, ...rest] = el.dataset.f.split(':');
  const key = rest.join(':');
  const v = el.type === 'checkbox' ? el.checked : el.value;
  if (kind === 'text') {
    const r = APP_TEXTS[Number(key)], to = String(v).trim();
    draft.texts ??= {};
    if (!to || to === r.t) delete draft.texts[r.t]; else draft.texts[r.t] = { to, s: r.s };
    if (!Object.keys(draft.texts).length) delete draft.texts;
    return;
  }
  if (kind === 'add' || kind === 'dadd') {   // 足した商品（テイクアウト）・足した品（店内）
    const listKey = kind === 'add' ? 'added' : 'dineAdded', list = (menuDraft()[listKey] || []).map(x => ({ ...x })), a = list.find(x => x.id === key);
    if (!a) return;
    const before = kind === 'dadd' ? `${a.cat}/${a.n}` : '';
    a[field] = ['price', 'regular', 'p'].includes(field) ? toNum(v) : String(v).trim();   // 値段は空なら null（受け口の版 2026-11-04c は、足した商品の値段が整数でないと保存しない）
    if (kind === 'dadd' && field === 'n') {   // 店内の品は「見出し/名前」で写真・出さないを持つので、名前を変えたら付け替える
      const after = `${a.cat}/${a.n}`;
      if (draft.dine?.[before]) { draft.dine[after] = draft.dine[before]; delete draft.dine[before]; }
      if (draft.photos?.['dine:' + before]) { draft.photos['dine:' + after] = draft.photos['dine:' + before]; delete draft.photos['dine:' + before]; }
    }
    if (field === 'regular' && a.regular == null) delete a.regular;   // レギュラーは無くてもよい（無ければミニと同じ値段）
    return setMenu(listKey, list);
  }
  if (kind === 'notice') {
    const n = { ...(draft.notice || {}), [field]: String(v).trim() };
    if (!n.text) delete draft.notice; else draft.notice = n.until ? n : { text: n.text };
    return;
  }
  if (kind === 'news') {
    const list = newsList(), i = Number(key);
    list[i] = { ...list[i], [field]: field === 'date' ? v : String(v) };
    draft.news = list;
    return;
  }
  if (kind === 'item') {
    const i = ITEM_BY_ID[key], b = CONTENT_BASE.items[ITEMS.indexOf(i)];
    if (field === 'soldOut' || field === 'hidden') return setOv('items', key, field, v || undefined);
    const n = toNum(v), base = field === 'regular' ? b.regular : b.price;
    return setOv('items', key, field, n == null || n === base ? undefined : n);
  }
  if (kind === 'choice') {
    if (field === 'soldOut') return setOv('choices', key, 'soldOut', v || undefined);
    const [gid, ...name] = key.split('/'), g = CONTENT_BASE.groups.find(x => x.g.id === gid);
    const base = g.ps[g.g.choices.findIndex(c => c.n === name.join('/'))], n = toNum(v);
    return setOv('choices', key, 'p', n == null || n === base ? undefined : n);
  }
  if (kind === 'dine') {
    if (field === 'hidden') return setOv('dine', key, 'hidden', v || undefined);
    const [catName, ...rest2] = (field === 'size' ? key.slice(0, key.lastIndexOf(':')) : key).split('/');
    const a = DINE_IN.findIndex(c => c.name === catName), b = DINE_IN[a].items.findIndex(x => x.n === rest2.join('/'));
    const base = CONTENT_BASE.dine[a][b], n = toNum(v);
    if (field === 'p') return setOv('dine', key, 'p', n == null || n === base.p ? undefined : n);
    const k = Number(key.slice(key.lastIndexOf(':') + 1)), dkey = key.slice(0, key.lastIndexOf(':'));
    const sizes = Array.isArray(ov('dine', dkey).sizes) ? ov('dine', dkey).sizes.slice() : base.sizes.map(() => null);
    sizes[k] = n == null || n === base.sizes[k] ? null : n;
    return setOv('dine', dkey, 'sizes', sizes.some(x => x != null) ? sizes : undefined);
  }
  if (kind === 'reward') {
    const r = STAMP.rewards.find(x => String(x.at) === key), b = CONTENT_BASE.rewards[STAMP.rewards.indexOf(r)];
    if (field === 'title') { const t = String(v).trim(); return setOv('rewards', key, 'title', !t || t === b.title ? undefined : t); }
    const list = lines(v), base = field === 'picks' ? b.picks : b.options;
    return setOv('rewards', key, field, !list.length || sameList(list, base) ? undefined : list);
  }
}

// お知らせのタイトルは1行なので、直す欄で改行させない
document.addEventListener('keydown', e => { if (e.target.id === 'edMirror' && e.key === 'Enter' && ed?.cur?.news && ed.cur.f === 'title') e.preventDefault(); });
document.addEventListener('input', e => {
  if (e.target.id === 'edMirror') return edTyped(e.target);   // 画面で直す：枠ごとの直す欄
  if (e.target.id === 'textSearch') { textQuery = e.target.value; $('#textList').innerHTML = textListHtml(); return; }   // 探す欄から指が離れないように、一覧だけ描き直す
  if (e.target.dataset.f && server) {
    take(e.target);
    drawBar();
    if (e.target.dataset.f.startsWith('text:')) edSend();   // 画面で直す：打ったそばから、中のアプリの字を変える
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'textOnly') { textOnly = e.target.checked; return render(); }
  if (e.target.dataset.photo) return choosePhoto(e.target);   // 写真のタブ：写真を選んだ
  if (!e.target.dataset.f || !server) return;
  take(e.target);
  if (e.target.dataset.f.startsWith('text:')) {   // 文章のタブは、書いている場所が動かないように描き直さない
    e.target.closest('.m-text').classList.toggle('is-edited', !!draft.texts?.[APP_TEXTS[Number(e.target.dataset.f.split(':')[2])].t]);
    if (e.target.closest('#edPanel')) edPanel();   // 画面で直す：「元の文」と「元の文に戻す」を出し入れする
    return drawBar();
  }
  render();
});

document.addEventListener('click', e => {
  const t = e.target.closest('[data-tab]');
  if (t) { tab = t.dataset.tab; window.scrollTo(0, 0); if (tab === 'people') loadPeople(); return render(); }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'forget') {
    if (!confirm('この端末の合言葉を消します。同じブラウザの予約ボード・Order受付でも、また入れることになります。よろしいですか？')) return;
    pin = ''; pinSet(''); server = null; draft = {}; loginErr = '';
    return render();
  }
  if (b.dataset.act === 'people-csv') return savePeople();
  if (b.dataset.act === 'see') return openSee(SEE_TAB[tab]);
  if (b.dataset.act === 'see-go') return openSee(b.dataset.route);
  if (b.dataset.act === 'see-close') return closeSee();
  if (b.dataset.act === 'see-text') { const r = APP_TEXTS[Number(b.dataset.i)]; return openSee(SEE_AT[r.at] || 'home', draft.texts?.[r.t]?.to || r.t); }
  if (b.dataset.act === 'text-mode') { textMode = b.dataset.mode; return render(); }
  if (b.dataset.act?.startsWith('ed-')) return edAct(b);
  if (b.dataset.act === 'photo-reset') { setOv('photos', b.dataset.slot, 'id', undefined); delete photoErr[b.dataset.slot]; return render(); }   // 写真をもとに戻す（ドライブの写真は消さない）
  if (menuAct(b)) return render();
  if (b.dataset.act === 'frame-reset' && draft.texts) {   // 一覧の「枠ごと」の文を元に戻す
    delete draft.texts[b.dataset.k];
    if (!Object.keys(draft.texts).length) delete draft.texts;
    return render();
  }
  if (b.dataset.act === 'text-group') {
    if (!textOpen.delete(b.dataset.at)) textOpen.add(b.dataset.at);
    return render();
  }
  const list = newsList(), i = Number(b.dataset.i);
  if (b.dataset.act === 'news-add') draft.news = [{ date: todayKey(), title: '', body: '' }, ...list];
  if (b.dataset.act === 'news-del') { if (!confirm(`「${list[i].title || '（見出しなし）'}」を消します。よろしいですか？`)) return; list.splice(i, 1); draft.news = list; }
  if (b.dataset.act === 'news-up') { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draft.news = list; }
  if (b.dataset.act === 'news-down') { [list[i + 1], list[i]] = [list[i], list[i + 1]]; draft.news = list; }
  if (b.dataset.act === 'news-reset') { if (!confirm('お知らせを data.js のものに戻します。よろしいですか？')) return; delete draft.news; }
  if (b.dataset.act === 'reward-reset' && draft.rewards) {
    delete draft.rewards[b.dataset.at];
    if (!Object.keys(draft.rewards).length) delete draft.rewards;
  }
  render();
});

/* ---- 合言葉・読む・保存 ---- */

document.addEventListener('submit', async e => {
  if (e.target.id !== 'login') return;
  e.preventDefault();
  const v = $('#pin').value.trim();
  if (!v || busy) return;
  busy = true; loginErr = ''; render();
  try {
    await post({ action: 'ping', pin: v });
    pin = v;
    pinSet(v);
    await loadContent();
  } catch (err) {
    loginErr = message(err);
  }
  busy = false;
  render();
});

async function loadContent() {
  const r = await post({ action: 'appContent' });
  server = { content: r.content || {}, v: Number(r.v) || 0, at: r.at || '' };
  draft = clone(server.content);
}

$('#saveBtn').onclick = async () => {
  if (!dirty() || busy) return;
  // お知らせの見出しが空のものは、公式アプリに出ないので、保存する前に知らせる
  if (draft.news?.some(n => !n.title.trim())) { tab = 'news'; render(); return alert('見出しが空のお知らせがあります。見出しを入れるか、削除してください。'); }
  if (draft.menu?.added?.some(a => !a.name.trim())) { tab = 'items'; render(); return alert('名前が空の、足した商品があります。名前を入れるか、削除してください。'); }
  if (draft.menu?.dineAdded?.some(a => !a.n.trim())) { tab = 'dine'; render(); return alert('名前が空の、足した店内の品があります。名前を入れるか、削除してください。'); }
  if (draft.menu?.added?.some(a => a.price == null)) { tab = 'items'; render(); return alert('値段が入っていない、足した商品があります。値段を入れてください（無料なら 0）。'); }
  if (draft.menu?.dineAdded?.some(a => a.p == null)) { tab = 'dine'; render(); return alert('値段が入っていない、足した店内の品があります。値段を入れてください（無料なら 0）。'); }
  busy = true; drawBar();
  try {
    const r = await post({ action: 'saveAppContent', pin, content: draft, expect: server.v });
    server = { content: clone(draft), v: r.v, at: r.at };
    toast('保存しました。公式アプリには数分のうちに出ます');
  } catch (err) {
    if (err.code === 'conflict') {
      alert('ほかの端末で、先に保存されていました。最新の中身を読み直します（ここで直した分は消えます）。');
      server = { content: err.data.content || {}, v: Number(err.data.v) || 0, at: err.data.at || '' };
      draft = clone(server.content);
    } else if (err.code === 'bad_pin' || err.code === 'locked') {
      alert(message(err));
      server = null; pin = '';
      if (err.code === 'bad_pin') pinSet('');
    } else alert(message(err));
  }
  busy = false;
  render();
};

function toast(text) {
  const t = Object.assign(document.createElement('p'), { className: 'm-toast', textContent: text });
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

// 保存していない直しがあるときに閉じようとしたら、ひとこと聞く
window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

/* ---- はじめ ---- */
(async () => {
  if (pin) {
    try { await post({ action: 'ping', pin }); await loadContent(); }
    catch (err) { if (err.code === 'bad_pin') { pin = ''; pinSet(''); } loginErr = err.code === 'bad_pin' ? '' : message(err); }
  }
  render();
})();

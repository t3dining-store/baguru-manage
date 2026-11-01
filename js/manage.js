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
  unknown_action: '受け口が、まだ新しい版（2026-10-30j 以降）になっていません。予約ボードのセッションの案内で、Google の受け口を入れ替えてください。',
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
const TABS = [
  ['notice', '一言'], ['news', 'お知らせ'], ['items', 'テイクアウト'], ['choices', '選ぶもの'], ['dine', '店内'], ['rewards', '特典'], ['texts', '文章'],
];

function render() {
  const view = $('#view');
  $('#saveBtn').hidden = !server;
  if (!server) { view.innerHTML = loginHtml(); $('#bar').hidden = true; return $('#pin')?.focus(); }
  const y = window.scrollY;
  view.innerHTML = `
    <nav class="m-tabs">${TABS.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</nav>
    ${({ notice: noticeHtml, news: newsHtml, items: itemsHtml, choices: choicesHtml, dine: dineHtml, rewards: rewardsHtml, texts: textsHtml })[tab]()}
    <p class="m-foot"><button class="m-link" data-act="forget">この端末の合言葉を消す</button><br><a href="${esc(appUrl())}" target="_blank" rel="noopener">公式アプリで見る ›</a><br>
      保存すると、公式アプリには数分のうちに出ます（開いている人は、開き直したときに）。値段はホームページには出ません（ホームページは別に直します）。</p>`;
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

/* ---- アプリで見る：保存する前の直しを入れた公式アプリを、画面の中に開く（改行などの見え方を確かめる）。★お客様には見えない ---- */
const SEE_SCREENS = [['home', 'ホーム'], ['menu', 'メニュー'], ['cart', 'カート'], ['stamp', 'スタンプ'], ['shop', 'お店'], ['me', 'マイページ'], ['reserve', '予約']];
const SEE_TAB = { notice: 'home', news: 'home', items: 'menu', choices: 'menu', dine: 'shop', rewards: 'stamp', texts: 'home' };
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
      <p class="m-hint">公式アプリのホームの「お知らせ」に、上から順に出ます。${draft.news ? '' : '今は data.js のままです。'}</p>
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

function itemsHtml() {
  return CATEGORIES.map(cat => `<section class="m-sec">
      <h2>${esc(cat.name)}</h2>
      ${ITEMS.filter(i => i.cat === cat.id).map(i => {
        const b = CONTENT_BASE.items[ITEMS.indexOf(i)], o = ov('items', i.id);
        return `<div class="m-row ${o.hidden ? 'is-hidden' : ''} ${o.soldOut ? 'is-out' : ''}">
            <b class="m-name">${esc(i.full || i.name)}</b>
            <div class="m-prices">${b.regular != null
              ? priceIn(`item:price:${i.id}`, o.price, b.price, 'ミニ') + priceIn(`item:regular:${i.id}`, o.regular, b.regular, 'レギュラー')
              : priceIn(`item:price:${i.id}`, o.price, b.price)}</div>
            <div class="m-flags">${flagIn(`item:soldOut:${i.id}`, o.soldOut, '売り切れ')}${flagIn(`item:hidden:${i.id}`, o.hidden, '出さない')}</div>
          </div>`;
      }).join('')}
    </section>`).join('') + '<p class="m-hint">「売り切れ」は、メニューに出したまま押せなくします。「出さない」は、メニューに並べません。どちらも、戻すまでそのままです。</p>';
}

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

function dineHtml() {
  return '<p class="m-hint">お店の情報の「店内のメニュー」（見るだけのメニュー）です。</p>' + DINE_IN.map((cat, a) => `<section class="m-sec">
      <h2>${esc(cat.name)}</h2>
      ${cat.items.map((it, b) => {
        const base = CONTENT_BASE.dine[a][b], key = contentKey.dine(cat, it), o = ov('dine', key);
        const prices = base.sizes
          ? it.sizes.map((s, k) => priceIn(`dine:size:${key}:${k}`, Array.isArray(o.sizes) ? o.sizes[k] ?? null : null, base.sizes[k], s[0])).join('')
          : priceIn(`dine:p:${key}`, o.p, base.p);
        return `<div class="m-row ${o.hidden ? 'is-hidden' : ''}">
            <b class="m-name">${esc(it.n)}</b>
            <div class="m-prices">${prices}</div>
            <div class="m-flags">${flagIn(`dine:hidden:${key}`, o.hidden, '出さない')}</div>
          </div>`;
      }).join('')}
    </section>`).join('');
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

function textListHtml() {
  const q = textQuery.trim(), hits = (q || textOnly) && APP_TEXTS.filter(r => (!q || r.t.includes(q) || draft.texts?.[r.t]?.to.includes(q)) && (!textOnly || draft.texts?.[r.t]));
  if (hits) {
    return `<p class="m-hint">${hits.length}件${hits.length > 60 ? '（はじめの60件を出しています。言葉をしぼってください）' : ''}</p>${hits.slice(0, 60).map(textRow).join('')}`;
  }
  return textAts.map(at => {
    const rows = textRows(at), n = rows.filter(r => draft.texts?.[r.t]).length;
    return `<button class="m-group ${textOpen.has(at) ? 'on' : ''}" data-act="text-group" data-at="${esc(at)}"><b>${esc(at)}</b><small>${rows.length}件${n ? `・${n}件直しました` : ''}</small></button>
      ${textOpen.has(at) ? rows.map(textRow).join('') : ''}`;
  }).join('');
}

function textsHtml() {
  return `<section class="m-sec">
      <h2>アプリの文章</h2>
      <p class="m-hint">公式アプリの画面に出る文を、全部ここで直せます。上の小さい字が元の文です。改行すると、アプリでも改行されます。「アプリで見る」で、保存する前に見え方を確かめられます。空にすると元の文に戻ります。下から見出しを開くか、言葉で探してください。</p>
      <p class="m-hint">数字などが間に入る文は、前後に分かれて出ます。お知らせ・値段・売り切れ・特典は、それぞれのタブで直してください。</p>
      <input id="textSearch" type="search" value="${esc(textQuery)}" placeholder="言葉で探す（例：受け取り）" aria-label="言葉で探す">
      <label class="m-only"><input id="textOnly" type="checkbox" ${textOnly ? 'checked' : ''}>直したものだけ出す（${Object.keys(draft.texts || {}).length}件）</label>
    </section>
    <div id="textList">${textListHtml()}</div>`;
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

document.addEventListener('input', e => {
  if (e.target.id === 'textSearch') { textQuery = e.target.value; $('#textList').innerHTML = textListHtml(); return; }   // 探す欄から指が離れないように、一覧だけ描き直す
  if (e.target.dataset.f && server) { take(e.target); drawBar(); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'textOnly') { textOnly = e.target.checked; return render(); }
  if (!e.target.dataset.f || !server) return;
  take(e.target);
  if (e.target.dataset.f.startsWith('text:')) {   // 文章のタブは、書いている場所が動かないように描き直さない
    e.target.closest('.m-text').classList.toggle('is-edited', !!draft.texts?.[APP_TEXTS[Number(e.target.dataset.f.split(':')[2])].t]);
    return drawBar();
  }
  render();
});

document.addEventListener('click', e => {
  const t = e.target.closest('[data-tab]');
  if (t) { tab = t.dataset.tab; window.scrollTo(0, 0); return render(); }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'forget') {
    if (!confirm('この端末の合言葉を消します。同じブラウザの予約ボード・Order受付でも、また入れることになります。よろしいですか？')) return;
    pin = ''; pinSet(''); server = null; draft = {}; loginErr = '';
    return render();
  }
  if (b.dataset.act === 'see') return openSee(SEE_TAB[tab]);
  if (b.dataset.act === 'see-go') return openSee(b.dataset.route);
  if (b.dataset.act === 'see-close') return closeSee();
  if (b.dataset.act === 'see-text') { const r = APP_TEXTS[Number(b.dataset.i)]; return openSee(SEE_AT[r.at] || 'home', draft.texts?.[r.t]?.to || r.t); }
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

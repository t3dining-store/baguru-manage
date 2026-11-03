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
const MEMBER_PLUS = !!STAMP.memberPlus || (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]test\b/.test(location.search));   // 公式アプリの js/stamp-api.js と同じ
const TABS = [
  ['notice', '一言'], ['news', 'お知らせ'], ['items', 'テイクアウト'], ['choices', '選ぶもの'], ['dine', '店内'], ['rewards', '特典'], ['texts', '文章'],
  ...(MEMBER_PLUS ? [['people', '客層']] : []),
];

function render() {
  const view = $('#view');
  $('#saveBtn').hidden = !server;
  if (!server) { view.innerHTML = loginHtml(); $('#foot').innerHTML = ''; editShow(); $('#bar').hidden = true; return $('#pin')?.focus(); }
  const y = window.scrollY;
  view.innerHTML = `
    <nav class="m-tabs">${TABS.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</nav>
    ${({ notice: noticeHtml, news: newsHtml, items: itemsHtml, choices: choicesHtml, dine: dineHtml, rewards: rewardsHtml, texts: textsHtml, people: peopleHtml })[tab]()}`;
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
  const sw = `<div class="m-switch">${[['screen', '画面で直す'], ['list', '一覧で直す']].map(([k, n]) => `<button data-act="text-mode" data-mode="${k}" class="${textMode === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  if (textMode === 'screen') {
    return `<section class="m-sec">
      <h2>アプリの文章</h2>
      ${sw}
      <p class="m-hint">点線の文を押すと、アプリの下の欄で直せます。保存するまで、お客様には見えません。押して開く所（商品を選ぶ画面など）は「アプリを動かす」で開いてから、「文を押して直す」に戻して押します。</p>
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
let ed = null;      // { frame, route, on（文を押して直す）, row（直している文の APP_TEXTS の番号。無ければ -1）, cands（押した所の文の番号。押す前は null）, base }
const ED_W = 390;   // 中のアプリの幅（スマホと同じ幅にして、改行の位置をそろえる）
const editUrl = route => seeUrl(route).replace('preview#', 'preview&edit#');
const edPost = msg => ed?.frame?.contentWindow?.postMessage({ type: 'baguru-manage', ...msg }, location.origin);
const notTexts = () => canon({ ...draft, texts: undefined });
const oneLine = t => String(t).replace(/\s+/g, ' ').trim();
const edKey = i => ({ key: i >= 0 ? APP_TEXTS[i].t : '', s: i >= 0 ? APP_TEXTS[i].s : 0 });

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
  ed = { route: 'home', on: true, row: -1, cands: null, base: notTexts(), frame: null };
  box.innerHTML = `
    <nav class="m-ed-tabs" aria-label="画面">${SEE_SCREENS.map(([k, n]) => `<button data-act="ed-go" data-route="${k}" class="${k === ed.route ? 'on' : ''}">${n}</button>`).join('')}</nav>
    <div class="m-ed-mode" role="group" aria-label="押したときの動き"><button data-act="ed-mode" data-on="1" class="on">文を押して直す</button><button data-act="ed-mode" data-on="0">アプリを動かす</button></div>
    <div class="m-ed-frame"><iframe title="公式アプリの画面" src="${esc(editUrl(ed.route))}"></iframe></div>
    <div id="edPanel" class="m-ed-panel">${edPanelHtml()}</div>`;
  ed.frame = $('iframe', box);
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

function edPanelHtml() {
  if (!ed || ed.row < 0) {
    if (ed?.cands?.length) {
      return `<p class="m-ed-q">ここには、直せる文が${ed.cands.length}つあります。どれを直しますか？</p>
        ${ed.cands.map(i => `<button class="m-ed-cand" data-act="ed-cand" data-i="${i}"><b>${esc(oneLine(draft.texts?.[APP_TEXTS[i].t]?.to ?? APP_TEXTS[i].t))}</b><small>${esc(APP_TEXTS[i].at)}</small></button>`).join('')}`;
    }
    if (ed?.cands) return '<p class="m-ed-q">この字は、ここでは直せません。</p><p class="m-hint">値段・売り切れ・お知らせ・一言・特典の中身は、それぞれのタブで直します。数字や、お客様が入れた字は直せません。</p>';
    return '<p class="m-ed-q">上の画面で、直したい文（点線で囲んだ文）を押してください。</p>';
  }
  const r = APP_TEXTS[ed.row], to = draft.texts?.[r.t]?.to;
  return `<div class="m-text ${to ? 'is-edited' : ''}">
      <div class="m-text-top"><small>${esc(r.at)}${to ? `<br>元の文：${esc(r.t)}` : ''}</small>${to ? '<button class="m-ed-undo" data-act="ed-undo">元の文に戻す</button>' : ''}</div>
      <textarea data-f="text:to:${ed.row}" rows="${Math.min(6, Math.max(2, Math.ceil(r.t.length / 18)))}" aria-label="直した文">${esc(to ?? r.t)}</textarea>
      <p class="m-hint">打ったそばから、上の画面の字が変わります。改行すると、アプリでも改行されます。空にすると元の文に戻ります。</p>
    </div>`;
}
const edPanel = () => { const p = $('#edPanel'); if (p) p.innerHTML = edPanelHtml(); };
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
/** 中のアプリで文を押したとき。1つなら、すぐ下の欄で直す。いくつかあれば選んでもらう */
function edOnPick(d) {
  const arr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 2000).slice(0, 20) : []);
  const main = edRows(arr(d.main)), attrs = edRows(arr(d.attrs));
  const rows = edRows([...(main.length ? main : edRows(arr(d.more))), ...attrs].map(i => APP_TEXTS[i].t)).slice(0, 8);
  ed.cands = rows;
  ed.row = rows.length === 1 ? rows[0] : -1;
  edPanel();
  edPost({ kind: 'pick', ...edKey(ed.row) });
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
  if (act === 'ed-cand') { ed.row = Number(b.dataset.i); edPanel(); return edPost({ kind: 'pick', ...edKey(ed.row) }); }
  if (act === 'ed-undo' && ed.row >= 0) {
    const t = $('#edPanel textarea');
    t.value = APP_TEXTS[ed.row].t;
    take(t);
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
    edPost({ kind: 'keys', exact: APP_TEXTS.map(r => r.t), part: APP_TEXTS.filter(r => r.s).map(r => r.t) });
    edPost({ kind: 'mode', on: ed.on });
    edSend();
    edPost({ kind: 'pick', ...edKey(ed.row) });
  }
  if ((d.kind === 'ready' || d.kind === 'route') && typeof d.route === 'string') { ed.route = d.route; edTabs(); }
  if (d.kind === 'pick') edOnPick(d);
});

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
  if (e.target.dataset.f && server) {
    take(e.target);
    drawBar();
    if (e.target.dataset.f.startsWith('text:')) edSend();   // 画面で直す：打ったそばから、中のアプリの字を変える
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'textOnly') { textOnly = e.target.checked; return render(); }
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

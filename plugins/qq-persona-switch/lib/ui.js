// 插件自带的一页 UI。故意做成零依赖、零构建、零外部请求的单文件：
// 它要在 DSH 的 webServer 上直接吐出去，任何打包步骤都会让「装个插件」变成
// 「先跑一遍前端构建」，不值得。
//
// 界面上只有一件事要做：把两侧的人设列成同一张列表，点一下就收敛到一张。
// 所以这里没有搜索、没有排序、没有分页 —— 人格卡通常个位数，插件人设也是。

/**
 * 渲染整页。`basePath` 是路由前缀（由 index.js 传入），页面所有请求都打它。
 */
export function renderPage({ basePath, version }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>人设总开关</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --ink: #1c1f23; --muted: #6b7280;
    --line: #e3e6ea; --accent: #2f6feb; --accent-ink: #ffffff;
    --ok: #15803d; --bad: #b42318; --warn-bg: #fff7e6; --warn-line: #f0c36d;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181c; --card: #1e2126; --ink: #e6e8eb; --muted: #9aa2ad;
      --line: #2c3138; --accent: #5b8ef7; --accent-ink: #0b1020;
      --ok: #4ade80; --bad: #f87171; --warn-bg: #2a2318; --warn-line: #8a6a2a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 64px; background: var(--bg); color: var(--ink);
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { margin: 0; font-size: 22px; letter-spacing: .2px; }
  h2 { margin: 0 0 10px; font-size: 14px; color: var(--muted); font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 0; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--card); font-size: 12px; color: var(--muted);
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .chip.ok .dot { background: var(--ok); }
  .chip.bad .dot { background: var(--bad); }
  .warn {
    margin: 14px 0 0; padding: 10px 12px; border-radius: 10px; font-size: 13px;
    background: var(--warn-bg); border: 1px solid var(--warn-line);
  }
  .warn div + div { margin-top: 6px; }
  .now {
    margin: 18px 0 14px; padding: 14px 16px; border-radius: 12px; background: var(--card);
    border: 1px solid var(--line);
  }
  .now .label { font-size: 12px; color: var(--muted); }
  .now .value { font-size: 17px; font-weight: 600; margin-top: 2px; }
  .now .meta { font-size: 12px; color: var(--muted); margin-top: 6px; word-break: break-all; }
  .actions { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
  button {
    font: inherit; cursor: pointer; border-radius: 10px; padding: 8px 14px;
    border: 1px solid var(--line); background: var(--card); color: var(--ink);
  }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.ghost { color: var(--muted); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 820px) { .cols { grid-template-columns: 1fr; } }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .card {
    text-align: left; width: 100%; padding: 12px 14px; border-radius: 12px;
    border: 1px solid var(--line); background: var(--card); color: var(--ink);
    display: flex; flex-direction: column; gap: 4px;
  }
  .card:hover { border-color: var(--accent); }
  .card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .card .row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .card .name { font-weight: 600; }
  .card .size { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .card .desc { font-size: 12px; color: var(--muted); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .card .badge { font-size: 11px; color: var(--accent); }
  .empty { font-size: 13px; color: var(--muted); padding: 10px 2px; }
  .foot { margin-top: 28px; font-size: 12px; color: var(--muted); line-height: 1.9; word-break: break-all; }
  .toast {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    background: var(--ink); color: var(--bg); padding: 10px 16px; border-radius: 10px;
    font-size: 13px; max-width: min(90vw, 620px); z-index: 10;
  }
  .toast.bad { background: var(--bad); color: #fff; }
</style>
</head>
<body>
<div class="wrap">
  <h1>人设总开关</h1>
  <div class="sub">两边的人设会各注一层，同时生效就会串味。点一张卡，另一侧自动关掉。</div>

  <div class="chips" id="chips"></div>
  <div class="warn" id="warn" hidden></div>

  <div class="now">
    <div class="label">当前生效</div>
    <div class="value" id="nowValue">正在读取…</div>
    <div class="meta" id="nowMeta"></div>
  </div>

  <div class="actions">
    <button id="reload" class="ghost">刷新</button>
    <button id="off" class="ghost">不使用任何人设</button>
  </div>

  <div class="cols">
    <section>
      <h2>人格卡 <span>qq-bridge / roles</span></h2>
      <div class="list" id="roles"></div>
    </section>
    <section>
      <h2>插件人设 <span>dsh-persona-dafeiyu</span></h2>
      <div class="list" id="plugins"></div>
    </section>
  </div>

  <div class="foot" id="foot"></div>
</div>
<div class="toast" id="toast" hidden></div>
<script>
(function () {
  var BASE = ${JSON.stringify(basePath)};
  var busy = false;
  var toastTimer = 0;

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function toast(text, bad) {
    var node = $('toast');
    node.textContent = text;
    node.className = bad ? 'toast bad' : 'toast';
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, bad ? 9000 : 4200);
  }

  function api(path, options) {
    return fetch(BASE + path, options).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'HTTP ' + res.status }; })
        .then(function (data) {
          if (!res.ok && data && data.ok !== false) return { ok: false, error: 'HTTP ' + res.status };
          return data;
        });
    }, function (error) {
      return { ok: false, error: '连不上插件自己的接口：' + (error && error.message ? error.message : error) };
    });
  }

  function chip(text, state) {
    return '<span class="chip ' + state + '"><span class="dot"></span>' + esc(text) + '</span>';
  }

  function cardHtml(item) {
    var cls = 'card' + (item.active ? ' on' : '');
    var size = item.chars ? item.chars + ' 字' : '空';
    var desc = item.description ? '<div class="desc">' + esc(item.description) + '</div>' : '';
    var badge = item.active ? '<span class="badge">生效中</span>' : '';
    return '<button class="' + cls + '" data-source="' + esc(item.source) + '" data-id="' + esc(item.id) + '">' +
      '<span class="row"><span class="name">' + esc(item.name) + '</span><span class="size">' + esc(size) + '</span></span>' +
      desc + badge + '</button>';
  }

  function render(state) {
    var bridgeOk = state.bridge && state.bridge.reachable;
    var pluginOk = state.plugin && state.plugin.reachable;
    $('chips').innerHTML =
      chip('人格卡 ' + (bridgeOk ? '已连接' : '连不上'), bridgeOk ? 'ok' : 'bad') +
      chip('插件人设 ' + (pluginOk ? '已连接' : '连不上'), pluginOk ? 'ok' : 'bad') +
      chip('工作区 ' + (state.workspaceCwd ? '已定位' : '未配置'), state.workspaceCwd ? 'ok' : 'bad');

    var warn = $('warn');
    if (state.warnings && state.warnings.length > 0) {
      warn.innerHTML = state.warnings.map(function (line) { return '<div>' + esc(line) + '</div>'; }).join('');
      warn.hidden = false;
    } else {
      warn.hidden = true;
      warn.innerHTML = '';
    }

    var active = state.active || { source: 'none' };
    if (active.source === 'none') {
      $('nowValue').textContent = '没有额外人设';
      $('nowMeta').textContent = 'bot 只用预设自带的人格。';
    } else {
      $('nowValue').textContent = (active.source === 'role' ? '人格卡「' : '插件人设「') + active.name + '」';
      $('nowMeta').textContent = active.source === 'role'
        ? '来自 qq-bridge roles/' + active.id + '.md' + (active.chars ? '，' + active.chars + ' 字' : '')
        : '来自 dsh-persona-dafeiyu' + (active.chars ? '，' + active.chars + ' 字' : '');
    }

    var roles = (state.items || []).filter(function (item) { return item.source === 'role'; });
    var plugins = (state.items || []).filter(function (item) { return item.source === 'plugin'; });

    $('roles').innerHTML = roles.length > 0
      ? roles.map(cardHtml).join('')
      : '<div class="empty">' + (bridgeOk ? 'roles/ 里没有可用的卡。' : '桥接连不上：' + esc(state.bridge && state.bridge.error)) + '</div>';
    $('plugins').innerHTML = plugins.length > 0
      ? plugins.map(cardHtml).join('')
      : '<div class="empty">' + (pluginOk ? '插件里没有可用的人设。' : '插件不可达：' + esc(state.plugin && state.plugin.error)) + '</div>';

    $('foot').innerHTML =
      '桥接 ' + esc(state.bridge && state.bridge.baseUrl) + ' · 插件 ' + esc(state.plugin && state.plugin.baseUrl) + esc(state.plugin && state.plugin.basePath ? state.plugin.basePath : '') + '<br>' +
      '工作区 ' + esc(state.workspaceCwd || '（未配置：插件人设无法按工作区落位）') + '<br>' +
      '插件版本 ' + esc(${JSON.stringify(version)});
  }

  function load() {
    return api('/state').then(function (data) {
      if (!data.ok) { toast(data.error || '读取失败', true); return; }
      // notices 是「配置没填全」这类提示，和「两层人设同时生效」的告警一样值得摆在最上面。
      data.warnings = (data.warnings || []).concat(data.notices || []);
      render(data);
    });
  }

  function switchTo(source, id) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button').forEach(function (node) { node.disabled = true; });
    api('/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: source, id: id || undefined })
    }).then(function (data) {
      if (!data.ok) {
        toast(data.error || '切换失败', true);
      } else {
        var extra = (data.warnings && data.warnings.length > 0) ? '（' + data.warnings.join(' ') + '）' : '';
        toast('已切到：' + (data.name || '不使用人设') + extra, false);
      }
      return load();
    }).then(function () {
      busy = false;
      document.querySelectorAll('button').forEach(function (node) { node.disabled = false; });
    });
  }

  document.addEventListener('click', function (event) {
    var card = event.target.closest ? event.target.closest('.card') : null;
    if (card) { switchTo(card.getAttribute('data-source'), card.getAttribute('data-id')); return; }
    if (event.target === $('reload')) { load(); return; }
    if (event.target === $('off')) { switchTo('none', null); }
  });

  load();
})();
</script>
</body>
</html>`
}
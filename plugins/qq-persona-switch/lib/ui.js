// 插件自带的一页 UI。故意做成零依赖、零构建、零外部请求的单文件：
// 它要在 DSH 的 webServer 上直接吐出去，任何打包步骤都会让「装个插件」变成
// 「先跑一遍前端构建」，不值得。
//
// 页面有两个模式，对应两种真实的用法：
//   全局  —— 「这台 bot 就是这只」：点一张卡，另一侧自动关掉。
//   按对话 —— 「这群是 A、那群是 B」：每个对话一行，各挑一个。
// 两者互斥：按对话模式会把两侧的全局注入都关掉，否则「A 群的人设」会被
// 「全局 A」再注一层，模型看到两份互相矛盾的设定。

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
  .modes { display: flex; gap: 8px; margin: 18px 0 0; flex-wrap: wrap; }
  .modes button {
    padding: 7px 14px; border-radius: 999px; font-size: 13px;
    border: 1px solid var(--line); background: var(--card); color: var(--muted);
  }
  .modes button.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .now {
    margin: 16px 0 14px; padding: 14px 16px; border-radius: 12px; background: var(--card);
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
  table.chats { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  table.chats th, table.chats td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: middle; }
  table.chats th { font-weight: 600; color: var(--muted); font-size: 12px; }
  table.chats tr:last-child td { border-bottom: 0; }
  table.chats .key { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--muted); }
  table.chats select {
    font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--card); color: var(--ink); max-width: 100%;
  }
  .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .tag.pend { border-color: var(--warn-line); color: #a16207; }
  .note { font-size: 12px; color: var(--muted); margin: 0 0 12px; line-height: 1.8; }
</style>
</head>
<body>
<div class="wrap">
  <h1>人设总开关</h1>
  <div class="sub">两边的人设会各注一层，同时生效就会串味。全局模式只能有一个人设；按对话模式给每个群各挑一个。</div>

  <div class="chips" id="chips"></div>
  <div class="warn" id="warn" hidden></div>

  <div class="modes" id="modes"></div>

  <div class="now">
    <div class="label">当前生效</div>
    <div class="value" id="nowValue">正在读取…</div>
    <div class="meta" id="nowMeta"></div>
  </div>

  <div class="actions" id="actions">
    <button id="reload" class="ghost">刷新</button>
    <button id="off" class="ghost">不使用任何人设</button>
    <button id="sync" class="ghost" hidden>补写待生效的指定</button>
  </div>

  <div id="globalPane">
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
  </div>

  <div id="perChatPane" hidden>
    <h2>每个对话用谁</h2>
    <p class="note">
      按对话模式下，两侧的<strong>全局</strong>注入都被关掉了：没有指定的对话就<strong>不带任何人设</strong>，只用预设自带的。
      只列已经出现过会话的对话，外加你指定过、但那个人的会话还没建立的。
    </p>
    <div id="chats"></div>
  </div>

  <div class="foot" id="foot"></div>
</div>
<div class="toast" id="toast" hidden></div>
<script>
(function () {
  var BASE = ${JSON.stringify(basePath)};
  var VERSION = ${JSON.stringify(version)};
  var busy = false;
  var toastTimer = 0;
  var lastState = null;

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
    var opts = options || {};
    if (!opts.method) opts.method = 'GET';
    return fetch(BASE + path, opts).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'HTTP ' + res.status }; })
        .then(function (data) {
          if (!res.ok && data && data.ok !== false) return { ok: false, error: 'HTTP ' + res.status };
          return data;
        });
    }, function (error) {
      return { ok: false, error: '连不上插件自己的接口：' + (error && error.message ? error.message : error) };
    });
  }

  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function lock(value) {
    busy = value;
    var nodes = document.querySelectorAll('button, select');
    for (var i = 0; i < nodes.length; i += 1) nodes[i].disabled = value;
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

  function perChat() {
    return (lastState && lastState.perChat) || { mode: 'global', chats: [] };
  }

  function assignments() {
    return perChat().assignments || {};
  }

  function optionsHtml(current) {
    var items = (lastState && lastState.items) || [];
    var out = '<option value="none"' + (current === 'none' ? ' selected' : '') + '>— 不指定（无人设）—</option>';
    var roles = items.filter(function (item) { return item.source === 'role'; });
    var plugins = items.filter(function (item) { return item.source === 'plugin'; });
    if (roles.length > 0) {
      out += '<optgroup label="人格卡（qq-bridge / roles）">';
      roles.forEach(function (item) {
        var value = 'role:' + item.id;
        out += '<option value="' + esc(value) + '"' + (current === value ? ' selected' : '') + '>' + esc(item.name) + '</option>';
      });
      out += '</optgroup>';
    }
    if (plugins.length > 0) {
      out += '<optgroup label="插件人设（dsh-persona-dafeiyu）">';
      plugins.forEach(function (item) {
        var value = 'plugin:' + item.id;
        out += '<option value="' + esc(value) + '"' + (current === value ? ' selected' : '') + '>' + esc(item.name) + '</option>';
      });
      out += '</optgroup>';
    }
    return out;
  }

  function renderChats(data) {
    var chats = perChat().chats || [];
    if (chats.length === 0) {
      $('chats').innerHTML = '<div class="empty">还没有对话。先在 QQ 里让 bot 收到一条消息，群里就会出现在这里。</div>';
      return;
    }
    var rows = chats.map(function (chat) {
      var assignment = assignments()[chat.key] || null;
      var current = assignment && assignment.source && assignment.source !== 'none'
        ? assignment.source + ':' + assignment.id
        : 'none';
      var tags = '';
      if (chat.pending) tags += ' <span class="tag pend">待生效</span>';
      if (!chat.sessionId) tags += ' <span class="tag">无会话</span>';
      return '<tr>' +
        '<td><div>' + esc(chat.label) + tags + '</div><div class="key">' + esc(chat.key) + '</div></td>' +
        '<td><select data-chat="' + esc(chat.key) + '">' + optionsHtml(current) + '</select></td>' +
        '</tr>';
    }).join('');
    $('chats').innerHTML = '<table class="chats"><thead><tr><th>对话</th><th>人设</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function render(state) {
    lastState = state;
    var bridgeOk = state.bridge && state.bridge.reachable;
    var pluginOk = state.plugin && state.plugin.reachable;
    var mode = perChat().mode || 'global';
    $('chips').innerHTML =
      chip('人格卡 ' + (bridgeOk ? '已连接' : '连不上'), bridgeOk ? 'ok' : 'bad') +
      chip('插件人设 ' + (pluginOk ? '已连接' : '连不上'), pluginOk ? 'ok' : 'bad') +
      chip('工作区 ' + (state.workspaceCwd ? '已定位' : '未配置'), state.workspaceCwd ? 'ok' : 'bad') +
      chip(mode === 'perChat' ? '按对话指定' : '全局单一人设', mode === 'perChat' ? 'ok' : '');

    $('modes').innerHTML =
      '<button data-mode="global" class="' + (mode === 'global' ? 'on' : '') + '">一个人设（全局）</button>' +
      '<button data-mode="perChat" class="' + (mode === 'perChat' ? 'on' : '') + '">按对话各自指定</button>';

    var warn = $('warn');
    var lines = (state.warnings || []).concat(state.notices || []);
    if (lines.length > 0) {
      warn.innerHTML = lines.map(function (line) { return '<div>' + esc(line) + '</div>'; }).join('');
      warn.hidden = false;
    } else {
      warn.hidden = true;
      warn.innerHTML = '';
    }

    if (mode === 'perChat') {
      var count = Object.keys(assignments()).filter(function (key) {
        var item = assignments()[key];
        return item && item.source && item.source !== 'none';
      }).length;
      $('nowValue').textContent = '按对话：' + count + ' 个对话指定了人设';
      $('nowMeta').textContent = count === 0
        ? '还没有指定。未指定的对话不带任何人设。'
        : '其余对话不带人设；全局注入已关闭。';
      $('globalPane').hidden = true;
      $('perChatPane').hidden = false;
      $('off').hidden = true;
      var pending = (perChat().chats || []).filter(function (chat) { return chat.pending; }).length;
      $('sync').hidden = pending === 0;
      $('sync').textContent = '补写待生效的指定（' + pending + '）';
      renderChats(state);
    } else {
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
      $('globalPane').hidden = false;
      $('perChatPane').hidden = true;
      $('off').hidden = false;
      $('sync').hidden = true;

      var roles = (state.items || []).filter(function (item) { return item.source === 'role'; });
      var plugins = (state.items || []).filter(function (item) { return item.source === 'plugin'; });
      $('roles').innerHTML = roles.length > 0
        ? roles.map(cardHtml).join('')
        : '<div class="empty">' + (bridgeOk ? 'roles/ 里没有可用的卡。' : '桥接连不上：' + esc(state.bridge && state.bridge.error)) + '</div>';
      $('plugins').innerHTML = plugins.length > 0
        ? plugins.map(cardHtml).join('')
        : '<div class="empty">' + (pluginOk ? '插件里没有可用的人设。' : '插件不可达：' + esc(state.plugin && state.plugin.error)) + '</div>';
    }

    $('foot').innerHTML =
      '桥接 ' + esc(state.bridge && state.bridge.baseUrl) + ' · 插件 ' + esc(state.plugin && state.plugin.baseUrl) + esc(state.plugin && state.plugin.basePath ? state.plugin.basePath : '') + '<br>' +
      '工作区 ' + esc(state.workspaceCwd || '（未配置：插件人设无法按工作区落位）') + '<br>' +
      '插件版本 ' + esc(VERSION);
  }

  function load() {
    return api('/state').then(function (data) {
      if (!data.ok) { toast(data.error || '读取失败', true); return; }
      render(data);
    });
  }

  function switchTo(source, id) {
    if (busy) return;
    lock(true);
    post('/switch', { source: source, id: id || undefined }).then(function (data) {
      if (!data.ok) toast(data.error || '切换失败', true);
      else {
        var extra = (data.warnings && data.warnings.length > 0) ? '（' + data.warnings.join(' ') + '）' : '';
        toast('已切到：' + (data.name || '不使用人设') + extra, false);
      }
      return load();
    }).then(function () { lock(false); });
  }

  function setMode(mode) {
    if (busy || mode === perChat().mode) return;
    lock(true);
    post('/mode', { mode: mode }).then(function (data) {
      if (!data.ok) toast(data.error || '切换模式失败', true);
      else {
        var extra = (data.warnings && data.warnings.length > 0) ? '（' + data.warnings.join(' ') + '）' : '';
        toast(mode === 'perChat' ? '已进入按对话模式：全局人设已关闭' + extra : '已回到全局模式：按对话的指定保留但不再生效', false);
      }
      return load();
    }).then(function () { lock(false); });
  }

  function assign(chatKey, value) {
    var parts = String(value || 'none').split(':');
    var source = parts[0] || 'none';
    var id = parts.length > 1 ? parts.slice(1).join(':') : undefined;
    if (busy) return;
    lock(true);
    post('/assign', { chatKey: chatKey, source: source, id: id }).then(function (data) {
      if (!data.ok) toast(data.error || '指定失败', true);
      else if (data.pending) toast('已记下：' + chatKey + '。这个对话还没有会话，等它下次说话时自动生效。', false);
      else {
        var extra = (data.warnings && data.warnings.length > 0) ? '（' + data.warnings.join(' ') + '）' : '';
        toast('已指定：' + chatKey + extra, false);
      }
      return load();
    }).then(function () { lock(false); });
  }

  function sync() {
    if (busy) return;
    lock(true);
    post('/sync', {}).then(function (data) {
      if (!data.ok) toast(data.error || '同步失败', true);
      else toast(data.applied > 0 ? '补写了 ' + data.applied + ' 个对话' : '没有需要补写的', false);
      return load();
    }).then(function () { lock(false); });
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var card = target.closest ? target.closest('.card') : null;
    if (card) { switchTo(card.getAttribute('data-source'), card.getAttribute('data-id')); return; }
    var modeButton = target.closest ? target.closest('button[data-mode]') : null;
    if (modeButton) { setMode(modeButton.getAttribute('data-mode')); return; }
    if (target === $('reload')) { load(); return; }
    if (target === $('off')) { switchTo('none', null); return; }
    if (target === $('sync')) { sync(); }
  });

  document.addEventListener('change', function (event) {
    var select = event.target;
    if (select && select.getAttribute && select.getAttribute('data-chat')) {
      assign(select.getAttribute('data-chat'), select.value);
    }
  });

  load();
})();
</script>
</body>
</html>`
}
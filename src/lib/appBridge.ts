/**
 * AI 小应用的数据桥（docs/15）。
 *
 * 应用运行在 sandbox iframe 里，没有同源权限，也不允许 localStorage，
 * 所以持久化走 postMessage：应用调用 window.glimnote.data，宿主收到后
 * 读写仓库里的 apps/<id>/data.json。系统通知也走同一条桥：
 * window.glimnote.notify(title, { body })，由宿主决定弹桌面通知还是站内提示。
 * 桥脚本由 withCsp 注入到应用代码前面，生成的代码本身不需要（也不能）
 * 直接访问 window.parent。
 */

export const APP_BRIDGE_TAG = 'glimnote-app-data';

/** 注入到每个小应用 head 最前面的脚本；保持 ES5，避免旧内核兼容问题 */
export const APP_BRIDGE_SCRIPT = `(function () {
  var TAG = '${APP_BRIDGE_TAG}';
  var seq = 0;
  var pending = {};
  var changeHandlers = [];

  function fail(message) {
    var error = new Error(message || '数据操作失败');
    error.name = 'GlimnoteDataError';
    return error;
  }

  function call(op, payload) {
    return new Promise(function (resolve, reject) {
      if (window.parent === window) {
        reject(fail('当前环境没有宿主，应用数据只在预览外可用'));
        return;
      }
      var id = 'r' + (++seq) + '-' + Date.now().toString(36);
      var timer = setTimeout(function () {
        delete pending[id];
        reject(fail('数据操作超时，请稍后重试'));
      }, 10000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      try {
        var message = { __glimnote: TAG, id: id, op: op };
        if (payload) for (var key in payload) message[key] = payload[key];
        window.parent.postMessage(message, '*');
      } catch (e) {
        clearTimeout(timer);
        delete pending[id];
        reject(fail('无法连接宿主'));
      }
    });
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.__glimnote !== TAG + '-reply' || !data.id) return;
    var item = pending[data.id];
    if (!item) return;
    delete pending[data.id];
    clearTimeout(item.timer);
    if (data.ok) item.resolve(data.value);
    else item.reject(fail(data.error));
  });

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.__glimnote !== TAG + '-changed') return;
    for (var i = 0; i < changeHandlers.length; i += 1) {
      try {
        changeHandlers[i](data.key || null);
      } catch (e) {
        /* 单个回调出错不影响其它监听 */
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('glimnote:data-changed', { detail: { key: data.key || null } }));
    } catch (e) {
      /* 老内核没有 CustomEvent 也不影响主流程 */
    }
  });

  var api = window.glimnote || {};
  api.data = {
    get: function (key, fallback) {
      return call('get', { key: key }).then(function (value) {
        return value === undefined || value === null ? fallback : value;
      });
    },
    set: function (key, value) {
      return call('set', { key: key, value: value });
    },
    remove: function (key) {
      return call('remove', { key: key });
    },
    all: function () {
      return call('all');
    },
    keys: function () {
      return call('keys');
    },
    clear: function () {
      return call('clear');
    },
    onChange: function (handler) {
      if (typeof handler === 'function') changeHandlers.push(handler);
      return function () {
        var index = changeHandlers.indexOf(handler);
        if (index >= 0) changeHandlers.splice(index, 1);
      };
    },
  };
  api.notify = function (title, options) {
    var payload = { title: title };
    if (options && typeof options === 'object') {
      if (typeof options.body === 'string') payload.body = options.body;
    }
    return call('notify', payload).then(function (value) {
      return value === true;
    });
  };
  window.glimnote = api;
})();`;

/**
 * 市场预览专用的数据桥：读操作立刻返回默认值，写操作直接拒绝。
 * 预览里的数据一律不落盘，用户尝试保存时由应用自己的提示条告诉
 * 他先把应用添加到首页；装好之后才换成真正的 APP_BRIDGE_SCRIPT。
 */
export const APP_PREVIEW_BRIDGE_SCRIPT = `(function () {
  function refuse() {
    var error = new Error('预览中不保存数据，请先安装应用后再使用');
    error.name = 'GlimnotePreviewError';
    return Promise.reject(error);
  }
  window.glimnote = {
    data: {
      get: function (key, fallback) { return Promise.resolve(fallback); },
      set: refuse,
      remove: refuse,
      clear: refuse,
      all: function () { return Promise.resolve({}); },
      keys: function () { return Promise.resolve([]); },
      onChange: function () { return function () {}; },
    },
  };
})();`;

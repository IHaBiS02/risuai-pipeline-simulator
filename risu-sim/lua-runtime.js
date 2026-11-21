/*
 * RisuAI 파이프라인 시뮬레이터 — Lua 레이어
 * ------------------------------------------------------------------
 * 원본:
 *   src/ts/process/scriptings.ts:1302  luaCodeWrapper()
 *   src/ts/process/scriptings.ts:1478  runLuaEditTrigger()
 *   src/ts/process/scriptings.ts:1060-1240  runScripted() (Lua 분기)
 *
 * wasmoon(Lua 5.4 WASM)을 그대로 사용합니다. RisuAI와 같은 엔진입니다.
 *
 * 지원 범위
 *   - listenEdit('editInput'|'editOutput'|'editDisplay'|'editRequest')
 *   - getChatVar / setChatVar / setChatVarChanged / getGlobalVar / cbs / log
 *   - getChat / getFullChat / getChatLength / getChatRole / getChatData
 *   - getState / setState / setStateChanged
 *   - alert* / stopChat / setChat / cutChat / addChat / insertChat (Safe 게이팅)
 *   미지원: async()/:await() 기반 API (LLM, request, generateImage, similarity, loadLoreBooks)
 */
(function () {
  'use strict';

  // 원본 scriptings.ts:1302-1476 의 동기 버전.
  // async(callback)/Promise.create/:await() 부분은 브리지가 동기라 제거했습니다.
  var WRAPPER = [
    "json = require 'json'",
    '',
    'function getChat(id, index) return json.decode(getChatMain(id, index)) end',
    'function getFullChat(id) return json.decode(getFullChatMain(id)) end',
    'function getRecentChats(id, count) return json.decode(getRecentChatsMain(id, count)) end',
    'function setFullChat(id, value) setFullChatMain(id, json.encode(value)) end',
    '',
    'function log(value) logMain(json.encode(value)) end',
    '',
    'local editRequestFuncs = {}',
    'local editDisplayFuncs = {}',
    'local editInputFuncs = {}',
    'local editOutputFuncs = {}',
    '',
    'function listenEdit(type, func)',
    "    if type == 'editRequest' then",
    '        editRequestFuncs[#editRequestFuncs + 1] = func',
    '        __registerEditListener(type)',
    '        return',
    '    end',
    "    if type == 'editDisplay' then",
    '        editDisplayFuncs[#editDisplayFuncs + 1] = func',
    '        __registerEditListener(type)',
    '        return',
    '    end',
    "    if type == 'editInput' then",
    '        editInputFuncs[#editInputFuncs + 1] = func',
    '        __registerEditListener(type)',
    '        return',
    '    end',
    "    if type == 'editOutput' then",
    '        editOutputFuncs[#editOutputFuncs + 1] = func',
    '        __registerEditListener(type)',
    '        return',
    '    end',
    "    throw('Invalid type')",
    'end',
    '',
    'function getState(id, name)',
    '    local escapedName = "__"..name',
    '    return json.decode(getChatVar(id, escapedName))',
    'end',
    '',
    'function setState(id, name, value)',
    '    local escapedName = "__"..name',
    '    setChatVar(id, escapedName, json.encode(value))',
    'end',
    '',
    'function setStateChanged(id, name, value)',
    '    local escapedName = "__"..name',
    '    return setChatVarChanged(id, escapedName, json.encode(value))',
    'end',
    '',
    'function callListenMain(eventType, id, value, meta)',
    '    local realMeta = json.decode(meta)',
    '',
    "    if eventType == 'editDisplay' then",
    '        local out = value',
    '        for _, func in ipairs(editDisplayFuncs) do',
    '            local r = func(id, out, realMeta)',
    "            if type(r) == 'string' then out = r end",
    '        end',
    '        return out',
    '    end',
    '',
    '    local realValue = json.decode(value)',
    "    if eventType == 'editRequest' then",
    '        for _, func in ipairs(editRequestFuncs) do realValue = func(id, realValue, realMeta) end',
    '    end',
    "    if eventType == 'editInput' then",
    '        for _, func in ipairs(editInputFuncs) do realValue = func(id, realValue, realMeta) end',
    '    end',
    "    if eventType == 'editOutput' then",
    '        for _, func in ipairs(editOutputFuncs) do realValue = func(id, realValue, realMeta) end',
    '    end',
    '    return json.encode(realValue)',
    'end',
    ''
  ].join('\n');

  // 현재 실행 컨텍스트 (엔진은 코드별로 캐시되므로 클로저로 잡으면 안 됨)
  var CURRENT = { ctx: null, safe: false, editDisplay: false, logs: [] };

  var factoryPromise = null;
  var engines = new Map(); // code -> { engine, editListeners }
  var loadState = 'idle'; // idle | loading | ready | error
  var loadError = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error('스크립트 로드 실패: ' + src));
      };
      document.head.appendChild(s);
    });
  }

  function isFileProtocol() {
    return location.protocol === 'file:';
  }

  async function ensureFactory() {
    if (factoryPromise) return factoryPromise;
    loadState = 'loading';
    factoryPromise = (async function () {
      // 지연 로드: Lua 를 실제로 쓸 때만 152KB 를 받는다
      if (typeof window.wasmoon === 'undefined') {
        await loadScript('vendor/wasmoon/index.js');
      }
      if (typeof window.wasmoon === 'undefined') {
        throw new Error('wasmoon 로드 실패 (vendor/wasmoon/index.js)');
      }
      if (!window.__JSON_LUA_SRC) {
        await loadScript('vendor/lua/json-lua.js');
      }

      var uri = 'vendor/wasmoon/glue.wasm';
      if (isFileProtocol()) {
        if (!window.__WASMOON_GLUE_URI) {
          await loadScript('vendor/wasmoon/glue.dataurl.js');
        }
        uri = window.__WASMOON_GLUE_URI;
      }

      var factory = new window.wasmoon.LuaFactory(uri);
      await factory.mountFile('json.lua', window.__JSON_LUA_SRC);
      loadState = 'ready';
      return factory;
    })().catch(function (e) {
      loadState = 'error';
      loadError = e;
      throw e;
    });
    return factoryPromise;
  }

  // 호스트 API 주입 (원본 scriptings.ts:100-520 의 축소판)
  function installBridge(engine) {
    var g = engine.global;
    var ctx = function () {
      return CURRENT.ctx;
    };

    // ---- 무게이트 ----
    g.set('getChatVar', function (id, key) {
      var v = ctx().vars[key];
      return v == null ? '' : String(v);
    });
    g.set('getGlobalVar', function (id, key) {
      var v = ctx().globalVars[key];
      return v == null ? '' : String(v);
    });
    g.set('cbs', function (value) {
      var internal = window.RisuSim && window.RisuSim._internal;
      if (!internal) return String(value);
      return internal.cbsParse(String(value), ctx());
    });
    g.set('logMain', function (jsonValue) {
      CURRENT.logs.push(String(jsonValue));
    });
    g.set('getName', function () {
      return ctx().charName || '';
    });
    g.set('getPersonaName', function () {
      return ctx().userName || '';
    });
    g.set('getTokens', function () {
      return 0;
    });

    // ---- 채팅 읽기 ----
    g.set('getChatMain', function (id, index) {
      var c = ctx().chat || [];
      var m = c[index];
      if (!m) return JSON.stringify({});
      return JSON.stringify({ role: m.role, data: m.data, content: m.data, time: m.time || 0 });
    });
    g.set('getFullChatMain', function () {
      var c = ctx().chat || [];
      return JSON.stringify(
        c.map(function (m) {
          return { role: m.role, data: m.data, content: m.data };
        })
      );
    });
    g.set('getRecentChatsMain', function (id, count) {
      var c = ctx().chat || [];
      var n = parseInt(count, 10) || 10;
      return JSON.stringify(
        c.slice(-n).map(function (m) {
          return { role: m.role, data: m.data, content: m.data };
        })
      );
    });
    g.set('getChatLength', function () {
      return (ctx().chat || []).length;
    });
    g.set('getChatRole', function (id, index) {
      var m = (ctx().chat || [])[index];
      return m ? m.role : '';
    });
    g.set('getChatData', function (id, index) {
      var m = (ctx().chat || [])[index];
      return m ? String(m.data) : '';
    });

    // ---- Safe 등급 (editDisplay 에서는 무시됨) ----
    function guardSafe() {
      return CURRENT.safe;
    }

    g.set('setChatVar', function (id, key, value) {
      // 원본: Safe 또는 EditDisplay 만 허용 → 편집 훅에서는 항상 허용
      if (!CURRENT.safe && !CURRENT.editDisplay) return;
      ctx().vars[key] = String(value);
    });
    g.set('setChatVarChanged', function (id, key, value) {
      if (!CURRENT.safe && !CURRENT.editDisplay) return;
      ctx().vars[key] = String(value);
      return true;
    });
    g.set('setGlobalVar', function (id, key, value) {
      if (!CURRENT.safe && !CURRENT.editDisplay) return;
      ctx().globalVars[key] = String(value);
    });

    g.set('stopChat', function () {
      if (!guardSafe()) return;
      CURRENT.ctx.stopSending = true;
    });

    g.set('setChatMain', function (id, index, value) {
      if (!guardSafe()) return;
      var c = CURRENT.ctx.chat || [];
      try {
        var v = JSON.parse(value);
        if (c[index]) c[index].data = v;
      } catch (e) {}
    });
    g.set('setChatRole', function (id, index, role) {
      if (!guardSafe()) return;
      var c = CURRENT.ctx.chat || [];
      if (c[index]) c[index].role = String(role);
    });
    g.set('cutChat', function (id, start, end) {
      if (!guardSafe()) return;
      var c = CURRENT.ctx.chat || [];
      c.splice(start, end);
    });
    g.set('removeChat', function (id, index) {
      if (!guardSafe()) return;
      var c = CURRENT.ctx.chat || [];
      c.splice(index, 1);
    });
    g.set('addChat', function (id, role, value) {
      if (!guardSafe()) return;
      var c = CURRENT.ctx.chat || [];
      c.push({ role: String(role), data: String(value) });
    });
    g.set('insertChat', function (id, index, role, value) {
      if (!guardSafe()) return;
      var c = CURRENT.ctx.chat || [];
      c.splice(index, 0, { role: String(role), data: String(value) });
    });
    g.set('setFullChatMain', function (id, jsonValue) {
      if (!guardSafe()) return;
      try {
        var arr = JSON.parse(jsonValue);
        CURRENT.ctx.chat.length = 0;
        arr.forEach(function (m) {
          CURRENT.ctx.chat.push({ role: m.role, data: m.data != null ? m.data : m.content });
        });
      } catch (e) {}
    });

    ['alertNormal', 'alertError', 'alertInput', 'alertSelect', 'alertConfirm'].forEach(function (name) {
      g.set(name, function () {
        if (!guardSafe()) return '';
        CURRENT.logs.push('[' + name + '] 로그(시뮬레이터에서는 출력만)');
        return '';
      });
    });
    g.set('sleep', function () {
      if (!guardSafe()) return;
    });
    g.set('reloadDisplay', function () {
      if (!guardSafe()) return;
    });
    g.set('reloadChat', function () {
      if (!guardSafe()) return;
    });
    g.set('getLoreBooks', function () {
      return '[]';
    });
    g.set('setBackgroundEmbedding', function () {
      return;
    });
  }

  async function getEngine(code) {
    var cached = engines.get(code);
    if (cached) return cached;
    var factory = await ensureFactory();
    var engine = await factory.createEngine({ injectObjects: true, enableProxy: false });
    var editListeners = new Set();
    engine.global.set('__registerEditListener', function (eventType) {
      editListeners.add(String(eventType));
    });
    installBridge(engine);
    await engine.doString(WRAPPER + '\n' + code);
    var state = { engine: engine, editListeners: editListeners, code: code };
    engines.set(code, state);
    return state;
  }

  var keyCounter = 0;
  function nextKey() {
    keyCounter += 1;
    return 'sim-' + keyCounter;
  }

  /**
   * 원본 scriptings.ts:1478 runLuaEditTrigger
   * triggers 배열을 순회하며 effect[0].type === 'triggerlua' 인 것만 실행한다.
   */
  async function runEditHooks(triggers, mode, data, ctx, meta) {
    var results = [];
    var list = Array.isArray(triggers) ? triggers : [];

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var entry = {
        n: i + 1,
        comment: (t && t.comment) || '',
        triggerType: t && t.type,
        mode: mode
      };

      var effect0 = t && Array.isArray(t.effect) ? t.effect[0] : null;
      if (!effect0 || effect0.type !== 'triggerlua') {
        entry.skipped = 'effect[0].type 이 triggerlua 가 아님 (원본도 이 트리거는 건너뜀)';
        results.push(entry);
        continue;
      }
      var code = effect0.code;
      if (!code || !String(code).trim()) {
        entry.skipped = 'code 가 비어 있음';
        results.push(entry);
        continue;
      }

      CURRENT.ctx = ctx;
      CURRENT.safe = mode !== 'editDisplay';
      CURRENT.editDisplay = mode === 'editDisplay';
      CURRENT.logs = [];
      entry.code = String(code);

      try {
        var state = await getEngine(String(code));
        if (!state.editListeners.has(mode)) {
          entry.skipped = "이 스크립트가 listenEdit('" + mode + "') 를 등록하지 않음";
          results.push(entry);
          continue;
        }
        var fn = state.engine.global.get('callListenMain');
        if (typeof fn !== 'function') {
          entry.skipped = 'callListenMain 없음 (래퍼 초기화 실패)';
          results.push(entry);
          continue;
        }

        var payload = mode === 'editDisplay' ? String(data) : JSON.stringify(data);
        var res = await fn(mode, nextKey(), payload, JSON.stringify(meta || {}));

        var before = data;
        if (mode === 'editDisplay') {
          if (typeof res === 'string') data = res;
        } else {
          try {
            data = JSON.parse(res);
          } catch (e) {
            entry.error = 'callListenMain 반환값 JSON 파싱 실패';
          }
        }
        entry.before = before;
        entry.after = data;
        entry.changed = before !== data;
        entry.logs = CURRENT.logs.slice();
        results.push(entry);
      } catch (e) {
        entry.error = String((e && e.message) || e);
        results.push(entry);
      }
    }

    return { data: data, results: results };
  }

  /**
   * 트리거의 triggerlua 효과 실행 (scriptings.ts:1116-1181 Lua 분기)
   *   start  → onStart(id)
   *   input  → onInput(id)
   *   output → onOutput(id)
   *   manual → 전역 함수 <manualName>(id)
   */
  async function runTriggerScript(code, mode, manualName, ctx, lowLevelAccess) {
    if (!code || !String(code).trim()) return { skipped: 'code 가 비어 있음' };

    var fnName =
      mode === 'manual'
        ? manualName
        : mode === 'start'
          ? 'onStart'
          : mode === 'input'
            ? 'onInput'
            : mode === 'output'
              ? 'onOutput'
              : mode;
    if (!fnName) return { skipped: 'manualName 이 비어 있음' };

    CURRENT.ctx = ctx;
    CURRENT.safe = true;
    CURRENT.editDisplay = false;
    CURRENT.logs = [];

    var state;
    try {
      state = await getEngine(String(code));
    } catch (e) {
      return { fn: fnName, error: String((e && e.message) || e) };
    }

    var fn;
    try {
      fn = state.engine.global.get(fnName);
    } catch (e) {
      fn = null;
    }
    if (typeof fn !== 'function') {
      return { fn: fnName, skipped: fnName + ' 함수가 없음' };
    }

    try {
      var res = await fn(nextKey());
      return {
        fn: fnName,
        stopSending: res === false,
        logs: CURRENT.logs.slice()
      };
    } catch (e) {
      return { fn: fnName, error: String((e && e.message) || e), logs: CURRENT.logs.slice() };
    }
  }

  window.RisuLua = {
    runEditHooks: runEditHooks,
    runTriggerScript: runTriggerScript,
    status: function () {
      return { state: loadState, error: loadError ? String(loadError.message) : null, engines: engines.size };
    },
    reset: function () {
      engines.forEach(function (s) {
        try {
          s.engine.global.close();
        } catch (e) {}
      });
      engines.clear();
      factoryPromise = null;
      loadState = 'idle';
    }
  };
})();

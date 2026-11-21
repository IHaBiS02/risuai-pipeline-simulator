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

  // 원본 scriptings.ts:1302 luaCodeWrapper — 그대로 (async / Promise.create / :await() 포함).
  // wasmoon(injectObjects) 의 Promise 확장으로 원본과 똑같이 동작한다.
  var WRAPPER = "\njson = require 'json'\n\nfunction getChat(id, index)\n    return json.decode(getChatMain(id, index))\nend\n\nfunction getFullChat(id)\n    return json.decode(getFullChatMain(id))\nend\n\nfunction getRecentChats(id, count)\n    return json.decode(getRecentChatsMain(id, count))\nend\n\nfunction setFullChat(id, value)\n    setFullChatMain(id, json.encode(value))\nend\n\nfunction log(value)\n    logMain(json.encode(value))\nend\n\nfunction getLoreBooks(id, search)\n    return json.decode(getLoreBooksMain(id, search))\nend\n\n\nfunction loadLoreBooks(id)\n    return json.decode(loadLoreBooksMain(id):await())\nend\n\nfunction LLM(id, prompt, useMultimodal, options)\n    useMultimodal = useMultimodal or false\n    options = options or {}\n    return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())\nend\n\nfunction axLLM(id, prompt, useMultimodal, options)\n    useMultimodal = useMultimodal or false\n    options = options or {}\n    return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())\nend\n\nfunction getCharacterImage(id)\n    return getCharacterImageMain(id):await()\nend\n\nfunction getPersonaImage(id)\n    return getPersonaImageMain(id):await()\nend\n\nlocal editRequestFuncs = {}\nlocal editDisplayFuncs = {}\nlocal editInputFuncs = {}\nlocal editOutputFuncs = {}\n\nfunction listenEdit(type, func)\n    if type == 'editRequest' then\n        editRequestFuncs[#editRequestFuncs + 1] = func\n        __registerEditListener(type)\n        return\n    end\n\n    if type == 'editDisplay' then\n        editDisplayFuncs[#editDisplayFuncs + 1] = func\n        __registerEditListener(type)\n        return\n    end\n\n    if type == 'editInput' then\n        editInputFuncs[#editInputFuncs + 1] = func\n        __registerEditListener(type)\n        return\n    end\n\n    if type == 'editOutput' then\n        editOutputFuncs[#editOutputFuncs + 1] = func\n        __registerEditListener(type)\n        return\n    end\n\n    throw('Invalid type')\nend\n\nfunction getState(id, name)\n    local escapedName = \"__\"..name\n    return json.decode(getChatVar(id, escapedName))\nend\n\nfunction setState(id, name, value)\n    local escapedName = \"__\"..name\n    setChatVar(id, escapedName, json.encode(value))\nend\n\nfunction setStateChanged(id, name, value)\n    local escapedName = \"__\"..name\n    return setChatVarChanged(id, escapedName, json.encode(value))\nend\n\nfunction async(callback)\n    return function(...)\n        local co = coroutine.create(callback)\n        local safe, result = coroutine.resume(co, ...)\n\n        return Promise.create(function(resolve, reject)\n            local checkresult\n            local step = function()\n                if coroutine.status(co) == \"dead\" then\n                    local send = safe and resolve or reject\n                    return send(result)\n                end\n\n                safe, result = coroutine.resume(co)\n                checkresult()\n            end\n\n            checkresult = function()\n                if safe and result == Promise.resolve(result) then\n                    result:finally(step)\n                else\n                    step()\n                end\n            end\n\n            checkresult()\n        end)\n    end\nend\n\ncallListenMain = async(function(eventType, id, value, meta)\n    local realValue = value\n    local realMeta = json.decode(meta)\n\n    if eventType == 'editDisplay' then\n        local realValue = value\n        for _, func in ipairs(editDisplayFuncs) do\n            local output = func(id, realValue, realMeta)\n            local outputType = type(output)\n            if outputType == 'string' then\n                realValue = output\n            else\n                print('Error: Lua editDisplay must return a string, received ' .. outputType)\n            end\n        end\n        return realValue\n    end\n\n    realValue = json.decode(value)\n\n    if eventType == 'editRequest' then\n        for _, func in ipairs(editRequestFuncs) do\n            realValue = func(id, realValue, realMeta)\n        end\n    end\n\n    if eventType == 'editInput' then\n        for _, func in ipairs(editInputFuncs) do\n            realValue = func(id, realValue, realMeta)\n        end\n    end\n\n    if eventType == 'editOutput' then\n        for _, func in ipairs(editOutputFuncs) do\n            realValue = func(id, realValue, realMeta)\n        end\n    end\n\n    return json.encode(realValue)\nend)\n\n";

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
    // scriptings.ts:111 — chatVar.svelte 의 getChatVar (scriptstate → defaultVariables → 'null')
    // 트리거에서 부르면 트리거의 getVar/setVar (로컬 변수·display tempVars 포함, scriptings.ts:67-68)
    g.set('getChatVar', function (id, key) {
      if (CURRENT.vars) return CURRENT.vars.getVar(String(key));
      return window.RisuCBS.getChatVar(ctx(), String(key));
    });
    // scriptings.ts:128 — getGlobalChatVar (없으면 'null')
    g.set('getGlobalVar', function (id, key) {
      return window.RisuCBS.getGlobalChatVar(ctx(), String(key));
    });
    // scriptings.ts:283 — risuChatParser(value, { chara })
    g.set('cbs', function (value) {
      return window.RisuCBS.parse(String(value), ctx(), {});
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
    // scriptings.ts:168-270 — .at(index) (음수 인덱스 허용), 없으면 null
    function msgOut(m) {
      return { role: m.role, data: m.data, time: m.time || 0, chatId: m.chatId };
    }
    g.set('getChatMain', function (id, index) {
      var m = (ctx().chat || []).at(index);
      if (!m) return JSON.stringify(null);
      return JSON.stringify(msgOut(m));
    });
    g.set('getFullChatMain', function () {
      return JSON.stringify((ctx().chat || []).map(msgOut));
    });
    g.set('getRecentChatsMain', function (id, count) {
      var c = ctx().chat || [];
      var safeCount = Math.max(0, Math.floor(count || 0));
      var start = Math.max(0, c.length - safeCount);
      return JSON.stringify(c.slice(start).map(msgOut));
    });
    g.set('getChatLength', function () {
      return (ctx().chat || []).length;
    });
    g.set('getChatRole', function (id, index) {
      var m = (ctx().chat || []).at(index);
      return m ? m.role : '';
    });
    g.set('getChatData', function (id, index) {
      var m = (ctx().chat || []).at(index);
      return m ? m.data : '';
    });

    // ---- Safe 등급 (editDisplay 에서는 무시됨) ----
    function guardSafe() {
      return CURRENT.safe;
    }

    g.set('setChatVar', function (id, key, value) {
      // 원본: Safe 또는 EditDisplay 만 허용 → 편집 훅에서는 항상 허용
      if (!CURRENT.safe && !CURRENT.editDisplay) return;
      if (CURRENT.vars) CURRENT.vars.setVar(String(key), String(value));
      else window.RisuCBS.setChatVar(ctx(), String(key), String(value));
    });
    g.set('setChatVarChanged', function (id, key, value) {
      if (!CURRENT.safe && !CURRENT.editDisplay) return;
      if (CURRENT.vars) {
        if (CURRENT.vars.setVar(String(key), String(value)) === true) return true;
        return;
      }
      var before = ctx().scriptstate['$' + key];
      window.RisuCBS.setChatVar(ctx(), String(key), String(value));
      if (before !== ctx().scriptstate['$' + key]) return true;
    });
    // 원본에는 setGlobalVar API 가 없다 (전역 변수는 Lua 에서 읽기 전용)

    g.set('stopChat', function () {
      if (!guardSafe()) return;
      CURRENT.ctx.stopSending = true;
    });

    // scriptings.ts:197 setChat(id, index, value) — 값은 문자열 그대로, .at(index)
    g.set('setChat', function (id, index, value) {
      if (!guardSafe()) return;
      var m = (CURRENT.ctx.chat || []).at(index);
      if (m) m.data = value == null ? '' : value;
    });
    g.set('setChatRole', function (id, index, role) {
      if (!guardSafe()) return;
      var m = (CURRENT.ctx.chat || []).at(index);
      if (m) m.role = role === 'user' ? 'user' : 'char';
    });
    g.set('cutChat', function (id, start, end) {
      if (!guardSafe()) return;
      // scriptings.ts:222 — slice(start, end) 로 교체 (splice 아님)
      CURRENT.ctx.chat = (CURRENT.ctx.chat || []).slice(start, end);
    });
    g.set('removeChat', function (id, index) {
      if (!guardSafe()) return;
      var c = CURRENT.ctx.chat || [];
      c.splice(index, 1);
    });
    g.set('addChat', function (id, role, value) {
      if (!guardSafe()) return;
      var c = CURRENT.ctx.chat || [];
      c.push({ role: role === 'user' ? 'user' : 'char', data: value == null ? '' : value });
    });
    g.set('insertChat', function (id, index, role, value) {
      if (!guardSafe()) return;
      var c = CURRENT.ctx.chat || [];
      c.splice(index, 0, { role: role === 'user' ? 'user' : 'char', data: value == null ? '' : value });
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
      // scriptings.ts:321 ReloadGUIPointer + 1 → resetScriptCache()
      if (window.RisuSim && window.RisuSim.resetScriptCache) window.RisuSim.resetScriptCache();
    });
    g.set('reloadChat', function () {
      if (!guardSafe()) return;
    });
    // DIFF: 로어북은 시뮬레이터에 없음 — 빈 목록
    g.set('getLoreBooksMain', function () {
      return '[]';
    });
    g.set('setBackgroundEmbedding', function () {
      return;
    });
  }

  // scriptings.ts:1271 getOrCreateEngineState + :84-97 — 엔진은 mode 별로 하나.
  // 코드가 바뀌면 엔진을 닫고 새로 만든다 → 같은 mode 에 Lua 트리거가 여러 개면
  // 매번 새 엔진이라 Lua 전역 변수가 이어지지 않는다 (원본과 동일).
  async function getEngine(code, mode) {
    var cached = engines.get(mode);
    if (cached && cached.code === code) return cached;
    if (cached) {
      try {
        cached.engine.global.close();
      } catch (e) {
        /* ignore */
      }
      engines.delete(mode);
    }
    var factory = await ensureFactory();
    var engine = await factory.createEngine({ injectObjects: true, enableProxy: false });
    var editListeners = new Set();
    engine.global.set('__registerEditListener', function (eventType) {
      editListeners.add(String(eventType));
    });
    installBridge(engine);
    await engine.doString(WRAPPER + '\n' + code);
    var state = { engine: engine, editListeners: editListeners, code: code };
    engines.set(mode, state);
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
    var content = data;
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
      CURRENT.vars = null;
      CURRENT.safe = mode !== 'editDisplay';
      CURRENT.editDisplay = mode === 'editDisplay';
      CURRENT.logs = [];
      entry.code = String(code);

      // 엔진 생성(코드 로드) 오류는 원본에서 runScripted 밖으로 던져져
      // runLuaEditTrigger 전체가 원래 content 를 돌려준다 (scriptings.ts:1514-1516)
      var state;
      try {
        state = await getEngine(String(code), mode);
      } catch (e) {
        entry.error = String((e && e.message) || e) + ' — 원본도 이 훅 전체를 취소하고 원래 텍스트를 씀';
        results.push(entry);
        return { data: content, results: results, aborted: true };
      }
      if (!state.editListeners.has(mode)) {
        entry.skipped = "이 스크립트가 listenEdit('" + mode + "') 를 등록하지 않음";
        results.push(entry);
        continue;
      }
      var before = data;
      var res;
      try {
        var fn = state.engine.global.get('callListenMain');
        if (fn) {
          var directString = mode === 'editDisplay';
          var payload = directString ? data : JSON.stringify(data);
          res = await fn(mode, nextKey(), payload, JSON.stringify(meta || {}));
          if (!directString) res = JSON.parse(res);
        }
      } catch (e) {
        // 원본: console.error 후 res 는 undefined → data 유지
        entry.error = String((e && e.message) || e);
        res = undefined;
      }
      data = res == null ? data : res; // runResult.res ?? data
      entry.before = before;
      entry.after = data;
      entry.changed = before !== data;
      entry.logs = CURRENT.logs.slice();
      results.push(entry);
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
  async function runTriggerScript(code, mode, manualName, ctx, lowLevelAccess, vars) {
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
    CURRENT.vars = vars || null;

    var state;
    try {
      state = await getEngine(String(code), mode === 'manual' ? manualName : mode);
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

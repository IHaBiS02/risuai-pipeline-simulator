/*
 * RisuAI 파이프라인 시뮬레이터 — 트리거
 * ------------------------------------------------------------------
 * 트리거 VM 은 원본 src/ts/process/triggers.ts 의 runTrigger 를 그대로 쓴다
 * (vendor/risu-core.js — tools/build-vendor.mjs 가 원본 파일을 묶음).
 * 여기는 원본이 읽는 앱 상태(DB · 현재 캐릭터 · 현재 채팅 · 모듈 트리거)를 시뮬레이터 값으로 채우고,
 * 실행 기록(trace)을 모으는 어댑터일 뿐이다.
 *
 * 원본 그대로인 것: 모든 effect(v1/v2 · 문자열 치환 · 딕셔너리 · 배열 · 로어북 · 로컬 변수),
 *   type 필터와 triggerlua 우회, 조건, display/request allowlist, 재귀 깊이,
 *   lowLevelAccess (캐릭터 트리거 = char.lowLevelAccess, 모듈 트리거 = module.lowLevelAccess)
 * 바깥 세계가 필요한 것(스텁): runLLM / imgGen / 유사도 / 명령어 / 알림 입력 → 실패 값 + 배지
 */
(function () {
  'use strict';
  var G = typeof window !== 'undefined' ? window : globalThis;

  function core() {
    if (!G.RisuCore || !G.RisuCore.runTrigger) throw new Error('vendor/risu-core.js 미로드');
    return G.RisuCore;
  }

  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }

  function describe(effect) {
    var keys = ['var', 'operator', 'value', 'source', 'condition', 'target', 'outputVar', 'target', 'index', 'name', 'regex', 'replacement', 'key'];
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (effect[k] != null && effect[k] !== '' && out.indexOf(k) < 0) out.push(k + '=' + String(effect[k]).slice(0, 40));
    }
    return out.join(' ');
  }

  /**
   * @param ctx   simulator makeCtx() 결과 (scriptstate · chat · defaultVariables · ...)
   * @param opts  charTriggers, moduleTriggers(각자 lowLevelAccess 를 이미 가진 것), chat,
   *              charLowLevelAccess, displayMode, displayData, globalLore
   */
  function create(ctx, opts) {
    opts = opts || {};

    async function run(mode, arg) {
      arg = arg || {};
      var R = core();
      var env = R.env;
      var trace = [];
      var logs = [];
      var cur = null;
      var byTrigger = new Map();
      var unsupported = ctx.unsupported || (ctx.unsupported = new Set());

      // 원본이 보는 앱 상태: DB 한 개 · 캐릭터 한 개 · 채팅 한 개
      var chatObj = {
        message: opts.chat || ctx.chat || [],
        scriptstate: ctx.scriptstate || (ctx.scriptstate = {}),
        note: ctx.authorNote || '',
        fmIndex: ctx.fmIndex == null ? -1 : ctx.fmIndex,
        localLore: []
      };
      var character = ctx.character || {};
      var dbChar = {
        type: 'character',
        chaId: ctx.chaId || 'sim',
        name: ctx.charName || 'Char',
        desc: character.desc || '',
        firstMessage: character.firstMessage || '',
        alternateGreetings: character.alternateGreetings || [],
        replaceGlobalNote: character.replaceGlobalNote || '',
        defaultVariables: ctx.defaultVariables || '',
        lowLevelAccess: !!opts.charLowLevelAccess,
        triggerscript: clone(opts.charTriggers || []),
        globalLore: clone(opts.globalLore || []),
        chats: [chatObj],
        chatPage: 0
      };
      var db = {
        characters: [dbChar],
        templateDefaultVariables: ctx.templateDefaultVariables || '',
        personaPrompt: ctx.personaPrompt || '',
        personas: [{ personaPrompt: ctx.personaPrompt || '', name: ctx.userName || 'User' }],
        selectedPersona: 0
      };
      // getModuleTriggers() 는 원본도 매번 module.trigger 를 그대로(복사 없이) 이어 붙인다
      var moduleTriggers = clone(opts.moduleTriggers || []);

      function entryOf(trigger) {
        var e = byTrigger.get(trigger);
        if (!e) {
          e = { n: trace.length + 1, comment: trigger.comment || '', type: trigger.type, mode: mode, manualName: arg.manualName,
                lowLevelAccess: !!trigger.lowLevelAccess, skipped: null, conditions: [], effectsRun: [], logs: [] };
          var first = trigger.effect && trigger.effect[0] && trigger.effect[0].type;
          if (first === 'triggercode' || first === 'triggerlua') e.bypass = 'effect[0]=' + first + ' → type 필터 우회';
          byTrigger.set(trigger, e);
          trace.push(e);
        }
        return e;
      }

      var hook = {
        trigger: function (t) {
          cur = entryOf(t);
          cur.skipped = arg.manualName ? 'manual 이름 불일치' : 'type 불일치 (' + t.type + ' ≠ ' + mode + ')';
        },
        matched: function (t) {
          cur = entryOf(t);
          cur.skipped = (t.conditions && t.conditions.length) ? '조건 불충족' : null;
        },
        cond: function (t, c, pass) {
          entryOf(t).conditions.push({ type: c.type, operator: c.operator || c.type2, value: c.var != null ? c.var : c.value, expect: c.type === 'exists' ? c.value : c.value, pass: !!pass });
        },
        passed: function (t) {
          cur = entryOf(t);
          cur.skipped = null;
        },
        effect: function (t, index, effect) {
          entryOf(t).effectsRun.push({ index: index, type: effect.type, detail: describe(effect) });
        },
        setVar: function (key, value, display) {
          if (cur) cur.logs.push((display ? '(표시 전용) ' : '') + 'setVar ' + key + ' = ' + String(value).slice(0, 200));
        }
      };

      function unsup(name) {
        unsupported.add(name);
        if (cur) {
          var last = cur.effectsRun[cur.effectsRun.length - 1];
          if (last) last.skipped = name + ' — 시뮬레이터에서 지원 안 함 (실패 값으로 진행)';
        }
      }

      var prevEnv = {};
      var patch = {
        db: db,
        hook: hook,
        moduleTriggers: function () { return moduleTriggers; },
        // risuChatParser(x, { chara }) — 트리거가 바꾼 scriptstate 를 그대로 본다
        risuChatParser: function (s, o) {
          ctx.scriptstate = chatObj.scriptstate;
          return G.RisuCBS.parse(String(s == null ? '' : s), ctx, o || {});
        },
        runScripted: async function (code, a) {
          if (!G.RisuLua || !G.RisuLua.runTriggerScript) {
            unsup('triggerlua(Lua 런타임 없음)');
            return { chat: a.chat, stopSending: false };
          }
          ctx.chat = a.chat.message;
          ctx.scriptstate = chatObj.scriptstate;
          var isManual = mode === 'manual';
          var res = await G.RisuLua.runTriggerScript(String(code || ''), isManual ? 'manual' : a.mode, isManual ? a.mode : '', ctx,
            !!a.lowLevelAccess, { getVar: a.getVar, setVar: a.setVar });
          a.chat.message = ctx.chat;
          if (cur) {
            var last = cur.effectsRun[cur.effectsRun.length - 1];
            if (last) {
              last.detail = 'Lua ' + (res && res.fn ? res.fn + '()' : '') + (a.lowLevelAccess ? ' · lowLevelAccess' : '') + (res && res.skipped ? ' — ' + res.skipped : '');
              if (res && res.error) last.error = res.error;
            }
            if (res && res.logs) cur.logs.push.apply(cur.logs, res.logs);
          }
          return { chat: a.chat, stopSending: !!(res && res.stopSending) };
        },
        unsupported: function (name) { unsup(name); },
        alert: function (kind, m) { if (cur) cur.logs.push('[alert ' + kind + '] ' + m); },
        alertInput: async function (m) { unsup('alertInput'); return ''; },
        alertSelect: async function () { unsup('alertSelect'); return '0'; },
        tokenize: async function (s) { return Math.ceil(String(s).length / 4); },
        onReloadGUI: function () { if (typeof opts.onReloadGUI === 'function') opts.onReloadGUI(); }
      };
      Object.keys(patch).forEach(function (k) { prevEnv[k] = env[k]; });
      R.setEnv(patch);

      // v2ConsoleLog 는 원본에서 console.log 로 간다 → 실행 중에만 가로챈다
      var origLog = console.log;
      console.log = function () {
        var line = Array.prototype.map.call(arguments, function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join(' ');
        if (cur) cur.logs.push(line);
        logs.push(line);
      };

      var tempVars = opts.displayMode ? {} : undefined;
      var res = null;
      var error = null;
      try {
        res = await R.runTrigger(dbChar, mode, {
          chat: chatObj,
          displayMode: !!opts.displayMode,
          displayData: opts.displayData,
          tempVars: tempVars,
          manualName: arg.manualName,
          recursiveCount: arg.recursiveCount,
          triggerId: arg.triggerId
        });
      } catch (e) {
        error = String((e && e.message) || e);
        if (cur) cur.error = error;
      } finally {
        console.log = origLog;
        Object.keys(prevEnv).forEach(function (k) { env[k] = prevEnv[k]; });
        env.hook = null;
      }

      // 원본: 비표시 모드는 chat 사본을 돌려주고, 바뀐 변수는 이미 현재 채팅 scriptstate 에 들어가 있다
      var outChat = res && res.chat ? res.chat : chatObj;
      ctx.scriptstate = outChat.scriptstate || chatObj.scriptstate || ctx.scriptstate;
      return {
        chat: outChat.message || ctx.chat,
        stopSending: !!(res && res.stopSending),
        sendAIprompt: !!(res && res.sendAIprompt),
        displayData: res ? res.displayData : opts.displayData,
        additionalSysPrompt: res ? res.additonalSysPrompt : { start: '', historyend: '', promptend: '' },
        tokens: res ? res.tokens : 0,
        scriptstate: ctx.scriptstate,
        tempVars: tempVars || {},
        lorebook: dbChar.globalLore,
        logs: logs,
        trace: trace,
        error: error
      };
    }

    return { run: run };
  }

  G.RisuTrigger = {
    create: create,
    get allowlists() {
      var R = core();
      return { display: R.displayAllowList, request: R.requestAllowList };
    }
  };
})();

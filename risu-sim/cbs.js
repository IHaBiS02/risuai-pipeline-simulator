/*
 * CBS ({{...}}) 엔진 — RisuAI 원본을 줄 단위로 옮긴 것
 * ------------------------------------------------------------------
 *   스캐너/블록:  src/ts/parser/parser.svelte.ts:1096-1873
 *                 (matcher, legacyBlockMatcher, blockStartMatcher, trimLines,
 *                  blockEndMatcher, risuChatParser — 로직 변경 없음)
 *   함수 242개:   src/ts/cbs.ts 를 그대로 번들 (vendor/risu-core.js, registerCBS)
 *   {{? }}/calc:  src/ts/process/infunctions.ts calcString (번들)
 *   변수:         src/ts/parser/chatVar.svelte.ts (아래 getChatVar 등)
 *
 * 앱 상태(DB/선택된 캐릭터/채팅)는 시뮬레이터 ctx 로 만든 가짜 DB 에서 읽는다 (buildDb).
 * 이 파일의 함수는 RisuAI 와 같은 이름·같은 인자를 쓴다.
 *
 * 의존: vendor/risu-core.js (window.RisuCore)
 */
(function () {
  'use strict';

  var G = typeof window !== 'undefined' ? window : globalThis;
  var Core = G.RisuCore;
  if (!Core) throw new Error('cbs.js: vendor/risu-core.js 를 먼저 불러와야 합니다');

  // ------------------------------------------------------------------
  // 현재 실행 컨텍스트 (원본의 DBState / selectedCharID 에 해당)
  //   risuChatParser 는 동기 함수라 전역 하나로 충분하다.
  // ------------------------------------------------------------------
  var CUR = null;

  function withCtx(ctx, fn) {
    var prev = CUR;
    CUR = ctx;
    try {
      return fn();
    } finally {
      CUR = prev;
    }
  }

  // util.ts:989 parseKeyValue — 그대로
  function parseKeyValue(template) {
    try {
      if (!template) return [];
      var keyValue = [];
      var lines = String(template).split('\n');
      for (var i = 0; i < lines.length; i++) {
        var kv = lines[i].split('=');
        var key = kv[0];
        var value = kv[1];
        if (key && value) keyValue.push([key, value]);
      }
      return keyValue;
    } catch (e) {
      return [];
    }
  }

  // chatVar.svelte.ts:6 getChatVar
  function getChatVar(key) {
    var ctx = CUR;
    if (!ctx) return 'null';
    ctx.scriptstate = ctx.scriptstate || {};
    var state = ctx.scriptstate['$' + key];
    if (state === undefined || state === null) {
      var defs = parseKeyValue(ctx.defaultVariables).concat(parseKeyValue(ctx.templateDefaultVariables));
      for (var i = 0; i < defs.length; i++) {
        if (defs[i][0] === key) return defs[i][1];
      }
      return 'null';
    }
    return state.toString();
  }

  // chatVar.svelte.ts:29 setChatVar
  function setChatVar(key, value) {
    var ctx = CUR;
    if (!ctx) return false;
    ctx.scriptstate = ctx.scriptstate || {};
    var stateKey = '$' + key;
    if (ctx.scriptstate[stateKey] === value) return false;
    ctx.scriptstate[stateKey] = value;
    return true;
  }

  // chatVar.svelte.ts:61 getGlobalChatVar (GLGlobalVariables 는 시뮬레이터에 없음)
  function getGlobalChatVar(key) {
    var ctx = CUR;
    if (!ctx || !ctx.globalVars) return 'null';
    var v = ctx.globalVars[key];
    return v === undefined || v === null ? 'null' : v;
  }

  function setGlobalChatVar(key, value) {
    if (CUR) {
      CUR.globalVars = CUR.globalVars || {};
      CUR.globalVars[key] = value;
    }
  }

  // parser.svelte.ts:1127 dateTimeFormat — 그대로
  function dateTimeFormat(main, time) {
    time = time || 0;
    var date = time === 0 ? new Date() : new Date(time);
    if (!main) return '';
    if (main.startsWith(':')) main = main.substring(1);
    if (main.length > 300) return '';
    return main
      .replace(/YYYY/g, date.getFullYear().toString())
      .replace(/YY/g, date.getFullYear().toString().substring(2))
      .replace(/MMMM/g, Intl.DateTimeFormat('en', { month: 'long' }).format(date))
      .replace(/MMM/g, Intl.DateTimeFormat('en', { month: 'short' }).format(date))
      .replace(/MM/g, (date.getMonth() + 1).toString().padStart(2, '0'))
      .replace(/DDDD/g, Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24)).toString())
      .replace(/DD/g, date.getDate().toString().padStart(2, '0'))
      .replace(/dddd/g, Intl.DateTimeFormat('en', { weekday: 'long' }).format(date))
      .replace(/ddd/g, Intl.DateTimeFormat('en', { weekday: 'short' }).format(date))
      .replace(/HH/g, date.getHours().toString().padStart(2, '0'))
      .replace(/hh/g, (date.getHours() % 12 || 12).toString().padStart(2, '0'))
      .replace(/mm/g, date.getMinutes().toString().padStart(2, '0'))
      .replace(/ss/g, date.getSeconds().toString().padStart(2, '0'))
      .replace(/X/g, Math.floor(date.getTime() / 1000).toString())
      .replace(/x/g, date.getTime().toString())
      .replace(/A/g, date.getHours() >= 12 ? 'PM' : 'AM');
  }

  // util.ts:503 sfc32 / util.ts:1101 pickHashRand — 그대로
  function sfc32(a, b, c, d) {
    return function () {
      a |= 0; b |= 0; c |= 0; d |= 0;
      var t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  function pickHashRand(cid, word) {
    var hashAddress = 5515;
    var rand = function (w) {
      for (var counter = 0; counter < w.length; counter++) {
        hashAddress = (hashAddress << 5) + hashAddress + w.charCodeAt(counter);
      }
      return hashAddress;
    };
    var randF = sfc32(rand(word), rand(word), rand(word), rand(word));
    var v = cid % 1000;
    for (var i = 0; i < v; i++) randF();
    return randF();
  }

  // parser.svelte.ts:1184-1211 — 그대로
  function parseArray(p1) {
    try {
      var arr = JSON.parse(p1);
      if (Array.isArray(arr)) return arr;
      return p1.split('§');
    } catch (e) {
      return p1.split('§');
    }
  }

  function parseDict(p1) {
    try {
      return JSON.parse(p1);
    } catch (e) {
      return {};
    }
  }

  function makeArray(p1) {
    return JSON.stringify(
      p1.map(function (f) {
        if (typeof f === 'string') return f.replace(/::/g, '\\u003A\\u003A');
        return f;
      })
    );
  }

  // ------------------------------------------------------------------
  // 가짜 DB: cbs.ts 콜백이 읽는 필드만 ctx 에서 채운다
  //   db.characters[getSelectedCharID()].chats[chatPage].message ...
  // ------------------------------------------------------------------
  function buildDb(ctx) {
    var ch = ctx.character || {};
    var chat = {
      message: ctx.chat || [],
      fmIndex: ctx.fmIndex == null ? -1 : ctx.fmIndex,
      note: ctx.authorNote || '',
      localLore: [],
      scriptstate: ctx.scriptstate
    };
    var character = {
      type: 'character',
      name: ctx.charName || ch.name || 'Char',
      nickname: ch.nickname || '',
      chaId: ch.chaId || 'sim',
      firstMessage: ch.firstMessage || '',
      alternateGreetings: ch.alternateGreetings || [],
      desc: ch.desc || '',
      personality: ch.personality || '',
      scenario: ch.scenario || '',
      exampleMessage: ch.exampleMessage || '',
      globalLore: ch.globalLore || [],
      additionalAssets: ch.additionalAssets || [],
      emotionImages: ch.emotionImages || [],
      prebuiltAssetCommand: !!ch.prebuiltAssetCommand,
      prebuiltAssetExclude: ch.prebuiltAssetExclude || [],
      chats: [chat],
      chatPage: 0
    };
    return {
      characters: [character],
      aiModel: ctx.aiModel || 'sim',
      subModel: ctx.subModel || 'sim',
      mainPrompt: ctx.mainprompt || '',
      jailbreak: ctx.jb || '',
      globalNote: ctx.globalnote || '',
      jailbreakToggle: false,
      maxContext: 4000,
      promptTemplate: null,
      language: 'ko',
      globalChatVariables: ctx.globalVars || {}
    };
  }

  function getDatabase() {
    if (!CUR) return buildDb({});
    if (!CUR.__db || CUR.__dbChat !== CUR.chat) {
      CUR.__db = buildDb(CUR);
      CUR.__dbChat = CUR.chat;
    }
    // scriptstate / 변수는 매번 최신 참조로
    var c = CUR.__db.characters[0];
    c.name = CUR.charName || c.name;
    c.chats[0].scriptstate = CUR.scriptstate;
    c.chats[0].message = CUR.chat || [];
    return CUR.__db;
  }

  // ------------------------------------------------------------------
  // 함수 레지스트리 (parser.svelte.ts:1045 initMatcher)
  // ------------------------------------------------------------------
  var matcherMap = new Map();
  var docOnly = new Set();

  Core.setEnv({
    getChatVar: getChatVar,
    getGlobalChatVar: getGlobalChatVar,
    setChatVar: setChatVar,
    get triggerId() {
      return CUR && CUR.triggerId != null ? CUR.triggerId : null;
    }
  });

  Core.registerCBS({
    registerFunction: function (arg) {
      var names = [arg.name].concat(arg.alias || []);
      if (arg.callback === 'doc_only') {
        names.forEach(function (n) { docOnly.add(n); });
        return;
      }
      for (var i = 0; i < names.length; i++) matcherMap.set(names[i], arg.callback);
    },
    getDatabase: getDatabase,
    getUserName: function () {
      return (CUR && CUR.userName) || 'User';
    },
    getPersonaPrompt: function () {
      return (CUR && CUR.personaPrompt) || '';
    },
    risuChatParser: function (t, a) {
      return risuChatParser(t, a);
    },
    makeArray: makeArray,
    safeStructuredClone: function (o) {
      return JSON.parse(JSON.stringify(o));
    },
    parseArray: parseArray,
    parseDict: parseDict,
    getChatVar: getChatVar,
    setChatVar: setChatVar,
    getGlobalChatVar: getGlobalChatVar,
    calcString: Core.calcString,
    dateTimeFormat: dateTimeFormat,
    getModules: function () {
      return (CUR && CUR.modules) || [];
    },
    getModuleLorebooks: function () {
      return [];
    },
    pickHashRand: pickHashRand,
    getSelectedCharID: function () {
      return 0;
    },
    getModelInfo: function () {
      return { id: 'sim', name: 'sim', shortName: 'sim', internalID: 'sim', format: 0, provider: 0, tokenizer: 0, flags: [] };
    },
    callInternalFunction: function () {
      return '';
    },
    isTauri: false,
    isNodeServer: false,
    isMobile: false,
    appVer: 'sim'
  });

  // parser.svelte.ts:1096 matcher — 그대로 (+ 모르는 함수 기록)
  function matcher(p1, matcherArg, vars) {
    try {
      if (p1.startsWith('? ')) {
        var substring = p1.substring(2);
        return Core.calcString(substring).toString();
      }
      var colonIndex = p1.indexOf(':');
      var splited;
      if (colonIndex !== -1 && p1[colonIndex + 1] === ':') splited = p1.split('::');
      else splited = p1.split(':');
      var name = splited[0].toLocaleLowerCase().replace(/[\s_-]/g, '');
      var args = splited.slice(1);
      var callback = matcherMap.get(name);
      if (callback) return callback(p1, matcherArg, args, vars);
      // 시뮬레이터 진단용: 원본에도 없는 함수인지 기록 (자산 태그 등 doc_only 는 제외)
      if (CUR && CUR.unsupported && !docOnly.has(name) && !docOnly.has(splited[0])) {
        CUR.unsupported.add('{{' + splited[0] + '}}');
      }
    } catch (error) {
      if (CUR) {
        CUR.cbsErrors = CUR.cbsErrors || [];
        CUR.cbsErrors.push(String((error && error.message) || error) + ' @ {{' + p1.slice(0, 40) + '}}');
      }
    }
    return null;
  }

  // parser.svelte.ts:1158 — 그대로
  function legacyBlockMatcher(p1) {
    var bn = p1.indexOf('\n');
    if (bn === -1) return null;
    var logic = p1.substring(0, bn);
    var content = p1.substring(bn + 1);
    var statement = logic.split(' ', 2);
    switch (statement[0]) {
      case 'if': {
        if (['', '0', '-1'].indexOf(statement[1]) >= 0) return '';
        return content.trim();
      }
    }
    return null;
  }

  // parser.svelte.ts:1213 — 그대로
  function blockStartMatcher(p1) {
    if (p1.startsWith('#if') || p1.startsWith('#if_pure ')) {
      var st0 = p1.split(' ', 2);
      var s0 = st0[1];
      if (s0 === 'true' || s0 === '1') {
        return { type: p1.startsWith('#if_pure') ? 'ifpure' : 'parse' };
      }
      return { type: 'ignore' };
    }

    if (p1.startsWith('#when')) {
      if (p1.startsWith('#when ')) {
        var st1 = p1.split(' ', 2);
        var s1 = st1[1];
        return { type: s1 === 'true' || s1 === '1' ? 'newif' : 'newif-falsy' };
      } else if (p1.startsWith('#when::')) {
        var statement = p1.split('::').slice(1);
        if (statement.length === 1) {
          var s2 = statement[0];
          return { type: s2 === 'true' || s2 === '1' ? 'newif' : 'newif-falsy' };
        }
        var mode = 'normal';
        var isTruthy = function (s) {
          return s === 'true' || s === '1';
        };
        while (statement.length > 1) {
          var condition = statement.pop();
          var operator = statement.pop();
          var condition2, variable;
          switch (operator) {
            case 'not':
              statement.push(isTruthy(condition) ? '0' : '1');
              break;
            case 'keep':
              mode = 'keep';
              statement.push(condition);
              break;
            case 'legacy':
              mode = 'legacy';
              statement.push(condition);
              break;
            case 'and':
              condition2 = statement.pop();
              statement.push(isTruthy(condition) && isTruthy(condition2) ? '1' : '0');
              break;
            case 'or':
              condition2 = statement.pop();
              statement.push(isTruthy(condition) || isTruthy(condition2) ? '1' : '0');
              break;
            case 'is':
              condition2 = statement.pop();
              statement.push(condition === condition2 ? '1' : '0');
              break;
            case 'isnot':
              condition2 = statement.pop();
              statement.push(condition !== condition2 ? '1' : '0');
              break;
            case 'var':
              variable = getChatVar(condition);
              statement.push(isTruthy(variable) ? '1' : '0');
              break;
            case 'toggle':
              variable = getGlobalChatVar('toggle_' + condition);
              statement.push(isTruthy(variable) ? '1' : '0');
              break;
            case 'vis':
              variable = getChatVar(statement.pop());
              statement.push(variable === condition ? '1' : '0');
              break;
            case 'visnot':
              variable = getChatVar(statement.pop());
              statement.push(variable !== condition ? '1' : '0');
              break;
            case 'tis':
              variable = getGlobalChatVar('toggle_' + statement.pop());
              statement.push(variable === condition ? '1' : '0');
              break;
            case 'tisnot':
              variable = getGlobalChatVar('toggle_' + statement.pop());
              statement.push(variable !== condition ? '1' : '0');
              break;
            case '>':
              condition2 = statement.pop();
              statement.push(parseFloat(condition2) > parseFloat(condition) ? '1' : '0');
              break;
            case '<':
              condition2 = statement.pop();
              statement.push(parseFloat(condition2) < parseFloat(condition) ? '1' : '0');
              break;
            case '>=':
              condition2 = statement.pop();
              statement.push(parseFloat(condition2) >= parseFloat(condition) ? '1' : '0');
              break;
            case '<=':
              condition2 = statement.pop();
              statement.push(parseFloat(condition2) <= parseFloat(condition) ? '1' : '0');
              break;
            default:
              statement.push(isTruthy(condition) ? '1' : '0');
              break;
          }
        }
        var finalCondition = statement[0];
        if (isTruthy(finalCondition)) {
          if (mode === 'keep') return { type: 'newif', type2: 'keep' };
          if (mode === 'legacy') return { type: 'parse' };
          return { type: 'newif' };
        } else {
          if (mode === 'keep') return { type: 'newif-falsy', type2: 'keep' };
          if (mode === 'legacy') return { type: 'ignore' };
          return { type: 'newif-falsy' };
        }
      } else {
        return { type: 'newif-falsy' };
      }
    }
    if (p1 === '#pure') return { type: 'pure' };
    if (p1 === '#pure_display' || p1 === '#puredisplay') return { type: 'pure-display' };
    if (p1 === '#code') return { type: 'normalize' };
    if (p1.startsWith('#escape')) {
      var t2e = p1.substring(7).trim();
      return { type: 'escape', mode: t2e === '::keep' ? 'keep' : undefined };
    }
    if (p1.startsWith('#each')) {
      var t2 = p1.substring(5).trim();
      var emode;
      if (t2.startsWith('::keep ')) {
        emode = 'keep';
        t2 = t2.substring(7).trim();
      }
      if (t2.startsWith('as ')) t2 = t2.substring(3).trim();
      return { type: 'each', type2: t2, mode: emode };
    }
    if (p1.startsWith('#func')) {
      var sf = p1.split(' ');
      if (sf.length > 1) return { type: 'function', funcArg: sf.slice(1) };
    }
    return { type: 'nothing' };
  }

  // parser.svelte.ts:1487 — 그대로
  function trimLines(p1) {
    return p1
      .split('\n')
      .map(function (v) {
        return v.trimStart();
      })
      .join('\n')
      .trim();
  }

  // parser.svelte.ts:144 risuEscape / :137 risuUnescape — 그대로
  var REPLACEMENTS = ['{', '}', '(', ')', '&lt;', '&gt;', ':', ';'];

  function risuUnescape(text) {
    return text.replace(/[-]/g, function (f) {
      return REPLACEMENTS[f.charCodeAt(0) - 0xe9b8];
    });
  }

  function risuEscape(text) {
    return text.replace(/[{}()]/g, function (f) {
      switch (f) {
        case '{': return '';
        case '}': return '';
        case '(': return '';
        case ')': return '';
        default: return f;
      }
    });
  }

  // parser.svelte.ts:1493 — 그대로
  function blockEndMatcher(p1, type) {
    var p1Trimmed = p1.trim();
    switch (type.type) {
      case 'pure':
      case 'pure-display':
      case 'function':
        return p1Trimmed;
      case 'parse':
        return trimLines(p1Trimmed);
      case 'each':
        if (type.mode === 'keep') return p1;
        return trimLines(p1Trimmed);
      case 'ifpure':
        return p1;
      case 'newif':
      case 'newif-falsy': {
        var lines = p1.split('\n');
        if (lines.length === 1) {
          var elseIndex = p1.indexOf('{{:else}}');
          if (elseIndex !== -1) {
            if (type.type === 'newif') return p1.substring(0, elseIndex);
            if (type.type === 'newif-falsy') return p1.substring(elseIndex + 9);
          } else {
            if (type.type === 'newif') return p1;
            if (type.type === 'newif-falsy') return '';
          }
        }
        var elseLine = lines.findIndex(function (v) {
          return v.trim() === '{{:else}}';
        });
        if (elseLine !== -1 && type.type === 'newif') lines.splice(elseLine);
        if (elseLine !== -1 && type.type === 'newif-falsy') lines.splice(0, elseLine + 1);
        if (elseLine === -1 && type.type === 'newif-falsy') return '';
        if (type.type2 !== 'keep') {
          while (lines.length > 0 && lines[0].trim() === '') lines.shift();
          while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
        }
        return lines.join('\n');
      }
      case 'normalize':
        return p1Trimmed
          .trim()
          .replaceAll('\n', '')
          .replaceAll('\t', '')
          .replaceAll(/\\u([0-9A-Fa-f]{4})/g, function (m, h) {
            return String.fromCharCode(parseInt(h, 16));
          })
          .replaceAll(/\\(.)/g, function (m, c) {
            switch (c) {
              case 'n': return '\n';
              case 'r': return '\r';
              case 't': return '\t';
              case 'b': return '\b';
              case 'f': return '\f';
              case 'v': return '\v';
              case 'a': return 'a'; // TS 의 '\a' 는 'a'
              case 'x': return '\x00';
              default: return c;
            }
          });
      case 'escape':
        return risuEscape(type.mode === 'keep' ? p1 : p1Trimmed);
      default:
        return '';
    }
  }

  // parser.svelte.ts:1599 risuChatParser — 그대로 (그룹챗 / tokenizeAccurate 분기만 생략)
  function risuChatParser(da, arg) {
    arg = arg || {};
    da = da == null ? '' : String(da);
    var chatID = arg.chatID == null ? -1 : arg.chatID;
    var chara = arg.chara || null;

    var pointer = 0;
    var nested = [''];
    var stackType = new Uint8Array(512);
    var pureModeNest = new Map();
    var pureModeNestType = new Map();
    var blockNestType = new Map();
    var tempVar = {};
    var functions = arg.functions || new Map();

    arg.callStack = (arg.callStack || 0) + 1;
    if (arg.callStack > 20) return 'ERROR: Call stack limit reached';

    var matcherObj = {
      chatID: chatID,
      chara: chara,
      rmVar: arg.rmVar || false,
      db: getDatabase(),
      var: arg.var || null,
      tokenizeAccurate: arg.tokenizeAccurate || false,
      displaying: arg.visualize || false,
      role: arg.role,
      runVar: arg.runVar || false,
      consistantChar: arg.consistantChar || false,
      cbsConditions: arg.cbsConditions || {},
      callStack: arg.callStack,
      getNested: function () {
        return nested;
      },
      setNestedRoot: function (val) {
        nested[0] = val;
      }
    };

    da = da.replace(/\<(user|char|bot)\>/gi, '{{$1}}');

    var isPureMode = function () {
      return pureModeNest.size > 0;
    };

    function isPureBlock(t) {
      return t === 'ignore' || t === 'pure' || t === 'each' || t === 'function' || t === 'pure-display' || t === 'escape';
    }

    while (pointer < da.length) {
      switch (da[pointer]) {
        case '{': {
          if (da[pointer + 1] !== '{' && da[pointer + 1] !== '#') {
            nested[0] += da[pointer];
            break;
          }
          pointer++;
          nested.unshift('');
          stackType[nested.length] = 1;
          break;
        }
        case '#': {
          if (da[pointer + 1] !== '}' || nested.length === 1 || stackType[nested.length] !== 1) {
            nested[0] += da[pointer];
            break;
          }
          pointer++;
          var datL = nested.shift();
          var mcL = legacyBlockMatcher(datL, matcherObj);
          nested[0] += mcL != null ? mcL : '{#' + datL + '#}';
          break;
        }
        case '}': {
          if (da[pointer + 1] !== '}' || nested.length === 1 || stackType[nested.length] !== 1) {
            nested[0] += da[pointer];
            break;
          }
          pointer++;
          var dat = nested.shift();
          if (dat.startsWith('#') || dat.startsWith(':')) {
            if (isPureMode()) {
              nested[0] += '{{' + dat + '}}';
              if (dat !== ':else') {
                nested.unshift('');
                stackType[nested.length] = 6;
              }
              break;
            }
            var matchResult = blockStartMatcher(dat, matcherObj);
            if (matchResult.type === 'nothing') {
              nested[0] += '{{' + dat + '}}';
              break;
            } else {
              nested.unshift('');
              stackType[nested.length] = 5;
              blockNestType.set(nested.length, matchResult);
              if (isPureBlock(matchResult.type)) {
                pureModeNest.set(nested.length, true);
                pureModeNestType.set(nested.length, 'block');
              }
              break;
            }
          }
          if (dat.startsWith('/') && !dat.startsWith('//')) {
            if (stackType[nested.length] === 5) {
              var blockType = blockNestType.get(nested.length);
              if (isPureBlock(blockType.type)) {
                pureModeNest.delete(nested.length);
                pureModeNestType.delete(nested.length);
              }
              blockNestType.delete(nested.length);
              var dat2 = nested.shift();
              var mr = blockEndMatcher(dat2, blockType, matcherObj);
              if (blockType.type === 'each') {
                var asIndex = blockType.type2.lastIndexOf(' as ');
                var sub = blockType.type2.substring(asIndex + 4).trim();
                var array = parseArray(blockType.type2.substring(0, asIndex));
                if (asIndex === -1) {
                  var subind = blockType.type2.lastIndexOf(' ');
                  if (subind === -1) break;
                  sub = blockType.type2.substring(subind + 1);
                  array = parseArray(blockType.type2.substring(0, subind));
                }
                var added = '';
                for (var i = 0; i < array.length; i++) {
                  added += mr.replaceAll('{{slot::' + sub + '}}', typeof array[i] === 'string' ? array[i] : JSON.stringify(array[i]));
                }
                da = da.substring(0, pointer + 1) + (blockType.mode === 'keep' ? added : added.trim()) + da.substring(pointer + 1);
                break;
              }
              if (blockType.type === 'function') {
                functions.set(blockType.funcArg[0], { data: mr, arg: blockType.funcArg.slice(1) });
                break;
              }
              if (blockType.type === 'pure-display') {
                nested[0] += mr.replaceAll('{{', '\\{\\{').replaceAll('}}', '\\}\\}');
                break;
              }
              if (mr === '') break;
              nested[0] += mr;
              break;
            }
            if (stackType[nested.length] === 6) {
              var sft = nested.shift();
              nested[0] += sft + '{{' + dat + '}}';
              break;
            }
          }
          if (dat.startsWith('call::')) {
            if (arg.callStack && arg.callStack > 20) {
              nested[0] += 'ERROR: Call stack limit reached';
              break;
            }
            var argData = dat.split('::').slice(1);
            var func = functions.get(argData[0]);
            if (func) {
              var fdata = func.data;
              for (var j = 0; j < argData.length; j++) {
                fdata = fdata.replaceAll('{{arg::' + j + '}}', argData[j]);
              }
              arg.functions = functions;
              nested[0] += risuChatParser(fdata, arg);
              break;
            }
          }
          var mc = isPureMode() ? null : matcher(dat, matcherObj, tempVar);
          if (!mc && mc !== '') {
            nested[0] += '{{' + dat + '}}';
          } else if (typeof mc === 'string') {
            nested[0] += mc;
          } else {
            nested[0] += mc.text;
            tempVar = mc.var;
            if (tempVar['__force_return__']) {
              return tempVar['__return__'] != null ? tempVar['__return__'] : 'null';
            }
          }
          break;
        }
        default: {
          nested[0] += da[pointer];
          break;
        }
      }
      pointer++;
    }
    if (nested.length === 1) return nested[0];
    var result = '';
    while (nested.length > 1) {
      var d = stackType[nested.length] === 1 ? '{{' : '<';
      d += nested.shift();
      result = d + result;
    }
    return nested[0] + result;
  }

  /**
   * 시뮬레이터 진입점. ctx 를 현재 상태로 걸고 원본 risuChatParser 를 호출한다.
   * @param {string} text
   * @param {object} ctx  시뮬레이터 실행 컨텍스트
   * @param {object} [arg]  risuChatParser 인자 그대로 (chatID, rmVar, visualize, runVar, cbsConditions ...)
   */
  function parse(text, ctx, arg) {
    return withCtx(ctx, function () {
      return risuChatParser(text, Object.assign({}, arg || {}));
    });
  }

  G.RisuCBS = {
    parse: parse,
    withCtx: withCtx,
    risuChatParser: risuChatParser,
    risuEscape: risuEscape,
    risuUnescape: risuUnescape,
    getChatVar: function (ctx, k) {
      return withCtx(ctx, function () { return getChatVar(k); });
    },
    setChatVar: function (ctx, k, v) {
      return withCtx(ctx, function () { return setChatVar(k, v); });
    },
    getGlobalChatVar: function (ctx, k) {
      return withCtx(ctx, function () { return getGlobalChatVar(k); });
    },
    setGlobalChatVar: function (ctx, k, v) {
      return withCtx(ctx, function () { return setGlobalChatVar(k, v); });
    },
    parseKeyValue: parseKeyValue,
    pickHashRand: pickHashRand,
    has: function (name) {
      return matcherMap.has(name);
    },
    functionCount: function () {
      return matcherMap.size;
    }
  };
})();

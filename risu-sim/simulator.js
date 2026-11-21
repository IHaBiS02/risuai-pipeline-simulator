/*
 * RisuAI 파이프라인 시뮬레이터 — 엔진
 * ------------------------------------------------------------------
 * RisuAI 6db4b681 의 다음 코드를 옮긴 것입니다.
 *   src/ts/process/scripts.ts        processScriptFull / executeScript
 *   src/ts/parser/parser.svelte.ts   ParseMarkdown / parseAdditionalAssets / renderMarkdown /
 *                                    renderHighlightableMarkdown / parseThoughtsAndTools /
 *                                    encodeStyle / decodeStyleRule / decodeStyleContent /
 *                                    trimMarkdown (DOMPurify 설정·훅)
 *   src/lib/ChatScreens/Chat.svelte  표시 전 CBS 사전 패스 (displaya)
 *   src/ts/process/index.svelte.ts   runCurrentChatFunction (runVar 패스), 트리거 순서
 *
 * 라이브러리(markdown-it, DOMPurify, @adobe/css-tools, postcss-selector-parser,
 * highlight.js, KaTeX)와 CBS 함수(cbs.ts)는 원본과 같은 버전을 그대로 씁니다
 * (vendor/risu-core.js, tools/build-vendor.mjs).
 *
 * 각 함수 위에 원본 위치를 주석으로 표기했습니다.
 * "원본과 다른 부분"은 DIFF 주석으로 표시했습니다.
 */
(function () {
  'use strict';

  var G = typeof window !== 'undefined' ? window : globalThis;
  if (!G.RisuCBS) throw new Error('simulator.js: cbs.js 를 먼저 불러와야 합니다 (vendor/risu-core.js → cbs.js → simulator.js)');
  var Core = G.RisuCore;
  var HAS_DOM = typeof document !== 'undefined';

  // ==================================================================
  // 0. 공통 유틸
  // ==================================================================

  function hexEncode(str) {
    var bytes = new TextEncoder().encode(str);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function hexDecode(hex) {
    var n = Math.floor(hex.length / 2);
    var arr = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      arr[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return new TextDecoder().decode(arr);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==================================================================
  // 1. CBS ({{...}})
  //    cbs.js — 원본 risuChatParser(parser.svelte.ts:1599) 를 줄 단위로 옮긴 것 +
  //    원본 cbs.ts 함수 레지스트리를 그대로 번들(vendor/risu-core.js).
  //    원본 테스트(src/ts/parser/tests/cbs/*.test.ts) 59개를 그대로 통과한다.
  //
  //    arg 는 원본 risuChatParser 인자와 같다:
  //      { chatID, rmVar, visualize, runVar, cbsConditions, role }
  //    setvar/addvar 는 runVar:true 일 때만 실제로 쓴다 (cbs.ts:812-858).
  // ==================================================================

  function cbsParse(str, ctx, arg) {
    if (str == null) return '';
    return G.RisuCBS.parse(String(str), ctx, arg || {});
  }

  // chatVar.svelte.ts — 트리거 / Lua 와 같은 저장소
  function chatVarGet(ctx, key) {
    return G.RisuCBS.getChatVar(ctx, key);
  }

  function chatVarSet(ctx, key, value) {
    G.RisuCBS.setChatVar(ctx, key, String(value));
  }

  // ==================================================================
  // 2. 정규식 파이프라인
  //    원본: src/ts/process/scripts.ts:99  processScriptFull
  //          src/ts/process/scripts.ts:145 executeScript
  //          src/ts/process/scripts.ts:296 <order N> 파싱 / 정렬
  // ==================================================================

  var DREG = /\{\{data\}\}/g;

  // 봇 트리거(전체) + Lua 트리거 + 모듈 트리거.
  // 원본은 char.triggerscript(일반·Lua 섞인 원래 순서) 다음에 모듈 트리거.
  // config.charTriggerscript 가 있으면 원래 순서 그대로 쓴다 (importer 가 넣어줌).
  // triggers.ts:1081 — char.triggerscript 다음에 getModuleTriggers()
  function charTriggerList(config) {
    return Array.isArray(config.charTriggerscript)
      ? config.charTriggerscript
      : [].concat(config.charTriggers || []).concat(config.charLua || []);
  }
  function moduleTriggerList(config) {
    return Array.isArray(config.moduleTriggerscript)
      ? config.moduleTriggerscript
      : [].concat(config.moduleTriggers || []).concat(config.moduleLua || []);
  }
  function triggerOpts(config, ctx, extra) {
    return Object.assign({
      charTriggers: charTriggerList(config),
      moduleTriggers: moduleTriggerList(config),
      charLowLevelAccess: !!config.charLowLevelAccess,
      globalLore: config.globalLore || [],
      chat: ctx.chat,
      // 원본: 트리거가 변수를 바꾸면 ReloadGUIPointer → resetScriptCache() (stores.svelte.ts:184)
      onReloadGUI: resetScriptCache
    }, extra || {});
  }

  // ---- 표시 결과 캐시 (scripts.ts:68-97 processScriptCache) ----
  // 키 = CBS 를 거친 본문 + 모드 + 그 모드 스크립트의 in/out/flag + chatID. 변수 값은 키에 없다.
  // 그래서 같은 본문이면 정규식 out 안의 {{getvar}} 가 바뀌어도 이전 결과가 그대로 나온다(원본 동작).
  // 비우는 때: 트리거가 변수를 바꿈 · Lua reloadDisplay() · 모듈 구성 변경 · 채팅 전환 (ReloadGUIPointer)
  var scriptCache = new Map();
  var scriptCacheEnabled = true;
  function resetScriptCache() {
    scriptCache = new Map();
  }
  function scriptCacheKey(scripts, data, mode, chatID, cbsConditions, ctx) {
    var hash = data + '|||' + mode + '|||';
    for (var i = 0; i < scripts.length; i++) {
      var script = scripts[i];
      if (script.type !== mode) continue;
      var input = script.flag && String(script.flag).indexOf('<cbs>') >= 0
        ? cbsParse(script.in, ctx, { chatID: chatID, cbsConditions: cbsConditions })
        : script.in;
      hash += input + '|||' + script.out + chatID + '|||' + (script.flag == null ? '' : script.flag) + '|||' + (script.ableFlag ? 1 : 0);
    }
    return hash;
  }
  function cacheScript(hash, result) {
    scriptCache.set(hash, result);
    if (scriptCache.size > 1000) scriptCache.delete(scriptCache.keys().next().value);
  }

  // scripts.ts:296-330 — 그대로 (빈 meta 도 actions 에 들어간다, order 는 parseInt 그대로)
  function parseScriptMeta(script) {
    if (script.ableFlag && typeof script.flag === 'string' && script.flag.indexOf('<') >= 0) {
      var copy = JSON.parse(JSON.stringify(script));
      var order = 0;
      var actions = [];
      var orderChanged = false;
      copy.flag = script.flag.replace(/<(.+?)>/g, function (v, p1) {
        var meta = p1.split(',').map(function (x) {
          return x.trim();
        });
        for (var i = 0; i < meta.length; i++) {
          var m = meta[i];
          if (m.startsWith('order ')) {
            order = parseInt(m.substring(6));
            orderChanged = true;
          } else {
            actions.push(m);
          }
        }
        return '';
      });
      return { script: copy, layer: script.__layer, order: order, actions: actions, orderChanged: orderChanged };
    }
    return { script: script, layer: script.__layer, order: 0, actions: [], orderChanged: false };
  }

  // scripts.ts:145-293 — 그대로. 원본에서 throw 하는 경우(out 없음, 정규식 오류,
  // repeat_back 매치 실패)는 여기서도 throw 하고 호출부가 잡는다 (원본 :335 try/catch).
  function executeScript(ps, data, mode, ctx, entry, chatID, cbsConditions) {
    var script = ps.script;
    var pArg = { chatID: chatID, cbsConditions: cbsConditions };
    entry.type = script.type;
    entry.flag = script.ableFlag ? script.flag : 'g';
    entry.order = ps.order;
    entry.actions = ps.actions.join(',');

    if (script.in === '') {
      entry.skipped = 'in 이 비어 있음';
      return data;
    }
    if (script.type !== mode) {
      entry.skipped = 'type 불일치 (' + script.type + ' ≠ ' + mode + ')';
      return data;
    }

    var outScript2 = script.out.replaceAll('$n', '\n'); // out 이 없으면 원본처럼 TypeError
    var outScript = outScript2.replace(DREG, '$&');
    var flag = 'g';
    if (script.ableFlag) flag = script.flag || 'g';

    if (
      outScript.startsWith('@@move_top') ||
      outScript.startsWith('@@move_bottom') ||
      ps.actions.includes('move_top') ||
      ps.actions.includes('move_bottom')
    ) {
      flag = flag.replace('g', '');
    }
    if (outScript.endsWith('>') && !ps.actions.includes('no_end_nl')) {
      outScript += '\n';
    }
    flag = flag.trim().replace(/[^dgimsuvy]/g, '');
    flag = flag
      .split('')
      .filter(function (v, i, a) {
        return a.indexOf(v) === i;
      })
      .join('');
    if (flag.length === 0) flag = 'u';

    var input = script.in;
    if (ps.actions.includes('cbs')) {
      input = cbsParse(input, ctx, pArg);
    }

    entry.flag = flag;
    entry.resolvedIn = input;
    entry.resolvedOut = outScript;

    var reg = new RegExp(input, flag); // 오류면 throw → 스킵 (원본과 동일)

    if (outScript.startsWith('@@') || ps.actions.length > 0) {
      var matched = reg.test(data);
      entry.matched = matched;
      if (matched) {
        if (outScript.startsWith('@@emo ')) {
          entry.action = '@@emo';
          entry.emotion = script.out.substring(6).trim();
          // DIFF: 감정 이미지 상태(CharEmotion) 저장은 생략 — 텍스트는 바뀌지 않는다 (원본도 동일)
        } else if ((outScript.startsWith('@@inject') || ps.actions.includes('inject')) && chatID !== -1) {
          entry.action = '@@inject';
          // scripts.ts:207-210 — 현재 텍스트 전체를 저장된 메시지에 쓰고, 표시본에서는 매치를 지운다
          if (ctx.chat && ctx.chat[chatID]) ctx.chat[chatID].data = data;
          data = data.replace(reg, '');
        } else if (
          outScript.startsWith('@@move_top') ||
          outScript.startsWith('@@move_bottom') ||
          ps.actions.includes('move_top') ||
          ps.actions.includes('move_bottom')
        ) {
          entry.action = 'move';
          var isGlobal = flag.includes('g');
          var matchAll = isGlobal ? Array.from(data.matchAll(reg)) : [data.match(reg)];
          data = data.replace(reg, '');
          for (var mi = 0; mi < matchAll.length; mi++) {
            var m = matchAll[mi];
            if (!m) continue;
            var inData = m[0];
            var out = outScript
              .replace('@@move_top ', '')
              .replace('@@move_bottom ', '')
              .replace(/(?<!\$)\$[0-9]+/g, function (v) {
                var index = parseInt(v.substring(1));
                if (index < m.length) return m[index];
                return v;
              })
              .replace(/\$\&/g, inData)
              .replace(/(?<!\$)\$<([^>]+)>/g, function (v) {
                var groupName = parseInt(v.substring(2, v.length - 1));
                if (m.groups && m.groups[groupName]) return m.groups[groupName];
                return v;
              });
            if (outScript.startsWith('@@move_top') || ps.actions.includes('move_top')) {
              data = out + '\n' + data;
            } else {
              data = data + '\n' + out;
            }
          }
        } else {
          entry.action = 'literal';
          data = cbsParse(data.replace(reg, outScript), ctx, pArg);
        }
      } else {
        if ((outScript.startsWith('@@repeat_back') || ps.actions.includes('repeat_back')) && chatID !== -1) {
          entry.action = '@@repeat_back';
          var v2 = outScript.split(' ', 2)[1];
          var chat = ctx.chat || [];
          var ch = ctx.character || {};
          var fm = ctx.fmIndex == null ? -1 : ctx.fmIndex;
          var lastChat = fm === -1 ? ch.firstMessage || '' : (ch.alternateGreetings || [])[fm];
          var pointer = chatID - 1;
          while (pointer >= 0) {
            if (chat[pointer].role === chat[chatID].role) {
              lastChat = chat[pointer].data;
              break;
            }
            pointer--;
          }
          var r = lastChat.match(reg);
          if (!v2) {
            data = data + r[0];
          } else if (r[0]) {
            if (v2 === 'end') data = data + r[0];
            else if (v2 === 'start') data = r[0] + data;
            else if (v2 === 'end_nl') data = data + '\n' + r[0];
            else if (v2 === 'start_nl') data = r[0] + '\n' + data;
          }
        }
      }
    } else {
      data = cbsParse(data.replace(reg, outScript), ctx, pArg);
    }

    return data;
  }

  // scripts.ts:99-387
  async function processScriptFull(config, char, data, mode, chatID, cbsConditions) {
    var ctx = config.ctx;
    var trace = [];
    chatID = chatID == null ? -1 : chatID;
    cbsConditions = cbsConditions || {};

    // ① Lua  (scriptings.ts:1478 runLuaEditTrigger) — meta 는 { index: chatID }
    var luaMode = null;
    if (mode === 'editinput') luaMode = 'editInput';
    else if (mode === 'editoutput') luaMode = 'editOutput';
    else if (mode === 'editdisplay') luaMode = 'editDisplay';

    if (config.luaEnabled === false) {
      trace.push({ stage: '① Lua', detail: '사용 안 함 (기능 토글)', skipped: true });
    } else if (luaMode && G.RisuLua) {
      var luaTriggers = charTriggerList(config).concat(moduleTriggerList(config));
      var beforeLua = data;
      try {
        var luaRes = await G.RisuLua.runEditHooks(luaTriggers, luaMode, data, ctx, { index: chatID });
        data = luaRes.data;
        var ranLua = luaRes.results.filter(function (r) {
          return !r.skipped;
        }).length;
        trace.push({
          stage: '① Lua',
          detail: 'runLuaEditTrigger(' + luaMode + ') — 트리거 ' + luaTriggers.length + '개 중 ' + ranLua + '개 실행',
          before: beforeLua,
          after: data,
          luaResults: luaRes.results
        });
      } catch (e) {
        trace.push({
          stage: '① Lua',
          detail: 'Lua 실행 오류: ' + ((e && e.message) || e),
          before: beforeLua,
          after: data,
          skipped: true
        });
      }
    } else if (mode === 'editprocess') {
      trace.push({ stage: '① Lua', detail: 'Lua 훅 없음 — 원본 scriptings.ts:1489-1491 이 즉시 return', before: data, after: data, skipped: true });
    } else {
      trace.push({ stage: '① Lua', detail: 'lua-runtime.js 미로드', before: data, after: data, skipped: true });
    }

    // ② display 트리거 (scripts.ts:104-121 → triggers.ts runTrigger(display))
    if (config.triggersEnabled === false) {
      trace.push({ stage: '② 트리거(display)', detail: '사용 안 함 (기능 토글)', skipped: true });
    } else if (mode === 'editdisplay' && G.RisuTrigger) {
      var beforeTrig = data;
      try {
        var runner = G.RisuTrigger.create(ctx, triggerOpts(config, ctx, { displayMode: true, displayData: data }));
        var tr = await runner.run('display');
        if (tr.error) throw new Error(tr.error); // 원본: scripts.ts:116 catch → console.error, data 유지
        if (tr.displayData != null) data = tr.displayData;
        var fired = tr.trace.filter(function (x) {
          return !x.skipped;
        }).length;
        trace.push({
          stage: '② 트리거(display)',
          detail: 'runTrigger("display") — 트리거 ' + tr.trace.length + '개 중 ' + fired + '개 발화',
          before: beforeTrig,
          after: data,
          triggerTrace: tr.trace
        });
      } catch (e) {
        trace.push({ stage: '② 트리거(display)', detail: '실행 오류: ' + ((e && e.message) || e), before: beforeTrig, after: data, skipped: true });
      }
    } else if (mode === 'editdisplay') {
      trace.push({ stage: '② 트리거(display)', detail: 'trigger-runtime.js 미로드', before: data, after: data, skipped: true });
    }

    // ③ 플러그인
    trace.push({ stage: '③ 플러그인', detail: 'pluginV2["' + mode + '"] — 등록된 플러그인 없음', before: data, after: data, skipped: true });

    // ④ CBS (scripts.ts:133)
    var beforeCbs = data;
    data = cbsParse(data, ctx, { chatID: chatID, cbsConditions: cbsConditions });
    trace.push({ stage: '④ CBS', detail: 'risuChatParser(data, { chatID: ' + chatID + ' })', before: beforeCbs, after: data });

    // ⑤ 정규식
    var scripts = []
      .concat(config.presetRegex || [])
      .concat(char.customscript || [])
      .concat(config.moduleRegex || []);

    var cacheKey = scriptCacheKey(scripts, data, mode, chatID, cbsConditions, ctx);
    var cached = scriptCacheEnabled ? scriptCache.get(cacheKey) : undefined;
    // 원본은 캐시 적중이면 여기서 바로 돌려준다(정규식·동적 에셋 생략). 무엇이 가려졌는지 보이도록
    // 시뮬레이터는 정규식을 한 번 더 돌려 비교만 하고, 그 부작용(@@inject 등)은 되돌린다.
    var chatSnap = cached ? JSON.parse(JSON.stringify(ctx.chat || [])) : null;

    if (scripts.length === 0) {
      if (scriptCacheEnabled) cacheScript(cacheKey, data);
      trace.push({ stage: '⑤ 정규식', detail: '스크립트 없음 — 원본은 여기서 끝 (동적 에셋도 건너뜀)', before: data, after: data, skipped: true });
      return { data: data, trace: trace };
    }

    var parsed = scripts.map(parseScriptMeta);
    var orderChanged = parsed.some(function (p) {
      return p.orderChanged;
    });
    var sorted = parsed.slice();
    if (orderChanged) {
      sorted.sort(function (a, b) {
        return b.order - a.order; // 내림차순 (stable)
      });
    }

    var entries = [];
    for (var i = 0; i < sorted.length; i++) {
      var ps = sorted[i];
      var entry = {
        n: i + 1,
        layer: ps.layer,
        originalIndex: parsed.indexOf(ps),
        in: ps.script.in,
        out: ps.script.out,
        comment: ps.script.comment || ''
      };
      var before = data;
      try {
        data = executeScript(ps, data, mode, ctx, entry, chatID, cbsConditions);
      } catch (e) {
        entry.error = String(e && e.message) + ' (원본도 이 스크립트를 건너뜀)';
      }
      entry.before = before;
      entry.after = data;
      entry.changed = before !== data;
      entries.push(entry);
    }

    var fresh = null;
    if (cached) {
      fresh = data;
      ctx.chat = chatSnap;
      data = cached;
      trace.push({
        stage: '⑤ 정규식 — 캐시 적중',
        detail: 'processScriptCache 적중 (scripts.ts:136) — 원본은 정규식·동적 에셋을 다시 돌리지 않고 이전 결과를 씁니다' +
          (fresh !== cached ? ' ⚠ 지금 다시 돌리면 결과가 다릅니다 (아래 표는 비교용 재실행)' : ' · 다시 돌려도 같은 결과'),
        cacheHit: true,
        cacheStale: fresh !== cached,
        before: fresh,
        after: cached,
        entries: entries
      });
      return { data: data, trace: trace, cacheHit: true };
    }

    trace.push({
      stage: '⑤ 정규식',
      detail: 'presetRegex → char.customscript → module regex',
      orderChanged: orderChanged,
      table: sorted.map(function (ps, idx) {
        return { n: idx + 1, layer: ps.layer, type: ps.script.type, order: ps.order, actions: ps.actions, in: ps.script.in, out: ps.script.out };
      }),
      entries: entries
    });

    // ⑥ 동적 에셋 (scripts.ts:345-382)
    if (config.assets && G.RisuAssets) {
      var assetRes = await G.RisuAssets.resolve(data, mode, config.assets);
      data = assetRes.data;
      trace.push(assetRes.trace);
    } else {
      trace.push({ stage: '⑥ 동적 에셋', detail: 'asset-runtime.js 미로드', before: data, after: data, skipped: true });
    }

    if (scriptCacheEnabled) cacheScript(cacheKey, data); // scripts.ts:384
    return { data: data, trace: trace };
  }

  // ==================================================================
  // 3. 자산 태그 (parser.svelte.ts:412-666)
  //    char.additionalAssets [[이름, 경로, 확장자]] + 모듈 에셋 → {{img::}} 등
  //    char.emotionImages [[이름, 경로]] → {{emotion::}} (정확 일치만)
  //    퍼지 매칭은 char.additionalAssets 에서만 (getClosestMatch)
  // ==================================================================

  var ASSET_RE = /{{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::(.+?)}}/gms;
  var VIDEO_EXT = ['mp4', 'webm', 'avi', 'm4p', 'm4v'];

  function extOf(name) {
    var m = String(name).match(/\.([A-Za-z0-9]+)$/);
    return m ? m[1].toLowerCase() : 'png';
  }

  /**
   * 시뮬레이터 자산 설정 → 원본 구조.
   *   { additional:[[name,path,ext]], emotions:[[name,path]], module:[[name,path,ext]],
   *     srcOf(path)→url, maxDifference, charIcon, userIcon }
   * 예전 형식(assetNames: string[], srcOf(name))도 받는다 — 이름을 경로로 쓴다.
   */
  function normalizeAssets(a) {
    a = a || {};
    var additional = Array.isArray(a.additional)
      ? a.additional
      : (a.assetNames || []).map(function (n) {
          return [String(n), String(n), extOf(n)];
        });
    return {
      additional: additional,
      emotions: Array.isArray(a.emotions) ? a.emotions : [],
      module: Array.isArray(a.module) ? a.module : [],
      srcOf: typeof a.srcOf === 'function' ? a.srcOf : null,
      maxDifference: a.maxDifference == null ? 4 : a.maxDifference,
      charIcon: a.charIcon || '',
      userIcon: a.userIcon || '',
      chaId: a.chaId || 'sim'
    };
  }

  // parser.svelte.ts:414 getAssetSrc / :427 getEmoSrc / :455 resetAssetsCache
  function buildAssetPaths(A) {
    var assetPaths = {};
    var emoPaths = {};
    function add(arr) {
      for (var i = 0; i < arr.length; i++) {
        var asset = arr[i];
        if (!asset || asset[0] == null) continue;
        var key = String(asset[0]).toLocaleLowerCase();
        if (!assetPaths[key]) assetPaths[key] = { srcPaths: [], ext: asset[2] };
        if (assetPaths[key].ext === asset[2]) assetPaths[key].srcPaths.push(asset[1]);
      }
    }
    add(A.additional);
    add(A.module);
    for (var j = 0; j < A.emotions.length; j++) {
      var emo = A.emotions[j];
      if (!emo || emo[0] == null) continue;
      emoPaths[String(emo[0]).toLocaleLowerCase()] = { srcPaths: [emo[1]] };
    }
    return { assetPaths: assetPaths, emoPaths: emoPaths };
  }

  // parser.svelte.ts:657 trimmer — 그대로 (모든 확장자를 순서대로 검사)
  function trimmer(str) {
    var ext = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg'];
    for (var i = 0; i < ext.length; i++) {
      if (str.endsWith('.' + ext[i])) str = str.substring(0, str.length - ext[i].length - 1);
    }
    return str.trim().replace(/[_ -.]/g, '');
  }

  // parser.svelte.ts:636 getDistance — 그대로 (Int16Array)
  function getDistance(a, b) {
    var h = a.length + 1;
    var w = b.length + 1;
    var d = new Int16Array(h * w);
    for (var i = 0; i < h; i++) d[i * w] = i;
    for (var j = 0; j < w; j++) d[j] = j;
    for (var y = 1; y < h; y++) {
      for (var x = 1; x < w; x++) {
        d[y * w + x] = Math.min(
          d[(y - 1) * w + x - 1] + (a.charAt(y - 1) === b.charAt(x - 1) ? 0 : 1),
          d[(y - 1) * w + x] + 1,
          d[y * w + x - 1] + 1
        );
      }
    }
    return d[h * w - 1];
  }

  // parser.svelte.ts:603 getClosestMatch — 그대로
  function getClosestMatch(A, name, assetPaths) {
    if (!A.additional) return null;
    var closest = '';
    var closestDist = 999999;
    var targetPath = '';
    var targetExt = '';
    var trimmedName = trimmer(name);
    for (var i = 0; i < A.additional.length; i++) {
      var asset = A.additional[i];
      var key = String(asset[0]).toLocaleLowerCase();
      var dist = getDistance(trimmedName, trimmer(key));
      if (dist < closestDist) {
        closest = key;
        closestDist = dist;
        targetPath = asset[1];
        targetExt = asset[2];
      }
    }
    if (closestDist > A.maxDifference) return null;
    assetPaths[closest] = { srcPaths: [targetPath], ext: targetExt };
    return assetPaths[closest];
  }

  // DIFF: 실제 바이트가 없는 에셋(이름만 아는 경우)은 자리표시자로 보여준다.
  //       원본에서는 getFileSrc(path) 가 항상 URL 을 돌려준다.
  function assetPlaceholder(type, name) {
    var n = escapeHtml(name);
    switch (type) {
      case 'raw':
      case 'path':
        return 'asset://' + n;
      case 'video':
      case 'video-img':
        return '<span class="x-risu-sim-asset" data-t="VIDEO">' + n + '</span>';
      case 'audio':
      case 'bgm':
        return '<span class="x-risu-sim-asset" data-t="AUDIO">' + n + '</span>';
      default:
        return '<span class="x-risu-sim-asset" data-t="' + escapeHtml(String(type).toUpperCase()) + '">' + n + '</span>';
    }
  }

  // parser.svelte.ts:486 parseAdditionalAssets — 그대로 (hideAllImages/legacyMediaFindings 기본값 false)
  function parseAdditionalAssets(data, A, mode, arg) {
    var assetWidthString = ''; // db.assetWidth 기본 -1
    var paths = A.__paths || (A.__paths = buildAssetPaths(A));
    var assetPaths = paths.assetPaths;
    var emoPaths = paths.emoPaths;
    var needsSourceAccess = false;
    var cx = null;

    function src(path) {
      if (!A.srcOf) return null;
      try {
        return A.srcOf(path) || null;
      } catch (e) {
        return null;
      }
    }

    data = data.replace(ASSET_RE, function (full, type, name) {
      name = name.toLocaleLowerCase();

      if (type === 'emotion') {
        var srcPath = emoPaths[name] && emoPaths[name].srcPaths && emoPaths[name].srcPaths[0];
        if (!srcPath) return '';
        var ep = src(srcPath);
        if (!ep) return assetPlaceholder('emotion', name);
        return '<img src="' + ep + '" alt="' + ep + '" style="' + assetWidthString + ' "/>';
      }

      if (type === 'source') {
        needsSourceAccess = true;
        if (name === 'char') return 'CHAR';
        if (name === 'user') return 'USER';
      }

      var match = assetPaths[name];
      if (!match) {
        match = getClosestMatch(A, name, assetPaths);
        if (!match) return '';
      }

      var pSrc = match.srcPaths[0];
      if (match.srcPaths.length > 1) {
        if (cx === null) {
          var chatID = arg.ch;
          cx = G.RisuCBS.pickHashRand(chatID, (A.chaId || 'global') + chatID);
        }
        pSrc = match.srcPaths[Math.floor(cx * match.srcPaths.length)];
      }

      var p = src(pSrc);
      if (!p) {
        if (type === 'bg' && mode !== 'back') return '';
        return assetPlaceholder(type, pSrc);
      }
      switch (type) {
        case 'raw':
        case 'path':
          return p;
        case 'img':
          return '<img src="' + p + '" alt="' + p + '" style="' + assetWidthString + ' "/>';
        case 'image':
          return '<div class="risu-inlay-image"><img src="' + p + '" alt="' + p + '" style="' + assetWidthString + '"/></div>\n';
        case 'video':
          return '<video controls autoplay loop><source src="' + p + '" type="video/mp4"></video>\n';
        case 'video-img':
          return '<video autoplay muted loop><source src="' + p + '" type="video/mp4"></video>\n';
        case 'audio':
          return '<audio controls autoplay loop><source src="' + p + '" type="audio/mpeg"></audio>\n';
        case 'bg':
          if (mode === 'back') {
            return '<div style="width:100%;height:100%;background: linear-gradient(rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.8)),url(' + p + '); background-size: cover;"></div>';
          }
          break;
        case 'asset':
          if (match.ext && VIDEO_EXT.indexOf(match.ext) >= 0) {
            return '<video autoplay muted loop><source src="' + p + '" type="video/mp4"></video>\n';
          }
          return '<img src="' + p + '" alt="' + p + '" style="' + assetWidthString + ' "/>\n';
        case 'bgm':
          return '<div risu-ctrl="bgm___auto___' + p + '" style="display:none;"></div>\n';
      }
      return '';
    });

    if (needsSourceAccess) {
      data = data.replace(/CHAR/g, A.charIcon || '');
      data = data.replace(/USER/g, A.userIcon || '');
    }
    return data;
  }

  // 예전 테스트/외부용: 이름 목록 + srcOf(name) 으로 자산 태그만 푼다
  function resolveAssetTags(data, names, maxDiff, srcOf) {
    return parseAdditionalAssets(String(data), normalizeAssets({ assetNames: names || [], maxDifference: maxDiff, srcOf: srcOf }), 'normal', { ch: -1 });
  }

  // ==================================================================
  // 4. <Thoughts> / <tool_call>  (parser.svelte.ts:717) — 그대로, 문구는 ko
  // ==================================================================

  // src/lang/ko.ts / en.ts 의 문구 (RisuAI 언어 설정에 따라 다름 — setLanguage 로 바꿈)
  var LANGS = {
    ko: { cot: '생각의 사슬', toolCalled: "도구 '{{tool}}' 호출됨", error: '에러' },
    en: { cot: 'Chain of Thoughts', toolCalled: "Tool '{{tool}}' Called", error: 'Error' }
  };
  var LANG = LANGS.ko;

  function parseThoughtsAndTools(data) {
    var result = '';
    var i = 0;
    while (i < data.length) {
      if (data.slice(i, i + 10) === '<Thoughts>') {
        var j = i + 10;
        var depth = 1;
        while (j < data.length && depth > 0) {
          if (data.slice(j, j + 10) === '<Thoughts>') depth++;
          if (data.slice(j, j + 11) === '</Thoughts>') depth--;
          j++;
        }
        if (depth === 0) {
          result += '<details><summary>' + LANG.cot + '</summary>' + data.substring(i + 10, j - 1) + '</details>';
          i = j + 10;
          continue;
        }
      }
      result += data[i++];
    }
    return result.replace(/<tool_call>(.+?)<\/tool_call>/gms, function (full, txt) {
      var parts = txt.split('');
      return '<div class="x-risu-tool-call">🛠️ ' + LANG.toolCalled.replace('{{tool}}', parts[1] != null ? parts[1] : 'unknown') + '</div>\n\n';
    });
  }

  // ==================================================================
  // 5. 마크다운 (parser.svelte.ts:24-44, 156-410) — markdown-it 14.3.3 그대로
  // ==================================================================

  var markdownItOptions = {
    html: true,
    breaks: true,
    linkify: false,
    typographer: true,
    quotes: '\u{E9b0}\u{E9b1}\u{E9b2}\u{E9b3}'
  };

  var md = null;
  var mdHighlight = null;

  function initMarkdown() {
    if (md || !Core || !Core.markdownit) return;
    md = Core.markdownit(markdownItOptions);
    mdHighlight = Core.markdownit(
      Object.assign(
        {
          highlight: function (str, lang) {
            if (lang) return '<pre-hljs-placeholder lang="' + lang + '">' + str + '</pre-hljs-placeholder>';
            return '';
          }
        },
        markdownItOptions
      )
    );
    md.disable(['code']);
    mdHighlight.disable(['code']);
  }

  // parser.svelte.ts:156 renderMarkdown — 그대로 (customQuotes/unformatQuotes/blockquoteStyling 기본값)
  function renderMarkdown(mdi, data) {
    initMarkdown();
    var quotes = ['“', '”', '‘', '’'];
    data = data.replace(/\$\$(.*?)\$\$/gs, function (match, content) {
      try {
        content = content.replace(//gu, '{').replace(//gu, '}').replace(//gu, '(').replace(//gu, ')');
        return Core.katex.renderToString(content, { displayMode: false, throwOnError: true, output: 'mathml' });
      } catch (error) {
        return match;
      }
    });
    var text = G.RisuCBS.risuUnescape(mdi.render(data.replace(/“|”/g, '"').replace(/‘|’/g, "'")));
    text = text.replace(//gu, '<mark risu-mark="quote2">' + quotes[0]).replace(//gu, quotes[1] + '</mark>');
    text = text.replace(//gu, '<mark risu-mark="quote1">' + quotes[2]).replace(//gu, quotes[3] + '</mark>');
    return text;
  }

  // parser.svelte.ts:229-386 의 언어 매핑
  var HL_LANG = {
    bash: ['bash', 'sh'], c: ['cpp', 'c'], cpp: ['cpp', 'cpp'], cs: ['csharp', 'cs'], csharp: ['csharp', 'cs'],
    css: ['css', 'css'], dart: ['dart', 'dart'], html: ['xml', 'html'], svg: ['xml', 'svg'], xml: ['xml', 'xml'],
    java: ['java', 'java'], js: ['javascript', 'js'], jsx: ['javascript', 'js'], javascript: ['javascript', 'js'],
    json: ['json', 'json'], lua: ['lua', 'lua'], markdown: ['markdown', 'md'], md: ['markdown', 'md'],
    py: ['python', 'py'], python: ['python', 'py'], rust: ['rust', 'rs'], shell: ['shell', 'sh'],
    ts: ['typescript', 'ts'], tsx: ['typescript', 'ts'], typescript: ['typescript', 'ts'],
    txt: ['plaintext', 'txt'], vtt: ['plaintext', 'vtt'], yaml: ['yaml', 'yml'], risuerror: ['error', 'error']
  };

  // parser.svelte.ts:210 renderHighlightableMarkdown — 그대로
  function renderHighlightableMarkdown(data) {
    initMarkdown();
    var rendered = renderMarkdown(mdHighlight, data);
    var placeholders = rendered.match(/<pre-hljs-placeholder lang="(.+?)">(.+?)<\/pre-hljs-placeholder>/gms);
    if (!placeholders) return rendered;
    for (var i = 0; i < placeholders.length; i++) {
      var placeholder = placeholders[i];
      try {
        var lm = placeholder.match(/lang="(.+?)"/);
        var cm = placeholder.match(/<pre-hljs-placeholder lang=".+?">(.+?)<\/pre-hljs-placeholder>/ms);
        var lang = lm && lm[1];
        var code = cm && cm[1];
        if (!lang || !code) continue;
        var map = HL_LANG[lang] || ['none', 'none'];
        lang = map[0];
        var fileExt = map[1];
        if (lang !== 'none' && lang !== 'error' && !Core.hljs.getLanguage(lang)) {
          Core.hljs.registerLanguage(lang, Core.hljsLanguages[lang]);
        }
        if (lang === 'none') {
          rendered = rendered.replace(placeholder, '<pre><code>' + md.utils.escapeHtml(code) + '</code></pre>');
        } else if (lang === 'error') {
          rendered = rendered.replace(placeholder, '<div class="risu-error"><h1>' + LANG.error + '</h1>' + md.utils.escapeHtml(code) + '</div>');
        } else {
          var highlighted = Core.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          rendered = rendered.replace(placeholder, '<pre class="hljs" x-hl-lang="' + fileExt + '"><code>' + highlighted + '</code></pre>');
        }
      } catch (e) {
        /* 원본도 무시 */
      }
    }
    return rendered;
  }

  // ==================================================================
  // 6. CSS 스코프 + 살균 (parser.svelte.ts:46-123, 783-856, 957-1029)
  // ==================================================================

  var STYLE_RE = /\<style\>(.+?)\<\/style\>/gms;

  // parser.svelte.ts:958 encodeStyle
  function encodeStyle(txt) {
    return txt.replace(STYLE_RE, function (f, c1) {
      return '<risu-style>' + hexEncode(c1) + '</risu-style>';
    });
  }

  // parser.svelte.ts:964 decodeStyleRule — 그대로.
  // DIFF(시뮬레이터 전용): scope 를 주면 '.chattext ' 대신 그 선택자를 붙인다 (트레이스 블록 격리용).
  function decodeStyleRule(rule, scope) {
    if (rule.type === 'rule') {
      if (rule.selectors) {
        for (var i = 0; i < rule.selectors.length; i++) {
          var slt = rule.selectors[i];
          if (slt) {
            var parser = Core.cssSelectorParser(function (root) {
              root.walkClasses(function (classes) {
                if (classes.type === 'class' && !classes.value.startsWith('x-risu-')) {
                  classes.value = 'x-risu-' + classes.value;
                }
              });
            });
            slt = parser.processSync(slt);
            rule.selectors[i] = (scope || '.chattext') + ' ' + slt;
          }
        }
      }
    }
    if (rule.type === 'media' || rule.type === 'supports' || rule.type === 'document' || rule.type === 'host' || rule.type === 'container') {
      for (var j = 0; j < rule.rules.length; j++) rule.rules[j] = decodeStyleRule(rule.rules[j], scope);
    }
    if (rule.type === 'import') {
      if (rule.import.startsWith('data:')) rule.import = 'data:,';
    }
    return rule;
  }

  // parser.svelte.ts:1005 decodeStyleContent — 그대로 (returnCSSError 기본 true)
  function decodeStyleContent(hexText, ctx, scope) {
    try {
      var text = hexDecode(hexText);
      text = cbsParse(text, ctx, {});
      var ast = Core.css.parse(text);
      var rules = ast && ast.stylesheet && ast.stylesheet.rules;
      if (rules) {
        for (var i = 0; i < rules.length; i++) rules[i] = decodeStyleRule(rules[i], scope);
        ast.stylesheet.rules = rules;
      }
      return { css: Core.css.stringify(ast, { indent: '', compress: true }) };
    } catch (error) {
      return { fallback: 'CSS ERROR: ' + error };
    }
  }

  var trimPurifyConfig = {
    ADD_TAGS: ['iframe', 'style', 'risu-style', 'x-em', 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'risu-btn', 'risu-ctrl', 'risu-form', 'risu-trigger', 'risu-mark', 'risu-id', 'x-hl-lang', 'x-hl-text']
  };

  var purifyReady = false;
  // parser.svelte.ts:46-123 DOMPurify 훅 — 그대로 (hideAllImages 기본 false)
  function initPurify() {
    if (purifyReady || !HAS_DOM || !Core || !Core.DOMPurify || !Core.DOMPurify.addHook) return;
    var P = Core.DOMPurify;
    P.addHook('uponSanitizeElement', function (node, data) {
      if (data.tagName === 'iframe') {
        var s = node.getAttribute('src') || '';
        if (!s.startsWith('https://www.youtube.com/embed/')) return node.parentNode.removeChild(node);
      }
      if (data.tagName === 'img') {
        if (!node.getAttribute('loading')) node.setAttribute('loading', 'lazy');
        if (!node.getAttribute('decoding')) node.setAttribute('decoding', 'async');
      }
    });
    P.addHook('uponSanitizeAttribute', function (node, data) {
      switch (data.attrName) {
        case 'class':
          if (data.attrValue) {
            data.attrValue = data.attrValue
              .split(' ')
              .map(function (v) {
                if (v.startsWith('hljs')) return v;
                if (v.startsWith('x-risu-')) return v;
                return 'x-risu-' + v;
              })
              .join(' ');
          }
          break;
        case 'href':
          if (data.attrValue.startsWith('http://') || data.attrValue.startsWith('https://')) {
            node.setAttribute('target', '_blank');
            break;
          }
          data.attrValue = '';
          break;
        case 'rel':
          data.attrValue = 'noopener noreferrer';
          break;
      }
    });
    P.addHook('uponSanitizeAttribute', function (node, data) {
      if (['IMG', 'SOURCE', 'VIDEO', 'AUDIO', 'STYLE'].includes(node.nodeName) && data.attrName === 'src') {
        if (data.attrValue.startsWith('blob:') || data.attrValue.startsWith('asset:')) data.forceKeepAttr = true;
      }
    });
    purifyReady = true;
  }

  // parser.svelte.ts:809 trimMarkdown — 그대로
  function trimMarkdown(data, ctx, scope) {
    if (!data) return '';
    initPurify();
    var P = Core.DOMPurify;
    if (!data.includes('<risu-style')) return P.sanitize(data, trimPurifyConfig);
    var root = P.sanitize(data, Object.assign({}, trimPurifyConfig, { RETURN_DOM: true }));
    if (!root) return '';
    var els = Array.from(root.querySelectorAll('risu-style'));
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var decoded = decodeStyleContent(el.textContent || '', ctx, scope);
      if (decoded.css === undefined) {
        el.replaceWith(root.ownerDocument.createTextNode(decoded.fallback || ''));
        continue;
      }
      var style = root.ownerDocument.createElement('style');
      style.textContent = decoded.css.replaceAll(/<\/(?=style)/gi, '<\\/');
      el.replaceWith(style);
    }
    return root.innerHTML;
  }

  // ==================================================================
  // 7. ParseMarkdown (parser.svelte.ts:740) — 순서 그대로
  //    자산 → processScriptFull(editdisplay) → (바뀌었으면) 자산 2차 → 인레이 →
  //    <Thoughts> → encodeStyle → markdown(normal) → trimMarkdown
  // ==================================================================

  async function parseMarkdown(data, config, char, mode, chatID, cbsConditions, opts) {
    opts = opts || {};
    var ctx = config.ctx;
    var A = ctx.assetsNorm;
    var trace = [];
    var additionalAssetMode = mode === 'back' ? 'back' : 'normal';

    var before = data;
    data = parseAdditionalAssets(data, A, additionalAssetMode, { ch: chatID });
    var firstParsed = data;
    if (before !== data) trace.push({ stage: '⓪-b 자산 해석 (1차)', detail: 'parseAdditionalAssets (parser.svelte.ts:752)', before: before, after: data });

    var psf = await processScriptFull(config, char, data, 'editdisplay', chatID, cbsConditions);
    data = psf.data;
    trace = trace.concat(psf.trace);

    if (firstParsed !== data) {
      var b2 = data;
      data = parseAdditionalAssets(data, A, additionalAssetMode, { ch: chatID });
      if (b2 !== data) trace.push({ stage: '⑥-b 자산 해석 (2차)', detail: 'editdisplay 결과에 새로 생긴 태그 (parser.svelte.ts:762-766)', before: b2, after: data });
    }

    // DIFF: {{inlay::}} 는 채팅에 첨부한 이미지라 시뮬레이터에 없음 — 그대로 둔다
    var textOut = data;
    data = parseThoughtsAndTools(data);
    var encoded = encodeStyle(data);
    var rendered = encoded;
    if (mode === 'normal' && opts.markdown !== false && Core && Core.markdownit) {
      rendered = renderHighlightableMarkdown(encoded);
    }
    var html = HAS_DOM ? trimMarkdown(rendered, ctx, opts.scope) : escapeHtml(rendered);
    var css = '';
    if (HAS_DOM) {
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      css = Array.prototype.slice
        .call(tpl.content.querySelectorAll('style'))
        .map(function (s) {
          return s.textContent;
        })
        .join('\n');
    }
    return { text: textOut, trace: trace, display: { encoded: encoded, markdown: rendered, html: html, css: css } };
  }

  // ==================================================================
  // 8. 진입점
  // ==================================================================

  function makeCtx(o) {
    var ctx = {
      vars: {},
      globalVars: Object.assign({}, o.globalVars || {}),
      scriptstate: Object.assign({}, o.scriptstate || {}),
      defaultVariables: o.defaultVariables || '',
      templateDefaultVariables: o.templateDefaultVariables || '',
      charName: o.charName || 'Char',
      userName: o.userName || 'User',
      personaPrompt: o.personaPrompt || '',
      character: Object.assign(
        { firstMessage: o.firstMessage != null ? o.firstMessage : o.input || '', alternateGreetings: [] },
        o.character || {}
      ),
      fmIndex: o.fmIndex == null ? -1 : o.fmIndex,
      role: o.role || '',
      mainprompt: o.mainprompt || '',
      jb: o.jb || '',
      globalnote: o.globalnote || '',
      unsupported: new Set(),
      stopSending: false,
      chat: Array.isArray(o.chat)
        ? o.chat.map(function (m) {
            return { role: m.role, data: m.data != null ? m.data : m.content };
          })
        : []
    };
    // 시뮬레이터의 '변수' 편집기 값 = 이 채팅의 scriptstate (사용자가 직접 넣은 현재 상태)
    Object.keys(o.vars || {}).forEach(function (k) {
      if (ctx.scriptstate['$' + k] === undefined) ctx.scriptstate['$' + k] = String(o.vars[k]);
    });
    // Lua/트리거 런타임이 ctx.vars 를 읽던 시절과의 호환: scriptstate 를 보는 뷰
    ctx.vars = new Proxy(
      {},
      {
        get: function (t, k) {
          if (typeof k !== 'string') return undefined;
          var v = ctx.scriptstate['$' + k];
          return v == null ? undefined : v;
        },
        set: function (t, k, v) {
          ctx.scriptstate['$' + k] = String(v);
          return true;
        },
        has: function (t, k) {
          return ctx.scriptstate['$' + k] != null;
        },
        ownKeys: function () {
          return Object.keys(ctx.scriptstate)
            .filter(function (k) {
              return k.charAt(0) === '$';
            })
            .map(function (k) {
              return k.slice(1);
            });
        },
        getOwnPropertyDescriptor: function (t, k) {
          var v = ctx.scriptstate['$' + k];
          return v == null ? undefined : { value: v, enumerable: true, configurable: true, writable: true };
        }
      }
    );
    ctx.assetsNorm = normalizeAssets(o.assets);
    if (ctx.character.chaId) ctx.assetsNorm.chaId = ctx.character.chaId;
    return ctx;
  }

  function pipeConfig(ctx, config) {
    return {
      ctx: ctx,
      presetRegex: config.presetRegex || [],
      moduleRegex: config.moduleRegex || [],
      charLua: config.charLua || [],
      moduleLua: config.moduleLua || [],
      charTriggers: config.charTriggers || [],
      moduleTriggers: config.moduleTriggers || [],
      charTriggerscript: config.charTriggerscript,
      moduleTriggerscript: config.moduleTriggerscript,
      charLowLevelAccess: !!config.charLowLevelAccess,
      globalLore: config.globalLore || [],
      assets: config.assets || null,
      triggersEnabled: config.triggersEnabled !== false,
      luaEnabled: config.luaEnabled !== false
    };
  }

  /**
   * @param config
   *   mode          'editdisplay' | 'editoutput' | 'editinput' | 'editprocess'
   *   input         메시지 텍스트
   *   chatID        -1 = 첫 메시지(인사말, 기본값). 0 이상 = chat 배열 안의 그 메시지
   *   chat          이전 메시지 [{role,data}] (첫 메시지는 넣지 않는다 — 원본도 chat.message 에 없다)
   *   defaultVariables  카드의 defaultVariables 원문 (key=value 줄)
   *   vars          현재 채팅 변수 (scriptstate 로 들어감)
   */
  async function run(config) {
    var ctx = makeCtx(config);
    var mode = config.mode || 'editdisplay';
    var char = { customscript: config.charRegex || [] };
    var pipeCfg = pipeConfig(ctx, config);

    var input = config.input || '';
    var chatID = config.chatID == null ? -1 : config.chatID;
    // 일반 메시지인데 chat 에 그 메시지가 없으면 끝에 넣는다
    if (chatID >= 0 && !ctx.chat[chatID]) {
      chatID = ctx.chat.length;
      ctx.chat.push({ role: config.role || (mode === 'editinput' ? 'user' : 'char'), data: input });
    }

    async function runTriggerPass(passMode, arg) {
      if (!G.RisuTrigger) return null;
      var runner = G.RisuTrigger.create(ctx, triggerOpts(pipeCfg, ctx));
      var r = await runner.run(passMode, arg);
      ctx.chat = r.chat;
      if (r.scriptstate) ctx.scriptstate = r.scriptstate;
      if (r.lorebook) pipeCfg.globalLore = r.lorebook;
      return r;
    }

    function trigStage(label, r) {
      var fired = r.trace.filter(function (x) {
        return !x.skipped;
      }).length;
      return {
        stage: label,
        detail: '트리거 ' + r.trace.length + '개 중 ' + fired + '개 발화',
        triggerTrace: r.trace,
        skipped: fired === 0
      };
    }

    var trace = [];
    var trigOn = config.triggersEnabled !== false;

    // 버튼(risu-trigger) — Chat.svelte:305 runTrigger('manual')
    if (config.manualTrigger) {
      if (!trigOn) trace.push({ stage: '⓪ 버튼 트리거', detail: '사용 안 함 (기능 토글)', skipped: true });
      else {
        var man = await runTriggerPass('manual', { manualName: config.manualTrigger });
        if (man) trace.push(trigStage('⓪ 버튼 트리거("' + config.manualTrigger + '") — runTrigger("manual")', man));
      }
    }

    var finalText = input;
    var display = null;

    if (mode === 'editdisplay') {
      // 표시: Chat.svelte:256 사전 패스 → ParseMarkdown
      var cbsCond = chatID === -1 ? { firstmsg: true, chatRole: null } : { firstmsg: false, chatRole: (ctx.chat[chatID] || {}).role || null };
      var shownRaw = chatID >= 0 && ctx.chat[chatID] ? ctx.chat[chatID].data : input;
      var pre = cbsParse(shownRaw, ctx, { chatID: chatID, rmVar: true, visualize: true, cbsConditions: cbsCond });
      trace.push({
        stage: '⓪ CBS 사전 패스',
        detail: 'Chat.svelte:256 risuChatParser(message, { chatID: ' + chatID + ', rmVar: true, visualize: true }) — setvar 는 지우기만 하고 실행하지 않음',
        before: shownRaw,
        after: pre
      });
      var pm = await parseMarkdown(pre, pipeCfg, char, config.markdown === false ? 'back' : 'normal', chatID, cbsCond, { markdown: config.markdown });
      trace = trace.concat(pm.trace);
      finalText = pm.text;
      display = pm.display;
    } else if (mode === 'editoutput') {
      // index.svelte.ts:1742-1770 — processScriptFull(editoutput, msgIndex) → 저장 →
      // runCurrentChatFunction(runVar) → runTrigger('output')
      var msgIndex = chatID >= 0 ? chatID : ctx.chat.length;
      if (!ctx.chat[msgIndex]) ctx.chat[msgIndex] = { role: 'char', data: input };
      var out = await processScriptFull(pipeCfg, char, input, 'editoutput', msgIndex, {});
      trace = trace.concat(out.trace);
      ctx.chat[msgIndex].data = out.data;
      var beforeRun = out.data;
      for (var ci = 0; ci < ctx.chat.length; ci++) {
        ctx.chat[ci].data = cbsParse(ctx.chat[ci].data, ctx, { runVar: true });
      }
      trace.push({
        stage: '⑦ runCurrentChatFunction',
        detail: 'index.svelte.ts:1761 — 저장된 모든 메시지에 risuChatParser(runVar: true). 여기서 setvar 가 실제로 실행되고 지워진다',
        before: beforeRun,
        after: ctx.chat[msgIndex].data
      });
      if (trigOn) {
        var outRun = await runTriggerPass('output');
        if (outRun) trace.push(trigStage('⑧ 트리거(output) — runTrigger("output")', outRun));
      }
      finalText = ctx.chat[msgIndex] ? ctx.chat[msgIndex].data : out.data;
      // 저장된 메시지가 다음에 화면에 그려지는 모습 (표시 전 패스 + ParseMarkdown)
      var cond2 = { firstmsg: false, chatRole: 'char' };
      var pre2 = cbsParse(finalText, ctx, { chatID: msgIndex, rmVar: true, visualize: true, cbsConditions: cond2 });
      var pm2 = await parseMarkdown(pre2, pipeCfg, char, config.markdown === false ? 'back' : 'normal', msgIndex, cond2, { markdown: config.markdown });
      display = pm2.display;
      display.note = '저장된 출력이 화면에 그려지는 모습 (표시 전 CBS 패스 → ParseMarkdown 전체, editdisplay 정규식 포함)';
      display.trace = pm2.trace;
    } else if (mode === 'editinput') {
      // DefaultChatScreen.svelte:188-195 — runTrigger('input') → processScript(editinput)
      if (trigOn) {
        var inRun = await runTriggerPass('input');
        if (inRun) trace.push(trigStage('⓪ 트리거(input) — runTrigger("input")', inRun));
      }
      var inp = await processScriptFull(pipeCfg, char, input, 'editinput', -1, {});
      trace = trace.concat(inp.trace);
      finalText = inp.data;
    } else {
      // editprocess — index.svelte.ts:343 runCurrentChatFunction → 첫 메시지 → runTrigger('start') → 각 메시지
      for (var cj = 0; cj < ctx.chat.length; cj++) {
        ctx.chat[cj].data = cbsParse(ctx.chat[cj].data, ctx, { runVar: true });
      }
      if (chatID === -1) {
        // index.svelte.ts:871-875 — 첫 메시지는 start 트리거보다 먼저, chatID 없이
        var fmPre = cbsParse(input, ctx, {});
        trace.push({ stage: '⓪ CBS', detail: 'risuChatParser(firstMsg) (index.svelte.ts:874)', before: input, after: fmPre });
        var fmRes = await processScriptFull(pipeCfg, char, fmPre, 'editprocess', -1, {});
        trace = trace.concat(fmRes.trace);
        finalText = fmRes.data;
        if (trigOn) {
          var st = await runTriggerPass('start');
          if (st) trace.push(trigStage('⑦ 트리거(start) — 첫 메시지 처리 뒤 실행 (index.svelte.ts:888)', st));
        }
      } else {
        if (trigOn) {
          var st2 = await runTriggerPass('start');
          if (st2) trace.push(trigStage('⓪ 트리거(start) — runTrigger("start")', st2));
        }
        var msg = ctx.chat[chatID] || { role: 'char', data: input };
        var mPre = cbsParse(msg.data, ctx, { role: msg.role });
        trace.push({ stage: '⓪ CBS', detail: 'risuChatParser(msg.data, { role }) (index.svelte.ts:902)', before: msg.data, after: mPre });
        var pr = await processScriptFull(pipeCfg, char, mPre, 'editprocess', chatID, { chatRole: msg.role });
        trace = trace.concat(pr.trace);
        finalText = pr.data;
      }
    }

    if (!display) {
      display = { encoded: finalText, markdown: finalText, html: escapeHtml(finalText).replace(/\n/g, '<br>'), css: '' };
    }

    return {
      trace: trace,
      finalText: finalText,
      display: display,
      chatID: chatID,
      varsAfter: (function () {
        var o = {};
        Object.keys(ctx.scriptstate || {}).forEach(function (k) {
          if (k.charAt(0) === '$') o[k.slice(1)] = ctx.scriptstate[k];
        });
        return o;
      })(),
      globalVarsAfter: ctx.globalVars,
      globalLoreAfter: pipeCfg.globalLore,
      chatAfter: ctx.chat,
      scriptstateAfter: ctx.scriptstate || {},
      unsupported: Array.from(ctx.unsupported),
      luaStatus: G.RisuLua ? G.RisuLua.status() : { state: 'absent' }
    };
  }

  /**
   * 카드 배경 — BackgroundDom.svelte:17
   *   ParseMarkdown(risuChatParser(backgroundHTML + '\n' + moduleBackgroundEmbedding, {chara}), char, 'back')
   *   'back' 은 마크다운을 건너뛰지만 Lua editDisplay · display 트리거 · editdisplay 정규식은 탄다.
   */
  async function renderBackground(source, config) {
    var ctx = makeCtx(config);
    var pipeCfg = pipeConfig(ctx, config);
    pipeCfg.assets = null; // 동적 에셋(임베딩)은 배경에 쓰지 않음
    var pre = cbsParse(source, ctx, {});
    var pm = await parseMarkdown(pre, pipeCfg, { customscript: config.charRegex || [] }, 'back', -1, {}, {});
    return {
      html: pm.display.html,
      css: pm.display.css,
      trace: pm.trace,
      source: source,
      scriptstateAfter: ctx.scriptstate,
      globalVarsAfter: ctx.globalVars
    };
  }

  /**
   * 임의의 텍스트를 표시 단계 뒷부분(자산 → <Thoughts> → encodeStyle → markdown → trimMarkdown)에 통과시킨다.
   * 트레이스의 After 미리보기용 — 정규식/Lua/트리거는 다시 돌리지 않는다.
   */
  function renderDisplay(text, opts) {
    opts = opts || {};
    var ctx = opts.ctx || makeCtx(opts);
    var src = String(text == null ? '' : text);
    if (opts.expandCbs) {
      try {
        src = cbsParse(src, ctx, { rmVar: true, visualize: true });
      } catch (e) {
        /* 무시 */
      }
    }
    if (opts.resolveAssets !== false) {
      var A =
        opts.assets && !Array.isArray(opts.assets)
          ? normalizeAssets(opts.assets)
          : normalizeAssets({ assetNames: opts.assets || [], srcOf: opts.srcOf, maxDifference: opts.maxDifference });
      src = parseAdditionalAssets(src, A, opts.markdown === false ? 'back' : 'normal', { ch: -1 });
    }
    src = parseThoughtsAndTools(src);
    var encoded = encodeStyle(src);
    var rendered = opts.markdown === false || !Core || !Core.markdownit ? encoded : renderHighlightableMarkdown(encoded);
    if (!HAS_DOM) return { html: escapeHtml(rendered), css: '', encoded: encoded, markdown: rendered };
    var html = trimMarkdown(rendered, ctx, opts.scope);
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var css = Array.prototype.slice
      .call(tpl.content.querySelectorAll('style'))
      .map(function (s) {
        return s.textContent;
      })
      .join('\n');
    return { html: html, css: css, encoded: encoded, markdown: rendered };
  }

  G.RisuSim = {
    run: run,
    renderDisplay: renderDisplay,
    renderBackground: renderBackground,
    resetScriptCache: resetScriptCache,
    setScriptCache: function (on) {
      scriptCacheEnabled = !!on;
      if (!on) resetScriptCache();
    },
    scriptCacheSize: function () {
      return scriptCache.size;
    },
    encodeStyle: encodeStyle,
    trimMarkdown: trimMarkdown,
    setLanguage: function (l) {
      LANG = LANGS[l] || LANGS.ko;
    },
    _internal: {
      cbsParse: cbsParse,
      chatVarGet: chatVarGet,
      chatVarSet: chatVarSet,
      resolveAssetTags: resolveAssetTags,
      parseAdditionalAssets: parseAdditionalAssets,
      normalizeAssets: normalizeAssets,
      renderMarkdown: function (s) {
        initMarkdown();
        return renderMarkdown(md, s);
      },
      renderHighlightableMarkdown: renderHighlightableMarkdown,
      decodeStyleContent: decodeStyleContent,
      parseThoughtsAndTools: parseThoughtsAndTools,
      makeCtx: makeCtx
    }
  };
})();

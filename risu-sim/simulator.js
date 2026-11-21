/*
 * RisuAI 파이프라인 시뮬레이터 — 엔진
 * ------------------------------------------------------------------
 * RisuAI 6db4b681 의 다음 코드를 1:1로 옮긴 것입니다.
 *   src/ts/process/scripts.ts        processScriptFull / executeScript
 *   src/ts/parser/parser.svelte.ts   encodeStyle / decodeStyleRule / decodeStyleContent
 *                                    trimMarkdown(DOMPurify 훅)
 *   src/ts/cbs.ts                    CBS 함수 (서브셋)
 *
 * 각 함수 위에 원본 위치를 주석으로 표기했습니다.
 * "원본과 다른 부분"은 DIFF 주석으로 표시했습니다.
 */
(function () {
  'use strict';

  // ==================================================================
  // 0. 공통 유틸
  // ==================================================================

  var PUA = ['\uE9B8', '\uE9B9', '\uE9BA', '\uE9BB', '\uE9BC', '\uE9BD', '\uE9BE', '\uE9BF'];
  var PUA_FROM = ['{', '}', '(', ')', '&lt;', '&gt;', ':', ';'];
  var PUA_TO = ['{', '}', '(', ')', '<', '>', ':', ';'];

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

  function isTruthy(s) {
    return s === 'true' || s === '1';
  }

  // ==================================================================
  // 1. CBS ({{...}})
  //    원본: src/ts/parser/parser.svelte.ts:1599 risuChatParser
  //          src/ts/cbs.ts (registerCBS 로 등록된 인라인 함수들)
  //    DIFF: RisuAI 는 문자 단위 상태머신이지만, 여기서는 동등한
  //          재귀 스캐너로 구현했습니다. 블록 중첩/else 처리는 동일합니다.
  // ==================================================================

  function findTagEnd(str, from) {
    // '{{' 다음 위치부터 짝이 맞는 '}}' 를 찾는다.
    // 태그 인자 안의 중첩({{#if {{getvar::x}}}})을 처리해야 하므로 깊이를 센다.
    // (원본 parser.svelte.ts 는 nested 스택으로 동일하게 처리)
    var depth = 1;
    var i = from;
    while (i < str.length) {
      var c = str.charAt(i);
      if (c === '{' && str.charAt(i + 1) === '{') {
        depth++;
        i += 2;
        continue;
      }
      if (c === '}' && str.charAt(i + 1) === '}') {
        depth--;
        if (depth === 0) return i;
        i += 2;
        continue;
      }
      i++;
    }
    return -1;
  }

  // 블록 이름의 '기본형' (if_pure → if, puredisplay → pure)
  function blockBaseName(name) {
    if (name === 'puredisplay' || name === 'pure_display') return 'pure';
    return name.replace(/_(pure|display)$/, '');
  }

  function isBlockOpen(inner) {
    return inner.charAt(0) === '#' && inner.length > 1;
  }

  // 같은 이름의 블록을 중첩 카운트하며 짝이 맞는 {{/name}} 을 찾는다.
  // 반환: { bodyEnd, end }  (bodyEnd = 본문 끝, end = 닫는 태그 다음)
  function findMatching(str, from, name) {
    var base = blockBaseName(name);
    var depth = 1;
    var i = from;
    while (i < str.length) {
      var idx = str.indexOf('{{', i);
      if (idx < 0) return { bodyEnd: str.length, end: str.length };
      var close = findTagEnd(str, idx + 2);
      if (close < 0) return { bodyEnd: str.length, end: str.length };
      var inner = str.slice(idx + 2, close).trim();
      var lower = inner.toLowerCase();
      if (isBlockOpen(inner)) {
        var om = inner.match(/^#([^\s:]+)/);
        if (om && blockBaseName(om[1].toLowerCase()) === base) depth++;
      } else if (lower.charAt(0) === '/') {
        var closeName = lower.slice(1).trim();
        if (closeName === name || blockBaseName(closeName) === base) {
          depth--;
          if (depth === 0) return { bodyEnd: idx, end: close + 2 };
        }
      }
      i = close + 2;
    }
    return { bodyEnd: str.length, end: str.length };
  }

  // 본문을 최상위 {{:else}} 기준으로 둘로 나눈다.
  function splitTopLevelElse(body) {
    var depth = 0;
    var i = 0;
    while (i < body.length) {
      var idx = body.indexOf('{{', i);
      if (idx < 0) break;
      var close = findTagEnd(body, idx + 2);
      if (close < 0) break;
      var inner = body.slice(idx + 2, close).trim();
      if (isBlockOpen(inner)) depth++;
      else if (inner.charAt(0) === '/') depth--;
      else if (inner === ':else' && depth === 0) {
        return [body.slice(0, idx), body.slice(close + 2)];
      }
      i = close + 2;
    }
    return [body, null];
  }

  function splitArgs(inner) {
    // '::' 로 인자를 나눈다. 이스케이프는 지원하지 않음(원본도 단순 split)
    return inner.split('::');
  }

  function cbsParse(str, ctx) {
    if (str == null) return '';
    str = String(str);
    var out = '';
    var i = 0;
    while (i < str.length) {
      var idx = str.indexOf('{{', i);
      if (idx < 0) {
        out += str.slice(i);
        break;
      }
      out += str.slice(i, idx);
      var close = findTagEnd(str, idx + 2);
      if (close < 0) {
        out += str.slice(idx);
        break;
      }
      var inner = str.slice(idx + 2, close).trim();

      if (isBlockOpen(inner)) {
        var m = inner.match(/^#([^\s:]+)([\s\S]*)$/);
        var name = m[1].toLowerCase();
        var rest = m[2] || '';
        var match = findMatching(str, close + 2, name);
        var body = str.slice(close + 2, match.bodyEnd);
        out += evalBlock(name, rest, body, ctx);
        i = match.end;
        continue;
      }
      if (inner.charAt(0) === '/') {
        // 짝 없는 닫는 태그는 무시 (원본도 그렇게 동작)
        i = close + 2;
        continue;
      }
      if (inner === ':else') {
        i = close + 2;
        continue;
      }
      out += evalInline(inner, ctx);
      i = close + 2;
    }
    return out;
  }

  function evalBlock(name, rest, body, ctx) {
    switch (name) {
      case 'if':
      case 'if_pure': {
        var cond = cbsParse(rest, ctx).trim();
        var parts = splitTopLevelElse(body);
        // DIFF 없음: 원본은 조건이 false 면 본문을 평가하지 않는다(사이드이펙트 없음)
        if (isTruthy(cond)) return cbsParse(parts[0], ctx);
        return parts[1] == null ? '' : cbsParse(parts[1], ctx);
      }
      case 'when':
      case 'when_pure': {
        var raw = rest.trim();
        var stmt;
        if (raw.indexOf('::') === 0) {
          stmt = splitArgs(raw.slice(2));
        } else if (raw.charAt(0) === ':' && raw.charAt(1) === ':') {
          stmt = splitArgs(raw.slice(2));
        } else {
          stmt = [cbsParse(raw.replace(/^[\s:]*(::)?/, ''), ctx)];
        }
        var ok = evalWhen(stmt, ctx);
        var wparts = splitTopLevelElse(body);
        // 원본은 #when 이 false 여도 본문 CBS 를 실행한 뒤 버린다.
        // (블록 내 {{setvar}} 등은 조건과 무관하게 실행됨)
        var evalFirst = cbsParse(wparts[0], ctx);
        var evalSecond = wparts[1] == null ? '' : cbsParse(wparts[1], ctx);
        return ok ? evalFirst : evalSecond;
      }
      case 'pure':
      case 'pure_display':
      case 'puredisplay':
        return body;
      case 'code': {
        var decoded = body
          .replace(/\n/g, '')
          .replace(/\t/g, '')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
            return String.fromCharCode(parseInt(h, 16));
          });
        return decoded;
      }
      case 'escape': {
        var out = '';
        for (var i = 0; i < body.length; i++) {
          var c = body.charAt(i);
          var p = PUA_FROM.indexOf(c);
          out += p >= 0 ? PUA[p] : c;
        }
        return out;
      }
      case 'each': {
        // {{#each <엔진> as <변수>}} ... {{/each}}
        var mm = rest.match(/^\s*([\s\S]+?)\s+as\s+([A-Za-z0-9_]+)\s*$/);
        if (!mm) return '';
        var src = resolveValue(mm[1], ctx);
        var arr;
        try {
          arr = typeof src === 'string' ? JSON.parse(src) : src;
        } catch (e) {
          arr = null;
        }
        if (!Array.isArray(arr)) return '';
        var item = mm[2];
        var acc = '';
        for (var k = 0; k < arr.length; k++) {
          var v = typeof arr[k] === 'string' ? arr[k] : JSON.stringify(arr[k]);
          acc += cbsParse(body.replace(new RegExp('\\{\\{slot::' + item + '\\}\\}', 'g'), v), ctx);
        }
        return acc;
      }
      case 'func':
        ctx.unsupported.add('{{#func}}');
        return '';
      default:
        ctx.unsupported.add('{{#' + name + '}}');
        return '';
    }
  }

  function evalWhen(stmt, ctx) {
    var st = stmt.slice();
    if (st.length === 0) return false;
    while (st.length > 1) {
      var condition = st.pop();
      var operator = (st.pop() || '').trim().toLowerCase();
      switch (operator) {
        case 'not':
          st.push(isTruthy(condition) ? '0' : '1');
          break;
        case 'and': {
          var a = st.pop();
          st.push(isTruthy(a) && isTruthy(condition) ? '1' : '0');
          break;
        }
        case 'or': {
          var b = st.pop();
          st.push(isTruthy(b) || isTruthy(condition) ? '1' : '0');
          break;
        }
        case 'is': {
          var c = st.pop();
          st.push(c === condition ? '1' : '0');
          break;
        }
        case 'isnot': {
          var d = st.pop();
          st.push(d === condition ? '0' : '1');
          break;
        }
        case '>':
        case '<':
        case '>=':
        case '<=': {
          var e = parseFloat(st.pop());
          var f = parseFloat(condition);
          var r = false;
          if (operator === '>') r = e > f;
          else if (operator === '<') r = e < f;
          else if (operator === '>=') r = e >= f;
          else r = e <= f;
          st.push(r ? '1' : '0');
          break;
        }
        case 'var': {
          var g = resolveValue(condition, ctx);
          st.push(isTruthy(g) ? '1' : '0');
          break;
        }
        case 'toggle': {
          var h = ctx.globalVars['toggle_' + condition];
          st.push(isTruthy(h) ? '1' : '0');
          break;
        }
        case 'vis': {
          var target = st.pop();
          st.push(resolveValue(target, ctx) === condition ? '1' : '0');
          break;
        }
        case 'visnot': {
          var target2 = st.pop();
          st.push(resolveValue(target2, ctx) === condition ? '0' : '1');
          break;
        }
        case 'tis': {
          var t = ctx.globalVars['toggle_' + st.pop()];
          st.push(t === condition ? '1' : '0');
          break;
        }
        case 'tisnot': {
          var t2 = ctx.globalVars['toggle_' + st.pop()];
          st.push(t2 === condition ? '0' : '1');
          break;
        }
        default:
          st.push('0');
      }
    }
    return isTruthy(st[0]);
  }

  // 인라인 값 해석: '{{...}}' 이면 CBS, 'getvar::x' 형태면 변수 참조
  function resolveValue(raw, ctx) {
    if (raw == null) return '';
    var s = String(raw);
    if (s.indexOf('{{') >= 0) return cbsParse(s, ctx);
    var m = s.match(/^(getvar|getglobalvar)::(.+)$/);
    if (m) {
      return m[1] === 'getvar' ? ctx.vars[m[2]] || '' : ctx.globalVars[m[2]] || '';
    }
    return s;
  }

  function evalInline(inner, ctx) {
    if (inner.indexOf('//') === 0) return '';
    var args = splitArgs(inner);
    var name = (args[0] || '').trim().toLowerCase();
    var rest = args.slice(1);

    switch (name) {
      // --- 변수 ---
      case 'getvar':
        return ctx.vars[rest[0]] != null ? ctx.vars[rest[0]] : '';
      case 'setvar':
        ctx.vars[rest[0]] = rest.slice(1).join('::');
        return '';
      case 'addvar':
        ctx.vars[rest[0]] = (ctx.vars[rest[0]] || '') + rest.slice(1).join('::');
        return '';
      case 'setdefaultvar':
        if (ctx.vars[rest[0]] == null) ctx.vars[rest[0]] = rest.slice(1).join('::');
        return '';
      case 'getglobalvar':
        return ctx.globalVars[rest[0]] != null ? ctx.globalVars[rest[0]] : '';
      case 'setglobalvar':
        ctx.globalVars[rest[0]] = rest.slice(1).join('::');
        return '';

      // --- 캐릭터/유저 ---
      case 'char':
        return ctx.charName || '';
      case 'user':
        return ctx.userName || '';
      case 'persona':
        return ctx.userName || '';
      case 'original':
        return '';
      case 'mainprompt':
      case 'jb':
      case 'globalnote':
        return ctx[name] || '';
      case 'role':
        return ctx.role || '';

      // --- 텍스트 ---
      case 'blank':
        return '';
      case 'newline':
        return '\n';
      case 'space':
        return ' ';
      case 'br':
        return '\n';
      case 'comment':
        return '';
      case '//':
        return '';
      case 'data':
        return '{{data}}';

      // --- 자산 태그: 원본에서는 doc_only 로 등록만 되고 matcherMap 에는 안 들어간다
      //     (cbs.ts:2289-2370 + parser.svelte.ts registerFunction 의 doc_only early return)
      //     → CBS 는 이 태그를 건드리지 않고, parseAdditionalAssets(assetRegex)가 처리한다.
      case 'img':
      case 'image':
      case 'emotion':
      case 'video':
      case 'audio':
      case 'bg':
      case 'bgm':
      case 'raw':
      case 'path':
      case 'source':
      case 'asset':
      case 'video-img':
      case 'inlay':
      case 'inlayed':
      case 'inlayeddata':
        return '{{' + inner + '}}';

      // --- 기타 ---
      case 'button':
        return '<button risu-trigger="' + escapeHtml(rest[1] || '') + '">' + escapeHtml(rest[0] || '') + '</button>';
      case 'ruby':
        return '<ruby>' + escapeHtml(rest[0] || '') + '<rp> (</rp><rt>' + escapeHtml(rest[1] || '') + '</rt><rp>) </rp></ruby>';
      case 'tex':
        return '$$' + (rest[0] || '') + '$$';
      case 'codeblock':
        return '<pre><code class="language-' + escapeHtml(rest[0] || '') + '">' + escapeHtml(rest[1] || '') + '</code></pre>';
      case 'debo':
        return PUA[0];
      case 'debc':
        return PUA[1];
      case 'deabo':
        return PUA[2];
      case 'deabc':
        return PUA[3];
      case 'dec':
        return PUA[6];
      case ';':
        return PUA[7];

      default:
        ctx.unsupported.add('{{' + (args[0] || '') + '}}');
        return '{{' + inner + '}}';
    }
  }

  function unescapePua(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var p = PUA.indexOf(s.charAt(i));
      out += p >= 0 ? PUA_TO[p] : s.charAt(i);
    }
    return out;
  }

  // ==================================================================
  // 2. 정규식 파이프라인
  //    원본: src/ts/process/scripts.ts:99  processScriptFull
  //          src/ts/process/scripts.ts:145 executeScript
  //          src/ts/process/scripts.ts:296 <order N> 파싱 / 정렬
  // ==================================================================

  var DREG = /\{\{data\}\}/g;

  // 봇 트리거(전체) + Lua 편의 입력 + 모듈 트리거를 하나의 실행 목록으로.
  // 원본도 runLuaEditTrigger 와 runTrigger 가 같은 triggerscript 배열을 쓴다.
  function allTriggers(config) {
    return []
      .concat(config.charTriggers || [])
      .concat(config.charLua || [])
      .concat(config.moduleTriggers || [])
      .concat(config.moduleLua || []);
  }

  function parseScriptMeta(script) {
    // scripts.ts:296-330
    if (script.ableFlag && typeof script.flag === 'string' && script.flag.indexOf('<') >= 0) {
      var copy = Object.assign({}, script);
      var order = 0;
      var actions = [];
      var orderChanged = false;
      copy.flag = script.flag.replace(/<(.+?)>/g, function (v, p1) {
        var meta = p1.split(',').map(function (x) {
          return x.trim();
        });
        for (var i = 0; i < meta.length; i++) {
          var m = meta[i];
          if (m.indexOf('order ') === 0) {
            order = parseInt(m.substring(6), 10) || 0;
            orderChanged = true;
          } else if (m) {
            actions.push(m);
          }
        }
        return '';
      });
      return { script: copy, layer: script.__layer, order: order, actions: actions, orderChanged: orderChanged };
    }
    return { script: script, layer: script.__layer, order: 0, actions: [], orderChanged: false };
  }

  // scripts.ts:145-293
  function executeScript(ps, data, mode, ctx, entry) {
    var script = ps.script;
    entry.type = script.type;
    entry.flag = script.ableFlag ? script.flag : 'g';
    entry.order = ps.order;
    entry.actions = ps.actions.join(',');

    if (script.in === '' || script.in == null) {
      entry.skipped = 'in 이 비어 있음';
      return data;
    }
    if (script.type !== mode) {
      entry.skipped = 'type 불일치 (' + script.type + ' ≠ ' + mode + ')';
      return data;
    }

    var outScript2 = String(script.out == null ? '' : script.out).replaceAll('$n', '\n');
    var outScript = outScript2.replace(DREG, '$&');
    var flag = 'g';
    if (script.ableFlag) flag = script.flag || 'g';

    if (
      outScript.indexOf('@@move_top') === 0 ||
      outScript.indexOf('@@move_bottom') === 0 ||
      ps.actions.indexOf('move_top') >= 0 ||
      ps.actions.indexOf('move_bottom') >= 0
    ) {
      flag = flag.replace('g', '');
    }
    if (outScript.slice(-1) === '>' && ps.actions.indexOf('no_end_nl') < 0) {
      outScript += '\n';
    }
    // remove unsupported flag
    flag = flag.trim().replace(/[^dgimsuvy]/g, '');
    // remove repeated flags
    flag = flag
      .split('')
      .filter(function (v, i, a) {
        return a.indexOf(v) === i;
      })
      .join('');
    if (flag.length === 0) flag = 'u';

    var input = String(script.in);
    if (ps.actions.indexOf('cbs') >= 0) {
      input = cbsParse(input, ctx);
    }

    var reg;
    try {
      reg = new RegExp(input, flag);
    } catch (e) {
      entry.error = '정규식 오류: ' + e.message;
      return data; // 원본도 try/catch 로 감싸 스킵
    }

    entry.flag = flag;
    entry.resolvedIn = input;
    entry.resolvedOut = outScript;

    var matched = reg.test(data);
    entry.matched = matched;

    if (outScript.indexOf('@@') === 0 || ps.actions.length > 0) {
      if (matched) {
        if (outScript.indexOf('@@emo ') === 0) {
          entry.action = '@@emo';
          entry.emotion = script.out.substring(6).trim();
          // DIFF: 감정 이미지 상태 저장은 생략 (UI 표시만)
        } else if (
          outScript.indexOf('@@inject') === 0 ||
          ps.actions.indexOf('inject') >= 0
        ) {
          entry.action = '@@inject';
          // DIFF: 채팅 메시지 저장은 생략. 본문에서만 제거.
          data = data.replace(reg, '');
        } else if (
          outScript.indexOf('@@move_top') === 0 ||
          outScript.indexOf('@@move_bottom') === 0 ||
          ps.actions.indexOf('move_top') >= 0 ||
          ps.actions.indexOf('move_bottom') >= 0
        ) {
          entry.action = 'move';
          var isGlobal = flag.indexOf('g') >= 0;
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
                var index = parseInt(v.substring(1), 10);
                if (index < m.length) return m[index];
                return v;
              })
              .replace(/\$&/g, inData)
              .replace(/(?<!\$)\$<([^>]+)>/g, function (v) {
                var groupName = parseInt(v.substring(2, v.length - 1), 10);
                if (m.groups && m.groups[groupName]) return m.groups[groupName];
                return v;
              });
            if (outScript.indexOf('@@move_top') === 0 || ps.actions.indexOf('move_top') >= 0) {
              data = out + '\n' + data;
            } else {
              data = data + '\n' + out;
            }
          }
        } else {
          entry.action = 'literal';
          data = cbsParse(data.replace(reg, outScript), ctx);
        }
      } else {
        if (outScript.indexOf('@@repeat_back') === 0 || ps.actions.indexOf('repeat_back') >= 0) {
          entry.action = '@@repeat_back';
          var v2 = outScript.split(' ')[1];
          var lastChat = ctx.prevMessage || '';
          var r = lastChat.match(reg);
          if (r) {
            if (!v2) data = data + r[0];
            else if (v2 === 'end') data = data + r[0];
            else if (v2 === 'start') data = r[0] + data;
            else if (v2 === 'end_nl') data = data + '\n' + r[0];
            else if (v2 === 'start_nl') data = r[0] + '\n' + data;
          }
        }
      }
    } else {
      data = cbsParse(data.replace(reg, outScript), ctx);
    }

    return data;
  }

  // scripts.ts:99-387 (Lua/trigger/plugin 단계는 생략 표시)
  async function processScriptFull(config, char, data, mode) {
    var ctx = config.ctx;
    var trace = [];

    // ① Lua  (scriptings.ts:1478 runLuaEditTrigger)
    //    editprocess 는 원본에서 즉시 return 하므로 Lua 가 개입할 수 없다.
    var luaMode = null;
    if (mode === 'editinput') luaMode = 'editInput';
    else if (mode === 'editoutput') luaMode = 'editOutput';
    else if (mode === 'editdisplay') luaMode = 'editDisplay';

    if (luaMode && window.RisuLua) {
      var luaTriggers = allTriggers(config);
      var beforeLua = data;
      try {
        var luaRes = await window.RisuLua.runEditHooks(luaTriggers, luaMode, data, ctx, {
          index: -1,
          chatRole: ctx.role || ''
        });
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
      trace.push({
        stage: '① Lua',
        detail: 'Lua 훅 없음 — 원본 scriptings.ts:1489-1491 이 즉시 return',
        before: data,
        after: data,
        skipped: true
      });
    } else {
      trace.push({
        stage: '① Lua',
        detail: 'lua-runtime.js 미로드',
        before: data,
        after: data,
        skipped: true
      });
    }

    // ② display 트리거 (triggers.ts:1058 runTrigger, displayMode)
    if (mode === 'editdisplay' && window.RisuTrigger) {
      var beforeTrig = data;
      try {
        var runner = window.RisuTrigger.create(ctx, {
          charTriggers: allTriggers(config),
          moduleTriggers: [],
          chat: ctx.chat,
          displayMode: true,
          displayData: data
        });
        var tr = await runner.run('display');
        if (tr.displayData != null) data = tr.displayData;
        if (tr.chat) ctx.chat = tr.chat;
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
        trace.push({
          stage: '② 트리거(display)',
          detail: '실행 오류: ' + ((e && e.message) || e),
          before: beforeTrig,
          after: data,
          skipped: true
        });
      }
    } else if (mode === 'editdisplay') {
      trace.push({
        stage: '② 트리거(display)',
        detail: 'trigger-runtime.js 미로드',
        before: data,
        after: data,
        skipped: true
      });
    }

    // ③ 플러그인
    trace.push({
      stage: '③ 플러그인',
      detail: 'pluginV2["' + mode + '"] — 등록된 플러그인 없음',
      before: data,
      after: data,
      skipped: true
    });

    // ④ CBS
    var beforeCbs = data;
    data = cbsParse(data, ctx);
    trace.push({ stage: '④ CBS', detail: 'risuChatParser(data)', before: beforeCbs, after: data });

    // ⑤ 정규식
    var scripts = []
      .concat(config.presetRegex || [])
      .concat(char.customscript || [])
      .concat(config.moduleRegex || []);

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
        data = executeScript(ps, data, mode, ctx, entry);
      } catch (e) {
        entry.error = String(e && e.message);
      }
      entry.before = before;
      entry.after = data;
      entry.changed = before !== data;
      entries.push(entry);
    }

    trace.push({
      stage: '⑤ 정규식',
      detail: 'presetRegex → char.customscript → module regex',
      orderChanged: orderChanged,
      table: sorted.map(function (ps, idx) {
        return {
          n: idx + 1,
          layer: ps.layer,
          type: ps.script.type,
          order: ps.order,
          actions: ps.actions,
          in: ps.script.in,
          out: ps.script.out
        };
      }),
      entries: entries
    });

    // ⑥ 동적 에셋 (scripts.ts:345-382)
    //    정규식 이후 · 반환 직전. editinput/editprocess 는 스킵,
    //    editdisplay 는 dynamicAssetsEditDisplay 가 켜져야 실행.
    if (config.assets && window.RisuAssets) {
      var assetRes = await window.RisuAssets.resolve(data, mode, config.assets);
      data = assetRes.data;
      trace.push(assetRes.trace);
    } else {
      trace.push({
        stage: '⑥ 동적 에셋',
        detail: 'asset-runtime.js 미로드',
        before: data,
        after: data,
        skipped: true
      });
    }

    return { data: data, trace: trace };
  }

  // ==================================================================
  // 3. CSS 스코프
  //    원본: src/ts/parser/parser.svelte.ts:957 encodeStyle
  //          src/ts/parser/parser.svelte.ts:964 decodeStyleRule
  //          src/ts/parser/parser.svelte.ts:1005 decodeStyleContent
  //    DIFF: @adobe/css-tools 대신 내장 파서 사용. 일반 rule / @media /
  //          @supports / @container / @import 처리 규칙은 동일.
  // ==================================================================

  // ==================================================================
  // 3-0. 자산 태그 해석 (parseAdditionalAssets 근사)
  //      원본: parser.svelte.ts:486 parseAdditionalAssets
  //            parser.svelte.ts:603 getClosestMatch (레벤슈타인 폴백)
  //      DIFF: 실제 이미지 대신 자리표시자를 만든다.
  // ==================================================================

  var ASSET_TAG_RE = /\{\{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::(.+?)\}\}/gms;

  function trimmer(str) {
    var exts = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg'];
    var s2 = String(str);
    for (var i = 0; i < exts.length; i++) {
      if (s2.endsWith('.' + exts[i])) {
        s2 = s2.substring(0, s2.length - exts[i].length - 1);
        break;
      }
    }
    return s2.trim().replace(/[_ \-.]/g, '');
  }

  // parser.svelte.ts:636 getDistance (1차원 배열 레벤슈타인)
  function getDistance(a, b) {
    var h = a.length + 1;
    var w = b.length + 1;
    var d = new Int32Array(h * w);
    for (var i = 0; i < h; i++) d[i * w] = i;
    for (var j = 0; j < w; j++) d[j] = j;
    for (var y = 1; y < h; y++) {
      for (var x = 1; x < w; x++) {
        d[y * w + x] = Math.min(
          d[(y - 1) * w + (x - 1)] + (a.charAt(y - 1) === b.charAt(x - 1) ? 0 : 1),
          d[(y - 1) * w + x] + 1,
          d[y * w + (x - 1)] + 1
        );
      }
    }
    return d[h * w - 1];
  }

  // parser.svelte.ts:603 getClosestMatch
  function getClosestMatch(name, names, maxDiff) {
    if (!names || !names.length) return null;
    var trimmed = trimmer(name);
    var best = null;
    var bestDist = 999999;
    for (var i = 0; i < names.length; i++) {
      var dist = getDistance(trimmed, trimmer(names[i]));
      if (dist < bestDist) {
        bestDist = dist;
        best = names[i];
      }
    }
    if (bestDist > maxDiff) return null;
    return best;
  }

  // 원본은 실제 이미지를 <img src="blob:..."> 로 넣는다. 시뮬레이터는 이미지 바이트를
  // 갖고 있지 않으므로 "여기에 어떤 에셋이 들어갔는지" 보이는 자리표시자로 바꾼다.
  // raw/path/source 는 CSS url() 등에 그대로 쓰여야 해서 문자열을 유지한다.
  function assetPlaceholder(type, name) {
    var n = escapeHtml(name);
    switch (type) {
      case 'raw':
      case 'path':
        return 'asset://' + n;
      case 'source':
        return 'profile://' + n;
      case 'bg':
        // 원본은 mode === 'back' 에서만 배경 div 를 만든다
        return '<div class="x-risu-sim-bg" data-t="BG">' + n + '</div>';
      case 'img':
        return '<span class="x-risu-sim-asset" data-t="IMG">' + n + '</span>';
      case 'video':
      case 'video-img':
        return '<span class="x-risu-sim-asset" data-t="VIDEO">' + n + '</span>';
      case 'audio':
      case 'bgm':
        return '<span class="x-risu-sim-asset" data-t="AUDIO">' + n + '</span>';
      case 'emotion':
        return '<span class="x-risu-sim-asset" data-t="EMOTION">' + n + '</span>';
      case 'image':
      case 'asset':
      default:
        return '<span class="x-risu-sim-asset" data-t="' + escapeHtml(String(type).toUpperCase()) + '">' + n + '</span>';
    }
  }

  /**
   * {{type::name}} → HTML 자리표시자.
   * 정확 일치(대소문자 무시) → 레벤슈타인 폴백 → 실패 시 '' (원본과 동일)
   */
  function resolveAssetTags(data, names, maxDiff) {
    if (!names || !names.length) return data;
    return data.replace(ASSET_TAG_RE, function (full, type, rawName) {
      var needle = String(rawName).toLocaleLowerCase();
      var hit = null;
      for (var i = 0; i < names.length; i++) {
        if (String(names[i]).toLocaleLowerCase() === needle) {
          hit = names[i];
          break;
        }
      }
      if (!hit) hit = getClosestMatch(needle, names, maxDiff == null ? 4 : maxDiff);
      if (!hit) return '';
      return assetPlaceholder(type, hit);
    });
  }

  var STYLE_RE = /<style>(.+?)<\/style>/gms;

  // parser.svelte.ts:957-962
  function encodeStyle(txt) {
    return txt.replace(STYLE_RE, function (f, c1) {
      return '<risu-style>' + hexEncode(c1) + '</risu-style>';
    });
  }

  var AT_RULE_NESTED = ['media', 'supports', 'document', 'host', 'container'];

  // 아주 작은 CSS 파서: 최상위 규칙을 {type, selector|atName, body} 로 분해
  function parseCss(text) {
    var nodes = [];
    var i = 0;
    var n = text.length;

    function skipWsAndComments() {
      while (i < n) {
        var c = text.charAt(i);
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
          i++;
          continue;
        }
        if (c === '/' && text.charAt(i + 1) === '*') {
          var end = text.indexOf('*/', i + 2);
          i = end < 0 ? n : end + 2;
          continue;
        }
        break;
      }
    }

    function readUntil(stops, respectBraces) {
      var start = i;
      var depth = 0;
      var quote = null;
      while (i < n) {
        var c = text.charAt(i);
        if (quote) {
          if (c === '\\') {
            i += 2;
            continue;
          }
          if (c === quote) quote = null;
          i++;
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          i++;
          continue;
        }
        if (c === '/' && text.charAt(i + 1) === '*') {
          var e = text.indexOf('*/', i + 2);
          i = e < 0 ? n : e + 2;
          continue;
        }
        if (respectBraces) {
          if (c === '(') depth++;
          else if (c === ')') depth--;
          else if (c === '{' && depth <= 0) return { text: text.slice(start, i), stop: '{' };
          else if (c === '}' && depth <= 0) return { text: text.slice(start, i), stop: '}' };
        }
        if (!respectBraces && stops.indexOf(c) >= 0) {
          return { text: text.slice(start, i), stop: c };
        }
        if (respectBraces && stops.indexOf(c) >= 0 && depth <= 0) {
          return { text: text.slice(start, i), stop: c };
        }
        i++;
      }
      return { text: text.slice(start, i), stop: null };
    }

    function readBlockBody() {
      // '{' 다음 위치에서 호출. 짝이 맞는 '}' 까지.
      var start = i;
      var depth = 1;
      var quote = null;
      while (i < n) {
        var c = text.charAt(i);
        if (quote) {
          if (c === '\\') {
            i += 2;
            continue;
          }
          if (c === quote) quote = null;
          i++;
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          i++;
          continue;
        }
        if (c === '/' && text.charAt(i + 1) === '*') {
          var e = text.indexOf('*/', i + 2);
          i = e < 0 ? n : e + 2;
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            var body = text.slice(start, i);
            i++;
            return body;
          }
        }
        i++;
      }
      return text.slice(start);
    }

    while (i < n) {
      skipWsAndComments();
      if (i >= n) break;
      var startPos = i;
      var head = readUntil(['{', ';', '}'], true);
      var headText = head.text.trim();
      if (head.stop === '{') {
        i++;
        var body = readBlockBody();
        if (headText.charAt(0) === '@') {
          var m = headText.match(/^@([A-Za-z-]+)\s*([\s\S]*)$/);
          nodes.push({
            type: 'atrule',
            name: (m ? m[1] : '').toLowerCase(),
            prelude: m ? m[2].trim() : '',
            body: body,
            raw: text.slice(startPos, i)
          });
        } else if (headText) {
          nodes.push({ type: 'rule', selector: headText, body: body });
        }
      } else if (head.stop === ';') {
        i++;
        if (headText.charAt(0) === '@') {
          var m2 = headText.match(/^@([A-Za-z-]+)\s*([\s\S]*)$/);
          nodes.push({
            type: 'atrule',
            name: (m2 ? m2[1] : '').toLowerCase(),
            prelude: m2 ? m2[2].trim() : '',
            body: null,
            raw: headText + ';'
          });
        }
      } else {
        i++;
      }
    }
    return nodes;
  }

  // 셀렉터 목록을 최상위 콤마로 분리 (괄호/문자열 무시)
  function splitSelectors(sel) {
    var out = [];
    var buf = '';
    var depth = 0;
    var quote = null;
    for (var i = 0; i < sel.length; i++) {
      var c = sel.charAt(i);
      if (quote) {
        buf += c;
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        buf += c;
        continue;
      }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) {
        out.push(buf.trim());
        buf = '';
        continue;
      }
      buf += c;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  // 클래스 셀렉터 .foo → .x-risu-foo (속성 셀렉터 내부는 제외)
  function renameClasses(sel) {
    var out = '';
    var i = 0;
    while (i < sel.length) {
      var c = sel.charAt(i);
      if (c === '[') {
        var end = sel.indexOf(']', i);
        if (end < 0) end = sel.length - 1;
        out += sel.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (c === '.') {
        var j = i + 1;
        var buf = '';
        while (j < sel.length && /[A-Za-z0-9_\-\u00a0-\uffff]/.test(sel.charAt(j))) {
          buf += sel.charAt(j);
          j++;
        }
        if (buf && buf.indexOf('x-risu-') !== 0) {
          out += '.x-risu-' + buf;
        } else {
          out += '.' + buf;
        }
        i = j;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  // parser.svelte.ts:964-997
  // scope: 기본 '.chattext'. 트레이스의 After 미리보기에서는 블록마다 다른 스코프를 쓴다
  //        (여러 블록의 카드 CSS 가 서로 섞이지 않게).
  function decodeStyleRule(node, scope) {
    var prefix = scope || '.chattext';
    if (node.type === 'rule') {
      var list = splitSelectors(node.selector);
      list = list.map(function (s) {
        return prefix + ' ' + renameClasses(s);
      });
      node.selector = list.join(',');
    }
    if (node.type === 'atrule' && AT_RULE_NESTED.indexOf(node.name) >= 0 && node.body) {
      node.children = parseCss(node.body).map(function (n) {
        return decodeStyleRule(n, prefix);
      });
    }
    if (node.type === 'atrule' && node.name === 'import' && node.prelude.indexOf('data:') === 0) {
      node.prelude = 'data:,';
    }
    return node;
  }

  function stringifyCss(nodes) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type === 'rule') {
        var decls = node.body
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split(';')
          .map(function (d) {
            return d.trim();
          })
          .filter(Boolean)
          .join(';');
        out += node.selector + '{' + decls + '}';
      } else if (node.type === 'atrule') {
        if (node.children) {
          out += '@' + node.name + ' ' + node.prelude + '{' + stringifyCss(node.children) + '}';
        } else if (node.body != null) {
          // @keyframes, @font-face 등은 원본 그대로 통과 (원본과 동일: 미처리)
          out += node.raw;
        } else {
          out += '@' + node.name + ' ' + node.prelude + ';';
        }
      }
    }
    return out;
  }

  // parser.svelte.ts:1005-1029
  function decodeStyleContent(hexText, ctx, scope) {
    try {
      var text = hexDecode(hexText);
      text = cbsParse(text, ctx); // CSS 안에서도 CBS 1회 (원본과 동일)
      var ast = parseCss(text);
      ast = ast.map(function (n) {
        return decodeStyleRule(n, scope);
      });
      return { css: stringifyCss(ast) };
    } catch (e) {
      return { css: undefined, fallback: ctx.returnCSSError ? 'CSS ERROR: ' + e.message : '' };
    }
  }

  // ==================================================================
  // 4. 새니타이저
  //    원본: src/ts/parser/parser.svelte.ts:783 trimPurifyConfig
  //          parser.svelte.ts:46 ~ 123 DOMPurify 훅
  //    DIFF: DOMPurify 대신 allowlist 기반 DOM 워커로 근사.
  //          허용 태그/속성/클래스 개명/href·rel 정책은 동일하게 맞춤.
  // ==================================================================

  var ADD_TAGS = [
    'iframe', 'style', 'risu-style', 'x-em', 'annotation', 'semantics',
    'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt'
  ];
  var ADD_ATTR = [
    'allow', 'allowfullscreen', 'frameborder', 'scrolling',
    'risu-btn', 'risu-ctrl', 'risu-form', 'risu-trigger', 'risu-mark',
    'risu-id', 'x-hl-lang', 'x-hl-text'
  ];

  var BASE_TAGS = (
    'a,abbr,acronym,address,area,article,aside,audio,b,bdi,bdo,big,blink,blockquote,br,' +
    'button,canvas,caption,center,cite,code,col,colgroup,data,datalist,dd,del,details,dfn,' +
    'dialog,div,dl,dt,em,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,' +
    'hgroup,hr,i,img,input,ins,kbd,label,legend,li,main,map,mark,menu,meter,nav,ol,optgroup,' +
    'option,output,p,picture,pre,progress,q,rp,rt,ruby,s,samp,section,select,slot,small,span,' +
    'strike,strong,style,sub,summary,sup,table,tbody,td,textarea,tfoot,th,thead,time,tr,tt,u,' +
    'ul,var,video,wbr,svg,g,path,rect,circle,ellipse,line,polygon,polyline,text,tspan,defs,' +
    'use,symbol,lineargradient,radialgradient,stop,clippath,mask,pattern,filter,feblend,' +
    'fecolormatrix,fecomponenttransfer,fecomposite,feconvolvematrix,fediffuselighting,' +
    'fedisplacementmap,fedistantlight,fedropshadow,feflood,fefunca,fefuncb,fefuncg,' +
    'fefuncr,fegaussianblur,feimage,femerge,femergenode,femorphology,feoffset,fepointlight,' +
    'fespecularlighting,fespotlight,fetile,feturbulence,math,menclose,mfenced,mfrac,' +
    'mglyph,mi,mlabeledtr,mmultiscripts,mn,mo,mover,mpadded,mphantom,mprescripts,mroot,' +
    'mrow,ms,mspace,msqrt,mstyle,msub,msubsup,msup,mtable,mtd,mtext,mtr,munder,munderover,' +
    'none,semantics,annotation,annotation-xml'
  )
    .split(',')
    .map(function (s) {
      return s.trim();
    });

  var ALLOWED_TAGS = new Set(BASE_TAGS.concat(ADD_TAGS));

  var BASE_ATTR = (
    'accept,action,align,alt,autocapitalize,autocomplete,autopictureinpicture,' +
    'autoplay,background,bgcolor,border,capture,cellpadding,cellspacing,checked,' +
    'cite,class,clear,color,cols,colspan,controls,controlslist,coords,crossorigin,' +
    'datetime,decoding,default,dir,disabled,disablepictureinpicture,disableremoteplayback,' +
    'download,draggable,enctype,enterkeyhint,face,for,frame,headers,height,hidden,high,' +
    'href,hreflang,id,inputmode,integrity,ismap,kind,label,lang,list,loading,loop,low,' +
    'max,maxlength,media,method,min,minlength,multiple,muted,name,nonce,noshade,novalidate,' +
    'nowrap,open,optimum,pattern,placeholder,playsinline,popover,popovertarget,' +
    'popovertargetaction,poster,preload,pubdate,radiogroup,readonly,rel,required,rev,' +
    'reversed,role,rows,rowspan,spellcheck,scope,selected,shape,size,sizes,span,srclang,' +
    'start,src,srcset,step,style,summary,tabindex,target,title,translate,type,usemap,' +
    'valign,value,width,wrap,xmlns'
  )
    .split(',')
    .map(function (s) {
      return s.trim();
    });

  var ALLOWED_ATTR = new Set(BASE_ATTR.concat(ADD_ATTR));

  function isAllowedAttr(name, tag) {
    var lower = name.toLowerCase();
    if (lower.indexOf('on') === 0) return false;
    if (ALLOWED_ATTR.has(lower)) return true;
    if (lower.indexOf('data-') === 0) return true;
    if (lower.indexOf('aria-') === 0) return true;
    if (lower.indexOf('x-') === 0) return true;
    // SVG 관련 소문자/대소문자 속성
    var svgAttrs = ['viewbox', 'd', 'fill', 'stroke', 'stroke-width', 'cx', 'cy', 'r', 'x', 'y',
      'x1', 'x2', 'y1', 'y2', 'points', 'transform', 'opacity', 'stop-color', 'offset',
      'gradientunits', 'gradienttransform', 'preserveaspectratio', 'xmlns:xlink', 'xlink:href'];
    if (svgAttrs.indexOf(lower) >= 0) return true;
    return false;
  }

  function sanitizeHref(v) {
    return /^https?:\/\//i.test(v);
  }

  function sanitizeHtml(html, ctx) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var root = tpl.content;

    (function walk(parent) {
      var children = Array.prototype.slice.call(parent.childNodes);
      for (var i = 0; i < children.length; i++) {
        var node = children[i];
        if (node.nodeType === 1) {
          var tag = node.tagName.toLowerCase();

          if (tag === 'iframe') {
            var src = node.getAttribute('src') || '';
            if (src.indexOf('https://www.youtube.com/embed/') !== 0) {
              parent.removeChild(node);
              continue;
            }
          }

          if (!ALLOWED_TAGS.has(tag)) {
            if (tag === 'script' || tag === 'object' || tag === 'embed' || tag === 'base' || tag === 'link') {
              parent.removeChild(node);
              continue;
            }
            // 태그는 벗기고 자식은 살린다
            var frag = document.createDocumentFragment();
            while (node.firstChild) frag.appendChild(node.firstChild);
            parent.replaceChild(frag, node);
            walk(parent);
            continue;
          }

          // 속성 정리
          var attrs = Array.prototype.slice.call(node.attributes);
          for (var a = 0; a < attrs.length; a++) {
            var attr = attrs[a];
            var an = attr.name.toLowerCase();
            if (!isAllowedAttr(an, tag)) {
              node.removeAttribute(attr.name);
              continue;
            }
            if (an === 'class') {
              var cls = attr.value
                .split(/\s+/)
                .filter(Boolean)
                .map(function (c) {
                  if (c.indexOf('hljs') === 0) return c;
                  if (c.indexOf('x-risu-') === 0) return c;
                  return 'x-risu-' + c;
                })
                .join(' ');
              node.setAttribute('class', cls);
            } else if (an === 'href') {
              if (sanitizeHref(attr.value)) {
                node.setAttribute('target', '_blank');
              } else {
                node.setAttribute('href', '');
              }
            } else if (an === 'rel') {
              node.setAttribute('rel', 'noopener noreferrer');
            } else if (an === 'src') {
              var v = attr.value;
              var isMedia = ['img', 'source', 'video', 'audio', 'style'].indexOf(tag) >= 0;
              if (isMedia && (v.indexOf('blob:') === 0 || v.indexOf('asset:') === 0)) {
                // 유지
              } else if (v.indexOf('data:') === 0 || /^https?:\/\//i.test(v) || v.indexOf('/') === 0) {
                // 유지
              } else if (v) {
                node.removeAttribute('src');
              }
            }
          }

          if (tag === 'a') {
            node.setAttribute('rel', 'noopener noreferrer');
          }

          walk(node);
        }
      }
    })(root);

    return tpl.innerHTML;
  }

  // parser.svelte.ts:809-856 trimMarkdown
  function trimMarkdown(html, ctx, scope) {
    if (!html) return '';
    if (html.indexOf('<risu-style') < 0) {
      return sanitizeHtml(html, ctx);
    }

    var tpl = document.createElement('template');
    tpl.innerHTML = sanitizeHtml(html, ctx);
    var root = tpl.content;

    var styles = Array.prototype.slice.call(root.querySelectorAll('risu-style'));
    for (var i = 0; i < styles.length; i++) {
      var el = styles[i];
      var decoded = decodeStyleContent(el.textContent || '', ctx, scope);
      if (decoded.css === undefined) {
        el.replaceWith(document.createTextNode(decoded.fallback || ''));
        continue;
      }
      var style = document.createElement('style');
      style.textContent = decoded.css.replaceAll(/<\/(?=style)/gi, '<\\/');
      el.replaceWith(style);
    }

    var wrapper = document.createElement('div');
    wrapper.appendChild(root);
    return wrapper.innerHTML;
  }

  // ==================================================================
  // 5. 미니 마크다운 (markdown-it 근사)
  //    DIFF: markdown-it 대신 최소 구현. html:true / breaks:true 동작만 재현.
  // ==================================================================

  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  }

  function renderMarkdown(src) {
    var lines = String(src).replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      // 펜스 코드
      var fence = line.match(/^```\s*([\w+-]*)\s*$/);
      if (fence) {
        var lang = fence[1];
        var code = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++;
        out.push('<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' + escapeHtml(code.join('\n')) + '</code></pre>');
        continue;
      }

      if (!line.trim()) {
        i++;
        continue;
      }

      // 원시 HTML 블록 (html:true)
      if (/^\s*</.test(line)) {
        var block = [line];
        i++;
        while (i < lines.length && lines[i].trim()) {
          block.push(lines[i]);
          i++;
        }
        out.push(block.join('\n'));
        continue;
      }

      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        out.push('<h' + h[1].length + '>' + inlineMd(h[2]) + '</h' + h[1].length + '>');
        i++;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push('<li>' + inlineMd(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        var oitems = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          oitems.push('<li>' + inlineMd(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol>' + oitems.join('') + '</ol>');
        continue;
      }

      var para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\s*</.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p>' + inlineMd(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }
    return out.join('\n');
  }

  // ==================================================================
  // 6. 진입점
  // ==================================================================

  async function run(config) {
    var ctx = {
      vars: Object.assign({}, config.vars || {}),
      globalVars: Object.assign({}, config.globalVars || {}),
      charName: config.charName || 'Char',
      userName: config.userName || 'User',
      role: config.role || '',
      prevMessage: config.prevMessage || '',
      mainprompt: config.mainprompt || '',
      jb: config.jb || '',
      globalnote: config.globalnote || '',
      returnCSSError: true,
      unsupported: new Set(),
      stopSending: false,
      chat: Array.isArray(config.chat)
        ? config.chat.map(function (m) {
            return { role: m.role, data: m.data != null ? m.data : m.content };
          })
        : [{ role: 'char', data: config.input || '' }]
    };

    var char = { customscript: config.charRegex || [] };
    var mode = config.mode || 'editdisplay';
    var assetNames = (config.assets && config.assets.assetNames) || [];
    var maxDiff = config.assets && config.assets.maxDifference != null ? config.assets.maxDifference : 4;

    async function runTriggerPass(passMode) {
      if (!window.RisuTrigger) return null;
      var runner = window.RisuTrigger.create(ctx, {
        charTriggers: allTriggers(config),
        moduleTriggers: [],
        chat: ctx.chat
      });
      var r = await runner.run(passMode);
      ctx.chat = r.chat;
      return r;
    }

    // 입력/프롬프트 단계 트리거는 processScriptFull 바깥에서 먼저 실행된다
    //   editinput   ↔ runTrigger('input')   (DefaultChatScreen.svelte:187)
    //   editprocess ↔ runTrigger('start')   (index.svelte.ts:888)
    var preTrace = [];
    if (mode === 'editinput' || mode === 'editprocess') {
      var passName = mode === 'editinput' ? 'input' : 'start';
      var preRun = await runTriggerPass(passName);
      if (preRun) {
        var preFired = preRun.trace.filter(function (x) { return !x.skipped; }).length;
        preTrace.push({
          stage: '⓪ 트리거(' + passName + ')',
          detail: 'runTrigger("' + passName + '") — 트리거 ' + preRun.trace.length + '개 중 ' + preFired + '개 발화',
          triggerTrace: preRun.trace
        });
      }
    }

    // ParseMarkdown 순서 재현: 자산 해석 → processScriptFull → 자산 해석(2차)
    //   parser.svelte.ts:740-780
    var pipelineInput = config.input || '';
    var preAsset = null;
    if (mode === 'editdisplay' && assetNames.length > 0) {
      var resolvedPre = resolveAssetTags(pipelineInput, assetNames, maxDiff);
      if (resolvedPre !== pipelineInput) {
        preAsset = { before: pipelineInput, after: resolvedPre };
      }
      pipelineInput = resolvedPre;
    }

    // --- ① ~ ⑥ 텍스트 단계 ---
    var textResult = await processScriptFull(
      {
        ctx: ctx,
        presetRegex: config.presetRegex || [],
        moduleRegex: config.moduleRegex || [],
        charLua: config.charLua || [],
        moduleLua: config.moduleLua || [],
        assets: config.assets || null,
        charTriggers: config.charTriggers || [],
        moduleTriggers: config.moduleTriggers || []
      },
      char,
      pipelineInput,
      mode
    );

    var finalText = textResult.data;

    // 출력 트리거 (index.svelte.ts:1763, 1871)
    if (mode === 'editoutput') {
      var outRun = await runTriggerPass('output');
      if (outRun) {
        var outFired = outRun.trace.filter(function (x) { return !x.skipped; }).length;
        textResult.trace.push({
          stage: '⑦ 트리거(output)',
          detail: 'runTrigger("output") — 트리거 ' + outRun.trace.length + '개 중 ' + outFired + '개 발화',
          triggerTrace: outRun.trace,
          skipped: outRun.trace.length === 0
        });
      }
    }

    if (preTrace.length) textResult.trace = preTrace.concat(textResult.trace);

    if (mode === 'editdisplay') {
      if (preAsset) {
        textResult.trace.unshift({
          stage: '⓪ 자산 해석 (1차)',
          detail: 'parseAdditionalAssets — editdisplay 이전에 실행됨 (parser.svelte.ts:752)',
          before: preAsset.before,
          after: preAsset.after
        });
      }
      var resolvedPost = resolveAssetTags(finalText, assetNames, maxDiff);
      if (resolvedPost !== finalText) {
        textResult.trace.push({
          stage: '⑥-b 자산 해석 (2차)',
          detail: 'editdisplay 결과에 새로 생긴 태그를 해석 (parser.svelte.ts:762-766)',
          before: finalText,
          after: resolvedPost
        });
        finalText = resolvedPost;
      }
    }

    // --- 표시 단계 ---
    function renderForDisplay(text) {
      // encodeStyle 은 순수 문자열 변환이라 DOM 없이도 가능하다
      var encodedNoDom = encodeStyle(text);
      // Node(테스트) 환경에는 DOM 이 없다 → 스코프/markdown 없이 텍스트만 돌려준다
      if (typeof document === 'undefined') {
        return { encoded: encodedNoDom, markdown: text, html: escapeHtml(text), css: '' };
      }
      var encoded = encodedNoDom;
      var md = config.markdown === false ? text : renderMarkdown(encoded);
      var html = trimMarkdown(md, ctx);
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      var cssText = Array.prototype.slice
        .call(tpl.content.querySelectorAll('style'))
        .map(function (s) {
          return s.textContent;
        })
        .join('\n');
      return { encoded: encoded, markdown: md, html: html, css: cssText };
    }

    var display = null;
    if (mode === 'editdisplay') {
      display = renderForDisplay(finalText);
    } else if (mode === 'editoutput') {
      // 실제 앱에서는 이 텍스트가 저장된 뒤 표시 단계를 한 번 더 거친다.
      // 그 왕복을 미리보기로 보여준다 (자산 해석 + CSS 스코프 포함).
      var shown = resolveAssetTags(finalText, assetNames, maxDiff);
      display = renderForDisplay(shown);
      display.note = '출력 결과를 표시 단계(자산 해석 → markdown → DOMPurify → CSS 스코프)에 통과시킨 미리보기';
    } else {
      display = {
        encoded: finalText,
        markdown: finalText,
        html: escapeHtml(finalText).replace(/\n/g, '<br>'),
        css: ''
      };
    }

    return {
      trace: textResult.trace,
      finalText: finalText,
      display: display,
      varsAfter: ctx.vars,
      globalVarsAfter: ctx.globalVars,
      chatAfter: ctx.chat,
      scriptstateAfter: ctx.scriptstate || {},
      unsupported: Array.from(ctx.unsupported),
      luaStatus: window.RisuLua ? window.RisuLua.status() : { state: 'absent' }
    };
  }

  // ==================================================================
  // 7. 표시 단계 단독 실행 (트레이스의 After 미리보기용)
  // ==================================================================

  function makeDisplayCtx(o) {
    return {
      vars: Object.assign({}, o.vars || {}),
      globalVars: Object.assign({}, o.globalVars || {}),
      charName: o.charName || 'Char',
      userName: o.userName || 'User',
      role: o.role || '',
      prevMessage: o.prevMessage || '',
      mainprompt: '',
      jb: '',
      globalnote: '',
      returnCSSError: true,
      unsupported: new Set(),
      stopSending: false,
      chat: [{ role: 'char', data: '' }]
    };
  }

  /**
   * 임의의 텍스트를 "표시 단계"에 통과시킨다.
   *   자산 태그 해석(선택) → encodeStyle → markdown → DOMPurify(근사) → CSS 스코프
   *
   * @param {string} text
   * @param {{markdown?:boolean, scope?:string, assets?:string[], maxDifference?:number, expandCbs?:boolean,
   *          charName?:string, userName?:string, vars?:object, globalVars?:object,
   *          prevMessage?:string, resolveAssets?:boolean}} [opts]
   * @returns {{html:string, css:string, encoded:string, markdown:string}}
   */
  function renderDisplay(text, opts) {
    opts = opts || {};
    var src = String(text == null ? '' : text);
    var ctx = opts.ctx || makeDisplayCtx(opts);

    // 중간 단계의 after 에는 아직 {{char}} 같은 CBS 가 남아 있다.
    // 미리보기용으로 강제 전개하고 싶을 때 expandCbs:true.
    if (opts.expandCbs) {
      try {
        src = cbsParse(src, ctx);
      } catch (e) {
        /* CBS 오류는 무시하고 원문 유지 */
      }
    }

    // 자산 태그: 이름 목록을 주면 {{asset::x}} 류를 자리표시자로 바꾼다
    if (opts.resolveAssets !== false && opts.assets && opts.assets.length) {
      src = resolveAssetTags(src, opts.assets, opts.maxDifference == null ? 4 : opts.maxDifference);
    }

    var encoded = encodeStyle(src);
    var md = opts.markdown === false ? src : renderMarkdown(encoded);

    if (typeof document === 'undefined') {
      return { html: escapeHtml(src).replace(/\n/g, '<br>'), css: '', encoded: encoded, markdown: md };
    }

    var html = trimMarkdown(md, ctx, opts.scope);

    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var css = Array.prototype.slice
      .call(tpl.content.querySelectorAll('style'))
      .map(function (s) {
        return s.textContent;
      })
      .join('\n');

    return { html: html, css: css, encoded: encoded, markdown: md };
  }

  window.RisuSim = {
    run: run,
    renderDisplay: renderDisplay,
    encodeStyle: encodeStyle,
    trimMarkdown: trimMarkdown,
    _internal: { cbsParse: cbsParse, resolveAssetTags: resolveAssetTags }
  };
})();

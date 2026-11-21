/*
 * RisuAI 파이프라인 시뮬레이터 — 트리거(Trigger) VM
 * ------------------------------------------------------------------
 * 원본: src/ts/process/triggers.ts:1058 runTrigger()
 *       조건 평가   :1212-1330
 *       effect 루프 :1331-...
 *       v2If/Else/EndIndent/Loop : 1627-1837
 *
 * 원본과 동일하게 구현한 것
 *   - effect[0] === 'triggerlua' 이면 trigger.type 필터를 건너뛴다 (triggers.ts:1238)
 *   - display/request 패스는 allowlist 만 실행 (triggers.ts:1331-1338)
 *   - 재귀 깊이 10, lowLevelAccess 는 무제한
 *   - v2StopTrigger → index = effect.length
 *   - v2If false → 같은 indent 의 v2Else/v2EndIndent 로 점프
 *   - v2EndIndent(endOfLoop) → 카운터/조건에 따라 v2Loop 로 회귀
 *   - displayMode 에서 setVar 는 tempVars 에만 기록(저장 안 함)
 *
 * 근사/미지원
 *   - runLLM / imgGen / similarity / command / lorebook CRUD / alert → 스텁 + 배지
 *   - v2Calculate 는 자체 산술 파서(원본 calcString 대체)
 */
(function () {
  'use strict';

  // triggers.ts:975-1021
  var SAFE_SUBSET = [
    'v2SetVar', 'v2If', 'v2IfAdvanced', 'v2Else', 'v2EndIndent', 'v2LoopNTimes', 'v2BreakLoop',
    'v2ConsoleLog', 'v2StopTrigger', 'v2Random', 'v2ExtractRegex', 'v2RegexTest',
    'v2GetCharAt', 'v2GetCharCount', 'v2ToLowerCase', 'v2ToUpperCase', 'v2SetCharAt',
    'v2SplitString', 'v2JoinArrayVar', 'v2ConcatString', 'v2MakeArrayVar', 'v2GetArrayVarLength',
    'v2GetArrayVar', 'v2SetArrayVar', 'v2PushArrayVar', 'v2PopArrayVar', 'v2ShiftArrayVar',
    'v2UnshiftArrayVar', 'v2SpliceArrayVar', 'v2SliceArrayVar', 'v2GetIndexOfValueInArrayVar',
    'v2RemoveIndexFromArrayVar', 'v2Calculate', 'v2Comment', 'v2DeclareLocalVar'
  ];

  // triggers.ts:1023-1036
  var DISPLAY_ALLOW = ['v2GetDisplayState', 'v2SetDisplayState'].concat(SAFE_SUBSET);
  var REQUEST_ALLOW = [
    'v2GetRequestState', 'v2SetRequestState', 'v2GetRequestStateRole',
    'v2SetRequestStateRole', 'v2GetRequestStateLength'
  ].concat(SAFE_SUBSET);

  var UNSUPPORTED = [
    'runLLM', 'v2RunLLM', 'imgGen', 'v2ImgGen', 'checkSimilarity', 'v2CheckSimilarity',
    'command', 'v2Command', 'showAlert', 'v2ShowAlert', 'sendAIprompt', 'v2SendAIprompt',
    'impersonate', 'v2Impersonate', 'v2QuickSearchChat', 'v2Tokenize', 'v2Wait',
    'v2UpdateGUI', 'v2UpdateChatAt', 'v2ModifyLorebook', 'v2GetLorebook', 'v2GetLorebookCount',
    'v2GetLorebookEntry', 'v2SetLorebookActivation', 'v2GetLorebookIndexViaName',
    'v2CreateLorebook', 'v2ModifyLorebookByIndex', 'v2DeleteLorebookByIndex',
    'v2GetLorebookCountNew', 'v2SetLorebookAlwaysActive', 'v2GetAllLorebooks',
    'v2GetLorebookByName', 'v2GetLorebookByIndex', 'v2GetAlertInput', 'v2GetAlertSelect',
    'v2GetCharacterDesc', 'v2SetCharacterDesc', 'v2GetPersonaDesc', 'v2SetPersonaDesc',
    'v2GetReplaceGlobalNote', 'v2SetReplaceGlobalNote', 'v2GetAuthorNote', 'v2SetAuthorNote',
    'v2GetFirstMessage', 'v2GetPersonaDesc', 'v2GetLastUserMessage', 'v2GetLastCharMessage',
    'v2GetLastMessage', 'v2GetMessageAtIndex', 'v2GetMessageCount'
  ];

  // ---- 산술 파서 (calcString 근사) ----
  function calcExpression(src) {
    var s = String(src).replace(/\s+/g, '');
    var i = 0;
    function peek() {
      return s.charAt(i);
    }
    function expr() {
      var v = term();
      while (peek() === '+' || peek() === '-') {
        var op = s.charAt(i++);
        var r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function term() {
      var v = unary();
      while (peek() === '*' || peek() === '/' || peek() === '%') {
        var op = s.charAt(i++);
        var r = unary();
        if (op === '*') v = v * r;
        else if (op === '/') v = v / r;
        else v = v % r;
      }
      return v;
    }
    function unary() {
      if (peek() === '-') {
        i++;
        return -unary();
      }
      if (peek() === '+') {
        i++;
        return unary();
      }
      return power();
    }
    function power() {
      var base = atom();
      if (peek() === '^') {
        i++;
        return Math.pow(base, power());
      }
      return base;
    }
    function atom() {
      if (peek() === '(') {
        i++;
        var v = expr();
        if (peek() === ')') i++;
        return v;
      }
      var start = i;
      while (i < s.length && /[0-9.eE]/.test(s.charAt(i))) i++;
      if (start === i) throw new Error('수식 오류: ' + s);
      return parseFloat(s.slice(start, i));
    }
    var out = expr();
    if (i < s.length) throw new Error('수식 오류: 남은 문자 ' + s.slice(i));
    return out;
  }

  /**
   * 트리거 러너 생성. 한 번의 패스에서 상태(trace, 로그)를 공유한다.
   */
  function create(ctx, opts) {
    opts = opts || {};

    var charTriggers = (opts.charTriggers || []).slice();
    var moduleTriggers = opts.moduleTriggers || []; // 이미 모듈 순서로 정렬되어 전달됨
    var triggers = charTriggers.concat(moduleTriggers); // triggers.ts:1081-1084

    var scriptstate = ctx.scriptstate || (ctx.scriptstate = {});
    // triggers.ts:1086 parseKeyValue(char.defaultVariables).concat(parseKeyValue(db.templateDefaultVariables))
    var defaultVariables = opts.defaultVariables ||
      window.RisuCBS.parseKeyValue(ctx.defaultVariables || '').concat(window.RisuCBS.parseKeyValue(ctx.templateDefaultVariables || ''));
    var logs = [];        // console.log 대체
    var trace = [];       // 트리거별 실행 기록
    var chat = opts.chat || ctx.chat || [];
    var additonalSysPrompt = { start: '', historyend: '', promptend: '' };
    var stopSending = false;
    var sendAIprompt = false;
    var displayData = opts.displayData != null ? opts.displayData : null;
    var displayMode = !!opts.displayMode;
    var tempVars = {};
    var localVars = [];
    var currentIndent = 0;
    var recursion = opts.recursiveCount || 0;

    // risuChatParser(x, { chara: char }) — 같은 변수 저장소(ctx.scriptstate)를 본다
    function cbs(str) {
      if (str == null) return '';
      return window.RisuCBS.parse(String(str), ctx, {});
    }

    function getLocalVar(key) {
      for (var i = localVars.length - 1; i >= 0; i--) {
        if (localVars[i].key === key) return localVars[i].value;
      }
      return null;
    }
    function declareLocalVar(key, value, indent) {
      localVars.push({ indent: indent, key: key, value: value });
    }
    function setLocalVar(key, value) {
      for (var i = localVars.length - 1; i >= 0; i--) {
        if (localVars[i].key === key) {
          localVars[i].value = value;
          return true;
        }
      }
      return false;
    }
    function clearLocalVarsAtIndent(indent) {
      localVars = localVars.filter(function (v) {
        return v.indent < indent;
      });
    }

    // triggers.ts:1180 getVar
    function getVar(key) {
      var local = getLocalVar(key);
      if (local !== null) return local;

      var state = scriptstate['$' + key];
      if (state === undefined || state === null) {
        var found = null;
        for (var i = 0; i < defaultVariables.length; i++) {
          if (defaultVariables[i][0] === key) {
            found = defaultVariables[i][1];
            break;
          }
        }
        if (found != null) return found;
        if (displayMode) {
          return tempVars[key] != null ? tempVars[key] : 'null';
        }
        return 'null';
      }
      return String(state);
    }

    // triggers.ts:1199 setVar
    function setVar(key, value) {
      if (displayMode) {
        if (tempVars[key] === value) return false;
        tempVars[key] = value;
        return true;
      }
      if (setLocalVar(key, value)) return true;
      var stateKey = '$' + key;
      if (scriptstate[stateKey] === value) return false;
      scriptstate[stateKey] = value;
      return true;
    }

    // effect 의 'var'|'value' 필드 해석
    function val(effect, name, typeField) {
      var raw = effect[name];
      var isVar = effect[(typeField || name + 'Type') || ''] === 'var';
      if (isVar) return getVar(cbs(raw));
      return cbs(raw);
    }
    function num(effect, name, typeField) {
      var n = Number(val(effect, name, typeField));
      return isNaN(n) ? 0 : n;
    }
    function arrOf(varName) {
      try {
        var parsed = JSON.parse(getVar(varName));
        return Array.isArray(parsed) ? parsed : null;
      } catch (e) {
        return null;
      }
    }

    // ---- 조건 평가 (triggers.ts:1212-1330) ----
    function evalConditions(trigger) {
      var results = [];
      var pass = true;
      var conds = trigger.conditions || [];
      for (var i = 0; i < conds.length; i++) {
        var condition = conds[i];
        var ok = true;

        if (condition.type === 'var' || condition.type === 'chatindex' || condition.type === 'value') {
          var varValue =
            condition.type === 'var'
              ? getVar(condition.var)
              : condition.type === 'chatindex'
                ? String(chat.length)
                : condition.var;

          var condValue = cbs(condition.value);
          varValue = cbs(varValue);

          switch (condition.operator) {
            case 'true':
              ok = varValue === 'true' || varValue === '1';
              break;
            case 'null':
              ok = varValue === 'null' || varValue === '';
              break;
            case '=':
              ok = varValue === condValue;
              break;
            case '!=':
              ok = varValue !== condValue;
              break;
            case '>':
              ok = !(Number(varValue) <= Number(condValue));
              break;
            case '<':
              ok = !(Number(varValue) >= Number(condValue));
              break;
            case '>=':
              ok = !(Number(varValue) < Number(condValue));
              break;
            case '<=':
              ok = !(Number(varValue) > Number(condValue));
              break;
            default:
              ok = false;
          }
          results.push({ type: condition.type, var: condition.var, operator: condition.operator, value: varValue, expect: condValue, pass: ok });
        } else if (condition.type === 'exists') {
          var cv = cbs(condition.value);
          var target = cbs(cv);
          var depth = condition.depth || 1;
          var hay = chat
            .slice(-depth)
            .map(function (m) {
              return m.data;
            })
            .join(' ');
          if (condition.type2 === 'strict') ok = hay.split(' ').indexOf(target) >= 0;
          else if (condition.type2 === 'loose') ok = hay.toLowerCase().indexOf(String(target).toLowerCase()) >= 0;
          else if (condition.type2 === 'regex') {
            try {
              ok = new RegExp(target).test(hay);
            } catch (e) {
              ok = false;
            }
          } else ok = false;
          results.push({ type: 'exists', mode: condition.type2, value: target, pass: ok });
        } else {
          ok = false;
          results.push({ type: condition.type, pass: false, unknown: true });
        }

        if (!ok) {
          pass = false;
          break;
        }
      }
      return { pass: pass, results: results };
    }

    // ---- effect 실행 ----
    async function runEffectLoop(trigger, entry) {
      var effects = trigger.effect || [];
      var mode = entry.mode;
      var isLow = !!trigger.lowLevelAccess;
      var executedEffects = [];

      for (var index = 0; index < effects.length; index++) {
        var effect = effects[index];
        if (!effect) continue;

        if (mode === 'display' && DISPLAY_ALLOW.indexOf(effect.type) < 0) {
          executedEffects.push({ index: index, type: effect.type, skipped: 'display allowlist 밖' });
          continue;
        }
        if (mode === 'request' && REQUEST_ALLOW.indexOf(effect.type) < 0) {
          executedEffects.push({ index: index, type: effect.type, skipped: 'request allowlist 밖' });
          continue;
        }
        if (UNSUPPORTED.indexOf(effect.type) >= 0) {
          executedEffects.push({ index: index, type: effect.type, skipped: '미지원 effect (스텁)' });
          continue;
        }

        if (typeof effect.indent === 'number' && effect.indent >= 0) {
          currentIndent = effect.indent;
        } else if (!('indent' in effect)) {
          currentIndent = 0;
        }

        var detail = null;
        try {
          switch (effect.type) {
            case 'v2Comment':
            case 'v2Header':
              break;

            case 'v2SetVar': {
              var key = cbs(effect.var);
              var original = Number(getVar(key));
              if (isNaN(original)) original = 0;
              var ev = cbs(effect.value);
              var result;
              switch (effect.operator) {
                case '=': result = ev; break;
                case '+=': result = String(original + Number(ev)); break;
                case '-=': result = String(original - Number(ev)); break;
                case '*=': result = String(original * Number(ev)); break;
                case '/=': result = String(original / Number(ev)); break;
                case '%=': result = String(original % Number(ev)); break;
                default: result = ev;
              }
              setVar(key, result);
              detail = key + ' = ' + result;
              break;
            }

            case 'v2DeclareLocalVar': {
              var dval = effect.valueType === 'value' ? cbs(effect.value) : getVar(cbs(effect.value));
              var dkey = cbs(effect.var);
              declareLocalVar(dkey, dval == null ? 'null' : dval, effect.indent);
              detail = 'local ' + dkey + ' = ' + (dval == null ? 'null' : dval);
              break;
            }

            case 'v2If':
            case 'v2IfAdvanced': {
              var sourceValue = effect.type === 'v2If' || effect.sourceType === 'var'
                ? getVar(cbs(effect.source))
                : cbs(effect.source);
              var targetValue = effect.targetType === 'value' ? cbs(effect.target) : getVar(cbs(effect.target));
              var pass = false;
              switch (effect.condition) {
                case '=':
                  if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) pass = Number(sourceValue) === Number(targetValue);
                  else pass = sourceValue === targetValue;
                  break;
                case '!=':
                  if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) pass = Number(sourceValue) !== Number(targetValue);
                  else pass = sourceValue !== targetValue;
                  break;
                case '>': pass = Number(sourceValue) > Number(targetValue); break;
                case '<': pass = Number(sourceValue) < Number(targetValue); break;
                case '>=': pass = Number(sourceValue) >= Number(targetValue); break;
                case '<=': pass = Number(sourceValue) <= Number(targetValue); break;
                case '∈':
                  try { pass = JSON.parse(targetValue).indexOf(sourceValue) >= 0; } catch (e) { pass = false; }
                  break;
                case '∋':
                  try { pass = JSON.parse(sourceValue).indexOf(targetValue) >= 0; } catch (e) { pass = false; }
                  break;
                case '∉':
                  try { pass = JSON.parse(targetValue).indexOf(sourceValue) < 0; } catch (e) { pass = true; }
                  break;
                case '∌':
                  try { pass = JSON.parse(sourceValue).indexOf(targetValue) < 0; } catch (e) { pass = true; }
                  break;
                case '≒': {
                  var n1 = Number(sourceValue);
                  var n2 = Number(targetValue);
                  if (isNaN(n1) || isNaN(n2)) {
                    pass = String(sourceValue).toLowerCase().replace(/ /g, '') === String(targetValue).toLowerCase().replace(/ /g, '');
                  } else {
                    pass = Math.abs(n1 - n2) < 0.0001;
                  }
                  break;
                }
                case '≡':
                  if (targetValue === 'true') pass = sourceValue === 'true' || sourceValue === '1';
                  else if (targetValue === 'false') pass = !(sourceValue === 'true' || sourceValue === '1');
                  else pass = sourceValue === targetValue;
                  break;
                default: pass = false;
              }
              detail = 'if ' + sourceValue + ' ' + effect.condition + ' ' + targetValue + ' → ' + (pass ? 'true' : 'false');

              if (!pass) {
                // triggers.ts:1737-1754
                var indent = effect.indent + 1;
                for (; index < effects.length; index++) {
                  var ef = effects[index];
                  if (ef && ef.type === 'v2EndIndent' && indent === ef.indent) {
                    var nextEf = effects[index + 1];
                    indent--;
                    if (nextEf && nextEf.type === 'v2Else' && nextEf.indent === indent) index++;
                    break;
                  }
                }
              }
              break;
            }

            case 'v2Else': {
              // triggers.ts:1756-1766
              var elseIndent = effect.indent + 1;
              for (; index < effects.length; index++) {
                var ef2 = effects[index];
                if (ef2 && ef2.type === 'v2EndIndent' && elseIndent === ef2.indent) break;
              }
              break;
            }

            case 'v2EndIndent': {
              if (effect.endOfLoop) {
                // triggers.ts:1768-1786
                var loopIndent = effect.indent - 1;
                var originalIndex = index;
                for (; index >= 0; index--) {
                  var lef = effects[index];
                  if ((lef.type === 'v2Loop' || lef.type === 'v2LoopNTimes') && loopIndent === lef.indent) {
                    if (lef.type === 'v2LoopNTimes') {
                      var times = Number(lef.valueType === 'value' ? cbs(lef.value) : getVar(cbs(lef.value)));
                      if (isNaN(times)) times = 0;
                      var counterKey = index + 'LoopNTimes';
                      tempVars[counterKey] = (tempVars[counterKey] || 0) + 1;
                      if (tempVars[counterKey] >= times) index = originalIndex;
                      else break;
                    }
                    break;
                  }
                }
                tempVars.loopTimes = (tempVars.loopTimes || 0) + 1;
                detail = 'loop end (반복 ' + tempVars.loopTimes + ')';
              }
              clearLocalVarsAtIndent(effect.indent);
              break;
            }

            case 'v2Loop':
            case 'v2LoopNTimes':
              // 반복 자체는 v2EndIndent 가 처리한다
              detail = 'loop 시작';
              break;

            case 'v2BreakLoop': {
              for (; index < effects.length; index++) {
                var bef = effects[index];
                if (bef && bef.type === 'v2EndIndent' && bef.endOfLoop) break;
              }
              detail = 'break';
              break;
            }

            case 'v2StopTrigger':
              index = effects.length;
              detail = '트리거 중단';
              break;

            case 'v2ConsoleLog':
              logs.push(String(val(effect, 'source')));
              detail = 'log: ' + String(val(effect, 'source')).slice(0, 80);
              break;

            case 'v2Random': {
              var min = num(effect, 'min');
              var max = num(effect, 'max');
              var rv = Math.floor(Math.random() * (max - min + 1)) + min;
              setVar(cbs(effect.outputVar), String(rv));
              detail = 'random ' + min + '..' + max + ' → ' + rv;
              break;
            }

            case 'v2Calculate': {
              var exprSrc = effect.expressionType === 'value' ? cbs(effect.expression) : getVar(cbs(effect.expression));
              var resolved = String(exprSrc).replace(/\$([a-zA-Z0-9_]+)/g, function (_, name) {
                var v = parseFloat(getVar(name));
                return isNaN(v) ? '0' : String(v);
              });
              var calcResult;
              try {
                calcResult = calcExpression(resolved);
              } catch (e) {
                calcResult = NaN;
              }
              var outVal = isNaN(calcResult) ? '0' : String(calcResult);
              setVar(cbs(effect.outputVar), outVal);
              detail = resolved + ' = ' + outVal;
              break;
            }

            case 'v2RegexTest': {
              try {
                var rv2 = effect.valueType === 'value' ? cbs(effect.value) : getVar(cbs(effect.value));
                var rp = effect.regexType === 'value' ? cbs(effect.regex) : getVar(cbs(effect.regex));
                var rf = effect.flagsType === 'value' ? cbs(effect.flags) : getVar(cbs(effect.flags));
                var re = new RegExp(rp, rf || '');
                setVar(cbs(effect.outputVar), re.test(rv2) ? '1' : '0');
                detail = 'regexTest → ' + (re.test(rv2) ? '1' : '0');
              } catch (e) {
                setVar(cbs(effect.outputVar), '0');
              }
              break;
            }

            case 'v2ExtractRegex': {
              try {
                var ev2 = effect.valueType === 'value' ? cbs(effect.value) : getVar(cbs(effect.value));
                var erp = effect.regexType === 'value' ? cbs(effect.regex) : getVar(cbs(effect.regex));
                var erf = effect.flagsType === 'value' ? cbs(effect.flags) : getVar(cbs(effect.flags));
                var m = new RegExp(erp, erf || '').exec(ev2);
                var resultTpl = effect.resultType === 'value' ? cbs(effect.result) : getVar(cbs(effect.result));
                var built = '';
                if (m) {
                  built = String(resultTpl).replace(/\$([0-9]+|\&)/g, function (token, g) {
                    if (g === '&') return m[0] || '';
                    var idx = parseInt(g, 10);
                    return m[idx] == null ? '' : m[idx];
                  });
                }
                setVar(cbs(effect.outputVar), built || 'null');
                detail = 'extractRegex → ' + (built || 'null');
              } catch (e) {
                setVar(cbs(effect.outputVar), 'null');
              }
              break;
            }

            case 'v2ConcatString': {
              var s1 = effect.source1Type === 'value' ? cbs(effect.source1) : getVar(cbs(effect.source1));
              var s2 = effect.source2Type === 'value' ? cbs(effect.source2) : getVar(cbs(effect.source2));
              setVar(cbs(effect.outputVar), String(s1) + String(s2));
              detail = 'concat';
              break;
            }

            case 'v2GetCharAt': {
              var gcSrc = String(val(effect, 'source'));
              var gcIdx = num(effect, 'index');
              setVar(cbs(effect.outputVar), gcSrc.charAt(gcIdx));
              break;
            }
            case 'v2GetCharCount': {
              setVar(cbs(effect.outputVar), String(String(val(effect, 'source')).length));
              break;
            }
            case 'v2ToLowerCase': {
              setVar(cbs(effect.outputVar), String(val(effect, 'source')).toLowerCase());
              break;
            }
            case 'v2ToUpperCase': {
              setVar(cbs(effect.outputVar), String(val(effect, 'source')).toUpperCase());
              break;
            }
            case 'v2SetCharAt': {
              var scSrc = String(val(effect, 'source'));
              var scIdx = num(effect, 'index');
              var scVal = String(val(effect, 'value'));
              var chars = scSrc.split('');
              chars[scIdx] = scVal;
              setVar(cbs(effect.outputVar), chars.join(''));
              break;
            }
            case 'v2SplitString': {
              var spSrc = String(val(effect, 'source'));
              var delim = cbs(effect.delimiter != null ? effect.delimiter : '');
              setVar(cbs(effect.outputVar), JSON.stringify(delim ? spSrc.split(delim) : spSrc.split('')));
              break;
            }
            case 'v2JoinArrayVar': {
              var jArr = arrOf(cbs(effect.var));
              var jDelim = cbs(effect.delimiter != null ? effect.delimiter : '');
              setVar(cbs(effect.outputVar), jArr ? jArr.join(jDelim) : 'null');
              break;
            }

            // ---- 배열 ----
            case 'v2MakeArrayVar': {
              var mkName = cbs(effect.var);
              setVar(mkName, '[]');
              detail = mkName + ' = []';
              break;
            }
            case 'v2GetArrayVarLength': {
              var la = arrOf(cbs(effect.var));
              setVar(cbs(effect.outputVar), la ? String(la.length) : 'null');
              break;
            }
            case 'v2GetArrayVar': {
              var ga = arrOf(cbs(effect.var));
              var gi = num(effect, 'index');
              setVar(cbs(effect.outputVar), ga && ga[gi] != null ? String(ga[gi]) : 'null');
              break;
            }
            case 'v2SetArrayVar': {
              var sa = arrOf(cbs(effect.var)) || [];
              var si = num(effect, 'index');
              sa[si] = val(effect, 'value');
              setVar(cbs(effect.var), JSON.stringify(sa));
              break;
            }
            case 'v2PushArrayVar': {
              var pa = arrOf(cbs(effect.var)) || [];
              pa.push(val(effect, 'value'));
              setVar(cbs(effect.var), JSON.stringify(pa));
              detail = 'push (' + pa.length + ')';
              break;
            }
            case 'v2PopArrayVar': {
              var poa = arrOf(cbs(effect.var)) || [];
              var popped = poa.pop();
              setVar(cbs(effect.var), JSON.stringify(poa));
              setVar(cbs(effect.outputVar), popped == null ? 'null' : String(popped));
              break;
            }
            case 'v2ShiftArrayVar': {
              var sha = arrOf(cbs(effect.var)) || [];
              var shifted = sha.shift();
              setVar(cbs(effect.var), JSON.stringify(sha));
              setVar(cbs(effect.outputVar), shifted == null ? 'null' : String(shifted));
              break;
            }
            case 'v2UnshiftArrayVar': {
              var ua = arrOf(cbs(effect.var)) || [];
              ua.unshift(val(effect, 'value'));
              setVar(cbs(effect.var), JSON.stringify(ua));
              break;
            }
            case 'v2SpliceArrayVar': {
              var spa = arrOf(cbs(effect.var)) || [];
              var start = num(effect, 'start');
              var item = val(effect, 'item');
              spa.splice(start, 0, item);
              setVar(cbs(effect.var), JSON.stringify(spa));
              break;
            }
            case 'v2SliceArrayVar': {
              var sla = arrOf(cbs(effect.var)) || [];
              var from = num(effect, 'start');
              var to = num(effect, 'end');
              setVar(cbs(effect.outputVar), JSON.stringify(sla.slice(from, to)));
              break;
            }
            case 'v2GetIndexOfValueInArrayVar': {
              var gia = arrOf(cbs(effect.var)) || [];
              setVar(cbs(effect.outputVar), String(gia.indexOf(val(effect, 'value'))));
              break;
            }
            case 'v2RemoveIndexFromArrayVar': {
              var ria = arrOf(cbs(effect.var)) || [];
              
              ria.splice(num(effect, 'index'), 1);
              setVar(cbs(effect.var), JSON.stringify(ria));
              break;
            }

            // ---- 표시/요청 상태 ----
            case 'v2GetDisplayState': {
              setVar(cbs(effect.outputVar), displayData == null ? 'null' : String(displayData));
              break;
            }
            case 'v2SetDisplayState': {
              displayData = effect.valueType === 'value' ? cbs(effect.value) : getVar(cbs(effect.value));
              detail = 'displayData = ' + String(displayData).slice(0, 60);
              break;
            }
            case 'v2GetRequestState': {
              try {
                var rq = JSON.parse(displayData);
                setVar(cbs(effect.outputVar), rq[num(effect, 'index')] ? String(rq[num(effect, 'index')].content) : 'null');
              } catch (e) {
                setVar(cbs(effect.outputVar), 'null');
              }
              break;
            }
            case 'v2SetRequestState': {
              try {
                var rq2 = JSON.parse(displayData);
                var ri = num(effect, 'index');
                if (rq2[ri]) rq2[ri].content = effect.valueType === 'value' ? cbs(effect.value) : getVar(cbs(effect.value));
                displayData = JSON.stringify(rq2);
              } catch (e) {}
              break;
            }
            case 'v2GetRequestStateLength': {
              try {
                setVar(cbs(effect.outputVar), String(JSON.parse(displayData).length));
              } catch (e) {
                setVar(cbs(effect.outputVar), '0');
              }
              break;
            }

            // ---- 채팅 조작 (safe) ----
            case 'setvar': {
              var sk = cbs(effect.var);
              var original2 = Number(getVar(sk));
              if (isNaN(original2)) original2 = 0;
              var ev3 = cbs(effect.value);
              var rv3 = ev3;
              if (effect.operator === '+=') rv3 = String(original2 + Number(ev3));
              else if (effect.operator === '-=') rv3 = String(original2 - Number(ev3));
              else if (effect.operator === '*=') rv3 = String(original2 * Number(ev3));
              else if (effect.operator === '/=') rv3 = String(original2 / Number(ev3));
              setVar(sk, rv3);
              detail = sk + ' = ' + rv3;
              break;
            }
            case 'v2CutChat':
            case 'cutchat': {
              var cs = effect.startType === 'value' || effect.startType === undefined ? Number(cbs(effect.start)) : Number(getVar(cbs(effect.start)));
              var ce = effect.endType === 'value' || effect.endType === undefined ? Number(cbs(effect.end)) : Number(getVar(cbs(effect.end)));
              if (isNaN(cs)) cs = 0;
              if (isNaN(ce)) ce = chat.length;
              chat = chat.slice(cs, ce);
              entry.chat = chat;
              detail = 'cutChat ' + cs + '..' + ce;
              break;
            }
            case 'v2ModifyChat':
            case 'modifychat': {
              var mi = effect.indexType === 'value' || effect.indexType === undefined ? Number(cbs(effect.index)) : Number(getVar(cbs(effect.index)));
              var mv = effect.valueType === 'value' || effect.valueType === undefined ? cbs(effect.value) : getVar(cbs(effect.value));
              if (chat[mi]) chat[mi].data = mv;
              entry.chat = chat;
              detail = 'modifyChat[' + mi + ']';
              break;
            }
            case 'v2SystemPrompt':
            case 'systemprompt': {
              var spv = effect.valueType === 'value' || effect.valueType === undefined ? cbs(effect.value) : getVar(cbs(effect.value));
              var loc = effect.location in additonalSysPrompt ? effect.location : 'start';
              additonalSysPrompt[loc] += spv + '\n\n';
              detail = 'systemPrompt(' + loc + ')';
              break;
            }
            case 'v2StopPromptSending':
            case 'stop':
              stopSending = true;
              detail = '송신 중단';
              break;

            // ---- Lua ----
            case 'triggerlua': {
              if (!window.RisuLua || !window.RisuLua.runTriggerScript) {
                detail = 'Lua 런타임 없음';
                break;
              }
              // triggers.ts:1560 — runScripted(code, { mode, setVar, getVar, chat }) → chat = result.chat
              ctx.chat = chat;
              var luaRes = await window.RisuLua.runTriggerScript(
                String(effect.code || ''),
                mode === 'manual' ? 'manual' : mode,
                entry.manualName || '',
                ctx,
                !!trigger.lowLevelAccess,
                { getVar: getVar, setVar: setVar }
              );
              chat = ctx.chat;
              if (luaRes && luaRes.stopSending) stopSending = true;
              if (luaRes && luaRes.logs && luaRes.logs.length) logs.push.apply(logs, luaRes.logs);
              detail = 'triggerlua' + (luaRes && luaRes.fn ? ' (' + luaRes.fn + ')' : '') + (luaRes && luaRes.skipped ? ' — ' + luaRes.skipped : '');
              break;
            }

            case 'runtrigger':
            case 'v2RunTrigger': {
              var target = effect.type === 'runtrigger' ? effect.value : effect.target;
              if (recursion < 10 || trigger.lowLevelAccess) {
                var sub = await run('manual', { manualName: cbs(target), recursiveCount: recursion + 1 });
                if (sub) {
                  chat = sub.chat;
                  stopSending = sub.stopSending || stopSending;
                  additonalSysPrompt = sub.additonalSysPrompt;
                }
                detail = 'runTrigger(' + cbs(target) + ')';
              } else {
                detail = 'runTrigger 깊이 초과';
              }
              break;
            }

            default:
              executedEffects.push({ index: index, type: effect.type, skipped: '미구현' });
              continue;
          }
          executedEffects.push({ index: index, type: effect.type, detail: detail });
        } catch (e) {
          executedEffects.push({ index: index, type: effect.type, error: String((e && e.message) || e) });
        }
      }

      entry.effectsRun = executedEffects;
      return { chat: chat, stopSending: stopSending, sendAIprompt: sendAIprompt, displayData: displayData };
    }

    // ---- 진입점 ----
    async function run(mode, arg) {
      arg = arg || {};
      var manualName = arg.manualName;
      var depth = arg.recursiveCount != null ? arg.recursiveCount : recursion;

      for (var t = 0; t < triggers.length; t++) {
        var trigger = triggers[t];
        var entry = {
          n: t + 1,
          comment: trigger.comment || '',
          type: trigger.type,
          mode: mode,
          manualName: manualName
        };
        tempVars = {};
        localVars = [];

        if (!trigger.effect || trigger.effect.length === 0) {
          entry.skipped = 'effect 없음';
          trace.push(entry);
          continue;
        }

        // triggers.ts:1238
        var firstType = trigger.effect[0] && trigger.effect[0].type;
        if (firstType === 'triggercode' || firstType === 'triggerlua') {
          entry.bypass = 'effect[0]=' + firstType + ' → type 필터 우회';
        } else if (manualName) {
          if (trigger.comment !== manualName) {
            entry.skipped = 'manual 이름 불일치';
            trace.push(entry);
            continue;
          }
        } else if (mode !== trigger.type) {
          entry.skipped = 'type 불일치 (' + trigger.type + ' ≠ ' + mode + ')';
          trace.push(entry);
          continue;
        }

        var cond = evalConditions(trigger);
        entry.conditions = cond.results;
        if (!cond.pass) {
          entry.skipped = '조건 불충족';
          trace.push(entry);
          continue;
        }

        try {
          var res = await runEffectLoop(trigger, entry);
          chat = res.chat;
          stopSending = res.stopSending || stopSending;
          sendAIprompt = res.sendAIprompt || sendAIprompt;
          displayData = res.displayData;
        } catch (e) {
          entry.error = String((e && e.message) || e);
        }
        entry.logs = logs.slice();
        trace.push(entry);
      }

      return {
        chat: chat,
        stopSending: stopSending,
        sendAIprompt: sendAIprompt,
        displayData: displayData,
        additionalSysPrompt: additonalSysPrompt,
        scriptstate: scriptstate,
        tempVars: tempVars,
        logs: logs,
        trace: trace
      };
    }

    return {
      run: run,
      allowlists: { display: DISPLAY_ALLOW, request: REQUEST_ALLOW, safe: SAFE_SUBSET }
    };
  }

  window.RisuTrigger = {
    create: create,
    allowlists: { display: DISPLAY_ALLOW, request: REQUEST_ALLOW, safe: SAFE_SUBSET },
    calc: calcExpression
  };
})();

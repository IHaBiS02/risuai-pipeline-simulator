const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('simulator.js', 'utf8');
const sandbox = { window: {}, console, TextEncoder, TextDecoder, Set, Map, Array, Object, String, JSON, RegExp, parseInt, parseFloat, Uint8Array };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
vm.runInContext(fs.readFileSync('trigger-runtime.js', 'utf8'), sandbox);
const sim = sandbox.window.RisuSim;

(async () => {

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got : ' + JSON.stringify(got) + '\n       want: ' + JSON.stringify(want)); }
}

console.log('\n[1] 레이어 순서 (preset → char → module)');
{
  const r = await sim.run({
    mode: 'editoutput',
    input: 'A',
    presetRegex: [{ type: 'editoutput', in: 'A', out: 'B', ableFlag: true, flag: 'g' }],
    charRegex:    [{ type: 'editoutput', in: 'B', out: 'C', ableFlag: true, flag: 'g' }],
    moduleRegex:  [{ type: 'editoutput', in: 'C', out: 'D', ableFlag: true, flag: 'g' }],
  });
  eq('A→B→C→D', r.finalText, 'D');
}

console.log('\n[2] <order N> 내림차순 정렬');
{
  // 모듈이 order 10 → 프리셋보다 먼저 실행되어야 함
  const r = await sim.run({
    mode: 'editoutput',
    input: 'x',
    presetRegex: [{ type: 'editoutput', in: 'aaa', out: 'CCC', ableFlag: true, flag: 'g,<order 0>' }],
    charRegex: [],
    moduleRegex: [{ type: 'editoutput', in: 'x', out: 'aaa', ableFlag: true, flag: 'g,<order 10>' }],
  });
  eq('module(order10) 먼저 → preset 이 결과를 잡음', r.finalText, 'CCC');
}
{
  const r = await sim.run({
    mode: 'editoutput',
    input: 'x',
    presetRegex: [{ type: 'editoutput', in: 'x', out: 'aaa', ableFlag: true, flag: 'g' }],
    charRegex: [],
    moduleRegex: [{ type: 'editoutput', in: 'aaa', out: 'BBB', ableFlag: true, flag: 'g,<order 10>' }],
  });
  eq('order 없으면 x→aaa 에서 멈춤(모듈이 먼저 못 봄)', r.finalText, 'aaa');
}

console.log('\n[3] ableFlag=false 면 <order> 무시');
{
  const r = await sim.run({
    mode: 'editoutput',
    input: 'x',
    presetRegex: [{ type: 'editoutput', in: 'aaa', out: 'CCC', ableFlag: true, flag: 'g,<order 0>' }],
    charRegex: [],
    moduleRegex: [{ type: 'editoutput', in: 'x', out: 'aaa', ableFlag: false, flag: '<order 10>' }],
  });
  eq('정렬 안 됨 → aaa', r.finalText, 'aaa');
}

console.log('\n[4] type 불일치 / 빈 in');
{
  const r = await sim.run({
    mode: 'editoutput',
    input: 'hello',
    presetRegex: [
      { type: 'editinput', in: 'hello', out: 'NOPE', ableFlag: true, flag: 'g' },
      { type: 'editoutput', in: '', out: 'NOPE', ableFlag: true, flag: 'g' },
    ],
    charRegex: [], moduleRegex: [],
  });
  eq('둘 다 스킵', r.finalText, 'hello');
}

console.log('\n[5] CBS 기본');
{
  const r = await sim.run({ mode: 'editoutput', input: '{{getvar::name}}!', vars: { name: 'Risu' } });
  eq('getvar', r.finalText, 'Risu!');
}
{
  const r = await sim.run({ mode: 'editoutput', input: '{{setvar::a::1}}{{getvar::a}}' });
  eq('setvar→getvar', r.finalText, '1');
}
{
  const r = await sim.run({
    mode: 'editoutput',
    input: '{{#when::toggle::cot}}ON{{:else}}OFF{{/when}}',
    globalVars: { toggle_cot: '1' },
  });
  eq('#when toggle ON', r.finalText, 'ON');
}
{
  const r = await sim.run({
    mode: 'editoutput',
    input: '{{#when::toggle::cot}}ON{{:else}}OFF{{/when}}',
    globalVars: { toggle_cot: '0' },
  });
  eq('#when toggle OFF', r.finalText, 'OFF');
}
{
  const r = await sim.run({
    mode: 'editoutput',
    input: '{{#if {{getvar::f}}}}Y{{:else}}N{{/if}}',
    vars: { f: '1' },
  });
  eq('#if 중첩', r.finalText, 'Y');
}

console.log('\n[6] 정규식 out 안의 CBS 재파싱');
{
  const r = await sim.run({
    mode: 'editoutput',
    input: 'X',
    presetRegex: [{ type: 'editoutput', in: 'X', out: '{{getvar::v}}', ableFlag: true, flag: 'g' }],
    vars: { v: 'Z' },
  });
  eq('out 의 CBS 전개', r.finalText, 'Z');
}

console.log('\n[7] $n / $& / $1');
{
  const r = await sim.run({
    mode: 'editoutput',
    input: 'a-b',
    presetRegex: [{ type: 'editoutput', in: '(a)-(b)', out: '$2$n$1', ableFlag: true, flag: 'g' }],
  });
  eq('그룹+개행', r.finalText, 'b\na');
}

console.log('\n[8] @@move_top');
{
  const r = await sim.run({
    mode: 'editoutput',
    input: 'AAA',
    presetRegex: [{ type: 'editoutput', in: 'AAA', out: '@@move_top HEAD', ableFlag: true, flag: 'g' }],
  });
  eq('move_top', r.finalText, 'HEAD\n' );
}

console.log('\n[9] cbs 액션 (in 에 CBS)');
{
  const r = await sim.run({
    mode: 'editoutput',
    input: 'foo',
    vars: { pat: 'foo' },
    presetRegex: [{ type: 'editoutput', in: '{{getvar::pat}}', out: 'bar', ableFlag: true, flag: 'g,<cbs>' }],
  });
  eq('in CBS', r.finalText, 'bar');
}

console.log('\n[10] 잘못된 정규식은 스킵');
{
  const r = await sim.run({
    mode: 'editoutput',
    input: 'abc',
    presetRegex: [{ type: 'editoutput', in: '([', out: 'x', ableFlag: true, flag: 'g' }],
  });
  eq('스킵', r.finalText, 'abc');
}

console.log('\n[11] #pure / #escape');
{
  const r = await sim.run({ mode: 'editoutput', input: '{{#pure}}{{getvar::x}}{{/pure}}' });
  eq('#pure 원문 유지', r.finalText, '{{getvar::x}}');
}
{
  const r = await sim.run({ mode: 'editoutput', input: '{{#escape}}{a}(b){{/escape}}' });
  eq('#escape → PUA', r.finalText, '\uE9B8a\uE9B9\uE9BAb\uE9BB');
}

console.log('\n[12] 자산 태그는 CBS 가 건드리지 않는다 (doc_only)');
{
  const r = await sim.run({ mode: 'editoutput', input: '{{image::smile_happy}}' });
  eq('image 태그 보존', r.finalText, '{{image::smile_happy}}');
}
{
  const r = await sim.run({ mode: 'editoutput', input: '{{emotion::happy}}{{bg::room}}{{raw::x}}' });
  eq('여러 자산 태그 보존', r.finalText, '{{emotion::happy}}{{bg::room}}{{raw::x}}');
}
{
  // 반대로 일반 CBS 는 정상 전개되어야 한다
  const r = await sim.run({ mode: 'editoutput', input: '{{char}}/{{image::a}}', charName: 'Risu' });
  eq('일반 CBS 는 전개, 자산 태그는 보존', r.finalText, 'Risu/{{image::a}}');
}

// ---------------- 트리거 ----------------
async function runTrig(triggers, mode, opts = {}) {
  const ctx = { vars: {}, globalVars: {}, chat: [{ role: 'char', data: 'hello' }], charName: 'C', userName: 'U', unsupported: new Set() };
  const runner = sandbox.window.RisuTrigger.create(ctx, Object.assign({
    charTriggers: triggers, moduleTriggers: [], chat: ctx.chat
  }, opts));
  const r = await runner.run(mode);
  return { r, ctx };
}
const st = (ctx, k) => ctx.scriptstate['$' + k];

console.log('\n[13] 트리거 — type 필터 / triggerlua 우회');
{
  const { r } = await runTrig([{ comment: 't', type: 'start', conditions: [], effect: [{ type: 'v2SetVar', var: 'a', operator: '=', value: '1', indent: 0 }] }], 'display');
  eq('type 불일치 → 스킵', !!r.trace[0].skipped, true);
}
{
  const { r } = await runTrig([{ comment: 't', type: 'start', conditions: [], effect: [{ type: 'triggerlua', code: 'x' }] }], 'display');
  eq('triggerlua 는 type 필터 우회', !!r.trace[0].bypass, true);
}

console.log('\n[14] 트리거 — 조건');
{
  const { r, ctx } = await runTrig([{
    comment: 'c', type: 'start', conditions: [{ type: 'value', var: 'a', operator: '=', value: 'a' }],
    effect: [{ type: 'v2SetVar', var: 'hit', operator: '=', value: '1', indent: 0 }]
  }], 'start');
  eq('조건 참 → 실행', st(ctx, 'hit'), '1');
}
{
  const { r, ctx } = await runTrig([{
    comment: 'c', type: 'start', conditions: [{ type: 'value', var: 'a', operator: '=', value: 'b' }],
    effect: [{ type: 'v2SetVar', var: 'hit', operator: '=', value: '1', indent: 0 }]
  }], 'start');
  eq('조건 거짓 → 스킵', st(ctx, 'hit'), undefined);
}

console.log('\n[15] 트리거 — v2If indent 제어');
{
  const eff = [
    { type: 'v2SetVar', var: 'x', operator: '=', value: '1', indent: 0 },
    { type: 'v2If', source: 'x', sourceType: 'var', condition: '=', target: '2', targetType: 'value', indent: 0 },
    { type: 'v2SetVar', var: 'y', operator: '=', value: 'NO', indent: 1 },
    { type: 'v2EndIndent', indent: 1 },
    { type: 'v2SetVar', var: 'z', operator: '=', value: 'OK', indent: 0 }
  ];
  const { ctx } = await runTrig([{ comment: 'i', type: 'start', conditions: [], effect: eff }], 'start');
  eq('if 거짓 → 블록 스킵', st(ctx, 'y'), undefined);
  eq('if 이후는 실행', st(ctx, 'z'), 'OK');
}
{
  const eff = [
    { type: 'v2SetVar', var: 'x', operator: '=', value: '2', indent: 0 },
    { type: 'v2If', source: 'x', sourceType: 'var', condition: '=', target: '2', targetType: 'value', indent: 0 },
    { type: 'v2SetVar', var: 'y', operator: '=', value: 'YES', indent: 1 },
    { type: 'v2EndIndent', indent: 1 }
  ];
  const { ctx } = await runTrig([{ comment: 'i', type: 'start', conditions: [], effect: eff }], 'start');
  eq('if 참 → 블록 실행', st(ctx, 'y'), 'YES');
}
{
  const eff = [
    { type: 'v2SetVar', var: 'x', operator: '=', value: '3', indent: 0 },
    { type: 'v2If', source: 'x', sourceType: 'var', condition: '=', target: '1', targetType: 'value', indent: 0 },
    { type: 'v2SetVar', var: 'a', operator: '=', value: 'A', indent: 1 },
    { type: 'v2EndIndent', indent: 1 },
    { type: 'v2Else', indent: 0 },
    { type: 'v2SetVar', var: 'b', operator: '=', value: 'B', indent: 1 },
    { type: 'v2EndIndent', indent: 1 }
  ];
  const { ctx } = await runTrig([{ comment: 'i', type: 'start', conditions: [], effect: eff }], 'start');
  eq('else 분기 실행', st(ctx, 'b'), 'B');
  eq('if 블록은 스킵', st(ctx, 'a'), undefined);
}

console.log('\n[16] 트리거 — 루프 / StopTrigger');
{
  const eff = [
    { type: 'v2MakeArrayVar', var: 'arr', indent: 0 },
    { type: 'v2LoopNTimes', value: '3', valueType: 'value', indent: 0 },
    { type: 'v2PushArrayVar', var: 'arr', value: '1', valueType: 'value', indent: 1 },
    { type: 'v2EndIndent', indent: 1, endOfLoop: true }
  ];
  const { ctx } = await runTrig([{ comment: 'l', type: 'start', conditions: [], effect: eff }], 'start');
  eq('NTimes 3회 반복', JSON.parse(st(ctx, 'arr')).length, 3);
}
{
  const eff = [
    { type: 'v2SetVar', var: 'a', operator: '=', value: '1', indent: 0 },
    { type: 'v2StopTrigger', indent: 0 },
    { type: 'v2SetVar', var: 'b', operator: '=', value: '2', indent: 0 }
  ];
  const { ctx } = await runTrig([{ comment: 's', type: 'start', conditions: [], effect: eff }], 'start');
  eq('StopTrigger 이후 실행 안 됨', st(ctx, 'b'), undefined);
}

console.log('\n[17] 트리거 — display allowlist / tempVars');
{
  const eff = [
    { type: 'v2ModifyChat', index: '0', indexType: 'value', value: 'X', valueType: 'value', indent: 0 },
    { type: 'v2SetVar', var: 'v', operator: '=', value: '1', indent: 0 }
  ];
  const { r, ctx } = await runTrig([{ comment: 'd', type: 'display', conditions: [], effect: eff }], 'display', { displayMode: true, displayData: 'orig' });
  const run = r.trace[0].effectsRun;
  eq('display allowlist 밖 effect 스킵', !!run.find(e => e.type === 'v2ModifyChat').skipped, true);
  eq('displayMode setVar 는 저장 안 됨', ctx.scriptstate['$v'], undefined);
  eq('displayMode setVar 는 tempVars 에 기록', r.tempVars.v, '1');
}
{
  const eff = [
    { type: 'v2GetDisplayState', outputVar: 'raw', indent: 0 },
    { type: 'v2SetDisplayState', valueType: 'var', value: 'raw', indent: 0 }
  ];
  const { r } = await runTrig([{ comment: 'd', type: 'display', conditions: [], effect: eff }], 'display', { displayMode: true, displayData: 'ORIGINAL' });
  eq('displayData 왕복', r.displayData, 'ORIGINAL');
}

console.log('\n결과: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
})();

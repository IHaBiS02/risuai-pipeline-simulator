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

console.log('\n[18] importer — 파일 형식 (픽스처는 실제 라이브러리로 생성)');
{
  const imp = require('./importer.js');
  const path = require('path');
  const dir = path.join(__dirname, 'tools', 'fixtures');
  const read = (f) => new Uint8Array(fs.readFileSync(path.join(dir, f)));

  const want = {
    'fixture-preset.risup': ['preset', 'risup'],
    'fixture-preset-old.risupreset': ['preset', 'risupreset'],
    'fixture-preset.json': ['preset', 'json'],
    'fixture-bot.charx': ['character', 'charx'],
    'fixture-bot-nomod.charx': ['character', 'charx'],
    'fixture-bot.png': ['character', 'png'],
    'fixture-charxjpeg.charx': ['character', 'charx'],
    'fixture-module.module': ['module', 'charx'],
    'fixture-module.risum': ['module', 'risum'],
    'fixture-module.json': ['module', 'json']
  };
  for (const [file, exp] of Object.entries(want)) {
    let got = null, err = null;
    try {
      const e = await imp.load({ name: file, data: read(file) });
      got = [e.kind, e.format];
    } catch (e) { err = e.message; }
    eq(file + ' → ' + exp.join('/'), err ? 'ERR: ' + err : got.join('/'), exp.join('/'));
  }
}

console.log('\n[19] importer — 프리셋 내용');
{
  const imp = require('./importer.js');
  const path = require('path');
  const read = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'tools', 'fixtures', f)));

  for (const f of ['fixture-preset.risup', 'fixture-preset-old.risupreset', 'fixture-preset.json']) {
    const e = await imp.load({ name: f, data: read(f) });
    eq(f + ' 정규식 2개', e.regex.length, 2);
    eq(f + ' order 플래그 보존', e.regex[1].flag, 'g,<order 5>');
    eq(f + ' 기본 변수', JSON.stringify(e.vars), '{"hp":"77","toggle_flag":"1"}');
  }
}

console.log('\n[20] importer — 봇 카드 내용 / 트리거 분리');
{
  const imp = require('./importer.js');
  const path = require('path');
  const read = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'tools', 'fixtures', f)));

  const c = await imp.load({ name: 'fixture-bot.charx', data: read('fixture-bot.charx') });
  eq('봇 이름', c.character.name, 'FixtureBot');
  eq('퍼스트메시지 유지', c.character.firstMessage.indexOf('*{{char}} 가 고개를 든다.*'), 0);
  eq('대체 인사 2개', c.character.alternateGreetings.length, 2);
  eq('봇 정규식 1개', c.regex.length, 1);
  eq('일반 트리거 1개', c.triggers.length, 1);
  eq('Lua 트리거 분리 1개', c.luaTriggers.length, 1);
  eq('Lua 트리거는 listenEdit 사용', c.luaTriggers[0].effect[0].code.indexOf("listenEdit('editDisplay'"), 0);
  eq('에셋 이름', JSON.stringify(c.assets), '["smile_happy.png","angry.png"]');
  eq('기본 변수', c.character.spec === 'chara_card_v3' && JSON.stringify(c.vars), '{"hp":"42"}');

  const p = await imp.load({ name: 'fixture-bot.png', data: read('fixture-bot.png') });
  eq('PNG 봇 이름', p.character.name, 'PngBot');
  eq('PNG 봇 spec', p.character.spec, 'chara_card_v2');
  eq('PNG 봇 정규식', p.regex.length, 1);

  // charx 를 모듈로도 읽을 수 있어야 한다 (RisuAI importModule 과 동일)
  const m = await imp.load({ name: 'fixture-bot.charx', data: read('fixture-bot.charx') }, { kind: 'module' });
  eq('charx → 모듈 변환', m.kind, 'module');
  eq('charx → 모듈 정규식', m.regex.length, 1);
  eq('charx → 모듈 Lua 트리거', m.luaTriggers.length, 1);
}

console.log('\n[21] importer — 모듈 3형식 동일성 + 잘못된 입력');
{
  const imp = require('./importer.js');
  const path = require('path');
  const read = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'tools', 'fixtures', f)));

  const a = await imp.load({ name: 'fixture-module.risum', data: read('fixture-module.risum') });
  const b = await imp.load({ name: 'fixture-module.module', data: read('fixture-module.module') });
  const c = await imp.load({ name: 'fixture-module.json', data: read('fixture-module.json') });
  for (const [label, e] of [['risum', a], ['.module', b], ['json', c]]) {
    eq(label + ' 모듈 이름', e.title, 'Fixture Module');
    eq(label + ' 정규식 1개', e.regex.length, 1);
    eq(label + ' <order 10> 보존', e.regex[0].flag, 'g,<order 10>');
    eq(label + ' 트리거 1개', e.triggers.length, 1);
  }

  let errMsg = '';
  try {
    await imp.load({ name: 'x.risup', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) });
  } catch (e) { errMsg = e.message; }
  eq('깨진 .risup 은 오류', errMsg.length > 0, true);

  let err2 = '';
  try { await imp.load({ name: 'x.bin', data: new Uint8Array([9, 9, 9]) }); } catch (e) { err2 = e.message; }
  eq('알 수 없는 확장자는 오류', /지원하지 않는 파일/.test(err2), true);
}

console.log('\n[22] importer — 실제 도구가 만드는 변형들');
{
  const imp = require('./importer.js');
  const path = require('path');
  const read = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'tools', 'fixtures', f)));

  // charxJpeg: JPEG 바이트 + ZIP (RisuAI exportCharacterCard 'charxJpeg')
  const j = await imp.load({ name: 'fixture-charxjpeg.charx', data: read('fixture-charxjpeg.charx') });
  eq('JPEG prefix 붙은 charx 도 읽힘', j.kind, 'character');
  eq('JPEG prefix charx 이름', j.character.name, 'FixtureBot');

  // first_mes 가 비면 alternate_greetings[0] 을 쓴다
  const ng = await imp.load({ name: 'fixture-nogreeting.json', data: read('fixture-nogreeting.json') });
  eq('대체 인사로 대체', ng.character.firstMessage, '*첫 번째 대체 인사*');
  eq('대체했다는 경고', /alternate_greetings/.test(ng.warnings.join(' ')), true);

  // lorebook entries 에 null 이 섞여도 죽지 않는다
  const dirty = {
    spec: 'chara_card_v3', spec_version: '3.0',
    data: {
      name: 'Dirty', description: '', first_mes: 'hi', mes_example: '', creator_notes: '',
      character_version: '1', tags: [], creator: '', alternate_greetings: [],
      character_book: { entries: [null, { keys: ['a'], content: 'c' }] },
      extensions: {}, assets: []
    }
  };
  let dirtyErr = null;
  try {
    await imp.load({ name: 'd.json', data: new TextEncoder().encode(JSON.stringify(dirty)) });
  } catch (e) { dirtyErr = e.message; }
  eq('lorebook 에 null 이 있어도 통과', dirtyErr, null);

  // ZIP 이 아닌 파일은 앞 8바이트를 보여준다
  let zipErr = '';
  try {
    imp.readZip(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  } catch (e) { zipErr = e.message; }
  eq('ZIP 아닌 파일은 앞 8바이트를 보여줌', /앞 8바이트: ff d8 ff e0/.test(zipErr), true);
}

console.log('\n[23] importer 로 읽은 봇 → 파이프라인 실행');
{
  const imp = require('./importer.js');
  const path = require('path');
  const read = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'tools', 'fixtures', f)));

  const preset = await imp.load({ name: 'fixture-preset.risup', data: read('fixture-preset.risup') });
  const bot = await imp.load({ name: 'fixture-bot.charx', data: read('fixture-bot.charx') });
  const mod = await imp.load({ name: 'fixture-module.risum', data: read('fixture-module.risum') });

  const r = await sim.run({
    mode: 'editdisplay',
    markdown: true,
    input: bot.character.firstMessage,
    charName: bot.character.name,
    userName: 'User',
    vars: bot.vars,
    presetRegex: preset.regex,
    charRegex: bot.regex,
    charTriggers: bot.triggers,
    charLua: bot.luaTriggers,
    moduleRegex: mod.regex,
    moduleTriggers: mod.triggers,
    moduleLua: mod.luaTriggers
  });

  eq('프리셋 정규식 적용', r.finalText.indexOf('pbadge') >= 0, true);
  eq('모듈 order 10 이 HP 강조', /HP:\s*<b>/.test(r.finalText.replace(/\n/g, ' ')) || r.finalText.indexOf('<b>') >= 0, true);
  // Node 에는 DOM 이 없어 CSS 스코프/html 은 브라우저 테스트에서 검증한다.
  // 여기서는 encodeStyle 단계까지만 확인한다.
  eq('encodeStyle 로 <style> 이 인코딩됨', r.display.encoded.indexOf('<risu-style>') >= 0, true);
  eq('봇 래퍼 div 존재', r.finalText.indexOf('<div class="botwrap">') >= 0, true);
  eq('CBS {{char}} 치환', r.finalText.indexOf('{{char}}') < 0, true);
  eq('CBS {{getvar::hp}} = 42', r.finalText.indexOf('42') >= 0, true);
  eq('미지원 CBS 없음', r.unsupported.length, 0);
}

console.log('\n결과: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
})();

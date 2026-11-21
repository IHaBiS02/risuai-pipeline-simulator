// RisuAI 원본 코드 + 원본이 쓰는 라이브러리를 그대로 묶어 vendor/risu-core.js 를 만든다.
//
// 손으로 옮기면 반드시 어긋난다(POSTMORTEM.md). 그래서 바꿀 수 없는 부분은 원본을 그대로 쓴다:
//   - src/ts/cbs.ts               CBS 함수 레지스트리 전체 (registerCBS — 의존성 주입형이라 그대로 동작)
//   - src/ts/process/infunctions.ts  calcString ({{? }} / {{calc}})
//   - src/ts/process/triggers.ts  runTrigger 전체 (트리거 VM — 모든 effect, lowLevelAccess, 로컬 변수)
//   - src/ts/parser/chatML.ts     parseChatML (runLLM 프롬프트)
//   - markdown-it 14.3.3, dompurify 3.4.17, @adobe/css-tools 4.4.4, postcss-selector-parser 7.1.7,
//     highlight.js 11.12.0 (renderHighlightableMarkdown 이 쓰는 언어만), katex 0.16.47
//     (RisuAI package.json 과 같은 버전)
//
// 사용법:
//   npm i esbuild@0.25.10            # 아무 데나 (경로를 ESBUILD 로 넘김)
//   ESBUILD=/path/node_modules/esbuild/lib/main.js \
//     node tools/build-vendor.mjs <Risuai 경로> <RisuAI node_modules 경로>
//
// 앱 상태에 묶인 import(svelte/store, stores.svelte, chatVar.svelte)는 아래 shim 으로 바꾼다.
// shim 은 런타임에 simulator.js 가 setEnv() 로 넣어주는 값을 읽는다.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { build } = await import(process.env.ESBUILD ? pathToFileURL(process.env.ESBUILD).href : 'esbuild');

const here = path.dirname(fileURLToPath(import.meta.url));
const risu = path.resolve(process.argv[2] || path.join(here, '../../Risuai'));
const nodeModules = path.resolve(process.argv[3] || path.join(risu, 'node_modules'));
const ts = path.join(risu, 'src/ts');
const out = path.join(here, '../vendor/risu-core.js');

for (const p of [path.join(ts, 'cbs.ts'), path.join(nodeModules, 'markdown-it')]) {
  if (!fs.existsSync(p)) { console.error('없음: ' + p); process.exit(1); }
}

const shimEnv = `
export const env = {
  triggerId: null, getChatVar: () => 'null', getGlobalChatVar: () => 'null', setChatVar: () => {},
  // triggers.ts 가 쓰는 앱 상태 — RisuTrigger(trigger-runtime.js) 가 실행마다 채운다
  risuChatParser: (s) => s, db: null, char: null, chat: null, moduleTriggers: () => [],
  tokenize: async (s) => Math.ceil(String(s).length / 4),
  runScripted: async (code, arg) => ({ chat: arg.chat, stopSending: false }),
  unsupported: () => {}, alert: () => {}, alertInput: async () => '', alertSelect: async () => '0',
  onReloadGUI: () => {}, onReloadChat: () => {}, hook: null,
};
export function setEnv(e) { Object.assign(env, e); }
// polyfill.ts:15 — 원본은 앱 시작 때 globalThis 에 넣는다
if (!globalThis.safeStructuredClone) globalThis.safeStructuredClone = (d) => { try { return structuredClone(d); } catch (e) { return JSON.parse(JSON.stringify(d)); } };
`;

const shims = {
  'svelte/store': `export function get(s) { return s && s.__get ? s.__get() : undefined; }`,
  // cbs.ts 는 CurrentTriggerIdStore 하나만 쓴다
  stores: `import { env } from 'risu-env'; export const CurrentTriggerIdStore = { __get: () => env.triggerId };`,
  // infunctions.ts(calcString) 가 쓰는 변수 접근
  chatVar: `import { env } from 'risu-env';
export function getChatVar(k) { return env.getChatVar(k); }
export function getGlobalChatVar(k) { return env.getGlobalChatVar(k); }
export function setChatVar(k, v) { return env.setChatVar(k, v); }`,
  // ---- triggers.ts 의존성 ----
  parser: `import { env } from 'risu-env'; export function risuChatParser(s, o) { return env.risuChatParser(s, o); }`,
  database: `import { env } from 'risu-env';
export function getDatabase() { return env.db; }
export function setDatabase(d) { env.db = d; }
export function getCurrentCharacter() { return env.db.characters[0]; }
export function setCurrentCharacter(c) { env.db.characters[0] = c; }
export function getCurrentChat() { const c = env.db.characters[0]; return c.chats[c.chatPage]; }`,
  tokenizer: `import { env } from 'risu-env'; export function tokenize(s) { return env.tokenize(s); }`,
  modules: `import { env } from 'risu-env'; export function getModuleTriggers() { return env.moduleTriggers(); }`,
  command: `import { env } from 'risu-env'; export async function processMultiCommand(c) { env.unsupported('command', c); }`,
  util: `export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
${fs.readFileSync(path.join(ts, 'util.ts'), 'utf8').match(/export function parseKeyValue\(template:string\)\{[\s\S]*?\n\}\n/)[0].replace('template:string', 'template').replace('const keyValue:[string, string][] = []', 'const keyValue = []')}`,
  alert: `import { env } from 'risu-env';
export function alertNormal(m) { env.alert('normal', m); }
export function alertError(m) { env.alert('error', m); }
export function alertInput(m) { return env.alertInput(m); }
export function alertSelect(o) { return env.alertSelect(o); }`,
  hypamemory: `import { env } from 'risu-env';
export class HypaProcesser { async addText() { env.unsupported('similarity'); } async similaritySearch() { return []; } }`,
  request: `import { env } from 'risu-env'; export async function requestChatData() { env.unsupported('runLLM'); return { type: 'fail', result: '(시뮬레이터: LLM 호출 없음)' }; }`,
  stableDiff: `import { env } from 'risu-env'; export async function generateAIImage() { env.unsupported('imgGen'); return false; }`,
  inlays: `export async function writeInlayImage() { return ''; }`,
  scriptings: `import { env } from 'risu-env'; export function runScripted(code, arg) { return env.runScripted(code, arg); }`,
};
// stores.svelte: 앱 전역 store 중 cbs.ts / triggers.ts 가 쓰는 것만
shims.stores = `import { env } from 'risu-env';
function store(getv, setv) { return { __get: getv, set: setv, subscribe() { return () => {}; } }; }
let gui = 0;
export const CurrentTriggerIdStore = store(() => env.triggerId, (v) => { env.triggerId = v; });
export const ReloadGUIPointer = store(() => gui, (v) => { gui = v; env.onReloadGUI(); });
export const ReloadChatPointer = store(() => ({}), () => { env.onReloadChat(); });
export const selectedCharID = store(() => 0, () => {});
export const DBState = { get db() { return env.db; } };`;

// 트리거 실행 기록용 훅. 원본 로직은 건드리지 않고, 정해진 위치에 관찰 호출만 끼운다.
// 기준 문자열이 바뀌면(원본 업데이트) 빌드를 멈춘다.
function instrumentTriggers(src) {
  const H = 'env.hook';
  const marks = [
    ['    for(const trigger of triggers){\n        let tempVars:Record<string, number> = {}\n',
     `$&        ${H}?.trigger(trigger, mode, arg)\n`],
    ['        let pass = true\n        for(const condition of trigger.conditions){\n',
     `        ${H}?.matched(trigger)\n$&`],
    ['            if(!pass){\n                break\n            }\n        }\n        if(!pass){\n            continue\n        }\n',
     `            ${H}?.cond(trigger, condition, pass)\n$&        ${H}?.passed(trigger)\n`],
    ["            switch(effect.type){\n                case'setvar': {",
     `            ${H}?.effect(trigger, index, effect)\n$&`],
    ['    function setVar(key:string, value:string): boolean {\n',
     `$&        ${H}?.setVar(key, value, !!arg.displayMode)\n`],
  ];
  for (const [find, rep] of marks) {
    const n = src.split(find).length - 1;
    if (n !== 1) throw new Error('triggers.ts 계측 기준 문자열이 ' + n + '번 나옴: ' + JSON.stringify(find.slice(0, 60)));
    src = src.replace(find, rep.replace('$&', () => find));
  }
  return "import { env } from 'risu-env';\n" + src;
}

const entry = `
export { registerCBS } from '${path.join(ts, 'cbs.ts')}';
export { calcString } from '${path.join(ts, 'process/infunctions.ts')}';
export { setEnv, env } from 'risu-env';
export { runTrigger, displayAllowList, requestAllowList } from '${path.join(ts, 'process/triggers.ts')}';
import markdownit from 'markdown-it';
import DOMPurify from 'dompurify';
import css from '@adobe/css-tools';
import cssSelectorParser from 'postcss-selector-parser';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
// parser.svelte.ts:229-386 이 동적으로 불러오는 언어 목록 그대로
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import cssLang from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import xml from 'highlight.js/lib/languages/xml';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import typescript from 'highlight.js/lib/languages/typescript';
import plaintext from 'highlight.js/lib/languages/plaintext';
import yaml from 'highlight.js/lib/languages/yaml';
const hljsLanguages = { bash, cpp, csharp, css: cssLang, dart, xml, java, javascript, json, lua, markdown, python, rust, shell, typescript, plaintext, yaml };
export { markdownit, DOMPurify, css, cssSelectorParser, katex, hljs, hljsLanguages };
`;

const plugin = {
  name: 'risu-shims',
  setup(b) {
    b.onResolve({ filter: /^risu-env$/ }, () => ({ path: 'risu-env', namespace: 'shim' }));
    b.onResolve({ filter: /^svelte\/store$/ }, () => ({ path: 'svelte/store', namespace: 'shim' }));
    b.onResolve({ filter: /stores\.svelte$/ }, () => ({ path: 'stores', namespace: 'shim' }));
    b.onResolve({ filter: /chatVar\.svelte$/ }, () => ({ path: 'chatVar', namespace: 'shim' }));
    // triggers.ts / chatML.ts 가 부르는 앱 모듈 (다른 파일의 같은 이름 import 는 건드리지 않는다)
    const fromTrig = (a) => /[\\/](triggers|chatML)\.ts$/.test(a.importer);
    const trigMap = [
      [/parser\.svelte$/, 'parser'], [/database\.svelte$/, 'database'], [/\/tokenizer$/, 'tokenizer'],
      [/^\.\/modules$/, 'modules'], [/^\.\/command$/, 'command'], [/^\.\.\/util$/, 'util'], [/^\.\.\/alert$/, 'alert'],
      [/hypamemory$/, 'hypamemory'], [/request\/request$/, 'request'], [/stableDiff$/, 'stableDiff'],
      [/files\/inlays$/, 'inlays'], [/^\.\/scriptings$/, 'scriptings'],
    ];
    b.onResolve({ filter: /.*/ }, (a) => {
      if (!fromTrig(a)) return undefined;
      for (const [re, name] of trigMap) if (re.test(a.path)) return { path: name, namespace: 'shim' };
      return undefined;
    });
    b.onLoad({ filter: /[\\/]process[\\/]triggers\.ts$/ }, (a) => ({
      contents: instrumentTriggers(fs.readFileSync(a.path, 'utf8')),
      loader: 'ts',
      resolveDir: path.dirname(a.path),
    }));
    b.onLoad({ filter: /.*/, namespace: 'shim' }, (a) => ({
      contents: a.path === 'risu-env' ? shimEnv : shims[a.path],
      loader: 'js',
      resolveDir: here,
    }));
  },
};

await build({
  stdin: { contents: entry, resolveDir: ts, loader: 'ts' },
  bundle: true,
  format: 'iife',
  globalName: 'RisuCore',
  platform: 'browser',
  target: 'es2020',
  nodePaths: [nodeModules],
  plugins: [plugin],
  minify: true,
  keepNames: true,
  legalComments: 'inline',
  banner: { js: '/* risu-core.js — tools/build-vendor.mjs 로 생성. 직접 고치지 마세요.\n * RisuAI (GPL-3.0) src/ts/cbs.ts, src/ts/process/infunctions.ts, src/ts/process/triggers.ts, src/ts/parser/chatML.ts\n * markdown-it (MIT), DOMPurify (MPL-2.0 OR Apache-2.0), @adobe/css-tools (MIT), postcss-selector-parser (MIT),\n * highlight.js (BSD-3-Clause), KaTeX (MIT) */' },
  footer: { js: 'if (typeof window !== "undefined") window.RisuCore = RisuCore; globalThis.RisuCore = RisuCore;' },
  outfile: out,
  logLevel: 'info',
});

// 코드 블록 색 (parser.svelte.ts:17 import 'highlight.js/styles/atom-one-dark.min.css')
fs.copyFileSync(path.join(nodeModules, 'highlight.js/styles/atom-one-dark.min.css'), path.join(here, '../vendor/atom-one-dark.min.css'));

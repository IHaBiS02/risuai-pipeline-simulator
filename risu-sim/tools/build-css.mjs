// RisuAI 채팅 화면 CSS 를 그대로 만들어 vendor/risu-chat.css 로 저장한다.
//
// 원본 src/styles.css 를 Tailwind 4 (+ @tailwindcss/typography) 로 컴파일한 결과에서
// 채팅 본문에 필요한 것만 남기고, 시뮬레이터 UI 를 망가뜨리지 않도록 `.risu-scope` 아래로 가둔다.
//   - preflight(리셋), :root 테마 변수(FontColor*, --risu-*), `* { font-family }`
//   - 메시지 본문 컨테이너 클래스: text chat-width chattext prose prose-invert minw-0
//   - .chattext * / .prose * / .x-risu-* 규칙 (styles.css:249-576)
// 카드 CSS 는 원본처럼 `.chattext ` 접두로 스코프되므로 이 파일과 무관하게 동작한다.
//
// 사용법:
//   node tools/build-css.mjs <Risuai 경로> <RisuAI node_modules 경로>
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const risu = path.resolve(process.argv[2] || path.join(here, '../../Risuai'));
const nm = path.resolve(process.argv[3] || path.join(risu, 'node_modules'));
const req = createRequire(path.join(nm, 'x.js'));
const { compile } = await import(pathToFileURL(path.join(nm, '@tailwindcss/node/dist/index.mjs')).href);
const postcss = req('postcss');

const SCOPE = '.risu-scope';
const src = path.join(risu, 'src/styles.css');
let css = fs.readFileSync(src, 'utf8')
  .replace(/@import\s+["']tailwindcss["'];/, `@import "${path.join(nm, 'tailwindcss/index.css')}";`)
  .replace(/@plugin\s+["']@tailwindcss\/typography["'];/, `@plugin "${path.join(nm, '@tailwindcss/typography/src/index.js')}";`);

const compiler = await compile(css, { base: path.dirname(src), from: src, onDependency: () => {} });
// Chat.svelte:540 메시지 본문 컨테이너 + BackgroundDom 의 배경 div 가 쓰는 클래스
const out = compiler.build(['text', 'chat-width', 'chattext', 'prose', 'prose-invert', 'minw-0', 'hidden', 'absolute', 'top-0', 'left-0', 'w-full', 'h-full', 'flex', 'justify-center']);

// 앱 껍데기용 규칙(채팅 본문과 무관)은 버린다
const DROP = [/^#app\b/, /::-webkit-scrollbar/, /^::highlight/, /^\.n-scroll/, /^\.risu-select/, /^\.saving-animation/, /^\.loadmove/, /^\.root-loaded-image/, /^\.strokeme/, /^\.z-100/, /^\.bgc$/, /^\.text-bordered/, /^\.chat-message-container/, /^\.flexium/];

const scoped = postcss([
  {
    postcssPlugin: 'risu-scope',
    Rule(rule) {
      if (rule.__done) return;
      rule.__done = true;
      let p = rule.parent;
      while (p) {
        if (p.type === 'atrule' && /keyframes$/.test(p.name)) return;
        if (p.type === 'rule') return; // CSS 중첩 규칙(prose 내부)은 부모가 이미 스코프됨
        p = p.parent;
      }
      const sels = [];
      for (const s of rule.selectors) {
        const t = s.trim();
        if (DROP.some((r) => r.test(t))) continue;
        // 문서 루트 → 프리뷰 루트
        if (/^(html|body|:root|:host)(\s*,|$)/.test(t) || t === 'html, :host' || t === ':root, :host') { sels.push(SCOPE); continue; }
        const r = t.replace(/^(html|body|:root|:host)\b/, SCOPE);
        if (r !== t) { sels.push(r); continue; }
        if (t === '*') { sels.push(SCOPE, SCOPE + ' *'); continue; }
        sels.push(SCOPE + ' ' + t);
      }
      if (sels.length === 0) rule.remove();
      else rule.selectors = [...new Set(sels)];
    },
  },
]).process(out, { from: undefined }).css;

const banner = `/* risu-chat.css — tools/build-css.mjs 로 생성. 직접 고치지 마세요.
 * RisuAI (GPL-3.0) src/styles.css + Tailwind CSS 4 (MIT) + @tailwindcss/typography (MIT), ${SCOPE} 아래로 스코프 */\n`;
fs.writeFileSync(path.join(here, '../vendor/risu-chat.css'), banner + scoped);
console.log('vendor/risu-chat.css', scoped.length, 'bytes');

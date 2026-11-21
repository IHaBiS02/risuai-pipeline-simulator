# NOTICE — 출처와 제3자 라이선스

이 저장소의 **전체 라이선스는 GNU GPL v3.0** 입니다 ([LICENSE](LICENSE)).
아래는 그 근거가 되는 출처와 제3자 구성요소입니다.

---

## 1. 파생 출처 — RisuAI

이 저장소의 분석 문서와 `risu-sim/` 의 코드는 아래 프로젝트의 소스를 읽고 옮긴 **2차적 저작물**입니다.

| 항목 | 내용 |
|---|---|
| 프로젝트 | RisuAI |
| 저장소 | https://github.com/kwaroran/Risuai |
| 기준 커밋 | `6db4b681` (2026-11-21) |
| 라이선스 | GNU GPL v3.0 |
| 저작권 | Copyright (C) 2024 Kwaroran |

포트/인용한 주요 파일:

- `src/ts/process/scripts.ts` — `processScriptFull`, `executeScript`, `<order N>` 정렬 → [`risu-sim/simulator.js`](risu-sim/simulator.js)
- `src/ts/parser/parser.svelte.ts` — `encodeStyle`, `decodeStyleRule`, `decodeStyleContent`, `trimMarkdown`, `parseAdditionalAssets`, `getClosestMatch`, DOMPurify 훅 → [`risu-sim/simulator.js`](risu-sim/simulator.js)
- `src/ts/parser/parser.svelte.ts` (`risuChatParser`, 블록 매처), `src/ts/parser/chatVar.svelte.ts`, `src/ts/util.ts`(`parseKeyValue`, `pickHashRand`) → [`risu-sim/cbs.js`](risu-sim/cbs.js)
- `src/ts/cbs.ts`(CBS 함수 레지스트리), `src/ts/process/infunctions.ts`(`calcString`) — **수정 없이 번들** → `risu-sim/vendor/risu-core.js` ([`tools/build-vendor.mjs`](risu-sim/tools/build-vendor.mjs))
- `src/ts/process/triggers.ts`(`runTrigger`), `src/ts/parser/chatML.ts`(`parseChatML`) — 같은 번들에 포함. `triggers.ts` 는 로직은 그대로 두고 실행 기록용 관찰 호출 5곳만 빌드 때 끼움
- `src/ts/util.ts` `parseKeyValue` — 빌드 때 원본 소스에서 그대로 추출
- `src/styles.css` — Tailwind 로 컴파일해 `.risu-scope` 아래로 가둔 것 → `risu-sim/vendor/risu-chat.css` ([`tools/build-css.mjs`](risu-sim/tools/build-css.mjs))
- `src/ts/parser/tests/cbs/*.test.ts`, `trimMarkdownStyle.test.ts`, `assetSrcSanitize.test.ts` — 이식본 검증에 그대로 사용 (저장소에 포함하지 않음)
- `src/ts/process/scriptings.ts` — `luaCodeWrapper`, `runLuaEditTrigger`, `runScripted` → [`risu-sim/lua-runtime.js`](risu-sim/lua-runtime.js)
- `src/ts/characterCards.ts` (`convertCharbook`), `src/ts/process/scripts.ts` (`processScriptCache`), `src/lib/SideBars/Toggles.svelte` (토글 묶기·그리기) → [`risu-sim/importer.js`](risu-sim/importer.js), [`risu-sim/simulator.js`](risu-sim/simulator.js), [`risu-sim/index.html`](risu-sim/index.html)
- `src/ts/process/memory/hypamemory.ts` — 임베딩 요청 형식(`custom` 경로) → [`risu-sim/asset-runtime.js`](risu-sim/asset-runtime.js)
- `src/ts/storage/database.svelte.ts` (`importPreset`, `downloadPreset`), `src/ts/process/modules.ts` (`readModule`), `src/ts/process/processzip.ts` (`CharXImporter`), `src/ts/characterCards.ts` (`importCharacterProcess`, `importCharacterCardSpec`), `src/ts/interchangeability.ts` (`convertCharacterToModule`), `src/ts/util.ts` (`encryptBuffer`/`decryptBuffer`) — 파일 포맷 해석 → [`risu-sim/importer.js`](risu-sim/importer.js)

비교 대상으로 `PocketRisu/PocketRisu` (포크, GPL-3.0) 도 참고했습니다.

> 두 원본 저장소는 이 저장소에 **커밋되지 않습니다**(`.gitignore`). 분석 시점의 스냅샷은 위 커밋 해시를 참조하세요.

## 2. 번들된 제3자 구성요소

| 구성요소 | 버전 | 라이선스 | 저작권 | 위치 |
|---|---|---|---|---|
| wasmoon (Lua 5.4 WASM) | 1.16.0 | MIT | © ceifa — https://github.com/ceifa/wasmoon | `risu-sim/vendor/wasmoon/` |
| json.lua | — | MIT | © 2020 rxi — https://github.com/rxi/json.lua | `risu-sim/vendor/lua/json.lua` |
| markdown-it | 14.3.3 | MIT | © 2014 Vitaly Puzrin, Alex Kocharin | `risu-sim/vendor/risu-core.js` |
| DOMPurify | 3.4.17 | MPL-2.0 OR Apache-2.0 (Apache-2.0 선택) | © Cure53 and other contributors | `risu-sim/vendor/risu-core.js` |
| @adobe/css-tools | 4.4.4 | MIT | © 2012 TJ Holowaychuk | `risu-sim/vendor/risu-core.js` |
| postcss-selector-parser | 7.1.7 | MIT | © Ben Briggs | `risu-sim/vendor/risu-core.js` |
| highlight.js (core + 17개 언어, atom-one-dark 테마) | 11.12.0 | BSD-3-Clause | © 2006 Ivan Sagalaev | `risu-sim/vendor/risu-core.js`, `vendor/atom-one-dark.min.css` |
| KaTeX | 0.16.47 | MIT | © 2013-2020 Khan Academy and other contributors | `risu-sim/vendor/risu-core.js` |
| Tailwind CSS (컴파일 결과) | 4.3.3 | MIT | © Tailwind Labs, Inc. | `risu-sim/vendor/risu-chat.css` |
| @tailwindcss/typography (컴파일 결과) | 0.5.20 | MIT | © Tailwind Labs, Inc. | `risu-sim/vendor/risu-chat.css` |
| rpack 치환 테이블 | — | MIT | RisuAI `src/ts/rpack/rpack_map.bin` (원본 rpack, © 그 저자) | [`risu-sim/importer.js`](risu-sim/importer.js) `RPACK_MAP_B64` |

`rpack_map.bin` 은 256바이트 치환표 2개(encode/decode)로 이루어진 512바이트 파일이며,
`importer.js` 안에 base64 문자열로 그대로 담겨 있습니다.

`glue.wasm` 은 Emscripten 으로 빌드된 Lua 5.4 인터프리터이며, wasmoon 패키지에 포함된 그대로입니다.
`glue.dataurl.js` 는 `file://` 에서도 동작하도록 `glue.wasm` 을 base64 data URL 로 감싼 파일입니다(내용 동일).

DOMPurify 는 Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0) 으로 사용합니다(GPL-3.0 과 호환).

### BSD 3-Clause 라이선스 전문 (highlight.js)

```
Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### MIT 라이선스 전문 (위 MIT 구성요소에 적용)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. 상표

"RisuAI", "PocketRisu" 는 각 프로젝트의 명칭입니다. 이 저장소는 **비공식 분석/시뮬레이션 도구**이며
어느 프로젝트와도 제휴·보증 관계가 없습니다.

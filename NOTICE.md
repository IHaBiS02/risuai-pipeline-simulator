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
- `src/ts/cbs.ts` + `parser.svelte.ts` — CBS(`{{...}}`) 디스패치 → [`risu-sim/simulator.js`](risu-sim/simulator.js)
- `src/ts/process/scriptings.ts` — `luaCodeWrapper`, `runLuaEditTrigger`, `runScripted` → [`risu-sim/lua-runtime.js`](risu-sim/lua-runtime.js)
- `src/ts/process/triggers.ts` — `runTrigger`, 조건 평가, indent 인터프리터, allowlist → [`risu-sim/trigger-runtime.js`](risu-sim/trigger-runtime.js)
- `src/ts/process/memory/hypamemory.ts` — 임베딩 요청 형식(`custom` 경로) → [`risu-sim/asset-runtime.js`](risu-sim/asset-runtime.js)

비교 대상으로 `PocketRisu/PocketRisu` (포크, GPL-3.0) 도 참고했습니다.

> 두 원본 저장소는 이 저장소에 **커밋되지 않습니다**(`.gitignore`). 분석 시점의 스냅샷은 위 커밋 해시를 참조하세요.

## 2. 번들된 제3자 구성요소

| 구성요소 | 버전 | 라이선스 | 저작권 | 위치 |
|---|---|---|---|---|
| wasmoon (Lua 5.4 WASM) | 1.16.0 | MIT | © ceifa — https://github.com/ceifa/wasmoon | `risu-sim/vendor/wasmoon/` |
| json.lua | — | MIT | © 2020 rxi — https://github.com/rxi/json.lua | `risu-sim/vendor/lua/json.lua` |

`glue.wasm` 은 Emscripten 으로 빌드된 Lua 5.4 인터프리터이며, wasmoon 패키지에 포함된 그대로입니다.
`glue.dataurl.js` 는 `file://` 에서도 동작하도록 `glue.wasm` 을 base64 data URL 로 감싼 파일입니다(내용 동일).

### MIT 라이선스 전문 (위 구성요소에 적용)

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

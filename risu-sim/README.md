# RisuAI 파이프라인 시뮬레이터

RisuAI(`kwaroran/Risuai` @ `6db4b681`)의 **텍스트 변환 파이프라인**을 정적 HTML 한 장으로 옮긴 것입니다.
서버도, 빌드도, 패키지 설치도 필요 없습니다.

```
risu-sim/
├── index.html          UI (설정 · 트레이스 · 렌더 프리뷰)
├── simulator.js        엔진 (CBS · 정규식 · CSS 스코프 · 새니타이저)
├── lua-runtime.js      Lua 레이어 (wasmoon, listenEdit 4종)
├── asset-runtime.js    동적 에셋 (OpenAI 호환 /embeddings)
├── trigger-runtime.js  트리거 VM (조건 / indent 인터프리터 / 35 effect)
├── ADDING-RUNTIMES.md  트리거·플러그인·동적 에셋 설계
├── test.js             엔진 단위 테스트 17개 (node test.js)
├── tools/
│   └── mock-embeddings.py  API 키 없이 테스트하는 목 임베딩 서버
├── vendor/
│   ├── wasmoon/        Lua 5.4 WASM 런타임 (index.js + glue.wasm)
│   └── lua/json.lua    RisuAI 가 쓰는 json 라이브러리
├── shot-trace.png      트레이스 화면 예시 (Lua)
├── shot-preview.png    렌더 프리뷰 예시
└── shot-assets.png     동적 에셋 화면 예시
```

## 실행

```bash
# 방법 1: 그냥 열기 (file:// 동작)
xdg-open risu-sim/index.html

# 방법 2: 정적 서버 (권장, 어떤 호스팅이든)
cd risu-sim && python3 -m http.server 8080
# → http://localhost:8080
```

`#trace`, `#preview`, `#css`, `#html`, `#vars` 해시로 탭을 바로 열 수 있습니다.

## 테스트

```bash
cd risu-sim && node test.js
# → 17 passed, 0 failed
```

## 트리거

봇/모듈 트리거를 JSON 으로 넣으면 `runTrigger` 를 그대로 재현합니다.

| 모드 | 실행되는 트리거 패스 |
|---|---|
| `editinput` | `runTrigger('input')` → editinput |
| `editprocess` | `runTrigger('start')` → editprocess |
| `editoutput` | editoutput → `runTrigger('output')` |
| `editdisplay` | editdisplay 내부 ② 에서 `runTrigger('display')` (displayMode) |

원본의 4가지 규칙을 그대로 지킵니다.

1. `effect[0].type === 'triggerlua'` 이면 **`trigger.type` 필터를 건너뛴다** (`triggers.ts:1238`)
2. `display`/`request` 패스는 **allowlist 의 effect 만** 실행 (`triggers.ts:1331`)
3. 재귀 깊이 **10**, `lowLevelAccess` 는 무제한
4. `v2StopTrigger` → `index = effect.length`

> ⚠️ `v2Else` 는 **`v2EndIndent` 뒤에** 옵니다. `v2If`-본문-`v2EndIndent`-`v2Else`-본문-`v2EndIndent` 순서입니다.
> (원본 `triggers.ts:1727-1731` 이 `effect[index+1]` 에서 `v2Else` 를 찾기 때문)

## 동적 에셋 (OpenAI 호환 임베딩)

설정 패널의 **동적 에셋** 항목에 URL / API 키 / 모델명을 넣으면
OpenAI 호환 `/embeddings` 로 에셋 이름을 벡터화해 `{{image::아무이름}}` 을
가장 가까운 실제 에셋 이름으로 치환합니다.

```
POST {URL}/embeddings          ← URL 이 /embeddings 로 끝나면 그대로 사용
Authorization: Bearer {KEY}
{ "input": ["smile_happy.png", ...], "model": "text-embedding-3-small" }
→ { "data": [ { "embedding": [...] }, ... ] }
```

RisuAI `hypaModel = 'custom'` 경로(`hypamemory.ts:96-118`)와 동일한 형식입니다.

- 에셋 이름 임베딩은 **캐시**됩니다(URL·모델·이름 목록이 바뀌면 무효).
- 치환 결과는 `bestMatchCache` 에 남아 재요청하지 않습니다.
- 오류가 나면 **태그를 그대로 두고** 트레이스에 표시합니다(응답을 막지 않음).

### API 키 없이 테스트

```bash
python3 tools/mock-embeddings.py 8899
# 시뮬레이터: http://localhost:8080/?asset=1&assetUrl=http://127.0.0.1:8899/v1&assetModel=mock&mode=editoutput
```

`?asset=1&assetUrl=...&assetModel=...&assetNames=a.png,b.png&mode=editoutput&input=...`
쿼리로 설정을 주입할 수 있습니다.

> **중요**: 동적 에셋은 `editoutput` 에서 효과가 보입니다.
> `editdisplay` 는 `parseAdditionalAssets` 가 **먼저** 태그를 소비하므로,
> 표시 단계에서 새로 생긴 태그에만 적용됩니다(원본과 동일).

## 어디까지 "그대로"인가

| 항목 | 상태 | 근거 |
|---|---|---|
| 정규식 3레이어 순서 (`presetRegex → char → module`) | **1:1** | `scripts.ts:134` |
| `<order N>` 내림차순 안정 정렬 | **1:1** | `scripts.ts:296-334` |
| `ableFlag` 게이팅, flag 정제(`[^dgimsuvy]` 제거, 중복 제거, 빈 값→`u`) | **1:1** | `scripts.ts:156-174` |
| `in === ''` 스킵, `type` 완전 일치 | **1:1** | `scripts.ts:148-152` |
| `$n` → 개행, `{{data}}` 이스케이프, `>` 끝나면 개행 추가 | **1:1** | `scripts.ts:154-165` |
| `@@emo` / `@@inject` / `@@move_top` / `@@move_bottom` / `@@repeat_back` | **1:1** (부수효과 제외) | `scripts.ts:182-288` |
| 치환 결과 재-CBS | **1:1** | `scripts.ts:248, 291` |
| CBS → 정규식 순서 | **1:1** | `scripts.ts:133-134` |
| `editprocess` 에 Lua 없음 | **1:1** (생략 표시) | `scriptings.ts:1489-1491` |
| **Lua `listenEdit` 4종** (`editInput`/`editOutput`/`editDisplay`/`editRequest`) | **1:1** | `scriptings.ts:1478-1519` |
| **Lua 트리거 순회** (봇 → 모듈, `effect[0]==='triggerlua'` 만) | **1:1** | `scriptings.ts:1496-1512` |
| **Lua 엔진 재생성 시 리스너 초기화** | **1:1** (코드별 캐시) | `scriptings.ts:85-98` |
| **Lua 게이팅** (`editDisplay` 에서 `setChat`/`alert`/`stopChat` 무시) | **1:1** | `scriptings.ts:1102-1111` |
| Lua `async()`/`:await()` 기반 API (`LLM`, `request`, `similarity`) | **미지원** | 브리지가 동기 |
| `encodeStyle` (`<style>` → `<risu-style>hex`) | **1:1** | `parser.svelte.ts:957-962` |
| CSS 스코프 (`.chattext ` 프리픽스 + 클래스 `x-risu-`) | **1:1** | `parser.svelte.ts:964-997` |
| `@import data:` 무력화, `@media`/`@supports`/`@container` 재귀 | **1:1** | `parser.svelte.ts:986-995` |
| 클래스 개명 (`class` 속성 → `x-risu-`) | **1:1** | `parser.svelte.ts:88-101` |
| `<iframe>` YouTube embed 만 허용 | **1:1** | `parser.svelte.ts:46-52` |
| `href` http(s) 만 + `target=_blank`, `rel` 강제 | **1:1** | `parser.svelte.ts:102-113` |
| CBS 함수 | **서브셋** | 아래 표 참고 |
| DOMPurify | **대체 구현** (allowlist 워커) | `parser.svelte.ts:783-786` |
| CSS 파서 | **대체 구현** (`@adobe/css-tools` 대신 내장) | — |
| 마크다운 | **근사** (markdown-it 대신 최소 구현) | — |
| **트리거** — `runTrigger` 5곳, `effect[0]=triggerlua` 타입 우회, display/request allowlist, 재귀 10 | **1:1** | `triggers.ts:1058` |
| **트리거 effect** — safeSubset 35개 + display/request 상태 5개 | **1:1** | `triggers.ts:975-1036` |
| **트리거** — `runLLM`/`imgGen`/`command`/로어북 CRUD/alert | **스텁** (배지 표시) | — |
| **동적 에셋** — 실행 조건 3개, 정확일치→레벤슈타인→임베딩, `bestMatchCache` | **1:1** | `scripts.ts:345-382` |
| **자산 태그 해석** (`parseAdditionalAssets` 근사) | **근사** (이미지 대신 자리표시자) | `parser.svelte.ts:486-598` |
| 트리거 VM / 플러그인 | **미탑재** (설계: [`ADDING-RUNTIMES.md`](ADDING-RUNTIMES.md)) | — |

### 지원하는 CBS

블록: `#if`, `#if_pure`, `#when`, `#when_pure`, `#pure`, `#puredisplay`, `#code`, `#escape`, `#each`, `{{:else}}`

인라인: `getvar`, `setvar`, `addvar`, `setdefaultvar`, `getglobalvar`, `setglobalvar`,
`char`, `user`, `persona`, `role`, `original`, `mainprompt`, `jb`, `globalnote`,
`blank`, `newline`, `space`, `br`, `comment`, `//`, `data`,
`img`, `image`, `emotion`, `video`, `audio`, `bg`, `raw`, `path`, `source`, `inlay`,
`button`, `ruby`, `tex`, `codeblock`, `debo`, `debc`, `deabo`, `deabc`, `dec`, `;`

`#when` 연산자: `and`, `or`, `is`, `isnot`, `>`, `<`, `>=`, `<=`, `not`, `var`, `vis`, `visnot`, `toggle`, `tis`, `tisnot`

미지원 태그는 **원문 그대로 남기고** 화면 하단에 목록으로 알려줍니다.

### 원본과 의도적으로 다른 부분

| 항목 | 차이 | 이유 |
|---|---|---|
| Lua | 항상 생략 (트레이스에 "생략" 표시) | wasmoon(WASM) + Lua VM 필요 |
| 트리거 / 플러그인 | 생략 | Svelte 스토어·iframe 호스트 필요 |
| `@@emo` | 감정 이미지 상태를 저장하지 않고 표시만 | 캐릭터 상태 저장소 없음 |
| `@@inject` | 채팅 메시지에 쓰지 않고 본문에서만 제거 | 채팅 DB 없음 |
| `@@repeat_back` | "직전 메시지" 입력 1건만 참조 | 채팅 히스토리 없음 |
| 동적 에셋(`db.dynamicAssets`) | 미구현 | 임베딩 모델 필요 |
| 캐시(`processScriptCache`) | 미구현 | 결과에 영향 없음 |
| `#when` 내부 CBS | 원본과 동일하게 **false 여도 실행** | `parser.svelte.ts:1737-1760` |
| `#if` 내부 CBS | 원본과 동일하게 **false 면 미실행** | `parser.svelte.ts:1214-1224` |

## 100% 동일 이식으로 가려면

`processScriptFull`의 실제 import 폐포(closure)는 **로컬 134개 파일 / npm 42개 패키지**입니다
(Tauri, `@huggingface/transformers`, `web-llm`, `ollama`, `peerjs` 포함 — 사실상 앱 전체).

이걸 정적 번들로 줄이려면 아래 8개만 shim 으로 대체하면 됩니다.

| shim 대상 | 대체 내용 |
|---|---|
| `src/ts/storage/database.svelte.ts` | `DBState.db` 객체 + `getDatabase` / `getCurrentCharacter` / `getCurrentChat` / `setCurrentCharacter` |
| `src/ts/stores.svelte.ts` | `selectedCharID`, `CustomCSSStore` 등 — Svelte store 대신 단순 객체 |
| `src/ts/globalApi.svelte.ts` | `saveAsset`, `getFileSrc`, `downloadFile`, `fetchNative` → 브라우저 구현/스텁 |
| `src/ts/platform.ts` | `isTauri=false`, `isNodeServer=false` |
| `src/ts/alert.ts` | `alertError` / `alertNormal` → `console` |
| `src/ts/lang` | 한국어/영어 사전만 |
| `src/ts/process/scriptings.ts` | `runLuaEditTrigger` → `content` 그대로 반환 |
| `src/ts/process/triggers.ts` | `runTrigger` → `null` |
| `src/ts/process/plugins.svelte.ts` | `pluginV2` → 빈 Set |

이렇게 하면 `scripts.ts` / `parser.svelte.ts` / `cbs.ts` 를 **수정 없이** 그대로 import 할 수 있습니다
(`parser.svelte.ts` 의 `$effect.root` 2줄만 패치 또는 Svelte 컴파일 필요).

## 참고

- 분석 문서: [`../RisuAI-pipeline-analysis.md`](../RisuAI-pipeline-analysis.md)
- 스코프 결과가 원본과 일치하는지 확인하는 상류 테스트:
  `Risuai/src/ts/parser/tests/trimMarkdownStyle.test.ts` (`.chattext .x-risu-mybox{color:red;}` 기대)

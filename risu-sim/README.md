# RisuAI 파이프라인 시뮬레이터

RisuAI(`kwaroran/Risuai` @ `6db4b681`)의 **텍스트 변환 파이프라인**을 정적 HTML 한 장으로 옮긴 것입니다.
서버도, 빌드도, 패키지 설치도 필요 없습니다.

```
risu-sim/
├── index.html          UI (파일 불러오기 · 설정 · 트레이스 · 렌더 프리뷰)
├── simulator.js        엔진 (CBS · 정규식 · CSS 스코프 · 새니타이저 · 표시 렌더)
├── importer.js         파일 로더 (.risup · .charx · .module · .risum · .png · .json)
├── lua-runtime.js      Lua 레이어 (wasmoon, listenEdit 4종)
├── asset-runtime.js    동적 에셋 (OpenAI 호환 /embeddings)
├── trigger-runtime.js  트리거 VM (조건 / indent 인터프리터 / 35 effect)
├── ADDING-RUNTIMES.md  트리거·플러그인·동적 에셋 설계
├── test.js             단위 테스트 125개 (node test.js)
├── tools/
│   ├── mock-embeddings.py  API 키 없이 테스트하는 목 임베딩 서버
│   ├── make-fixtures.js    테스트용 실제 포맷 파일 생성기 (msgpackr + fflate)
│   ├── fixtures/           위 스크립트로 만든 .risup / .charx / .module …
│   ├── ui-test.html        브라우저 UI 통합 테스트 65개 (iframe 안에서 실제 클릭)
│   └── shot.html           스크린샷 촬영용 페이지
├── vendor/
│   ├── wasmoon/        Lua 5.4 WASM 런타임 (index.js + glue.wasm)
│   └── lua/json.lua    RisuAI 가 쓰는 json 라이브러리
├── shot-cardui.png     HTML 카드 UI 봇 렌더 (실제 이미지 모드)
├── shot-htmlmode.png   같은 결과를 HTML 코드 모드로
├── shot-toggles.png    모듈 토글 + 변수 편집기
├── shot-import.png     파일 불러오기 + 트레이스
├── shot-after.png      After 렌더 (중간 단계)
├── shot-preview.png    채팅 프리뷰
├── shot-trace.png      트레이스 화면 예시 (Lua)
├── shot-trigger.png    트리거 발화 예시
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

## 파일 불러오기

`.risup` 프리셋 / `.charx` 봇 카드 / `.module` 모듈을 그대로 읽습니다.
별도 라이브러리 없이 브라우저 내장 API 만 씁니다 (`DecompressionStream`, `crypto.subtle`).

| 확장자 | 들어가는 곳 | 포맷 | 푸는 순서 |
|---|---|---|---|
| `.risup` | 프리셋 | 프리셋 | `rpack` → zlib/gzip → msgpack → **AES-GCM** → msgpack |
| `.risupreset` | 프리셋 | 구형 프리셋 | zlib/gzip → msgpack → **AES-GCM** → msgpack |
| `.charx` | 봇 카드 (또는 모듈) | ZIP | `card.json`(CCv3) + `module.risum` + `assets/*` |
| `.module` | 모듈 | ZIP (charx) | 위와 동일 — `exportModule` 이 charx 로 씁니다 |
| `.risum` | 모듈 | 바이너리 | 매직 `111` → 버전 `0` → `[len][rpack JSON]` → 자산 → `0` |
| `.png` | 봇 카드 | PNG | `tEXt`/`iTXt` 의 `ccv3`(V3) · `chara`(V2) = base64 JSON |
| `.json` | 알아서 판별 | — | `type:'risuModule'` / `chara_card_v2·v3` / `type:'preset'` |

원본과 같은 규칙을 지킵니다.

- **프리셋**: `regex` → `db.presetRegex` (그래서 프리셋 정규식 칸에 들어감)
- **봇 카드**: `extensions.risuai.customScripts` → 봇 정규식,
  `triggerscript` 중 `effect[0].type === 'triggerlua'` 인 것만 **Lua 칸으로 분리**
- **charx**: `module.risum` 이 있으면 그 안의 정규식·트리거로 **덮어씁니다**
  (`importCharacterProcess` 와 동일 — 실제 .charx 는 항상 이 구조입니다)
- **봇의 `first_mes`** 가 **입력 텍스트**로 들어갑니다 (채팅 내용)
- **모듈**은 여러 개 선택 가능하고, 합치는 순서는 **불러온 순서**(= `db.modules` 순서)입니다.
  원본 `getModuleByIds` 가 선택 순서가 아니라 `db.modules` 를 filter 하기 때문입니다.
- **프리셋·봇은 라디오 1개 선택**, 여러 개를 올려도 하나만 적용됩니다.

> **보안 컨텍스트 필요**: `.risup` 은 WebCrypto(AES-GCM)로 복호화합니다.
> `https://` 또는 `http://localhost` 에서만 동작하고, `file://` 에서는 안 됩니다.

### CHARX(ZIP) 리더가 받아들이는 것

`card.json` 은 스펙대로 **zip 루트**에 있어야 하지만, 실제 파일이 다양해서 아래는 모두 처리합니다
(`tools/fixtures/`, Python `zipfile`, fflate 로 만든 변형으로 회귀 테스트함).

| 변형 | 처리 |
|---|---|
| deflate(8) · stored(0) | ✓ |
| ZIP64 (EOCD64 / 0xFFFFFFFF + extra 0x0001) | ✓ |
| data descriptor (bit 3) — 스트리밍 writer | ✓ 중앙 디렉터리를 읽으므로 |
| 아카이브 주석 (EOCD 가 끝에서 22바이트가 아님) | ✓ |
| **JPEG 바이트가 앞에 붙은 ZIP** (RisuAI `charxJpeg`) | ✓ prefix 길이를 계산해 보정 |
| `card.json` 이 첫 엔트리가 아님 | ✓ |
| `card.json` 이 하위 경로(`x/card.json`) | ✓ 접미사 매칭 |
| bzip2(12) · lzma(14) | ✗ 명확한 오류 (캐릭터 카드 도구는 쓰지 않음) |

실패하면 **무엇이 문제인지** 알려줍니다 — ZIP 이 아니면 앞 8바이트를, `card.json` 이 없으면
**zip 안에 든 파일 이름 목록**을 보여줍니다.

### 실제 포맷으로 테스트하기

`tools/fixtures/` 아래 파일들은 **RisuAI 가 쓰는 라이브러리(msgpackr, fflate)로 직접 생성**한
진짜 포맷입니다. 생성기는 [`tools/make-fixtures.js`](tools/make-fixtures.js) 입니다.

```bash
npm i msgpackr@1.10.1 fflate@0.8.3   # 픽스처를 다시 만들 때만
node risu-sim/tools/make-fixtures.js
```

### 브라우저 UI 테스트

`tools/ui-test.html` 은 `index.html` 을 iframe 으로 띄운 뒤 **실제로 파일을 넣고 버튼을 눌러**
100개 항목을 확인합니다 (`DataTransfer` 로 file input 에 주입 + 페이지 전역 드롭).

```bash
cd risu-sim && python3 -m http.server 8901
chromium --headless=new --no-sandbox --virtual-time-budget=60000 \
  --dump-dom "http://127.0.0.1:8901/tools/ui-test.html"
# → <pre id="out">ALL PASS (100 checks)</pre>
```

## 보기 모드 — 실제 이미지 / HTML 코드

결과 영역(과 트레이스의 after)은 **두 가지 보기 방식**을 제공합니다. 탭 바 오른쪽 `보기` 스위치로 바꿉니다.

| 모드 | 보이는 것 |
|---|---|
| **실제 이미지** | 카드 CSS·에셋 이미지까지 적용한 실제 채팅 화면 |
| **HTML 코드** | `trimMarkdown` 을 통과한 최종 HTML 소스 (스코프된 `<style>` 포함) |

```
트레이스 │ 결과 │ 스코프된 CSS │ 변수                 보기 [실제 이미지][HTML 코드]  ☑ CBS 전개
```

- 선택은 `localStorage` 에 저장됩니다.
- **HTML 코드** 모드에서는 트레이스의 after 블록도 소스로 표시됩니다 (렌더 블록을 만들지 않음).
- 실제 이미지 모드에서만 `.rendered` 블록이 생기므로, 큰 카드에서 렌더가 느릴 때 HTML 모드를 쓰면 됩니다.

## 트리거 · 변수 · 토글

### 버튼 트리거 (`risu-trigger`)

미리보기의 `<button risu-trigger="이름">` 을 **클릭하면 그 트리거가 실행**됩니다
(`Chat.svelte:305` → `runTrigger('manual', { manualName })`). 실행 후 결과로 다시 렌더링합니다.

### 변수 — 하나의 공간

원본은 채팅 변수를 `chat.scriptstate['$key']` 에 저장합니다 (`chatVar.svelte.ts:6`).
**트리거 `v2SetVar` 도 같은 곳에 씁니다** (`triggers.ts:1203`). 그래서
트리거가 바꾼 값을 `{{getvar::x}}` 가 그대로 읽습니다 — 시뮬레이터도 동일하게 통일했습니다.

| | 저장 위치 |
|---|---|
| `{{getvar::x}}` / `{{setvar::x::v}}` | `scriptstate['$x']` |
| 트리거 `v2SetVar` | `scriptstate['$x']` |
| `{{getglobalvar::x}}` / `{{setglobalvar::x::v}}` | 전역 변수 (`toggle_*` 포함) |

없는 변수는 원본과 같이 문자열 `null` 을 돌려줍니다.

**변수 탭**에서 값을 직접 고칠 수 있습니다 (키/값 편집, 추가, 삭제 → 즉시 재실행).

### 모듈 토글 (`customModuleToggle`)

`key=라벨=타입=옵션` 형식을 그대로 파싱합니다 (`util.ts:1049` 포팅).

```
cot=CoT 로그                 → 체크박스 (toggle_cot = '1' / '0')
tone=톤=select=밝게,어둡게    → 셀렉트 (선택 인덱스)
note=메모=text                → 텍스트 입력
group=그룹=group … groupEnd   → 접히는 그룹
caption / divider             → 라벨 / 구분선
```

값은 전역 변수 `toggle_<key>` 에 들어가고, 카드에서는 `{{#when::toggle::cot}}` 로 읽습니다.
**패널을 다시 그리지 않고 값만 맞추기** 때문에 조작 중에 포커스나 체크가 날아가지 않습니다.

### 실행 기능 토글

| 스위치 | 끄면 |
|---|---|
| **트리거 실행** | `runTrigger` 5곳을 모두 건너뛰고 트레이스에 "사용 안 함" 표시 |
| **Lua 실행** | `listenEdit` 훅을 실행하지 않음 |
| **변수 유지** | 매 실행을 입력값에서 시작 (트리거가 바꾼 변수가 이어지지 않음) |

## 에셋 이미지

불러온 카드의 이미지를 **실제로 꺼내서** 렌더합니다. CCv3 의 `asset.uri` 는 형태가 여러 가지라 전부 처리합니다.

| `asset.uri` | 어디서 |
|---|---|
| `embeded://path` | CHARX zip 안의 파일 |
| `__asset:path` | PNG 카드의 `chara-ext-asset_:<path>` tEXt 청크 (base64) |
| `data:image/png;base64,...` | 그대로 사용 |
| `https://...` | 그대로 사용 (브라우저가 로드) |
| `ccdefault:` | 카드 이미지 자체 (PNG 카드면 그 파일) |

추가로:

- **모듈 `.risum` 내장 자산**도 읽습니다 (`encodeRPack(compressSync(image))` → rpack 만 풀면 이미지)
- `{{image::x}}` → `<img src="blob:...">`, `{{raw::x}}` → **URL 문자열**
  → `background:url({{raw::x}})` 같은 카드 CSS 도 그대로 동작
- 아바타는 `type: 'icon'` 에셋 (보통 `main`) 을 사용
- `assets/**` 중 카드가 이름으로 참조하지 않는 파일도 basename 으로 채워 둡니다
- 제한: 파일 8MB / 전체 48MB / 200개 (넘으면 경고)

## After 렌더 (트레이스)

트레이스의 **after** 블록을 실제 채팅처럼 렌더링합니다.
트레이스의 after 는 위 **보기 모드**를 그대로 따릅니다 (실제 이미지 / HTML 코드).
**CBS 전개** 체크박스는 별개입니다.

```
after  [RENDER · CBS]
┌──────────────────────────────────────────────┐
│ *FixtureBot 가 고개를 든다.*                   │
│ 안녕, User.                                   │
│ HP: 42                                        │
│ [ASSET smile_happy.png] [ASSET angry.png]     │
└──────────────────────────────────────────────┘
▸ 소스 보기
```

- **자산**: `{{asset::x}}` / `{{image::x}}` 등을 `parseAdditionalAssets` 처럼 해석합니다
  (정확 일치 → 레벤슈타인 유사도). **charx 안의 이미지를 그대로 꺼내 `blob:` URL 로 넣습니다.**
  `{{raw::x}}` 는 URL 문자열이 되므로 `background:url({{raw::x}})` 같은 카드 CSS 도 그대로 동작합니다.
  (이미지 바이트가 없는 경우에만 자리표시자)
- **카드 CSS**: 블록마다 스코프를 따로 줍니다 (`.simscope-N .x-risu-*`).
  그래야 단계마다 다른 CSS 가 서로 섞이지 않습니다.
- **CBS 전개**: 중간 단계의 after 에는 `{{char}}` 같은 CBS 가 아직 남아 있습니다
  (CBS 는 파이프라인 ④). 켜면 미리보기용으로 한 번 더 전개합니다.
  `소스 보기` 는 항상 원문 그대로입니다.
- 보기 모드가 **HTML 코드** 면 `.rendered` 를 만들지 않고 after 를 `<pre>` 로만 보여줍니다.

## 테스트

```bash
cd risu-sim && node test.js
# → 125 passed, 0 failed
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
| **자산 태그 해석** (`parseAdditionalAssets`) | **1:1** (charx 이미지는 실제 `<img>`/`url()`) | `parser.svelte.ts:486-598` |
| **파일 불러오기** — `.risup` rpack/zlib/msgpack/AES-GCM, `.charx` ZIP, `.risum`, PNG `tEXt` | **1:1** | `database.svelte.ts:2385`, `modules.ts:125`, `characterCards.ts:61` |
| **charx 의 `module.risum` 우선** (정규식·트리거 대체) | **1:1** | `characterCards.ts:158-167` |
| **Lua 트리거 분리** (`effect[0]==='triggerlua'` → Lua 단계) | **1:1** | `scriptings.ts:1496-1512` |
| 플러그인(CJS) | **미탑재** (설계: [`ADDING-RUNTIMES.md`](ADDING-RUNTIMES.md) §5) | — |

### 지원하는 CBS

블록: `#if`, `#if_pure`, `#when`, `#when_pure`, `#pure`, `#puredisplay`, `#code`, `#escape`, `#each`, `{{:else}}`

인라인: `getvar`, `setvar`, `addvar`, `setdefaultvar`, `getglobalvar`, `setglobalvar`,
`char`, `user`, `persona`, `role`, `original`, `mainprompt`, `jb`, `globalnote`,
`blank`, `newline`, `space`, `br`, `comment`, `//`, `data`,
`img`, `image`, `emotion`, `video`, `audio`, `bg`, `raw`, `path`, `source`, `inlay`,
`button`, `ruby`, `tex`, `codeblock`, `debo`, `debc`, `deabo`, `deabc`, `dec`, `;`

`#when` 연산자: `and`, `or`, `is`, `isnot`, `>`, `<`, `>=`, `<=`, `not`, `var`, `vis`, `visnot`, `toggle`, `tis`, `tisnot`

`#when` 의 피연산자는 **먼저 전개한 뒤** `::` 로 나눕니다. 원본은 문자 단위 스캐너라
바깥 태그가 닫히기 전에 안쪽 `{{...}}` 이 이미 전개되어 있기 때문입니다.
`{{#when::{{getvar::x}}::is::y}}` 처럼 변수를 조건에 쓰는 카드가 이 경로를 씁니다.

미지원 태그는 **원문 그대로 남기고** 화면 하단에 목록으로 알려줍니다.

### 원본과 의도적으로 다른 부분

| 항목 | 차이 | 이유 |
|---|---|---|
| 플러그인(CJS) | 생략 | iframe 샌드박스 호스트 필요 (설계: [`ADDING-RUNTIMES.md`](ADDING-RUNTIMES.md) §5) |
| `@@emo` | 감정 이미지 상태를 저장하지 않고 표시만 | 캐릭터 상태 저장소 없음 |
| `@@inject` | 채팅 메시지에 쓰지 않고 본문에서만 제거 | 채팅 DB 없음 |
| `@@repeat_back` | "직전 메시지" 입력 1건만 참조 | 채팅 히스토리 없음 |
| 로어북 발동 | 미구현 (불러와서 개수만 표시) | 스캔·토큰 계산 필요 |
| 에셋 이미지 | charx 안의 이미지만 사용 (원격 URL·data URL 은 자리표시자) | 네트워크/저장소 없음 |
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

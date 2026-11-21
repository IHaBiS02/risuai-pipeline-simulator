# Lua · 트리거 · 플러그인 · 동적 에셋 — 붙이는 순서와 방법

> 대상: [`risu-sim/`](.) 시뮬레이터에 남은 4개 레이어를 어떻게 넣을 것인가
> 기준 소스: RisuAI `6db4b681`
> 현재 상태: **Lua 탑재 완료** (wasmoon, 실제 동작 확인) / 나머지 3개는 설계

---

## 0. 지금 상태

| 레이어 | 상태 | 근거 |
|---|---|---|
| 정규식 3종 · CBS · CSS 스코프 · 새니타이저 | ✅ 1:1 이식 | `test.js` 17/17 |
| **Lua** | ✅ **탑재 완료** | `lua-runtime.js`, wasmoon 1.16.0, `listenEdit` 4종 |
| 트리거 VM | ✅ **탑재 완료** | `trigger-runtime.js` |
| 플러그인 | ⬜ 설계만 | 이 문서 5장 |
| 동적 에셋 | ✅ **탑재 완료** (OpenAI 호환 임베딩) | `asset-runtime.js` |

Lua는 실제로 돌아갑니다. 스크린샷의 `① Lua` 단계에서:
- **before**: `HP: {{getvar::hp}}` — 아직 CBS 전 (Lua가 CBS보다 먼저라는 증거)
- **after**: `… <span class="tag">Lua: hp=42</span>` — `getChatVar` 로 값을 읽어 붙임
- 이후 CBS → 정규식 → DOMPurify → `.chattext` 스코프를 그대로 통과해 화면에 렌더

---

## 1. 넷의 성격 비교 — 왜 순서가 중요한가

| | 삽입 지점 | 읽는 상태 | 쓰는 상태 | 격리 | 필요 런타임 | 이식 난이도 | 얻는 충실도 |
|---|---|---|---|---|---|---|---|
| **Lua** | `processScriptFull()` ① | 변수·채팅 | 변수·채팅 | WASM VM | wasmoon 417KB | 중 | **높음** (동일 엔진) |
| **트리거** | 파이프라인 **바깥 4곳** + Lua 매개 | 변수·채팅·표시상태 | 변수·채팅 | 없음 | 순수 JS | **높음** | 중 (effect 서브셋) |
| **플러그인** | `processScriptFull()` ③ + 요청 전후 | 거의 없음 | 문자열 | iframe | 없음 | 중 | **높음** (훅만) |
| **동적 에셋** | `processScriptFull()` ⑥ (정규식 **뒤**) | 에셋 목록 | 문자열 | 없음 | 선택: 임베딩 | **낮음** | 중 (유사도 엔진 대체) |

핵심 차이는 **삽입 지점의 개수**입니다.

```
유저 입력
  └ runTrigger('input')                    ← 트리거 (파이프라인 바깥)
      └ processScriptFull('editinput')
           ① Lua  ② (display 전용 트리거)  ③ 플러그인  ④ CBS  ⑤ 정규식  ⑥ 동적 에셋
프롬프트 조립
  └ runTrigger('start')                    ← 트리거
      └ processScriptFull('editprocess') × 메시지 수
          └ Lua listenEdit('editRequest')
출력
      └ processScriptFull('editoutput')
          └ runTrigger('output')           ← 트리거
표시
      └ processScriptFull('editdisplay')
           ① Lua  ② runTrigger('display')  ← 트리거   ③ 플러그인  ④ CBS  ⑤ 정규식
```

트리거만 **다섯 곳**에 끼어들고, 그중 한 곳(`triggerlua`)이 Lua를 다시 호출합니다.
나머지 셋은 `processScriptFull` 안의 **한 칸씩**만 차지합니다.

---

## 2. 결론: 이 순서로

### 1) Lua ✅ → 2) 트리거 → 3) 플러그인 → 4) 동적 에셋

이유는 세 가지입니다.

**① 의존 방향이 단방향이다.**
`runLuaEditTrigger`(`scriptings.ts:1478`)는 트리거 배열을 순회하며 `effect[0].type === 'triggerlua'` 인 것만 실행합니다. 즉 **Lua 편집 훅은 이미 트리거 데이터 모델 위에 얹혀 있습니다**. Lua를 먼저 넣어두면 트리거는 "이미 있는 모델에 실행기만 추가"하는 일이 됩니다. 반대 순서면 트리거를 만든 뒤 Lua용으로 다시 뜯어고쳐야 합니다.

**② 트리거가 파이프라인의 "구멍"을 미리 뚫어준다.**
플러그인·동적 에셋은 `processScriptFull` 안의 고정 슬롯이라 나중에 넣어도 기존 코드를 안 건드립니다. 반면 트리거는 `sendChat` 바깥의 stage 경계(`start`/`output`)와 `ParseMarkdown` 진입부(`display`)에 접점을 만듭니다. **자리부터 확정해 두는 게 안전**합니다.

**③ 격리 비용이 큰 것일수록 나중에.**
플러그인 iframe은 RPC·직렬화·디버깅 비용이 크고, 동적 에셋은 임베딩 모델(23MB) 로딩이 붙습니다. 둘 다 **파이프라인 정합성과 무관**하므로 마지막에 붙여도 손실이 없습니다.

---

## 3. 공통 원칙 — "고정 슬롯 + 선택적 구현"

**하지 말 것**: 레이어를 등록 순서로 조립하는 플러그인 아키텍처.
충실도가 목적인 도구에서 등록 순서로 파이프라인이 바뀌면, 시뮬레이터가 시뮬레이션 대상과 달라집니다.

**할 것**: `processScriptFull`의 ①~⑥ 순서를 코드에 그대로 박아두고, 각 슬롯이 모듈 유무를 확인.

```js
// 방향: 슬롯이 모듈을 호출한다. 모듈이 슬롯을 등록하지 않는다.
if (luaMode && window.RisuLua) { data = await RisuLua.runEditHooks(...) }
if (mode === 'editdisplay' && window.RisuTrigger) { data = await RisuTrigger.run('display', ...) }
if (window.RisuPlugin) { data = await RisuPlugin.apply(mode, data) }
data = cbsParse(data, ctx)
data = runRegex(data, mode)
if (window.RisuAssets) { data = await RisuAssets.resolve(data, mode) }
```

각 슬롯은 **항상 trace 1줄**을 남깁니다(`skipped: true` 라도). 그래야 "왜 이 단계가 결과에 영향이 없지?"를 눈으로 확인할 수 있습니다.

---

## 4. 트리거 — 다음 단계

### 4.1 데이터 모델 (원본 그대로)

```ts
triggerscript = {
  comment: string
  type: 'start' | 'input' | 'output' | 'display' | 'request' | 'manual'
  conditions: triggerCondition[]
  effect: triggerEffect[]        // 평평한 배열 + indent 로 중첩 표현
  lowLevelAccess?: boolean
}
```

`effect`는 트리 구조가 아니라 **평평한 배열**이고, `v2If`/`v2Loop`가 `indent`를 갖고 짝이 맞는 `v2EndIndent`까지가 본문입니다. 그래서 재귀 파서가 아니라 **PC + indent 스택 인터프리터**로 짜야 원본과 같아집니다.

### 4.2 반드시 재현해야 하는 4가지 규칙

이 4개를 틀리면 "시뮬레이터에서는 되는데 실기에서는 안 되는" 상황이 생깁니다.

| # | 규칙 | 근거 |
|---|---|---|
| **a** | `effect[0].type === 'triggerlua'` 이면 **`trigger.type` 필터를 건너뛴다** (모든 패스에서 실행됨) | `triggers.ts:1238-1248` |
| **b** | `display` / `request` 패스는 **allowlist에 있는 effect만** 실행 | `triggers.ts:1331-1338` |
| **c** | 재귀 깊이 **10**, `lowLevelAccess` 트리거는 **무제한** | `triggers.ts:1405-1422` |
| **d** | `v2StopTrigger` 는 `index = effect.length` 로 루프 탈출 | `triggers.ts:1826-1829` |

추가로:
- 조건(`conditions`)은 **AND**, 하나라도 실패하면 트리거 전체 스킵 (`triggers.ts:1250-1329`)
- `displayMode: true` 패스에서는 `setVar`가 **tempVars에만** 쓰고 저장하지 않음 (`triggers.ts:1203-1210`)
- `display` 패스는 `char`를 clone하지 않음 (`triggers.ts:1070`)

### 4.3 ⭐ 이게 핵심 — display/request 용 effect는 **35개뿐**이다

원본 코드에 목록이 그대로 있습니다 (`triggers.ts:975-1021`).

```ts
const safeSubset = [
  'v2SetVar','v2If','v2IfAdvanced','v2Else','v2EndIndent','v2LoopNTimes','v2BreakLoop',
  'v2ConsoleLog','v2StopTrigger','v2Random','v2ExtractRegex','v2RegexTest',
  'v2GetCharAt','v2GetCharCount','v2ToLowerCase','v2ToUpperCase','v2SetCharAt',
  'v2SplitString','v2JoinArrayVar','v2ConcatString','v2MakeArrayVar','v2GetArrayVarLength',
  'v2GetArrayVar','v2SetArrayVar','v2PushArrayVar','v2PopArrayVar','v2ShiftArrayVar',
  'v2UnshiftArrayVar','v2SpliceArrayVar','v2SliceArrayVar','v2GetIndexOfValueInArrayVar',
  'v2RemoveIndexFromArrayVar','v2Calculate','v2Comment','v2DeclareLocalVar'
]                                   // 총 35개

displayAllowList = ['v2GetDisplayState','v2SetDisplayState', ...safeSubset]        // 37개
requestAllowList = ['v2GetRequestState','v2SetRequestState','v2GetRequestStateRole',
                    'v2SetRequestStateRole','v2GetRequestStateLength', ...safeSubset] // 40개
```

**즉 표시/요청 단계의 트리거는 40개 effect만 구현하면 100% 동작합니다.** 나머지 80여 개(`runLLM`, `runImgGen`, `v2Command`, `impersonate`, 로어북 CRUD …)는 네트워크·DB·UI가 필요해서 시뮬레이터 범위 밖입니다.

권장 구현 등급:

| 등급 | 대상 | 처리 |
|---|---|---|
| **완전 이식** | safeSubset 35개 + display/request state 5개 | 그대로 구현 |
| **부분** | `v2Calculate`(수식 평가), `v2ExtractRegex`(정규식) | JS `eval` 대신 안전한 파서 |
| **스텁 + 배지** | `runLLM`, `runImgGen`, `v2Command`, `impersonate`, `checkSimilarity`, 로어북 CRUD | "미지원 effect" 로그 남기고 스킵 |
| **완전 무시** | `triggercode` (죽은 타입) | `switch` 에 case 자체가 없음 |

### 4.4 구현 스케치

```js
// RisuTrigger.run(mode, data, ctx)
async function runTrigger(char, mode, arg) {
  const triggers = char.triggerscript.concat(getModuleTriggers());
  const list = triggers.filter(t => shouldRun(t, mode, arg));   // 규칙 a
  let chat = arg.chat;
  for (const t of list) {
    if (!evalConditions(t.conditions, ctx)) continue;           // AND
    const pc = { i: 0, indent: 0, stop: false };
    while (pc.i < t.effect.length && !pc.stop) {
      const ef = t.effect[pc.i];
      if (mode === 'display' && !displayAllowList.includes(ef.type)) { pc.i++; continue; }  // 규칙 b
      executeEffect(ef, pc, ctx, chat);                         // 규칙 c,d 는 내부에서
      pc.i++;
    }
  }
  return { chat, stopSending, sendAIprompt };
}
```

`executeEffect` 는 `v2If` 에서 `indent + 1` 로 push, `v2EndIndent` 에서 pop 하고 조건이 false면 매칭되는 `v2Else`/`v2EndIndent` 로 점프하는 식입니다.

### 4.5 UI

- 트리거 JSON 편집기 (Lua 트리거 편집기와 같은 형태)
- **발화 로그** 패널: 패스별로

```
[start]  #1 "인사말 주입"        조건 ✓ → effect 3개 실행 (v2SetVar: greeting)
[start]  #2 "로어 검색"          조건 ✗ (chatindex 0 < 3)
[display] #3 "HP 바"             effect[0]=triggerlua → 타입 필터 우회, 실행
[display] #4 "이미지 교체"       v2SetVar 는 displayAllowList 에 없음 → 스킵
[output] #5 "LLM 요약"           runLLM → 미지원(스텁)
```

이 로그가 곧 디버깅 도구입니다. "왜 이 트리거가 안 돌지?"의 답이 대부분 여기서 나옵니다.

### 4.6 규모 / 리스크

- 규모: 인터프리터 250줄 + effect 35개 250줄 + UI 120줄 ≈ **600줄**
- 리스크: `v2Calculate` 수식 평가 — 원본은 자체 파서(`calcString`). `eval` 로 대충하면 원본과 결과가 달라질 수 있음 → 원본 `infunctions.ts` 를 이식하는 편이 안전
- 리스크: `indent` 매칭 로직이 미묘함. 원본 루프를 그대로 옮기는 게 정답(추상화하면 어긋남)

---

## 5. 플러그인

### 5.1 실행 모델 — 두 가지를 다 넣는 게 좋다

| 모드 | 방식 | 장점 | 단점 |
|---|---|---|---|
| **직접 실행** (기본) | `new Function('Risuai', code)` 같은 페이지 | `console.log`, 브레이크포인트, `debugger` 그대로 | 격리 없음 |
| **샌드박스** (검증용) | `iframe sandbox="allow-scripts"` + postMessage RPC | 실제 RisuAI와 동일한 격리 | 디버깅 어려움, 직렬화 비용 |

시뮬레이터의 목적이 "내 카드/모듈 디버깅"이라면 **직접 실행이 압도적으로 편합니다**. 반면 "남이 만든 플러그인이 우리 앱에서 어떻게 도나"를 볼 때는 샌드박스가 맞습니다. 토글로 두면 됩니다.

### 5.2 구현할 API는 6개면 충분하다

전체 API v3는 40개가 넘지만, **파이프라인에 영향을 주는 건 6개**입니다.

```js
Risuai.addRisuScriptHandler('input'|'process'|'output'|'display', fn)  // 4개 슬롯
Risuai.addRisuReplacer('beforeRequest'|'afterRequest', fn)             // 요청 2곳
Risuai.addRisuChatListener('output', fn)                               // 관찰 전용
Risuai.onUnload(fn)                                                    // 정리
Risuai.getDatabase()                                                   // 읽기 전용 서브셋
Risuai.log(...)                                                        // 출력
```

⚠️ **이름 매핑 함정**: 내부 Set은 `editdisplay` 인데 API에는 `'display'` 를 넘겨야 합니다. 구현이 `'edit' + name` 으로 조회하기 때문입니다(`plugins.svelte.ts:525`). 시뮬레이터도 이 함정을 **그대로 재현**해야 교육적입니다 — 잘못 넘기면 throw.

### 5.3 순서 문제 — 실제 앱보다 시뮬레이터가 더 결정적이다

실제 RisuAI는 `Promise.all` 로 플러그인을 병렬 로딩합니다(`v3.svelte.ts:1520`). 그래서 **등록 순서가 보장되지 않습니다**(top-level `await` 뒤에 등록하면 순서가 밀림).

시뮬레이터에서는 순차 등록으로 **항상 결정적인 순서**를 만들고, UI에 이렇게 표시하는 걸 권합니다:

```
플러그인 실행 순 = 등록 순 (시뮬레이터는 순차 로딩)
⚠ 실제 RisuAI 는 병렬 로딩이라 이 순서가 보장되지 않습니다.
```

즉 시뮬레이터가 **실기보다 더 친절한 환경**이라는 사실을 숨기지 않는 게 중요합니다.

### 5.4 재진입 가드

`parseRisuChat(text, {processRegex:true})` 는 CBS + `processScriptFull('editprocess')` 를 통째로 다시 돌립니다. `editprocess` 훅 안에서 호출하면 **무한 재귀**이고, 원본에는 가드가 없습니다(`v3.svelte.ts:996-1001`).

시뮬레이터에는 **깊이 3 정도의 가드**를 넣고, 걸렸을 때 화면에 경고를 띄우는 걸 권합니다. 원본의 버그를 재현하는 것보다, 그 버그를 **보여주는** 게 도구로서 더 유용합니다.

### 5.5 UI

- 플러그인 소스 textarea (여러 개, 순서 조정 가능)
- 실행 모드 토글 (직접 / 샌드박스)
- 등록된 훅 목록 표: `display` → 2개, `output` → 1개 …
- trace: ③ 플러그인 단계에서 플러그인별 before/after

### 5.6 규모 / 리스크

- 규모: 직접 실행 모드 **250줄**, iframe 샌드박스 +250줄
- 리스크: `getDatabase` 읽기 전용 서브셋 — 어떤 필드를 허용할지 정해야 함(`allowedDbKeys`, `plugins.svelte.ts:466-494` 참고)
- 리스크: `addRisuScriptHandler` 는 unload 콜백이 등록되지 않는 원본 동작 → 재실행 시 Set 이 누적될 수 있음. 시뮬레이터는 리셋 버튼을 두는 게 안전

---

## 6. 동적 에셋

### 6.1 삽입 지점 — 정확히 여기

`processScriptFull` 의 **정규식 다음**, 그리고 반환 직전입니다(`scripts.ts:345-382`).

```ts
if (db.dynamicAssets && (char.type === 'simple' || char.type === 'character') && char.additionalAssets?.length > 0) {
    if ((!db.dynamicAssetsEditDisplay && mode === 'editdisplay')
        || mode === 'editinput' || mode === 'editprocess') {
        return { data, emoChanged }      // ← 스킵
    }
    ... 에셋 이름 임베딩 → {{image::X}} 의 X 를 최근접 이름으로 치환 ...
}
```

그래서 실제 실행 조건은:

| 모드 | 실행? |
|---|---|
| `editinput` | ❌ 무조건 스킵 |
| `editprocess` | ❌ 무조건 스킵 |
| `editdisplay` | ⚠️ `dynamicAssetsEditDisplay` 가 켜져야만 |
| `editoutput` | ✅ 실행 |

이 표를 UI에 그대로 노출하면 "왜 내 동적 에셋이 표시 단계에서 안 먹지?"에 대한 답이 됩니다.

추가 규칙 3개:
- 치환 결과는 **재-CBS 되지 않는다** (정규식과 다른 점)
- `assetNames` = `char.additionalAssets` + `module.assets` (모듈 에셋 포함)
- 태그 이름이 이미 에셋 목록에 있으면 **검색하지 않음** (정확 일치 우선)
- `bestMatchCache` 키 = `chaId + '::' + assetName`

### 6.2 매칭기 3단

원본은 `HypaProcesser`(transformers.js)로 임베딩 유사도를 씁니다. 기본 모델은 `Xenova/all-MiniLM-L6-v2` 계열이고, 첫 사용 시 수십 MB를 HF에서 받습니다(`hypamemory.ts:15-24`).

시뮬레이터 권장:

| 단 | 방식 | 비용 | 정확도 |
|---|---|---|---|
| 1 | **정확 일치** | 0ms | 완전 |
| 2 | **어휘 유사도** (trigram cosine + Levenshtein 보정) — 기본값 | ~1ms | 근사 |
| 3 | **실제 임베딩** (`Xenova/all-MiniLM-L6-v2`, 토글) | 첫 23MB | **원본과 동일** |

기본은 2단, 토글로 3단. 그리고 결과 표에 **어떤 매칭기로 골랐는지** 배지를 붙이세요.

```
{{image::a happy dog}}  →  [trigram 0.71] "dog_happy.png"      ← 기본
                                 "dog_sad.png"   0.42
                                 "cat.png"       0.11
```

### 6.3 UI

- 에셋 이름 목록 textarea (`name1.png`, `name2.png` …) 또는 JSON
- `dynamicAssets` / `dynamicAssetsEditDisplay` 체크박스 (동작이 갈리는 지점)
- 해석 표 (태그 → 후보 top3 → 선택)
- 매칭기 선택

### 6.4 규모 / 리스크

- 규모: 정확일치 + trigram **120줄**, 임베딩 토글 +80줄, UI 100줄 ≈ **300줄**
- 리스크: 임베딩 경로는 모델 로딩 실패(오프라인/브라우저 제약) 시 폴백이 필요. 원본도 PocketRisu에서 "실패 시 태그 유지"로 고친 이력이 있음
- 리스크: 임베딩 모델이 다르면 결과가 달라짐 → **"동일 모델일 때만 원본과 일치"** 를 UI에 명시

---

## 7. 전부 붙였을 때의 파이프라인

```
[입력]
 ① runTrigger('input')                       ← 트리거
 ② processScriptFull('editinput')
      Lua → (트리거 없음) → 플러그인 → CBS → 정규식 → (동적에셋 스킵)

[프롬프트]
 ③ runTrigger('start')                       ← 트리거 (+triggerlua)
 ④ 메시지마다 processScriptFull('editprocess')
      Lua 없음 → 플러그인 → CBS → 정규식 → (동적에셋 스킵)
 ⑤ Lua listenEdit('editRequest')             ← 배열 전체

[요청]
 ⑥ 플러그인 beforeRequest → provider 템플릿 → bodyIntercepter → HTTP
 ⑦ 플러그인 afterRequest

[출력]
 ⑧ processScriptFull('editoutput')
      Lua → 플러그인 → CBS → 정규식 → 동적 에셋 ✓
 ⑨ runTrigger('output')                      ← 트리거 (+triggerlua)
 ⑩ 플러그인 chatOutput 리스너

[표시]
 ⑪ CBS(visualize) → 자산 해석
 ⑫ processScriptFull('editdisplay')
      Lua → runTrigger('display') → 플러그인 → CBS → 정규식 → (동적에셋: 옵션)
 ⑬ encodeStyle → markdown → DOMPurify → CSS 스코프 → {@html}
```

---

## 8. 다음 단계 체크리스트

- [x] **Lua** — wasmoon, `listenEdit` 4종, 게이팅, `json.lua`
- [x] **트리거** — 조건 평가, indent 인터프리터, safeSubset 35개, 발화 로그, triggerlua
- [ ] **플러그인** — `addRisuScriptHandler` 4슬롯 + replacer 2개, 직접실행/샌드박스 토글
- [x] **동적 에셋** — 삽입 지점 3조건, OpenAI 호환 `/embeddings`, 정확일치→레벤슈타인→임베딩 캐시

각 단계는 **독립적으로 커밋 가능**하고, 하나를 건너뛰어도 나머지가 깨지지 않도록 설계했습니다. 슬롯이 비어 있으면 trace에 "생략"만 남습니다.

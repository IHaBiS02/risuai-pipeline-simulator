# RisuAI / PocketRisu — 봇·모듈·플러그인·프롬의 정규식 / HTML / CSS / Lua 적용 방식과 순서

> 분석 대상
> - `Risuai` — <https://github.com/kwaroran/Risuai> `6db4b681` (2026-11-21), 앱 버전 `2026.10.295`
> - `PocketRisu` — <https://github.com/PocketRisu/PocketRisu> `40851fc9` (2026-11-01), 포크 버전 `1.17.0`
>
> 두 저장소 모두 `src/ts` 이하 코드를 직접 정독한 결과이며, 모든 `파일:라인` 표기는 **RisuAI 기준**입니다.
> PocketRisu는 같은 구조에 패치가 얹힌 포크이고, 차이는 [9장](#9-risuai-vs-pocketrisu--무엇이-다른가)에 정리했습니다.
>
> **실행 가능한 버전**: 이 문서의 파이프라인을 정적 HTML로 옮긴 시뮬레이터가 [`risu-sim/`](risu-sim/README.md) 에 있습니다. (빌드·설치 불필요)

---

## 0. 30초 요약

| 질문 | 답 |
|---|---|
| 네 레이어가 각각 따로 도는가? | **아니다.** 전부 `processScriptFull()` **한 함수**를 통과한다 (`src/ts/process/scripts.ts:99`) |
| 그 안의 고정 순서는? | **Lua → (표시 전용) 트리거 → 플러그인 → CBS → 정규식** |
| 정규식 3종의 순서는? | **프리셋 → 봇(캐릭터) → 모듈** (`scripts.ts:134`) |
| 모듈끼리의 순서는? | **`db.modules` 배열 순서** (켜진 순서·우선순위 필드 아님) (`modules.ts:379-386`) |
| 정렬을 바꾸는 유일한 수단은? | 정규식 `flag`의 **`<order N>`** — 있으면 전체를 **내림차순 안정 정렬** (`scripts.ts:332-334`) |
| Lua가 프롬프트 가공(`editprocess`)에 참여하나? | **못 한다.** `case 'editprocess': return content` (`scriptings.ts:1489-1491`) |
| 프롬(프리셋)이 CSS를 넣을 수 있나? | 프리셋 스키마에 CSS 필드 **없음**. 유일한 경로는 `editdisplay` 정규식 + `<style>` |
| `{{#style}}` CBS 블록이 있나? | **없다.** CSS는 `<style>` 태그 → `encodeStyle()` 후처리로만 처리 |
| CSS 격리는 어떻게? | 모든 셀렉터에 `.chattext ` 프리픽스 + 클래스명 `x-risu-` 개명 (`parser.svelte.ts:964-997`, `88-101`) |
| "Global Regex" 설정이 동작하나? | **동작하지 않는다.** `db.globalscript`는 런타임 참조 0건 (죽은 필드) |

---

## 1. 용어 정리

이 문서에서 쓰는 용어를 먼저 고정합니다. 코드 상의 식별자와 1:1로 대응시켜 두면 이후 설명이 편합니다.

| 사용자 용어 | 코드 상의 실체 | 저장 위치 | 성격 |
|---|---|---|---|
| **봇** | `character` (`type:'character'`) / `groupChat` | `db.characters[]` | 카드. 정규식·트리거·배경HTML·에셋·로어북 보유 |
| **모듈** | `RisuModule` | `db.modules[]` | 봇과 **거의 같은 스키마**의 재사용 묶음 (정규식/트리거/배경/에셋/로어북 + 토글) |
| **플러그인** | API v3.0 iframe 플러그인 | `db.plugins[]` | JS 코드. 훅으로 파이프라인에 개입 |
| **프롬** | `botPreset` (프롬프트 프리셋) | `db.botPresets[]`, 활성본은 `db.*`로 복사됨 | 프롬프트 템플릿 + 파라미터 + `presetRegex` |

### 봇과 모듈은 사실상 같은 것이다

`src/ts/interchangeability.ts:6-53` / `55-120`을 보면 양방향 변환이 1:1로 성립합니다.

| 모듈 필드 | 캐릭터 필드 |
|---|---|
| `regex` | `customscript` |
| `trigger` | `triggerscript` |
| `backgroundEmbedding` | `backgroundHTML` |
| `assets` | `additionalAssets` |
| `lorebook` | `globalLore` |
| `customModuleToggle` | `customModuleToggle` |

즉 **모듈 = "캐릭터에서 이름/첫 메시지/감정 이미지를 뺀 것"**입니다. 그래서 실행 파이프라인도 정규식은 `char.customscript`와 `module.regex`를 단순히 이어붙이고(`scripts.ts:134`), 트리거도 `char.triggerscript`와 `module.trigger`를 이어붙입니다(`triggers.ts:1081-1084`). **레이어가 다르다기보다 같은 배열의 다른 구간**이라고 이해하는 편이 정확합니다.

---

## 2. 아키텍처 — 단일 관문 `processScriptFull`

네 레이어(봇/모듈/플러그인/프롬)의 정규식·Lua·플러그인 훅은 **모두 이 함수 하나**를 지나갑니다.

```ts
// src/ts/process/scripts.ts:99-143 (요약)
export async function processScriptFull(char, data, mode, chatID = -1, cbsConditions = {}){
    let db = getDatabase()

    // ① Lua 편집 훅 (editinput / editoutput / editdisplay / editrequest 만)
    data = await runLuaEditTrigger(char, mode, data, { index: chatID })

    // ② 표시 단계 전용 트리거 (trigger 'display')
    if(mode === 'editdisplay' && currentChar.type !== 'group'){
        data = (await runTrigger(currentChar, 'display', {...})).displayData ?? data
    }

    // ③ 플러그인 훅
    for(const plugin of pluginV2[mode]) { data = await plugin(data) ?? data }

    // ④ CBS ({{...}}) 1회
    data = risuChatParser(data, { chatID, cbsConditions })

    // ⑤ 정규식: 프리셋 → 봇 → 모듈
    const scripts = (db.presetRegex ?? [])
        .concat(char.customscript)
        .concat(getModuleRegexScripts())

    // ⑥ 캐시 히트면 ⑤만 건너뛰고 반환
    ...
}
```

### 이 구조가 만드는 핵심 성질 4가지

1. **플러그인은 항상 CBS보다 먼저다.** 따라서 플러그인이 반환한 텍스트 안의 `{{...}}`는 플러그인 실행 **이후**에 전개됩니다.
2. **플러그인은 항상 정규식보다 먼저다.** 따라서 플러그인이 만든 텍스트도 봇/프리셋/모듈 정규식을 탑니다. 반대 방향은 불가능합니다.
3. **CBS는 정규식보다 먼저 한 번 돈다.** 정규식 `in`은 CBS가 전개된 **뒤의** 문자열을 매칭합니다. 게다가 정규식 치환 결과는 매번 다시 CBS로 재파싱됩니다(`scripts.ts:248`, `291`).
4. **한 번의 호출이 곧 한 레이어의 완결된 실행**이다. 네 레이어의 정규식이 섞여 있다는 사실은 `scripts` 배열을 만드는 134행에서만 드러납니다.

---

## 3. 다섯 개의 실행 지점(모드)

`ScriptMode`는 5개입니다 (`scripts.ts:18`).

```ts
export type ScriptMode = 'editinput' | 'editoutput' | 'editprocess' | 'editdisplay'
//   + 정규식 전용 'edittrans' (translator.ts 에서만 실행)
```

| 모드 | 한국어 UI 라벨 (`src/lang/ko.ts`) | 언제 | 무엇을 입력으로 | 어디서 호출 |
|---|---|---|---|---|
| `editinput` | 입력문 수정 | 유저가 전송할 때 | 유저가 친 원문 | `DefaultChatScreen.svelte:195` |
| `editprocess` | 리퀘스트 데이터 수정 | 프롬프트 조립 시 | **메시지 원문**(조립된 프롬프트 아님) | `index.svelte.ts:873, 902` |
| `editoutput` | 출력문 수정 | 모델 응답 직후 | 모델 원문 (스트리밍이면 청크마다) | `index.svelte.ts:1657, 1716, 1742, 1806, 1810` |
| `editdisplay` | 디스플레이 수정 | 화면에 그리기 직전 | 저장된 메시지 | `parser.svelte.ts:759` (ParseMarkdown 내부) |
| `edittrans` | (번역 후) | 번역 결과에 | 번역된 텍스트 | `translator.ts:640-712` |

> **`editrequest`라는 ScriptMode는 없습니다.** 프롬프트 **배열 전체**를 만지는 것은 Lua 전용 훅 `listenEdit('editRequest')`이며, `index.svelte.ts:1493`에서 직접 호출됩니다. `processScriptFull`을 거치지 않습니다.

### 3.1 `mode`별로 실제로 무엇이 도는가

| | Lua 훅 | 트리거 | 플러그인 | CBS | 정규식 |
|---|---|---|---|---|---|
| `editinput` | ✅ `editInput` | (`runTrigger('input')`가 별도로 먼저) | ✅ | ✅ | ✅ |
| `editprocess` | ❌ **없음** | ❌ | ✅ | ✅ | ✅ |
| `editoutput` | ✅ `editOutput` | (`runTrigger('output')`가 별도로 나중) | ✅ | ✅ | ✅ |
| `editdisplay` | ✅ `editDisplay` | ✅ `display` | ✅ | ✅ | ✅ |

`editprocess`에 Lua가 없다는 점은 실무에서 자주 발목을 잡습니다. 프롬프트를 Lua로 손보려면 **`editRequest`(배열 단위)** 를 써야 하고, 그것도 카드/로어북 텍스트 각각에는 닿지 않습니다.

---

## 4. 전체 타임라인

한 번의 응답 생성에서 일어나는 일을 순서대로 나열합니다. **굵게** 표시된 것이 네 레이어가 개입하는 지점입니다.

### 4.1 유저 입력 단계

```
① runTrigger(char, 'input')                        DefaultChatScreen.svelte:187
     └ 봇 트리거 → 모듈 트리거 (모듈은 db.modules 순)
     └ Lua: onInput(id)

② processScript(char, input, 'editinput')
     ├ Lua  listenEdit('editInput')   (봇 트리거 → 모듈 트리거 순, 각자 등록 순)
     ├ 플러그인 addRisuScriptHandler('input')
     ├ CBS
     └ 정규식: 프리셋 → 봇 → 모듈  (+ <order N> 재정렬)

③ 채팅에 user 메시지로 저장
```

### 4.2 프롬프트 조립 단계 (stage 1)

```
④ 첫 메시지(그리팅)
     risuChatParser(fm)  →  processScript(..., 'editprocess')
        ├ 플러그인 editprocess → CBS → 정규식(editprocess)

⑤ runTrigger(char, 'start')                        index.svelte.ts:888
     └ 봇 트리거 → 모듈 트리거 / Lua: onStart
     └ stopSending 반환 시 여기서 중단

⑥ 히스토리 메시지마다 반복                          index.svelte.ts:901-906
     risuChatParser(msg.data, {role})   ← 바깥 CBS (role 컨텍스트 있음)
       →  processScriptFull(..., 'editprocess')
            ├ 플러그인 editprocess
            ├ CBS                        ← 안쪽 CBS (role 없음)
            └ 정규식(editprocess)
     ※ 여기서 나온 결과가 이후 groupTemplate / sendName 으로 감싸짐
       → 정규식은 래퍼를 보지 못한다

⑦ 프롬프트 템플릿 카드 순회 → OpenAIChat[] 조립      index.svelte.ts:1271-1468
     (plain/chat/lorebook/description/postEverything/authornote/persona/memory/cache)
     ※ 카드 content 안의 CBS는 innerFormat 단계에서 전개
     ※ 연속 system 메시지는 \n\n 로 병합 (gpt/claude/openrouter/reverse_proxy)

⑧ char.depth_prompt 삽입                            index.svelte.ts:1484-1491

⑨ Lua listenEdit('editRequest')  ← 배열 전체         index.svelte.ts:1493

⑩ 토큰 재검사 → removable 메시지부터 비움            index.svelte.ts:1500-1527
```

### 4.3 요청 단계 (stage 3)

```
⑪ 플러그인 replacerbeforeRequest  (재시도마다 재실행)   request.ts:239-243
⑫ Lua/트리거 'request' (safeSubset only, Lua 불가)     triggers.ts (requestAllowList)
⑬ provider body 직렬화 (applyChatTemplate / stringlize / Anthropic system hoist 등)
⑭ bodyIntercepter (플러그인, provider 태그별)
⑮ HTTP 전송
⑯ 응답 → escape → 플러그인 replacerafterRequest        request.ts:285-289
```

### 4.4 출력 단계 (stage 4)

```
⑰ processScriptFull(..., 'editoutput')
     ├ Lua listenEdit('editOutput')
     ├ 플러그인 addRisuScriptHandler('output')
     ├ CBS
     └ 정규식: 프리셋 → 봇 → 모듈
   ※ 스트리밍 시: 청크마다 호출. 단 balanced/strong 성능 모드에서는
      125ms 디바운스로 묶고, deferStreamingPostProcessing 이면 아예 생략

⑱ 채팅에 char 메시지로 커밋
⑲ runCurrentChatFunction → risuChatParser(msg.data, {runVar:true}) 재실행
⑳ runTrigger(char, 'output')                        index.svelte.ts:1763, 1871
     └ Lua: onOutput
㉑ 플러그인 chatOutput 리스너 (관찰 전용, 반환값 무시)
㉒ TTS (addTTSPreprocessor → 합성 → addTTSPostprocessor)
```

### 4.5 표시 단계

```
㉓ risuChatParser(data, {visualize:true})   ← 표시용 CBS 1차
㉔ ParseMarkdown(data, char, mode, chatID)
     ├ parseAdditionalAssets          ({{image::}}, {{emotion::}} 등 자산 해석)
     ├ processScriptFull(..., 'editdisplay')
     │    ├ Lua listenEdit('editDisplay')
     │    ├ runTrigger(char, 'display')   ← trigger 타입 'display'
     │    ├ 플러그인 addRisuScriptHandler('display')
     │    ├ CBS
     │    └ 정규식: 프리셋 → 봇 → 모듈
     ├ parseAdditionalAssets (변경 시 2차)
     ├ parseInlayAssets               ({{inlay::}})
     ├ parseThoughtsAndTools          (<Thoughts> → <details>)
     ├ encodeStyle                    (<style> → <risu-style>HEX)
     ├ renderHighlightableMarkdown    (markdown-it, html:true)
     └ trimMarkdown                   (DOMPurify → <risu-style> 복원 + CSS 스코프)
㉕ {@html} 로 DOM 삽입
```

---

## 5. 레이어별 상세

### 5.1 봇(캐릭터 카드) 레이어

#### 가진 것

`character` 인터페이스(`storage/database.svelte.ts`)에서 파이프라인에 실제로 쓰이는 필드만 추리면:

| 필드 | 쓰이는 곳 | 매체 |
|---|---|---|
| `customscript[]` | 정규식 3종 중 2번째 | 정규식 |
| `triggerscript[]` | `runTrigger` (start/input/output/display/request/manual) | Lua/로직 |
| `backgroundHTML` | `BackgroundDom.svelte:17` | HTML/CSS |
| `additionalAssets` | `parseAdditionalAssets` | HTML |
| `systemPrompt` | 레거시 프롬프트 모드에서만 `main` 버킷 | 텍스트 |
| `depth_prompt` | 조립 후 삽입 | 텍스트 |
| `globalLore` | 로어북 | 텍스트 |
| `lowLevelAccess` | 트리거 Lua 게이팅 | 권한 |

#### 정규식

- 저장 타입은 `{ comment, in, out, type, flag?, ableFlag? }` (`database.svelte.ts:1321-1329`).
- 실행 시점: `editinput` / `editoutput` / `editprocess` / `editdisplay` 네 모드 모두.
- 순서: 항상 **프리셋 다음, 모듈 앞** (`scripts.ts:134`).

#### HTML / CSS

- `backgroundHTML`은 `BackgroundDom.svelte`에서 **모듈의 `backgroundEmbedding`과 문자열로 합쳐진 뒤** `ParseMarkdown(..., 'back')`으로 렌더됩니다.
  ```svelte
  <!-- src/lib/ChatScreens/BackgroundDom.svelte:17 -->
  {#await ParseMarkdown(
      risuChatParser((backgroundHTML || '') + '\n' + ($moduleBackgroundEmbedding || ''), {chara:currentChar}),
      currentChar, 'back') then md}
      {@html md}
  {/await}
  ```
- `'back'` 모드는 마크다운 렌더를 생략하지만 **`editdisplay` 정규식 → `encodeStyle` → DOMPurify → CSS 스코프**는 그대로 수행합니다. 즉 배경 HTML도 메시지와 동일한 살균 경로를 탑니다.
- `{{bg::<asset>}}` CBS는 `mode === 'back'`일 때만 실제 배경 div를 만듭니다(`parser.svelte.ts:571-575`).

#### Lua

- 봇은 `triggerscript[]`를 통해 Lua를 씁니다. 실행 경로는 두 가지입니다.
  1. **`runTrigger` 경유**: `trigger.trigger`가 `start`/`input`/`output`/`manual` 등일 때, `effect[0].type === 'triggerlua'`이면 실행 (`triggers.ts:1559-1574`). Lua 쪽 함수명은 `onStart`/`onInput`/`onOutput`/임의 이름(수동).
  2. **`runLuaEditTrigger` 경유**: `listenEdit('editInput'|'editOutput'|'editDisplay')`로 등록한 콜백들.
- **주의**: `runLuaEditTrigger`는 `char.triggerscript`를 순회하면서 `v.lowLevelAccess = false`를 **원본 객체에 대입**합니다(`scriptings.ts:1496-1499`). 그리고 훅 실행 시 `lowLevelAccess: false`를 하드코딩합니다(`:1505`). 즉 편집 훅에서는 LLM/네트워크 API를 못 씁니다.

---

### 5.2 모듈 레이어

#### 구조

`RisuModule` (`modules.ts:19-35`):

```ts
export interface RisuModule{
    name: string
    description: string
    lorebook?: loreBook[]
    regex?: customscript[]
    cjs?: string                    // ← 죽은 필드 (아래 참고)
    trigger?: triggerscript[]
    id: string
    lowLevelAccess?: boolean
    hideIcon?: boolean
    backgroundEmbedding?: string
    assets?: [string, string, string][]
    namespace?: string
    customModuleToggle?: string
    mcp?: MCPModule
    icon?: string
}
```

- `cjs`는 **한 번도 사용된 적 없는 죽은 필드**입니다. 저장소 전체에서 `plugins.svelte.ts`조차 참조하지 않습니다.
- Lua는 별도 필드가 아니라 **`trigger[0].effect[0] = { type:'triggerlua', code }`** 형태로 저장됩니다.
- `mcp`가 있으면 모듈이 아니라 "MCP 서버 묶음"이 되어 UI 편집/내보내기가 막힙니다(`modules.ts`, `interchangeability.ts:9-11`).

#### 파일 포맷

| 포맷 | 구조 |
|---|---|
| `.risum` | `[111][0][uint32 len][rpack(JSON)]` + `[1][len][rpack(asset)]` 반복 + `[0]` (`modules.ts:61-123`, `125-258`) |
| `.charx` 내 `module.risum` | ZIP 엔트리명이 정확히 `module.risum` |
| JSON | `{ type:'risuModule', module: RisuModule }` |

`module.json`이라는 파일은 두 저장소 어디에도 없습니다. `.module` 확장자는 `LocalWriter.init(module.name + '.module', ['charx'])`의 **출력 파일명**일 뿐입니다(`modules.ts:51`).

#### 어떤 모듈이 "켜져" 있는가

`getModules()` (`modules.ts:401-432`):

```ts
let ids = db.enabledModules ?? []
if (currentChat)                   ids = ids.concat(currentChat.modules ?? [])
if (character?.modules)            ids = ids.concat(character.modules)
if (persona?.embeddedModule)       ids = ids.concat([persona.embeddedModule.id])
if (db.moduleIntergration)         ids = ids.concat(intList)   // "a,b,c"
```

즉 5개 경로(전역 / 채팅 / 캐릭터 / 페르소나 내장 / namespace 통합)로 켤 수 있습니다. UI에서 **좌클릭 = 채팅 단위, 우클릭 = 캐릭터 단위**입니다.

#### ⚠️ 모듈 실행 순서의 결정 규칙

```ts
// modules.ts:379-386
function getModuleByIds(ids:string[]){
    const idSet = new Set(ids)
    const modules = db.modules.filter(m =>
        idSet.has(m.id) || (m.namespace && idSet.has(m.namespace))
    )
    return deduplicateModuleById(modules)
}
```

**필터 대상이 `db.modules`이므로, 결과 순서는 `db.modules` 배열 순서입니다.** `enabledModules`에 넣은 순서, 채팅에 붙인 순서, 캐릭터에 붙인 순서는 **전혀 무관**합니다. `deduplicateModuleById`는 id 기준 첫 등장만 남깁니다.

이건 실무에서 중요한 함정입니다. "모듈 A를 먼저 켰으니 A가 먼저 돌겠지"가 성립하지 않고, **모듈 라이브러리 목록의 정렬 순서**가 실행 순서를 결정합니다.

#### 정규식 / 트리거 / 배경

| 매체 | 진입점 | 순서 |
|---|---|---|
| 정규식 | `getModuleRegexScripts()` (`modules.ts:481-493`) | `db.modules` 순, 각 모듈의 `regex` 배열 순 |
| 트리거 | `getModuleTriggers()` (`modules.ts:464-479`) | `db.modules` 순, `module.trigger` 배열 순 |
| 배경 HTML/CSS | `moduleUpdate()` (`modules.ts:565-581`) | `'\n' + bg + '\n'` 로 **누적** 후 `moduleBackgroundEmbedding` 스토어에 set |
| 에셋 | `getModuleAssets()` (`modules.ts:449-461`) | `db.modules` 순으로 concat |
| 토글 | `getModuleToggles()` (`modules.ts:495-507`) | `customModuleToggle` 문자열 누적 |

#### 모듈 토글의 실체

`customModuleToggle`은 "토글 선언문"이고, 소비처는 `parseToggleSyntax()`(`util.ts:1049-1098`)입니다. 문법은 **줄 단위** `key=label[=type[=options]]`:

```
cot=COT 토글
tone=말투=select=정중,반말,냉소
name=이름=text
grp=그룹=group
grp=그룹=groupEnd
```

값은 **전역 채팅 변수 `toggle_<key>`** 에 저장되고(`globalChatVariables`), 모듈 쪽에서는 CBS로만 읽습니다:

```
{{#when::toggle::cot}} ... {{/when}}
{{getglobalvar::toggle_cot}}
```

즉 **모듈의 조건부 분기는 코드가 아니라 CBS 문자열**입니다. 프롬프트 템플릿 카드에는 토글 메타데이터가 없습니다(`PromptItem`에 `toggle`/`condition` 필드 없음).

#### ⚠️ `moduleUpdate()`의 스토어 미초기화 버그

```ts
// modules.ts:579-581
if(backgroundEmbedding){
    moduleBackgroundEmbedding.set(backgroundEmbedding)
}
```

`else` 분기가 없습니다. 모듈을 모두 끄거나 배경을 지워도 스토어가 **이전 값으로 남습니다**.

---

### 5.3 플러그인 레이어 (API v3.0)

#### 존재하지 않는 API 이름들 (먼저 정정)

문서에서 흔히 언급되는 아래 이름들은 **두 저장소 모두에 없습니다** (grep 0건):

| 흔히 쓰이는 이름 | 실제 API |
|---|---|
| `Risuai.hooks` | 없음 (훅별 개별 등록 함수) |
| `onBeforeRequest` | `addRisuReplacer('beforeRequest', fn)` |
| `onAfterRequest` | `addRisuReplacer('afterRequest', fn)` |
| `onMessageRendered` | `addRisuScriptHandler('display', fn)` + `addRisuChatListener('output', fn)` |
| `registerStyle` | 없음 (CSS는 4가지 우회 경로) |
| `editRequest` / `editDisplay` 훅 | **플러그인 API 아님** — Lua/트리거 모드 이름 |

#### 훅 이름 매핑의 함정

내부 Set 이름은 `editdisplay`인데, API에는 **`'display'`** 를 넘겨야 합니다. 구현이 `'edit' + name`으로 조회하기 때문입니다.

```ts
// plugins.svelte.ts:525-532
addRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
    if (pluginV2['edit' + name]) { pluginV2['edit' + name].add(func) }
    else { throw (`script handler named ${name} not found`) }
}
```

| API에 넘길 값 | 실제 Set | 발화 지점 |
|---|---|---|
| `'input'` | `pluginV2.editinput` | `DefaultChatScreen.svelte:195` |
| `'process'` | `pluginV2.editprocess` | `index.svelte.ts:873, 902` |
| `'output'` | `pluginV2.editoutput` | `index.svelte.ts:1657, 1716, 1742, 1806, 1810` |
| `'display'` | `pluginV2.editdisplay` | `parser.svelte.ts:759` |

`'editdisplay'`를 넘기면 `pluginV2['editeditdisplay']`가 없으므로 **throw**합니다.

#### 전체 훅 목록

| 분류 | 내부 Set | API | 발화 지점 | 특성 |
|---|---|---|---|---|
| 텍스트 | `editinput` | `addRisuScriptHandler('input')` | 입력 | 문자열 변환 |
| 텍스트 | `editprocess` | `addRisuScriptHandler('process')` | 프롬프트 조립 | 문자열 변환 |
| 텍스트 | `editoutput` | `addRisuScriptHandler('output')` | 출력 | 문자열 변환 |
| 텍스트 | `editdisplay` | `addRisuScriptHandler('display')` | 표시 직전 | 문자열 변환 |
| 요청 | `replacerbeforeRequest` | `addRisuReplacer('beforeRequest')` | HTTP 직전 | `OpenAIChat[]` 변환, **재시도마다** |
| 요청 | `replacerafterRequest` | `addRisuReplacer('afterRequest')` | 응답 직후 | 문자열 변환 |
| 요청 | `bodyIntercepter` | `registerBodyIntercepter` | 직렬화된 body | provider 태그별 |
| 관찰 | `chatOutput` | `addRisuChatListener('output')` | 메시지 커밋 후 | **반환값 무시** |
| TTS | (배열) | `addTTSPreprocessor` / `addTTSPostprocessor` | TTS 전후 | 순차 |
| 공급자 | `providers` | `addProvider` | 모델 호출 | `mode='v3'` 강제 |
| 정리 | `unload` | `onUnload` | 플러그인 해제 | 1초 타임아웃 |

#### ⚠️ 플러그인 실행 순서는 "보장되지 않는다"

컨테이너는 삽입 순서를 보존합니다(`Set`, 배열). 소비 측도 항상 `for (const p of pluginV2[mode])`입니다. 그런데 **v3 로딩이 병렬**입니다:

```ts
// v3.svelte.ts:1520
const loadPromises = plugins.map(plugin => executePluginV3(plugin));
await Promise.all(loadPromises);
```

각 플러그인의 유저 코드는 iframe 로드 후 비동기로 시작하고, 초기화 RPC를 await한 뒤에 등록합니다. 따라서 **top-level `await` 뒤에 등록하는 플러그인은 순서가 밀립니다**. 권한 프롬프트(`await getPermission(...)`)도 마찬가지로 순서를 바꿉니다.

정렬/우선순위 필드는 **없습니다**. 순서 제어 수단은 (a) `db.plugins` 배열 순서, (b) 정규식의 `<order N>` 두 가지뿐입니다.

#### HTML / CSS 주입 경로

| # | 경로 | 살균 | 스코프 | 중복 제거 |
|---|---|---|---|---|
| 1 | `editdisplay` 반환값 (권장) | DOMPurify | `.chattext` + `x-risu-` | 없음 |
| 2 | `editdisplay`로 넣은 `<style>` | 살균 후 복원(CSS는 sanitizer 미경유) | `.chattext` + `x-risu-` | 없음 |
| 3 | `setChatPanel(html, {id})` | DOMPurify 기본 | — | `id` 기준 교체 |
| 4 | `getRootDocument()` + `mainDom` 권한 | `setInnerHTML`만 DOMPurify | **없음(전역)** | 없음 |
| 5 | `setDatabaseLite({customCSS})` | 무살균 | **전역** | `<style id="customcss">` 단일 요소 재사용 |
| 6 | `setDatabaseLite({guiHTML})` | DOMParser만 | **전역** | — |

**플러그인 전용 background API는 없습니다.** 배경을 만지려면 `setCharacter()`로 `char.backgroundHTML`을 쓰거나 4·5번 경로를 씁니다.

#### 보안 모델

```ts
// apiV3/factory.ts:466
connect-src 'none'; script-src 'nonce-...' 'wasm-unsafe-eval';
frame-src 'none'; object-src 'none'; style-src * 'unsafe-inline';
default-src 'none'; img-src * data: blob:; ...
```

```ts
// factory.ts:814-818
iframe.sandbox.add('allow-scripts'); .add('allow-modals'); .add('allow-downloads');
// allow-same-origin 없음 → opaque origin
```

- `allow-same-origin`이 없어 부모 DOM/쿠키/스토리지 직접 접근 불가.
- `connect-src 'none'`이라 iframe 내부 `fetch` 불가 → 반드시 호스트 경유.
- 권한 8종: `fetchLogs`, `db`, `dbWrite`, `mainDom`, `replacer`, `provider`, `sendChat`, `inlay`.
- `dbWrite`는 `setDatabase`/`setDatabaseLite`/`setCharacter` 등에 자동 요구됩니다.
- `setDatabase` 계열은 `plugins` 키를 **제거한 뒤** 적용합니다.

#### 재진입 위험

`parseRisuChat(text, {processRegex:true})`는 CBS + `processScriptFull(..., 'editprocess')`를 **통째로** 다시 돌립니다(`v3.svelte.ts:996-1001`).

```ts
if(!options?.processRegex){ return parsed; }
return (await processScriptFull(char, parsed, 'editprocess', chatID, cbsConditions)).data;
```

`editprocess` 훅 안에서 이걸 호출하면 **자기 자신이 다시 호출**됩니다. 깊이 제한이 없습니다. CBS 쪽에는 `callStack > 20` 가드가 있지만(`parser.svelte.ts:1664-1668`) 플러그인 훅 재귀는 그 카운터에 포함되지 않습니다.

---

### 5.4 프롬(프리셋/프롬프트) 레이어

#### 구조

`botPreset`에는 **CSS/HTML 필드가 하나도 없습니다**. `theme`, `css`, `customCSS`, `backgroundHTML`, `guiHTML` 전부 없습니다. `presetTemplate`도 마찬가지입니다.

프리셋이 담는 것은:
- `promptTemplate: PromptItem[]` — 프롬프트 카드 배열
- `regex: customscript[]` — 활성화되면 `db.presetRegex`로 복사됨
- 각종 파라미터(`temperature`, `maxResponse`, `seperateModels`, …)

#### `presetRegex`의 동작

복사가 아니라 **프리셋별 스냅샷 교체**입니다.

```ts
// database.svelte.ts:2151 (saveCurrentPreset)
regex: db.presetRegex,

// database.svelte.ts:2276 (setPreset ← changeToPreset)
db.presetRegex = newPres.regex ?? []
```

| 동작 | 결과 |
|---|---|
| 프리셋 A → B 전환 | A에 현재 `db.presetRegex` 저장 → `db.presetRegex`를 B의 `regex`로 **덮어쓰기(병합 없음)** |
| B에 `regex` 없음 | `?? []` → **기존 정규식이 전부 사라짐** |
| 정규식 편집 | UI가 `db.presetRegex`를 직접 바인딩(`BotSettings.svelte:796`) → 즉시 반영, 단 프리셋 객체에는 전환/복사 시점에만 기록 |

#### ⚠️ `db.globalscript`는 죽은 필드

`src/lib/Setting/Pages/GlobalRegex.svelte`에 "Global Regex Script" 설정 페이지가 있고 `db.globalscript`에 바인딩되지만, **런타임에서 읽는 곳이 없습니다**.

```
grep 결과:
  src/lib/Setting/Pages/GlobalRegex.svelte:11,14,21  (UI)
  src/ts/process/scripts.ts:32                       (exportRegex 기본값)
  src/ts/storage/database.svelte.ts:352,913          (스키마)
  → processScriptFull 은 읽지 않음
```

git 이력상 2024-12-26 커밋 `2672195d`에서 `db.globalscript` → `db.presetRegex`로 교체되었고, 그 뒤로 이 필드는 export/import 전용으로 남았습니다. **"전역 정규식"을 쓰려면 프리셋 정규식에 넣어야 합니다.**

#### 프롬프트 조립 구조 (2-pass)

```ts
// index.svelte.ts:362-364
let promptTemplate = safeStructuredClone(DBState.db.promptTemplate)
const usingPromptTemplate = !!promptTemplate
```

- 템플릿 모드: `promptTemplate`이 배열이면(빈 배열도 truthy) **카드 순서 그대로**.
- 레거시 모드: `null`이면 `db.formatingOrder` 사용. 기본값은
  `['main','description','personaPrompt','chats','lastChat','jailbreak','lorebook','globalNote','authorNote']` + `postEverything` 강제 마지막.

같은 템플릿을 **두 번** 순회합니다:

| 패스 | 위치 | 목적 |
|---|---|---|
| 1차 | `index.svelte.ts:676-824` | 토큰 계산만 |
| 2차 | `index.svelte.ts:1271-1468` | 실제 `OpenAIChat[]` 생성 |

##### `unformated` 버킷 10개

`main, jailbreak, chats, lorebook, globalNote, authorNote, lastChat, description, postEverything, personaPrompt`

| 카드 타입 | 방출 내용 |
|---|---|
| `plain` / `jailbreak` / `cot` | 카드 `text` 한 개 (`jailbreakToggle` off면 jailbreak skip, `chainOfThought` off면 cot skip) |
| `chat` | `unformated.chats.slice(rangeStart, rangeEnd)` |
| `chatML` | `parseChatML(card.text)` |
| `lorebook` | `unformated.lorebook` |
| `description` | prefix + desc + additionalInfo + personality + scenario |
| `postEverything` | 각종 잔여물 (CoT, 그룹 지시문, depth 0 로어북, 트리거 promptend) |
| `authornote` | `chat.note` 또는 기본 텍스트 |
| `persona` | `db.personaPrompt` |
| `memory` | `memories[]` |
| `cache` | 방출 없음, 뒤 `depth`개 메시지에 `cachePoint` 마킹 |

##### ⚠️ 템플릿 모드에서 `main`/`jailbreak`/`globalNote`는 채워지지 않는다

`index.svelte.ts:410`의 조건이 `(!promptTemplate)`이기 때문입니다. 즉:

- `char.systemPrompt`는 **템플릿 모드에서 완전히 무시**됩니다(사용처가 411행 하나뿐).
- `db.mainPrompt` / `db.jailbreak` / `db.globalNote`는 자동 주입되지 않고, `{{mainprompt}}` / `{{jb}}` / `{{globalnote}}` CBS(`cbs.ts:309, 374, 384`)로만 접근할 수 있습니다.

##### `pushPrompts`의 system 병합

```ts
// index.svelte.ts:1235-1258
if(chat.role === 'system'){
    const endf = formated.at(-1)
    if(endf && endf.role === 'system' && endf.memo === chat.memo && endf.name === chat.name){
        formated[formated.length - 1].content += '\n\n' + chat.content
    }
    ...
}
```

`gpt`/`claude`/`openrouter`/`reverse_proxy`에서 **연속된 system 메시지가 하나로 합쳐집니다**. 카드 순서를 설계할 때 이 병합을 고려해야 합니다.

#### 프롬이 HTML/CSS를 넣는 유일한 경로

프리셋 스키마에 CSS 필드가 없으므로, 남은 경로는 **`editdisplay` 정규식**입니다.

```
프리셋 regex(type='editdisplay')
  → processScriptFull('editdisplay')  (표시 단계)
  → 출력 문자열이 그대로 DOM으로
  → encodeStyle → DOMPurify → CSS 스코프
```

이때 `editdisplay`는 마크다운과 HTML, `<style>`까지 받습니다. 다만 스코프는 메시지 본문과 동일하게 `.chattext` + `x-risu-` 규칙을 따릅니다.

> PocketRisu에는 `themePresets`라는 **별도 축**이 있어 `customCSS`/`guiHTML`/`theme`을 프리셋처럼 묶을 수 있지만, 이는 프롬프트 프리셋과 다른 기능입니다.

#### 토글/조건 평가에서의 함정

`#when`은 false여도 내부 CBS를 **그대로 실행**합니다(내용만 잘려나감). 반면 `#if`는 false면 내부를 평가하지 않습니다(`parser.svelte.ts:1214-1224`, `1832`).

```
{{#when::toggle::cot}}{{setvar::x::1}}{{/when}}   ← cot가 꺼져 있어도 setvar 실행됨
{{#if {{getglobalvar::toggle_cot}}}}{{setvar::x::1}}{{/if}}   ← 꺼져 있으면 미실행
```

부작용이 있는 CBS를 토글로 감쌀 때는 `#if`를 써야 합니다.

---

## 6. 매체별 적용 방식

### 6.1 정규식 (Regex Script)

#### 스키마

```ts
export interface customscript{
    comment: string
    in: string          // 정규식 본문
    out: string         // 치환 문자열
    type: string        // 'editinput' | 'editoutput' | 'editprocess' | 'editdisplay' | 'edittrans'
    flag?: string       // 'g', 'i', 'gi', '<order 5,cbs>', ...
    ableFlag?: boolean  // flag/특수 문법 사용 여부
}
```

#### 실행 알고리즘

```ts
// scripts.ts:145-293 (요약)
if(script.in === '') return                         // 빈 in은 무조건 스킵
if(script.type !== mode) return                      // 타입 완전 일치

let outScript = script.out.replaceAll("$n", "\n")     // $n → 개행
outScript = outScript.replace(/{{data}}/g, "$&")      // {{data}} 이스케이프

let flag = script.ableFlag ? (script.flag || 'g') : 'g'
if(move_top|move_bottom) flag = flag.replace('g','')  // 전역 플래그 강제 제거
if(outScript.endsWith('>') && !actions.includes('no_end_nl')) outScript += '\n'
flag = flag.trim().replace(/[^dgimsuvy]/g, '')        // 미지원 플래그 제거
flag = flag.split('').filter((v,i,a) => a.indexOf(v) === i).join('')  // 중복 제거
if(flag.length === 0) flag = 'u'

let input = script.in
if(actions.includes('cbs')) input = risuChatParser(input, ...)   // in 에도 CBS 사용 가능

const reg = new RegExp(input, flag)
if(outScript.startsWith('@@') || actions.length > 0){ ...액션 모드... }
else { data = risuChatParser(data.replace(reg, outScript), ...) }
```

#### `out`의 특수 접두사 / 액션

`flag`의 `<...>` 안에서 `order N`만 정렬 키로, 나머지는 "액션"으로 분류됩니다(`scripts.ts:296-330`).

| 액션 | 동작 |
|---|---|
| `@@emo <name>` | 감정 이미지 push (`emoChanged = true`) |
| `@@inject` / `inject` | 매치를 `chatID` 메시지에 저장하고 본문에서 제거 |
| `@@move_top` / `@@move_bottom` / `move_top` / `move_bottom` | 매치를 제거하고 `out`을 맨 앞/뒤로 이동 |
| `@@repeat_back [start\|end\|start_nl\|end_nl]` | **매치 실패 시** 직전 동명 role 메시지에서 가져와 붙임 |
| `cbs` | `in`에 CBS 적용 |
| `no_end_nl` | `out`이 `>`로 끝날 때 자동 개행 붙이는 것 방지 |

치환 문자열에서 지원하는 참조: `$1`~`$9`(그룹), `$&`(전체 매치), `$<name>`(명명 그룹 — 단 구현이 `parseInt`로 숫자 변환을 시도하는 버그성 동작이 있음, `scripts.ts:231-237`), `$n`(개행).

#### `<order N>` — 순서를 바꾸는 유일한 수단

```ts
// scripts.ts:332-334
if(orderChanged){
    parsedScripts.sort((a, b) => b.order - a.order)   // 내림차순
}
```

| 규칙 | 내용 |
|---|---|
| 적용 조건 | `ableFlag === true` 이고 `flag`에 `<`가 포함될 때 |
| 방향 | **내림차순** — `order`가 클수록 먼저 |
| 범위 | **전역 1회** — 프리셋/봇/모듈이 한 풀에서 함께 재정렬됨 |
| 동률 | ES2019+ stable sort → 원래 순서(프리셋 → 봇 → 모듈) 유지 |
| 부작용 | `order` 미지정 = 0. 하나라도 `order 1`을 쓰면 **모든 0-order 스크립트가 뒤로 밀림** |

즉 **모듈이 `<order 1>`을 쓰면 프리셋·봇 정규식보다 앞설 수 있습니다**. 레이어 경계가 정렬 한 번으로 무너지는 지점입니다.

#### 캐시

```ts
// scripts.ts:71-80, 82-93, 135-139, 384
hash = data + mode + (해당 mode 스크립트들의 in/out/flag/ableFlag)
if(cached) return { data: cached, emoChanged: false }   // 최대 1000개 FIFO
```

캐시는 **정규식 단계만** 건너뜁니다. Lua·트리거·플러그인은 이미 실행된 뒤입니다.

#### `edittrans`는 순서가 반대다

```ts
// translator.ts:641
scripts = (db.presetRegex ?? [])
            .concat(getModuleRegexScripts() ?? [])
            .concat(alwaysExistChar?.customscript ?? [])
```

**프리셋 → 모듈 → 봇**. `processScriptFull`과 정반대이며, `@@` 액션/CBS 재파싱도 지원하지 않습니다(단순 `text.replace`).

---

### 6.2 HTML

#### 파이프라인

```
문자열 (CBS/regex/플러그인이 만든 것 전부)
  → encodeStyle        <style>…</style> → <risu-style>HEX</risu-style>
  → markdown-it        html:true, breaks, typographer, hljs 후처리
  → DOMPurify          ADD_TAGS/ADD_ATTR 화이트리스트
  → trimMarkdown       <risu-style> → 실제 <style> 복원(스코프 적용)
  → {@html}            innerHTML
```

#### DOMPurify 설정

```ts
// parser.svelte.ts:783-786
const trimPurifyConfig = {
    ADD_TAGS: ["iframe","style","risu-style","x-em","annotation","semantics",
               "mrow","mi","mo","mn","msup","msub","mfrac","msqrt"],
    ADD_ATTR: ["allow","allowfullscreen","frameborder","scrolling",
               "risu-btn","risu-ctrl","risu-form","risu-trigger","risu-mark",
               "risu-id","x-hl-lang","x-hl-text"],
}
```

`ALLOWED_TAGS`/`ALLOWED_ATTR`를 **오버라이드하지 않고 ADD만** 하므로 DOMPurify 기본 allowlist(HTML+SVG+MathML)가 그대로 적용됩니다.

| 항목 | 결과 |
|---|---|
| `<script>` | 제거 (내용 포함) |
| `on*` 핸들러 | 전부 제거 |
| `javascript:` URL | 제거 |
| `<iframe>` | **YouTube embed만** 생존, 나머지는 `removeChild` (`parser.svelte.ts:46-52`) |
| `href` | `http(s)`만 유지 + `target="_blank"` 강제, 그 외 `''` |
| `rel` | `noopener noreferrer` 강제 |
| `class` | 토큰마다 `x-risu-` 접두 (`hljs*`, `x-risu-*` 예외) |
| `style` 속성 | 허용 (`hideAllImages`면 background url 제거) |
| `src="blob:"` / `"asset:"` | `forceKeepAttr`로 유지 |
| `data-*`, `aria-*` | 기본 허용 |

#### HTML로 코드를 호출하는 속성

메시지 HTML에서 직접 트리거/폼을 부를 수 있습니다.

| 속성 | 호출되는 것 |
|---|---|
| `risu-trigger="이름"` | `runTrigger(char, 'manual', { manualName: 이름 })` → Lua 전역 함수 `이름(id)` |
| `risu-btn="값"` | `runLuaInteractionTrigger('button')` → Lua `onButtonClick(id, 값)` |
| `risu-form="값"` | `onFormSubmit(id, 값, {data: FormData})` |

이 속성들은 `ADD_ATTR`에 명시되어 있어 살균을 통과합니다.

#### CBS가 만드는 HTML

CBS 출력도 **동일한 살균 경로**를 탑니다. 별도 신뢰 경로는 없습니다. 다만 `editdisplay` 정규식의 치환 결과만 다시 CBS로 재파싱됩니다(`scripts.ts:248, 291`).

| CBS | 출력 |
|---|---|
| `{{img::x}}` / `{{image::x}}` | `<img>` |
| `{{emotion::x}}` | `<img>` |
| `{{video::}}` / `{{audio::}}` | `<video>` / `<audio>` |
| `{{bg::x}}` | `'back'` 모드에서만 배경 div |
| `{{source::char\|user}}` | 프로필 이미지 URL |
| `{{button::text::trigger}}` | `<button risu-trigger="...">` |
| `{{ruby::a::b}}` | `<ruby>` |
| `{{comment::…}}` | `<div class="risu-comment">` |
| `{{debo}}`/`{{dec}}`/`{{;}}` 등 | private-use 문자 → `renderMarkdown`에서 `{ } ( ) : ;` 복원 |

---

### 6.3 CSS

#### ⚠️ `{{#style}}` 같은 CBS 블록은 존재하지 않는다

두 저장소 전체 grep + git history(`git log -S "#style"`) 결과 0건. CSS는 **`<style>` 태그 + 후처리**로만 동작합니다.

#### 3단계 처리

**1) 인코딩** — 마크다운 파서로부터 CSS를 격리

```ts
// parser.svelte.ts:957-962
const styleRegex = /\<style\>(.+?)\<\/style\>/gms
function encodeStyle(txt:string){
    return txt.replaceAll(styleRegex, (f, c1) =>
        "<risu-style>" + Buffer.from(c1).toString('hex') + "</risu-style>")
}
```

정확히 `<style>` (속성 없음, 내용 1자 이상)만 매칭합니다. **`<style media="...">` 같은 속성형은 매칭되지 않습니다.**

**2) 복원** — 살균 후 트리에서 직접 교체

```ts
// parser.svelte.ts:819-855 (요약)
if(!data.includes('<risu-style')) return DOMPurify.sanitize(data, purifyConfig)

const root = DOMPurify.sanitize(data, { ...purifyConfig, RETURN_DOM: true })
for(const el of Array.from(root.querySelectorAll('risu-style'))){
    const decoded = decodeStyleContent(el.textContent ?? '')
    if(decoded.css === undefined){ el.replaceWith(textNode(decoded.fallback)); continue }
    const style = root.ownerDocument.createElement('style')
    style.textContent = decoded.css.replaceAll(/<\/(?=style)/gi, '<\\/')
    el.replaceWith(style)
}
return root.innerHTML
```

CSS는 **절대 HTML sanitizer에 다시 들어가지 않습니다**. `<style>` 내용 중 `</style`만 `<\/style`로 이스케이프합니다.

**3) 스코핑** — 셀렉터 재작성

```ts
// parser.svelte.ts:964-997
if(rule.type === 'rule'){
    const parser = cssSelectorParser((root) => {
        root.walkClasses((classes) => {
            if(classes.type === 'class' && !classes.value.startsWith('x-risu-')){
                classes.value = 'x-risu-' + classes.value
            }
        })
    })
    slt = parser.processSync(slt)
    rule.selectors[i] = ".chattext " + slt
}
if(rule.type === 'media'|'supports'|'document'|'host'|'container'){
    for(...) rule.rules[i] = decodeStyleRule(rule.rules[i])   // 재귀
}
if(rule.type === 'import' && rule.import.startsWith('data:')) rule.import = 'data,'
```

`decodeStyleContent`는 CSS 문자열에 **CBS를 한 번 더** 돌립니다(`parser.svelte.ts:1007-1009`). 즉 CSS 안에서도 `{{getvar::x}}`를 쓸 수 있습니다(단 컨텍스트 없는 재파싱).

#### 격리 전략 3중

1. **셀렉터 스코프**: 모든 rule 셀렉터에 `.chattext ` → `html`/`body`/`:root` 도달 불가
2. **클래스 네임스페이스**: sanitize 시 `class` 토큰을 `x-risu-`로 개명 + CSS 셀렉터도 동일 개명 → 앱 클래스 탈취 불가
3. **HTML 무해화**: script/on*/위험 URL 제거, CSS는 hex로 격리

#### 뚫리는 구멍 (코드 근거)

| 구멍 | 원인 |
|---|---|
| `<style media="screen">body{…}</style>` | `encodeStyle` 정규식이 속성형을 못 잡음 → 스코프 없이 전역 |
| `@import url(https://…)` | `data:`만 무력화하므로 외부 CSS 전역 로드 |
| `@keyframes` 이름 / `@font-face` | 재귀 목록에 없어 이름이 전역 |
| `@layer` / `@starting-style` 내부 규칙 | 재귀 목록에 없어 셀렉터 미프리픽스 |
| `position:fixed` | 셀렉터만 맞으면 뷰포트 전체 덮기 가능 |
| `.chattext` 공유 | 알림(`AlertComp.svelte:205`), 온보딩 모달, MultiLangDisplay에도 같은 클래스 → 한 캐릭터 CSS가 이들 표면까지 영향 |
| per-message 격리 없음 | 캐릭터 A의 `<style>`이 그룹챗의 캐릭터 B 메시지에도 적용 |

#### CSS 소스별 주입 위치와 우선순위

| 소스 | 위치 | 스코프 |
|---|---|---|
| 앱 기본 CSS (Tailwind, styles.css) | `<head>` `<link>` | 전역 |
| 테마 색상 변수 | `<html>` inline `--risu-theme-*` | 전역 변수 |
| **봇 `backgroundHTML` + 모듈 `backgroundEmbedding`** | `BackgroundDom.svelte` | `.chattext` |
| **`db.guiHTML`** | `Chat.svelte:1240` | **전역** |
| **메시지 내 `<style>`** (봇/모듈/프롬 정규식/플러그인) | 메시지 `<style>` | `.chattext` + `x-risu-` |
| **`db.customCSS`** | `<style id="customcss">` → `document.body` | **전역, 무스코프** |
| **플러그인 `getRootDocument`** | head/body append | **전역** |

문서 순서상 우선순위(낮음→높음): `<head>` 번들 CSS → BackgroundDom style → guiHTML style → 메시지별 style → `#customcss`.
단 실제 승자는 **specificity 우선**입니다. `.chattext .x-risu-foo`(0,2,0)가 `#customcss`의 `.foo`(0,1,0)를 이깁니다.

#### 중복 제거는 없다

`mcp/risuaccess/client.ts:53`에 *"even `<style>` tags which will be prepended and deduplicated"* 라는 서술이 있지만, **코드에 dedup 로직이 없습니다**. 메시지마다 `<style>` 엘리먼트가 하나씩 생깁니다.

---

### 6.4 Lua

#### 런타임

- `wasmoon` (Lua 5.4 WASM) 위에서 동작 (`scriptings.ts:53-129`).
- `mode` 문자열 단위로 엔진을 캐시(`ScriptingEngines: Map`). **코드가 바뀌면 엔진을 재생성**하고 리스너도 초기화합니다(`:85-110`).
- `mutex.runExclusive`로 같은 mode의 Lua는 직렬 실행.
- Python(pyodide) 엔진도 선택 가능(`ScriptingEngineState.type === 'py'`, `scriptings.ts:1185-1219`).

**함의**: 모듈 A, B가 같은 mode에 Lua를 가지면 엔진이 A→B→A… 로 매번 재생성됩니다.

#### 훅 목록

| Lua 이름 | host mode | 발화 지점 |
|---|---|---|
| `onStart(id)` | `start` | `runTrigger('start')` → `triggerlua` |
| `onInput(id)` | `input` | `runTrigger('input')` |
| `onOutput(id)` | `output` | `runTrigger('output')` |
| `onButtonClick(id, data)` | `onButtonClick` | `risu-btn` |
| `onFormSubmit(id, data, meta)` | `onFormSubmit` | `risu-form` |
| `listenEdit('editInput', fn)` | `editInput` | `processScriptFull` 첫 줄 |
| `listenEdit('editOutput', fn)` | `editOutput` | 동일 |
| `listenEdit('editDisplay', fn)` | `editDisplay` | 동일 (ParseMarkdown 경유) |
| `listenEdit('editRequest', fn)` | `editRequest` | `index.svelte.ts:1493` |
| 임의 이름 `Foo(id)` | `manualName` | `risu-trigger="Foo"` |
| — | `editprocess` | **없음** (`return content`) |

#### `listenEdit`은 camelCase만 받는다

```lua
-- scriptings.ts:1355-1386
function listenEdit(type, func)
  if type == 'editRequest' then ...
  elseif type == 'editDisplay' then ...
  elseif type == 'editInput' then ...
  elseif type == 'editOutput' then ...
  end
  throw('Invalid type')
end
```

`listenEdit('editinput', ...)`는 예외를 던집니다. `callListenMain`은 `ipairs` 순회이므로 **등록 순서**대로 실행되고, 각 콜백의 반환값이 다음 콜백의 입력이 됩니다.

`editDisplay`만 JSON 없이 raw string을 주고받고, 나머지는 `json.decode`/`json.encode`를 씁니다. `editRequest`는 `OpenAIChat[]` 배열을 받습니다.

#### ⚠️ Lua 트리거의 특이한 실행 규칙

```ts
// triggers.ts:1238
if(trigger.effect[0]?.type === 'triggercode' || trigger.effect[0]?.type === 'triggerlua'){
    // 타입/매뉴얼 이름 필터를 전부 건너뛴다
}
```

**첫 이펙트가 `triggerlua`이면 `trigger.trigger`(start/input/output)가 무시됩니다.** 즉 그 Lua 스크립트는 start/input/output/manual 패스마다 매번 실행되고, 실제로 무엇이 돌지는 스크립트가 정의한 함수 이름(`onStart`/`onInput`/…)이 결정합니다.

단 `display`/`request` 패스는 allowlist(`displayAllowList`/`requestAllowList`)에서 걸러지므로 **Lua는 표시/요청 패스에서 실행되지 않습니다**(`triggers.ts:1331-1338`). 표시 단계에서 Lua를 쓰려면 `listenEdit('editDisplay')`를 써야 합니다.

#### 게이팅 (권한 등급)

```ts
// scriptings.ts:1102-1111
if(mode === 'editDisplay'){ ScriptingEditDisplayIds.add(accessKey) }
else { ScriptingSafeIds.add(accessKey); if(lowLevelAccess){ ScriptingLowLevelIds.add(accessKey) } }
```

| 등급 | 대표 API |
|---|---|
| 무게이트(항상) | `cbs`, `getChatVar`, `getGlobalVar`, `getChat*`, `getTokens`, `getLoreBooks`, `hash`, `getName`, `log` |
| Safe | `setChatVar`, `setChat`, `cutChat`, `addChat`, `insertChat`, `stopChat`, `alert*`, `sleep`, `reloadDisplay`, `setBackgroundEmbedding` |
| LowLevel | `similarity`, `request`, `generateImage`, `LLM`, `axLLM`, `simpleLLM`, `loadLoreBooks` |

**`editDisplay`는 Safe에 들어가지 않습니다** → display 훅에서는 `setChat`/`alert*`/`stopChat`이 무시되고 변수 쓰기만 가능합니다.

**`runLuaEditTrigger`는 `lowLevelAccess: false`를 하드코딩**합니다(`scriptings.ts:1505`). LowLevel 모듈이라도 편집 훅에서는 LLM/네트워크를 못 씁니다. 반면 `runTrigger`의 `triggerlua`는 `trigger.lowLevelAccess`를 그대로 넘깁니다(`:1561`).

#### 제한

| 항목 | 내용 |
|---|---|
| 실행 환경 | wasmoon WASM. DOM/FS/네트워크 직접 접근 불가 |
| 타임아웃 | **없음** — 무한루프는 UI를 멈출 수 있음 |
| `request` API | LowLevel 필수 + https만 + URL 120자 이하 + 특정 도메인 차단 + 분당 5회 |
| 재귀 | 트리거 재귀 최대 깊이 10. `lowLevelAccess` 트리거는 무제한(`triggers.ts:1405-1422`) |
| 오류 | `runLuaEditTrigger`는 예외 시 **원본 content 반환** |

---

## 7. 순서 결정 규칙 총정리

### 7.1 한 장 요약

```
[정규식]     presetRegex  →  char.customscript  →  module regex
                              (프리셋)      (봇)              (모듈, db.modules 순)
                              └─ 하나라도 <order N> 이면 전역 내림차순 안정 정렬 ─┘

[트리거]     char.triggerscript  →  module triggers (db.modules 순, 각 trigger 배열 순)

[Lua]        char 트리거 Lua  →  module 트리거 Lua
             (각 스크립트 내부에서는 listenEdit 등록 순)

[플러그인]   pluginV2[mode] Set 순회 = 등록 순 (보장 안 됨, priority 없음)

[모듈]       db.modules 배열 순 (enabledModules 순서 무관)

[CSS]        <head> 번들 → BackgroundDom → guiHTML → 메시지별 <style> → #customcss
             (specificity가 우선)
```

### 7.2 "무엇이 무엇을 이기는가" 표

| 상황 | 결과 | 근거 |
|---|---|---|
| 플러그인 훅 vs CBS | 플러그인이 **먼저** | `scripts.ts:124` → `:133` |
| 플러그인 훅 vs 정규식 | 플러그인이 **먼저** | `scripts.ts:124` → `:134` |
| Lua vs 플러그인 | Lua가 **먼저** (편집 훅 기준) | `scripts.ts:102` → `:124` |
| Lua vs `display` 트리거 | Lua가 **먼저** | `scripts.ts:102` → `:104` |
| `editprocess`에서 Lua | **불가** | `scriptings.ts:1489-1491` |
| 프리셋 정규식 vs 봇 정규식 | 프리셋이 먼저 | `scripts.ts:134` |
| 봇 vs 모듈 정규식 | 봇이 먼저 | `scripts.ts:134` |
| 모듈 A vs 모듈 B | `db.modules` 배열 순 | `modules.ts:379-386` |
| `<order 5>` vs 기본 | `order` 큰 쪽이 먼저 | `scripts.ts:333` |
| `edittrans` vs 나머지 | `edittrans`는 **프리셋→모듈→봇** (반대) | `translator.ts:641` |
| 정규식 vs provider 템플릿 | 정규식이 먼저 (raw text 단계) | `index.svelte.ts:1493` → `request.ts` |
| CSS 스코프 vs `#customCSS` | specificity 우선 (`.chattext .x-risu-foo` > `.foo`) | — |

### 7.3 레이어별 우선순위 필드 유무

| 레이어 | 우선순위 필드 | 순서 제어 수단 |
|---|---|---|
| 봇 | 없음 | `customscript` 배열 순서 |
| 모듈 | 없음 | `db.modules` 배열 정렬, `module.regex` 배열 순서 |
| 플러그인 | 없음 | `db.plugins` 배열 순서(보장 안 됨) |
| 프롬 | 없음 | `presetRegex` 배열 순서 |
| 정규식 공통 | `<order N>` | 전역 내림차순 정렬 |

---

## 8. 함정 체크리스트

실제로 카드/모듈/플러그인을 만들 때 밟기 쉬운 것들만 모았습니다.

| # | 함정 | 대응 |
|---|---|---|
| 1 | `db.globalscript`(Global Regex 설정)가 동작한다고 믿음 | **동작 안 함.** 프리셋 정규식에 넣어야 함 |
| 2 | 모듈을 켠 순서대로 실행된다고 믿음 | **`db.modules` 배열 순서**임. 모듈 라이브러리 정렬을 확인 |
| 3 | `<order 1>` 하나만 넣어도 된다고 생각 | **전역 재정렬**이라 0-order 스크립트가 전부 뒤로 밀림 |
| 4 | `ableFlag`를 끄고 `<order>`/`cbs` 사용 | `ableFlag === false`면 플래그 자체가 `'g'`로 대체되어 무시됨 |
| 5 | Lua로 프롬프트(`editprocess`)를 고치려 함 | **불가.** `editRequest`(배열 전체)를 써야 함 |
| 6 | `listenEdit('editinput')` | camelCase만 허용. `'editInput'` |
| 7 | `addRisuScriptHandler('editdisplay')` | `'display'`를 넘겨야 함 |
| 8 | 플러그인 훅 반환값에 `{{...}}`를 넣음 | 훅 이후 CBS가 돌므로 **전개됨**(의도하면 OK, 아니면 이스케이프) |
| 9 | 정규식 `out`에 `{{data}}`를 씀 | `{{data}}`는 이스케이프됨(`scripts.ts:155`). 매치 전체는 `$&` |
| 10 | `<style>`로 `body`/`:root` 스타일 | `.chattext body`가 되어 **매칭 실패**. `#customCSS`를 써야 함 |
| 11 | `<style media="...">`로 스코프 우회 | 의도적으로는 가능하지만, 카드 배포 시 전역 오염 위험 |
| 12 | CSS가 메시지별로 격리된다고 믿음 | `.chattext` 공유 + `x-risu-` 클래스만. 그룹챗에서 캐릭터 간 누수 |
| 13 | `<style>`가 자동 dedup된다고 믿음 | **dedup 없음.** 메시지 수만큼 `<style>` 생성 |
| 14 | 템플릿 모드에서 `char.systemPrompt`가 적용된다고 믿음 | **무시됨.** `{{mainprompt}}` CBS를 써야 함 |
| 15 | `#when` 안에 부작용 CBS(`setvar`)를 넣음 | false여도 **실행됨**. `#if`를 써야 함 |
| 16 | 프리셋 전환 시 정규식이 유지된다고 믿음 | B에 `regex`가 없으면 `[]`로 **덮어써짐** |
| 17 | 모듈 `backgroundEmbedding`을 지우면 반영된다고 믿음 | 스토어 클리어 분기 없음 → 이전 값 잔존 |
| 18 | `editdisplay` 정규식 결과가 CBS를 안 탄다고 믿음 | 치환 결과를 **다시 CBS로 파싱**함(`scripts.ts:248, 291`) |
| 19 | 그룹챗에서 `char.triggerscript`가 돈다고 믿음 | 그룹챗은 **모듈 트리거만** 실행(`scriptings.ts:1496`) |
| 20 | 스트리밍에서 `editoutput`이 청크마다 정확히 돈다고 믿음 | 성능 모드에서 125ms 디바운스, `deferStreamingPostProcessing`이면 생략 |
| 21 | `parseRisuChat(..., {processRegex:true})`를 `editprocess` 훅 안에서 호출 | **무한 재귀.** 깊이 가드 없음 |
| 22 | 모듈 Lua로 display/request를 가로채려 함 | allowlist에 의해 **실행 안 됨**. `listenEdit('editDisplay')` 사용 |

---

## 9. RisuAI vs PocketRisu — 무엇이 다른가

PocketRisu는 RisuAI의 포크지만 **코어 파이프라인 순서는 동일**합니다. 차이는 주변부입니다.

### 9.1 동일한 것

| 항목 | 상태 |
|---|---|
| `processScriptFull` 5단계 순서 | 완전 동일 (`PocketRisu/src/ts/process/scripts.ts:100-140`) |
| 정규식 3종 순서 `presetRegex → char → module` | 완전 동일 |
| `<order N>` 내림차순 안정 정렬 | 완전 동일 |
| `getModuleByIds` = `db.modules.filter` | 완전 동일 (모듈 순서 = DB 배열 순) |
| `encodeStyle` / `decodeStyleRule` / `trimMarkdown` CSS 스코프 | **diff 0** (PocketRisu `1254-1325`) |
| DOMPurify 클래스 `x-risu-` 개명 | 동일 |
| 플러그인 훅 API (`addRisuScriptHandler` 등) | 동일 |
| `globalscript` 죽은 필드 | **여전히 죽어 있음** |
| Lua `listenEdit` 4종 / `luaCodeWrapper` / `callListenMain` | 완전 동일 |

### 9.2 달라진 것

| 영역 | RisuAI | PocketRisu |
|---|---|---|
| 포크 규모 | — | `src/ts`에 50+ 파일 추가 (캐릭터 관리, 폴더, 온보딩, 알림음, 로그 캡처 등) |
| 없는 기능 | — | `iris`, `kei`, `loadout`, `drive/accounter`, `model/ollama` 등 제거 |
| 그룹챗 | 있음 | **없음** (그룹 분기 삭제) |
| `runTrigger('display')` | 그룹챗이면 스킵 | **모든 캐릭터에서 실행** (`if(currentChar)`) |
| `processScriptFull` | CBS 전 아무것도 안 함 | `hydrateAssetListsForCbs()` 선행 (에셋 매니페스트 사전 로딩) |
| `@@move_top/bottom` | 결과에 CBS 미적용 | **CBS 재적용 추가** |
| 동적 에셋 | 매 응답마다 임베딩 인덱스 구축 | **lazy** 구축 + 실패 시 태그 유지 |
| 모듈 `lowLevelAccess` 임포트 | 사용자 확인 후 거부 시 강등 | **확인 없이 그대로 유지** (보안상 주의) |
| `getModuleTriggers` | `t.lowLevelAccess`를 원본에 대입 | `{...t}` 복사 + `moduleId` 부착 |
| 모듈 추가 필드 | — | `folderId`, `assetManifest` |
| `trimMarkdown` | `(data, purifyConfig?)` | `(data)` 단일 인자 + **LRU 200 캐시** |
| `rel="noopener noreferrer"` 강제 | 있음 | **없음** |
| `src="asset:"` 유지 | 있음 | `blob:`만 (Tauri에서 문제 가능) |
| 온보딩 HTML | `parseOnboardingHTML` + 전용 purify config | 없음 |
| 플러그인 스토리지 | cold storage 단일 네임스페이스 | 서버 KV + 메타 사이드카 + `pluginCustomStorage` merge |
| 프리셋 UI | `BotSettings.svelte` 인라인 | `PromptPresetSettings.svelte` + 하위 컴포넌트로 분리, 폴더/uuid 지원 |
| 프리셋 ↔ 모델 설정 | 전환 시 `db.seperateModels` 덮어씀 | **분리** (전환해도 유지) |
| 토글 | 전역 변수만 | **채팅별 핀/복원** (`chat.savedToggleValues`, `loadTogglesFromChat`) |
| 테마 프리셋 | **없음** | **있음** (`themePresets` — `customCSS`/`guiHTML`/`theme` 묶음) |

### 9.3 요약

**"적용 방식과 순서"에 관한 한 두 저장소는 같은 제품**이라고 봐도 됩니다. PocketRisu는 그 위에 UI/스토리지/캐릭터 관리 기능을 얹은 포크이고, 파이프라인 자체는 손대지 않았습니다. 다만 안전장치(`lowLevelAccess` 확인, `rel` 강제, `asset:` URL)가 일부 빠져 있으므로 **모듈/카드 보안 측면에서는 RisuAI 쪽이 더 보수적**입니다.

---

## 10. 파일 인덱스

핵심 파일만. 경로는 `Risuai/src/...` 기준.

| 파일 | 역할 |
|---|---|
| `ts/process/index.svelte.ts` | `sendChat` — stage 1~4 오케스트레이션 (2226줄) |
| `ts/process/scripts.ts` | `processScriptFull` — **네 레이어의 단일 관문** (391줄) |
| `ts/process/modules.ts` | `RisuModule`, `getModules`, `getModuleRegexScripts`, `moduleUpdate` (593줄) |
| `ts/process/triggers.ts` | `runTrigger` — 트리거/Lua 실행 (2834줄) |
| `ts/process/scriptings.ts` | Lua/Python 엔진, `runLuaEditTrigger`, API 게이팅 (1636줄) |
| `ts/process/prompt.ts` | `PromptItem` 타입, ST 프리셋 변환, 토큰 계산 (498줄) |
| `ts/parser/parser.svelte.ts` | `risuChatParser`(CBS), `ParseMarkdown`, `trimMarkdown`, CSS 스코프 (1900줄) |
| `ts/cbs.ts` | CBS 함수 레지스트리 (2509줄) |
| `ts/plugins/plugins.svelte.ts` | `pluginV2` Set, 플러그인 로드 (987줄) |
| `ts/plugins/apiV3/v3.svelte.ts` | API v3 구현, iframe 브리지 |
| `ts/plugins/apiV3/factory.ts` | iframe 샌드박스, CSP, RPC |
| `ts/storage/database.svelte.ts` | 스키마, `changeToPreset`/`setPreset`, `presetRegex` |
| `ts/stores.svelte.ts` | `CustomCSSStore` → `<style id="customcss">` |
| `ts/interchangeability.ts` | 봇 ↔ 모듈 변환 (스키마 동일성의 근거) |
| `lib/ChatScreens/DefaultChatScreen.svelte` | 입력 경로 (`runTrigger('input')` + `editinput`) |
| `lib/ChatScreens/ParseMarkdown` 호출부 | `ChatBody.svelte` |
| `lib/ChatScreens/BackgroundDom.svelte` | 배경 HTML/모듈 임베딩 렌더 |
| `ts/translator/translator.ts` | `applyEdittransRegex` — 순서가 반대인 예외 경로 |
| `plugins.md` | 플러그인 개발자 문서 (1668줄) |
| `ts/plugins/migrationGuide.md` | API v2 → v3 마이그레이션 |

### 검증용으로 유용한 테스트

| 파일 | 검증 내용 |
|---|---|
| `ts/parser/tests/trimMarkdownStyle.test.ts` | CSS 스코프 기대값: `.chattext .x-risu-mybox{color:red;}` |
| `ts/process/scriptings.test.ts` | Lua 엔진 재생성 시 리스너 초기화 |
| `ts/translator/edittransRegex.test.ts` | `edittrans` 타입/순서 |
| `ts/process/mcp/risuaccess/tests/modules.test.ts` | 모듈 필드 직렬화 |

---

## 부록 A. 정규식 실행 의사코드 (한눈에)

```ts
async function processScriptFull(char, data, mode, chatID, cbsConditions) {
    // 1. Lua
    data = await runLuaEditTrigger(char, mode, data, { index: chatID })
    //    → mode === 'editprocess' 이면 즉시 return (no-op)

    // 2. 표시 전용 트리거
    if (mode === 'editdisplay' && currentChar.type !== 'group')
        data = (await runTrigger(currentChar, 'display', { displayData: data }))?.displayData ?? data

    // 3. 플러그인
    for (const fn of pluginV2[mode]) data = (await fn(data)) ?? data

    // 4. CBS
    data = risuChatParser(data, { chatID, cbsConditions })

    // 5. 정규식
    const scripts = [...db.presetRegex, ...char.customscript, ...getModuleRegexScripts()]
    const parsed = scripts.map(s => parseFlagMeta(s))        // <order N>, actions[]
    if (anyOrder) parsed.sort((a, b) => b.order - a.order)   // 내림차순 stable
    for (const s of parsed) {
        if (s.type !== mode || s.in === '') continue
        applyWithActions(data, s)                             // @@emo/@@inject/@@move_*/@@repeat_back
    }

    // 6. 동적 에셋 (db.dynamicAssets)
    ...
    return { data, emoChanged }
}
```

## 부록 B. 체크리스트 — "내 카드/모듈이 왜 안 먹지?"

1. `ableFlag`가 켜져 있나? (`<order>`, `cbs`, 특수 액션은 전부 `ableFlag` 필요)
2. `type`이 의도한 모드와 정확히 일치하나? (`'editdisplay'` vs `'editDisplay'`)
3. `in`이 빈 문자열은 아닌가? (빈 `in`은 무조건 스킵)
4. 모듈이 실제로 `getModules()`에 잡히나? (`db.modules`에 있고 id/namespace가 맞아야)
5. 템플릿 모드인가? → `char.systemPrompt`는 무시됨
6. 그룹챗인가? → `char.triggerscript`/`display` 트리거가 스킵될 수 있음
7. 프리셋을 바꿨나? → `presetRegex`가 덮어써졌을 수 있음
8. CSS가 안 먹나? → `body`/`:root`를 노렸는지 확인, `.chattext` 스코프
9. Lua가 안 도나? → `editprocess`는 미지원, `listenEdit`은 camelCase
10. 스트리밍 중 이상하게 보이나? → 125ms 디바운스/생략 모드 확인

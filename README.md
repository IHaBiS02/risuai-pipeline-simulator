# RisuAI Pipeline Simulator

RisuAI 의 **메시지 처리 파이프라인**을 코드 레벨로 분석하고, 그 동작을 **정적 웹페이지에서 재현**하는 프로젝트입니다.

- 정규식 스크립트(프리셋 / 봇 / 모듈)의 **실행 순서와 `<order N>` 정렬**
- CBS `{{...}}` 전개, HTML/CSS 스코프(`.chattext` + `x-risu-`), DOMPurify 살균
- **Lua** 편집 훅 (`listenEdit`) — wasmoon(Lua 5.4 WASM)
- **트리거** VM — 조건 평가, indent 인터프리터, display/request allowlist
- **동적 에셋** — OpenAI 호환 `/embeddings` 로 에셋 이름 유사도 매칭

빌드도, 서버도, 패키지 설치도 필요 없습니다. `risu-sim/index.html` 을 열면 바로 동작합니다.

> ⚠️ 이 저장소는 **분석/디버깅 도구**입니다. 앱이 아니고, LLM과 대화하지 않습니다.

---

## 구성

```
.
├── RisuAI-pipeline-analysis.md   # 분석 문서 (1,200줄) — 10장 + 부록
├── risu-sim/                     # 실행 가능한 시뮬레이터 (정적 HTML)
│   ├── index.html                # UI
│   ├── simulator.js              # 정규식 · CBS · CSS 스코프 · 새니타이저
│   ├── lua-runtime.js            # Lua (wasmoon)
│   ├── trigger-runtime.js        # 트리거 VM
│   ├── asset-runtime.js          # 동적 에셋 (OpenAI 호환 임베딩)
│   ├── test.js                   # 단위 테스트 35개
│   └── vendor/                   # wasmoon, json.lua (오프라인 동작용)
├── LICENSE                       # GPL-3.0
└── NOTICE.md                     # 출처 · 제3자 라이선스
```

## 빠른 시작

```bash
git clone https://github.com/IHaBiS02/risuai-pipeline-simulator.git
cd risuai-pipeline-simulator/risu-sim

# 방법 1: 그냥 열기
xdg-open index.html

# 방법 2: 정적 서버 (Lua · 임베딩 API 사용 시 권장)
python3 -m http.server 8080
# → http://localhost:8080
```

### 테스트

```bash
cd risu-sim && node test.js
# → 35 passed, 0 failed
```

### 동적 에셋을 API 키 없이 테스트

```bash
python3 tools/mock-embeddings.py 8899
```

```
http://localhost:8080/?asset=1&assetUrl=http://127.0.0.1:8899/v1&assetModel=mock&mode=editoutput
```

실제 API를 쓰려면 설정 패널의 **임베딩 API** 에 URL(`https://api.openai.com/v1`), 키, 모델명(`text-embedding-3-small`)을 넣으면 됩니다.

---

## 화면

**트레이스** — 단계별 before/after 와 트리거 발화 로그

![트레이스](risu-sim/shot-trigger.png)

**렌더 프리뷰** — 실제 `.chattext` 스코프가 적용된 결과

![프리뷰](risu-sim/shot-preview.png)

**동적 에셋** — 태그 → 후보(코사인) → 선택

![동적 에셋](risu-sim/shot-assets.png)

---

## 구현 범위

| 레이어 | 상태 | 비고 |
|---|---|---|
| 정규식 3레이어 + `<order N>` | ✅ 1:1 | `scripts.ts` |
| CBS `{{...}}` | 🟡 서브셋 | 미지원 태그는 화면에 표시 |
| HTML/CSS 스코프 · 새니타이저 | 🟡 근사 | DOMPurify 대체 구현 |
| Lua `listenEdit` 4종 | ✅ 1:1 | wasmoon, 동일 엔진 |
| 트리거 VM + 35 effect | ✅ 1:1 | allowlist · 재귀 · indent |
| 동적 에셋 | ✅ 1:1 | OpenAI 호환 `/embeddings` |
| 플러그인 | ⬜ 미탑재 | 훅 6개 구현 예정 |
| 실제 LLM 호출 | ❌ 범위 밖 | |

자세한 차이는 [risu-sim/README.md](risu-sim/README.md) 와
[risu-sim/ADDING-RUNTIMES.md](risu-sim/ADDING-RUNTIMES.md) 를 참고하세요.

---

## 분석 문서

[RisuAI-pipeline-analysis.md](RisuAI-pipeline-analysis.md) 에 정리되어 있습니다.

1. 네 레이어(봇/모듈/플러그인/프롬)의 관계
2. 단일 관문 `processScriptFull()` 구조
3. 다섯 개 실행 지점과 전체 타임라인
4. 레이어별 상세 (정규식 · HTML · CSS · Lua)
5. 순서 결정 규칙 총정리
6. 함정 22개 체크리스트
7. RisuAI vs PocketRisu 차이

---

## 라이선스

**GNU GPL v3.0** — [LICENSE](LICENSE)

이 프로젝트는 [RisuAI](https://github.com/kwaroran/Risuai) (GPL-3.0, © 2024 Kwaroran) 의
소스를 분석·이식한 2차적 저작물이므로 동일한 라이선스를 따릅니다.
출처와 제3자 라이선스는 [NOTICE.md](NOTICE.md) 를 참고하세요.

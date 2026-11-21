/*
 * RisuAI 파이프라인 시뮬레이터 — 동적 에셋(Dynamic Assets) 레이어
 * ------------------------------------------------------------------
 * 원본:
 *   src/ts/process/scripts.ts:345-382        (processScriptFull 말미의 에셋 치환)
 *   src/ts/parser/parser.svelte.ts:412       assetRegex
 *   src/ts/parser/parser.svelte.ts:603-640   getClosestMatch (레벤슈타인 폴백)
 *   src/ts/process/memory/hypamemory.ts:96-118  (custom / OpenAI 호환 임베딩 요청)
 *
 * 임베딩은 OpenAI 호환 /embeddings 엔드포인트를 사용한다.
 *   POST {url}/embeddings
 *   Authorization: Bearer {key}
 *   { "input": ["a","b"], "model": "text-embedding-3-small" }
 *   → { "data": [ { "embedding": [...] }, ... ] }
 *
 * RisuAI 의 hypaModel='custom' 경로와 동일한 형식이며,
 * URL 이 '/embeddings' 로 끝나면 그대로 쓰고 아니면 붙인다(appendLastPath).
 */
(function () {
  'use strict';

  var ASSET_RE = /\{\{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::(.+?)\}\}/gms;

  // 에셋 이름 임베딩 캐시 (URL + 모델 + 이름 목록이 바뀌면 무효)
  var nameCache = { key: null, vectors: null };
  // 질의 임베딩 캐시 (bestMatchCache 역할, scripts.ts:366-380)
  var bestMatchCache = new Map();
  var lastError = null;
  var lastLatency = 0;
  var lastRequests = 0;

  function normalizeUrl(url) {
    // util.ts:572 appendLastPath
    var u = String(url || '').trim().replace(/\/$/, '');
    if (!u) return '';
    if (/\/embeddings$/.test(u)) return u;
    return u + '/embeddings';
  }

  function dot(a, b) {
    var s = 0;
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }

  function norm(a) {
    return Math.sqrt(dot(a, a));
  }

  function cosine(a, b) {
    var na = norm(a);
    var nb = norm(b);
    if (!na || !nb) return 0;
    return dot(a, b) / (na * nb);
  }

  async function embed(texts, cfg) {
    var url = normalizeUrl(cfg.url);
    if (!url) throw new Error('임베딩 URL 이 비어 있습니다');

    var headers = { 'Content-Type': 'application/json' };
    var key = String(cfg.key || '').trim();
    if (key) headers['Authorization'] = 'Bearer ' + key;

    var body = { input: texts };
    var model = String(cfg.model || '').trim();
    if (model) body.model = model;

    var started = performance.now();
    var res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error(
        '네트워크/CORS 오류: ' + ((e && e.message) || e) +
          '\n→ 브라우저에서 직접 호출하려면 서버가 CORS 를 허용해야 합니다. ' +
          '(OpenAI 는 허용, 로컬 서버는 --cors 필요)'
      );
    }
    lastLatency = Math.round(performance.now() - started);
    lastRequests += 1;

    var raw = await res.text();
    var json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new Error('응답이 JSON 이 아닙니다 (HTTP ' + res.status + '): ' + raw.slice(0, 300));
    }

    if (!res.ok) {
      var msg = (json && json.error && (json.error.message || json.error)) || raw.slice(0, 300);
      throw new Error('HTTP ' + res.status + ': ' + msg);
    }
    if (!json || !Array.isArray(json.data)) {
      throw new Error('응답에 data 배열이 없습니다: ' + raw.slice(0, 300));
    }

    var out = json.data.map(function (d) {
      return d.embedding;
    });
    if (out.length !== texts.length) {
      throw new Error('요청 ' + texts.length + '개 / 응답 ' + out.length + '개 — 개수가 맞지 않습니다');
    }
    return out;
  }

  // 에셋 이름 벡터 (캐시)
  async function getAssetVectors(names, cfg) {
    var key = normalizeUrl(cfg.url) + '|' + String(cfg.model || '').trim() + '|' + names.join('\u0000');
    if (nameCache.key === key && nameCache.vectors) {
      return { vectors: nameCache.vectors, cached: true };
    }
    var vectors = await embed(names, cfg);
    nameCache = { key: key, vectors: vectors };
    return { vectors: vectors, cached: false };
  }

  /**
   * 원본 scripts.ts:345-382 를 그대로 옮긴 실행 조건.
   *
   *   if ((!db.dynamicAssetsEditDisplay && mode === 'editdisplay')
   *       || mode === 'editinput' || mode === 'editprocess') return;  // 스킵
   */
  function eligibility(mode, cfg) {
    if (!cfg || !cfg.enabled) return 'db.dynamicAssets 가 꺼져 있음';
    if (!cfg.assetNames || cfg.assetNames.length === 0) return '에셋 목록이 비어 있음';
    if (mode === 'editinput') return 'editinput 단계에서는 원본도 스킵';
    if (mode === 'editprocess') return 'editprocess 단계에서는 원본도 스킵';
    if (mode === 'editdisplay' && !cfg.applyToDisplay)
      return 'editdisplay 는 dynamicAssetsEditDisplay 가 켜져야 실행';
    return null;
  }

  /**
   * @returns {Promise<{data:string, trace:object}>}
   */
  async function resolve(data, mode, cfg) {
    var started = performance.now();
    var trace = {
      stage: '⑥ 동적 에셋',
      detail: 'processScriptFull 말미 — 정규식 이후, 반환 직전',
      before: data,
      after: data
    };
    var result = {
      mode: mode,
      url: normalizeUrl(cfg && cfg.url),
      model: (cfg && cfg.model) || '',
      tags: [],
      cachedNames: false,
      requests: 0,
      error: null
    };

    var skipReason = eligibility(mode, cfg);
    if (skipReason) {
      trace.skipped = true;
      trace.detail = skipReason;
      result.skipped = skipReason;
      trace.assetResult = result;
      return { data: data, trace: trace };
    }

    var assetNames = cfg.assetNames.slice();
    var lowerNames = assetNames.map(function (n) {
      return String(n).toLocaleLowerCase();
    });

    // 1) 태그 수집 (타입/이름별 중복 제거)
    var found = [];
    var seen = new Set();
    var m;
    ASSET_RE.lastIndex = 0;
    while ((m = ASSET_RE.exec(data)) !== null) {
      var type = m[1];
      var name = m[2];
      if (type === 'emotion' || type === 'source') continue;
      var dedupeKey = type + '::' + name;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      found.push({ type: type, name: name, full: m[0] });
    }

    if (found.length === 0) {
      trace.skipped = true;
      trace.detail = '치환할 {{type::name}} 태그가 없음';
      result.skipped = trace.detail;
      trace.assetResult = result;
      return { data: data, trace: trace };
    }

    try {
      // 2) 에셋 이름 벡터 (1회, 캐시)
      var nameRes = await getAssetVectors(assetNames, cfg);
      var nameVectors = nameRes.vectors;
      result.cachedNames = nameRes.cached;

      // 3) 정확 일치가 아닌 것만 질의
      var queries = [];
      for (var i = 0; i < found.length; i++) {
        var f = found[i];
        var exact = assetNames.indexOf(f.name) >= 0;
        f.exact = exact;
        if (!exact && queries.indexOf(f.name) < 0) queries.push(f.name);
      }

      var queryVectors = {};
      if (queries.length > 0) {
        var qv = await embed(queries, cfg);
        for (var q = 0; q < queries.length; q++) queryVectors[queries[q]] = qv[q];
      }

      // 4) cosine 최근접 (hypamemory.ts:207-225 대응)
      var rewritten = data;
      for (var k = 0; k < found.length; k++) {
        var tag = found[k];
        var row = {
          type: tag.type,
          name: tag.name,
          full: tag.full,
          exact: tag.exact,
          candidates: [],
          chosen: null
        };

        if (tag.exact) {
          row.chosen = tag.name;
          result.tags.push(row);
          continue;
        }

        var cacheKey = tag.name; // 원본은 chaId + '::' + name
        if (bestMatchCache.has(cacheKey)) {
          row.chosen = bestMatchCache.get(cacheKey);
          row.fromCache = true;
        } else {
          var qvec = queryVectors[tag.name];
          var scored = [];
          for (var v = 0; v < assetNames.length; v++) {
            scored.push({ name: assetNames[v], score: cosine(qvec, nameVectors[v]) });
          }
          scored.sort(function (a, b) {
            return b.score - a.score;
          });
          row.candidates = scored.slice(0, 3);
          row.chosen = scored.length ? scored[0].name : null;
          if (row.chosen) bestMatchCache.set(cacheKey, row.chosen);
        }

        if (row.chosen) {
          rewritten = rewritten.split(tag.full).join('{{' + tag.type + '::' + row.chosen + '}}');
        }
        result.tags.push(row);
      }

      data = rewritten;
      result.latencyMs = Math.round(performance.now() - started);
      result.requests = lastRequests;
      lastRequests = 0;
      trace.detail =
        '태그 ' + result.tags.length + '개 · 요청 ' +
        (result.cachedNames ? '1(이름 캐시)' : '2') +
        '회 · ' + result.latencyMs + 'ms';
    } catch (e) {
      // 원본은 예외를 밖으로 던지지만, 시뮬레이터는 태그를 건드리지 않고 오류만 보여준다.
      result.error = String((e && e.message) || e);
      lastError = result.error;
      lastRequests = 0;
      trace.error = result.error;
      trace.detail = '임베딩 실패 — 태그를 그대로 둠';
    }

    trace.after = data;
    trace.assetResult = result;
    return { data: data, trace: trace };
  }

  window.RisuAssets = {
    resolve: resolve,
    normalizeUrl: normalizeUrl,
    clearCache: function () {
      nameCache = { key: null, vectors: null };
      bestMatchCache.clear();
      lastError = null;
    },
    status: function () {
      return {
        namesCached: !!nameCache.vectors,
        nameCount: nameCache.vectors ? nameCache.vectors.length : 0,
        bestMatches: bestMatchCache.size,
        lastError: lastError,
        lastLatency: lastLatency
      };
    },
    // 연결 테스트: 한 문자열을 임베딩해서 차원/지연을 반환
    test: async function (cfg) {
      lastRequests = 0;
      var v = await embed(['test'], cfg);
      return { dim: v[0].length, latencyMs: lastLatency, url: normalizeUrl(cfg.url) };
    }
  };
})();

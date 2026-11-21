/*!
 * importer.js — RisuAI 파일 로더
 *
 * 지원 형식 (원본 RisuAI 6db4b681 기준)
 *   .risup       프롬프트 프리셋   rpack → zlib → msgpack → AES-GCM → msgpack
 *   .risupreset  프롬프트 프리셋   zlib → msgpack → AES-GCM → msgpack  (rpack 없음, 구형식)
 *   .json        위 둘 중 아무거나 (평문 JSON)
 *   .charx       봇 카드 / 모듈     ZIP: card.json (CCv3) + module.risum + assets/*
 *   .module      모듈              사실상 .charx 와 동일 (exportModule 이 charx 로 씀)
 *   .risum       모듈              매직 111 바이너리: [len][rpack msgpack][1][len][asset]…[0]
 *   .png         봇 카드           tEXt/iTXt 의 chara(v2) · ccv3(v3) 청크
 *
 * 참고 소스
 *   src/ts/storage/database.svelte.ts  importPreset / downloadPreset
 *   src/ts/process/modules.ts          importModule / exportModule / readModule
 *   src/ts/process/processzip.ts       CharXImporter (card.json, module.risum)
 *   src/ts/characterCards.ts           importCharacterProcess / importCharacterCardSpec
 *   src/ts/interchangeability.ts       convertCharacterToModule
 *   src/ts/util.ts                     encryptBuffer / decryptBuffer
 *   src/ts/rpack/rpack_js.js           decodeRPack
 *
 * 이 파일은 DOM 을 쓰지 않는다 (Node 테스트에서 그대로 require 가능).
 */
(function (root) {
  'use strict';

  var VERSION = 1;

  // ==================================================================
  // 0. 바이트 유틸
  // ==================================================================

  var td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

  function u16(b, p) {
    return b[p] | (b[p + 1] << 8);
  }
  function u32(b, p) {
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }
  function be16(b, p) {
    return (b[p] << 8) | b[p + 1];
  }
  function be32(b, p) {
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  }
  function u64(b, p) {
    var lo = u32(b, p);
    var hi = u32(b, p + 4);
    var v = hi * 0x100000000 + lo;
    return Number.isSafeInteger(v) ? v : v;
  }
  function utf8(b) {
    if (td) return td.decode(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return decodeURIComponent(escape(s));
  }
  function copy(b) {
    var o = new Uint8Array(b.length);
    o.set(b);
    return o;
  }
  function toBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return new Uint8Array(v);
    throw new Error('바이트 배열이 아닙니다');
  }

  function startsWith(b, sig, offset) {
    offset = offset || 0;
    if (b.length < offset + sig.length) return false;
    for (var i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
    return true;
  }

  // ==================================================================
  // 1. rpack — 256바이트 치환 테이블 (src/ts/rpack/rpack_map.bin)
  //    encodeMap = 앞 256바이트, decodeMap = 뒤 256바이트
  // ==================================================================

  var RPACK_MAP_B64 =
    'xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmopkvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwKx4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uCz3hIvJZfu2n66zAy0BaXQf5KPs7lw0IZNKD2riYgKeIpz9PPxxx8atWWcFcG2KRBL6JIZfr9F6R87+UGPdUQZvGOBSqAmdVnNMuFNsw6AOGc8+DX4HMmhG6kj5mS6rpEkgXlU1OAy807FYFnkoChrh8s3EOduiumBydn2V73/IwN43lL+1FIGSJUWs5/Vmpys2WsET40s66I2DG3wnsJpC64eq3FSOeCbSVynUt/gvj4l18EF3wh7/2BUR5QSXF/Mx0JsA18q0Tyo72bJr2l2hPzBhvZE9Tubfvk2CjB0jEJhk9IUze5BDu6mI8dalHPbMbrlbC5bt1enFywimgEA=';

  var rpackDecodeMap = null;

  function b64ToBytes(s) {
    if (typeof atob === 'function') {
      var bin = atob(s);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // Node
    /* eslint-disable no-undef */
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    /* eslint-enable no-undef */
    throw new Error('base64 디코더가 없습니다');
  }

  function initRpack() {
    if (rpackDecodeMap) return rpackDecodeMap;
    var map = b64ToBytes(RPACK_MAP_B64);
    if (map.length !== 512) throw new Error('rpack 맵 크기가 잘못되었습니다');
    rpackDecodeMap = map.subarray(256, 512);
    return rpackDecodeMap;
  }

  /** rpack_js.js decodeRPack — 바이트 단위 치환 (압축/암호화 아님) */
  function decodeRPack(data) {
    var m = initRpack();
    data = toBytes(data);
    var out = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) out[i] = m[data[i]];
    return out;
  }

  // ==================================================================
  // 2. 압축 해제 — fflate.decompressSync 대체
  //    fflate 는 gzip / zlib / raw-deflate 를 자동 판별한다. 여기서도 같게.
  // ==================================================================

  function hasDecompressionStream() {
    return typeof DecompressionStream !== 'undefined';
  }

  function inflateAs(format, data) {
    if (!hasDecompressionStream()) {
      return Promise.reject(
        new Error('이 브라우저에는 DecompressionStream 이 없습니다 (Chrome 80+ / Firefox 113+ / Safari 16.4+)')
      );
    }
    var ds = new DecompressionStream(format);
    var body = new Response(copy(data)).body;
    return new Response(body.pipeThrough(ds))
      .arrayBuffer()
      .then(function (b) {
        return new Uint8Array(b);
      })
      .catch(function (e) {
        // Node/브라우저 모두 메시지 없는 TypeError 를 던지는 경우가 있다
        var msg = (e && e.message) || '데이터 손상';
        throw new Error(format + ' 압축 해제 실패: ' + msg);
      });
  }

  /** gzip/zlib/raw 자동 판별 (fflate.decompressSync 와 동일한 휴리스틱) */
  function inflateAuto(data, opts) {
    data = toBytes(data);
    opts = opts || {};
    var tries = [];
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
      tries = ['gzip', 'deflate', 'deflate-raw'];
    } else if (data.length >= 2 && ((data[0] << 8) | data[1]) % 31 === 0 && (data[0] & 0x0f) === 8) {
      tries = ['deflate', 'deflate-raw', 'gzip'];
    } else {
      tries = ['deflate-raw', 'deflate', 'gzip'];
    }
    if (opts.format) tries = [opts.format];

    var lastErr = null;
    function next(i) {
      if (i >= tries.length) {
        return Promise.reject(
          new Error(
            '압축 해제 실패 (gzip/zlib/raw-deflate 모두 아님)' +
              (lastErr && lastErr.message ? ' — ' + lastErr.message : '')
          )
        );
      }
      return inflateAs(tries[i], data).catch(function (e) {
        lastErr = e;
        return next(i + 1);
      });
    }
    return next(0);
  }

  // ==================================================================
  // 3. msgpack 디코더
  //    RisuAI 는 msgpackr(index-no-eval) 의 encode/decode 를 쓴다.
  //    msgpackr 의 기본 export 는 useRecords:false 라서 순수 msgpack 이 나온다.
  //    (pack.js: `let defaultPackr = new Packr({ useRecords: false })`)
  //    확장 타입은 아래 표만 처리하고, 모르는 건 {__ext:{type,data}} 로 남긴다.
  // ==================================================================

  // msgpackr 확장 타입 코드
  var EXT_DATE = 0xff;
  var EXT_SET = 0x53; // 'S'
  var EXT_MAP = 0x4d; // 'M'
  var EXT_ERROR = 0x45; // 'E'
  var EXT_REGEXP = 0x52; // 'R'
  var EXT_TYPED_ARRAY = 0x63; // 'c'
  var EXT_RECORD = 0x72; // 'r'
  var EXT_RECORD_SHARED = 0x73; // 's'
  var EXT_TABLE = 0x74; // 't'
  var EXT_TABLE_SHARED = 0x75; // 'u'

  var TYPED_ARRAY_CTORS = {
    0xc0: 'Int8Array',
    0xc1: 'Uint8Array',
    0xc2: 'Uint8ClampedArray',
    0xc3: 'Int16Array',
    0xc4: 'Uint16Array',
    0xc5: 'Int32Array',
    0xc6: 'Uint32Array',
    0xc7: 'Float32Array',
    0xc8: 'Float64Array',
    0xc9: 'BigInt64Array',
    0xca: 'BigUint64Array'
  };

  function msgpackDecode(buf) {
    var b = toBytes(buf);
    var pos = 0;
    var view = new DataView(b.buffer, b.byteOffset, b.byteLength);

    function need(n) {
      if (pos + n > b.length) throw new Error('msgpack: 예상보다 일찍 끝났습니다 (offset ' + pos + ')');
    }
    function strChars(n) {
      need(n);
      var s = utf8(b.subarray(pos, pos + n));
      pos += n;
      return s;
    }
    function bin(n) {
      need(n);
      var o = copy(b.subarray(pos, pos + n));
      pos += n;
      return o;
    }
    function arr(n) {
      var o = new Array(n);
      for (var i = 0; i < n; i++) o[i] = parse();
      return o;
    }
    function map(n) {
      var o = {};
      for (var i = 0; i < n; i++) {
        var k = parse();
        o[typeof k === 'string' ? k : String(k)] = parse();
      }
      return o;
    }
    function ext(type, data) {
      switch (type) {
        case EXT_DATE: {
          // 4/8/12 바이트 — 초 또는 (초+나노초)
          if (data.length === 4) return new Date(new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false) * 1000);
          if (data.length === 8) {
            var v = Number(new DataView(data.buffer, data.byteOffset, 8).getBigInt64(0, false));
            return new Date(v * 1000);
          }
          return new Date(0);
        }
        case EXT_SET:
          return new Set(msgpackDecode(data));
        case EXT_MAP: {
          var pairs = msgpackDecode(data);
          var m = new Map();
          for (var i = 0; i + 1 < pairs.length; i += 2) m.set(pairs[i], pairs[i + 1]);
          return m;
        }
        case EXT_REGEXP: {
          var r = msgpackDecode(data);
          try {
            return new RegExp(r[0], r[1]);
          } catch (e) {
            return { __ext: { type: type, data: r } };
          }
        }
        case EXT_ERROR:
          return { name: 'Error', message: utf8(data) };
        case EXT_TYPED_ARRAY: {
          var ta = msgpackDecode(data);
          var name = TYPED_ARRAY_CTORS[ta[0]];
          var bytes = ta[1] instanceof Uint8Array ? ta[1] : toBytes(ta[1] || []);
          if (name && typeof root[name] === 'function') {
            try {
              return new root[name](bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
            } catch (e) {
              /* ignore */
            }
          }
          return bytes;
        }
        case EXT_RECORD:
        case EXT_RECORD_SHARED:
        case EXT_TABLE:
        case EXT_TABLE_SHARED:
          throw new Error(
            'msgpackr 레코드 구조(ext 0x' + type.toString(16) + ')는 지원하지 않습니다. ' +
              '이 파일은 useRecords 를 켠 도구로 만들어졌습니다.'
          );
        default:
          return { __ext: { type: type, data: data } };
      }
    }

    function parse() {
      need(1);
      var c = b[pos++];

      if (c <= 0x7f) return c;
      if (c >= 0xe0) return c - 0x100; // negative fixint

      if (c >= 0xa0 && c <= 0xbf) return strChars(c & 0x1f); // fixstr
      if (c >= 0x90 && c <= 0x9f) return arr(c & 0x0f); // fixarray
      if (c >= 0x80 && c <= 0x8f) return map(c & 0x0f); // fixmap

      switch (c) {
        case 0xc0:
          return null;
        case 0xc1:
          throw new Error('msgpack: 사용되지 않는 마커 0xc1');
        case 0xc2:
          return false;
        case 0xc3:
          return true;
        case 0xc4:
          need(1);
          return bin(b[pos++]);
        case 0xc5: {
          need(2);
          var n5 = be16(b, pos);
          pos += 2;
          return bin(n5);
        }
        case 0xc6: {
          need(4);
          var n6 = be32(b, pos);
          pos += 4;
          return bin(n6);
        }
        case 0xc7: {
          need(1);
          var e7 = b[pos++];
          need(1);
          var t7 = b[pos++];
          return ext(t7, bin(e7));
        }
        case 0xc8: {
          need(2);
          var e8 = be16(b, pos);
          pos += 2;
          need(1);
          var t8 = b[pos++];
          return ext(t8, bin(e8));
        }
        case 0xc9: {
          need(4);
          var e9 = be32(b, pos);
          pos += 4;
          need(1);
          var t9 = b[pos++];
          return ext(t9, bin(e9));
        }
        case 0xca:
          need(4);
          var f32 = view.getFloat32(pos, false);
          pos += 4;
          return f32;
        case 0xcb:
          need(8);
          var f64 = view.getFloat64(pos, false);
          pos += 8;
          return f64;
        case 0xcc:
          need(1);
          return b[pos++];
        case 0xcd: {
          need(2);
          var u16v = be16(b, pos); // msgpack 은 빅엔디언
          pos += 2;
          return u16v;
        }
        case 0xce: {
          need(4);
          var v = view.getUint32(pos, false);
          pos += 4;
          return v;
        }
        case 0xcf: {
          need(8);
          var big = view.getBigUint64(pos, false);
          pos += 8;
          var num = Number(big);
          return Number.isSafeInteger(num) ? num : big;
        }
        case 0xd0:
          need(1);
          return view.getInt8(pos++);
        case 0xd1: {
          need(2);
          var i16v = view.getInt16(pos, false);
          pos += 2;
          return i16v;
        }
        case 0xd2: {
          need(4);
          var i32v = view.getInt32(pos, false);
          pos += 4;
          return i32v;
        }
        case 0xd3: {
          need(8);
          var ibig = view.getBigInt64(pos, false);
          pos += 8;
          var inum = Number(ibig);
          return Number.isSafeInteger(inum) ? inum : ibig;
        }
        case 0xd4:
          need(1);
          var st4 = b[pos++];
          return ext(st4, bin(1));
        case 0xd5:
          need(1);
          var st5 = b[pos++];
          return ext(st5, bin(2));
        case 0xd6:
          need(1);
          var st6 = b[pos++];
          return ext(st6, bin(4));
        case 0xd7:
          need(1);
          var st7 = b[pos++];
          return ext(st7, bin(8));
        case 0xd8:
          need(1);
          var st8 = b[pos++];
          return ext(st8, bin(16));
        case 0xd9:
          need(1);
          return strChars(b[pos++]);
        case 0xda: {
          need(2);
          var s16 = be16(b, pos);
          pos += 2;
          return strChars(s16);
        }
        case 0xdb: {
          need(4);
          var s32 = be32(b, pos);
          pos += 4;
          return strChars(s32);
        }
        case 0xdc: {
          need(2);
          var a16 = be16(b, pos);
          pos += 2;
          return arr(a16);
        }
        case 0xdd: {
          need(4);
          var a32 = be32(b, pos);
          pos += 4;
          return arr(a32);
        }
        case 0xde: {
          need(2);
          var m16 = be16(b, pos);
          pos += 2;
          return map(m16);
        }
        case 0xdf: {
          need(4);
          var m32 = be32(b, pos);
          pos += 4;
          return map(m32);
        }
      }
      throw new Error('msgpack: 알 수 없는 마커 0x' + c.toString(16) + ' (offset ' + (pos - 1) + ')');
    }

    var out = parse();
    return out;
  }

  // ==================================================================
  // 4. AES-GCM 복호화 (src/ts/util.ts decryptBuffer)
  //    키 = SHA-256(문자열), IV = 12바이트 0, 추가 인증 데이터 없음
  // ==================================================================

  function getSubtle() {
    var c = root.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    if (!c || !c.subtle) {
      throw new Error(
        'WebCrypto(subtle)를 쓸 수 없습니다. https:// 또는 http://localhost 에서 열어주세요 (file:// 은 보안 컨텍스트가 아닙니다).'
      );
    }
    return c.subtle;
  }

  function decryptBuffer(data, keyString) {
    var subtle;
    try {
      subtle = getSubtle();
    } catch (e) {
      return Promise.reject(e);
    }
    var enc = new TextEncoder();
    return subtle
      .digest('SHA-256', enc.encode(keyString))
      .then(function (keyArray) {
        return subtle.importKey('raw', keyArray, 'AES-GCM', false, ['decrypt']);
      })
      .then(function (key) {
        return subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, copy(data));
      })
      .then(function (result) {
        return new Uint8Array(result);
      })
      .catch(function (e) {
        throw new Error('AES-GCM 복호화 실패 — 프리셋 파일이 손상되었거나 다른 키로 암호화되었습니다 (' + (e && e.message) + ')');
      });
  }

  function encryptBuffer(data, keyString) {
    var subtle = getSubtle();
    var enc = new TextEncoder();
    return subtle
      .digest('SHA-256', enc.encode(keyString))
      .then(function (keyArray) {
        return subtle.importKey('raw', keyArray, 'AES-GCM', false, ['encrypt']);
      })
      .then(function (key) {
        return subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, copy(data));
      })
      .then(function (result) {
        return new Uint8Array(result);
      });
  }

  // ==================================================================
  // 5. ZIP 리더 (charx / module)
  //    중앙 디렉터리를 읽는다. 로컬 헤더만 읽으면 data descriptor 때문에
  //    압축 크기를 알 수 없는 경우가 있다 (fflate 스트리밍 writer 가 그렇다).
  //    압축 방식: 0 = stored, 8 = deflate. 그 외는 건너뛴다.
  // ==================================================================

  var SIG_EOCD = [0x50, 0x4b, 0x05, 0x06];
  var SIG_EOCD64 = [0x50, 0x4b, 0x06, 0x06];
  var SIG_EOCD64_LOC = [0x50, 0x4b, 0x06, 0x07];
  var SIG_CEN = [0x50, 0x4b, 0x01, 0x02];
  var SIG_LOC = [0x50, 0x4b, 0x03, 0x04];

  function findSignatureBack(b, sig, from) {
    for (var i = from; i >= 0; i--) {
      if (b[i] === sig[0] && b[i + 1] === sig[1] && b[i + 2] === sig[2] && b[i + 3] === sig[3]) return i;
    }
    return -1;
  }

  function parseZip64Extra(extra, needUncomp, needComp, needOffset) {
    var out = {};
    var p = 0;
    while (p + 4 <= extra.length) {
      var id = u16(extra, p);
      var size = u16(extra, p + 2);
      var body = extra.subarray(p + 4, p + 4 + size);
      if (id === 0x0001) {
        var q = 0;
        if (needUncomp && q + 8 <= body.length) {
          out.uncompSize = u64(body, q);
          q += 8;
        }
        if (needComp && q + 8 <= body.length) {
          out.compSize = u64(body, q);
          q += 8;
        }
        if (needOffset && q + 8 <= body.length) {
          out.localOffset = u64(body, q);
          q += 8;
        }
      }
      p += 4 + size;
    }
    return out;
  }

  function readZip(bytes) {
    var b = toBytes(bytes);
    if (!startsWith(b, SIG_LOC)) throw new Error('ZIP 이 아닙니다 (로컬 헤더 시그니처 없음)');

    var eocd = findSignatureBack(b, SIG_EOCD, b.length - 22);
    if (eocd < 0) throw new Error('ZIP 중앙 디렉터리를 찾을 수 없습니다');

    var count = u16(b, eocd + 10);
    var cdSize = u32(b, eocd + 12);
    var cdOffset = u32(b, eocd + 16);

    // ZIP64
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      var locPos = findSignatureBack(b, SIG_EOCD64_LOC, Math.max(0, eocd - 20));
      if (locPos >= 0) {
        var e64off = u64(b, locPos + 8);
        if (startsWith(b, SIG_EOCD64, e64off)) {
          count = u64(b, e64off + 32);
          cdSize = u64(b, e64off + 40);
          cdOffset = u64(b, e64off + 48);
        }
      }
    }

    var entries = [];
    var p = cdOffset;
    for (var i = 0; i < count; i++) {
      if (!startsWith(b, SIG_CEN, p)) break;
      var flags = u16(b, p + 8);
      var method = u16(b, p + 10);
      var compSize = u32(b, p + 20);
      var uncompSize = u32(b, p + 24);
      var nameLen = u16(b, p + 28);
      var extraLen = u16(b, p + 30);
      var commentLen = u16(b, p + 32);
      var localOffset = u32(b, p + 42);
      var name = utf8(b.subarray(p + 46, p + 46 + nameLen));
      var extra = b.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        var z = parseZip64Extra(extra, uncompSize === 0xffffffff, compSize === 0xffffffff, localOffset === 0xffffffff);
        if (z.compSize != null) compSize = z.compSize;
        if (z.uncompSize != null) uncompSize = z.uncompSize;
        if (z.localOffset != null) localOffset = z.localOffset;
      }

      entries.push({
        name: name,
        method: method,
        compSize: compSize,
        uncompSize: uncompSize,
        localOffset: localOffset,
        isDir: name.charAt(name.length - 1) === '/',
        utf8: (flags & 0x800) !== 0
      });

      p += 46 + nameLen + extraLen + commentLen;
    }

    /** 엔트리 하나를 압축 해제해 Uint8Array 로 돌려준다 */
    entries.read = function (entry) {
      var e = typeof entry === 'string' ? entries.filter(function (x) { return x.name === entry; })[0] : entry;
      if (!e) return Promise.reject(new Error('ZIP 안에 ' + entry + ' 가 없습니다'));
      var lp = e.localOffset;
      if (!startsWith(b, SIG_LOC, lp)) return Promise.reject(new Error('ZIP 로컬 헤더가 깨졌습니다: ' + e.name));
      var nLen = u16(b, lp + 26);
      var xLen = u16(b, lp + 28);
      var dataStart = lp + 30 + nLen + xLen;
      var raw = b.subarray(dataStart, dataStart + e.compSize);
      if (e.method === 0) return Promise.resolve(copy(raw));
      if (e.method === 8) return inflateAs('deflate-raw', raw);
      return Promise.reject(new Error('지원하지 않는 ZIP 압축 방식 ' + e.method + ' (' + e.name + ')'));
    };

    entries.find = function (name) {
      for (var k = 0; k < entries.length; k++) if (entries[k].name === name) return entries[k];
      var lower = name.toLowerCase();
      for (var j = 0; j < entries.length; j++) if (entries[j].name.toLowerCase() === lower) return entries[j];
      return null;
    };

    entries.findEndsWith = function (suffix) {
      var lower = suffix.toLowerCase();
      for (var k = 0; k < entries.length; k++) {
        if (entries[k].name.toLowerCase().slice(-lower.length) === lower) return entries[k];
      }
      return null;
    };

    return entries;
  }

  // ==================================================================
  // 6. PNG 카드 (tEXt / iTXt 의 chara · ccv3)
  // ==================================================================

  var SIG_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function readPngTextChunks(bytes) {
    var b = toBytes(bytes);
    if (!startsWith(b, SIG_PNG)) return null;
    var p = 8;
    var out = {};
    while (p + 8 <= b.length) {
      var len = be32(b, p);
      var type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      var dataStart = p + 8;
      if (dataStart + len > b.length) break;
      var chunk = b.subarray(dataStart, dataStart + len);

      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        var z = chunk.indexOf(0);
        if (z > 0) {
          var keyword = utf8(chunk.subarray(0, z));
          var rest = chunk.subarray(z + 1);
          if (type === 'tEXt') {
            out[keyword] = utf8(rest);
          } else if (type === 'zTXt') {
            out[keyword] = { __zlib: copy(rest.subarray(1)) };
          } else {
            // iTXt: compFlag(1) compMethod(1) langTag\0 translatedKeyword\0 text
            var compFlag = rest[0];
            var q = 2;
            var langEnd = rest.indexOf(0, q);
            q = langEnd + 1;
            var transEnd = rest.indexOf(0, q);
            q = transEnd + 1;
            var textBytes = rest.subarray(q);
            out[keyword] = compFlag === 1 ? { __zlib: copy(textBytes) } : utf8(textBytes);
          }
        }
      }
      if (type === 'IEND') break;
      p = dataStart + len + 4; // + CRC
    }
    return out;
  }

  function readPngCard(bytes) {
    var chunks = readPngTextChunks(bytes);
    if (!chunks) return Promise.reject(new Error('PNG 가 아닙니다'));
    var order = ['ccv3', 'chara'];
    var jobs = [];
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      if (chunks[key] == null) continue;
      var val = chunks[key];
      jobs.push(
        (val && val.__zlib
          ? inflateAuto(val.__zlib).then(function (v) {
              return utf8(v);
            })
          : Promise.resolve(typeof val === 'string' ? val : '')
        ).then(function (text) {
          var json = utf8(b64ToBytes(String(text).replace(/\s+/g, '')));
          return JSON.parse(json);
        })
      );
      break;
    }
    if (!jobs.length) return Promise.reject(new Error('PNG 안에 chara/ccv3 카드 데이터가 없습니다'));
    return jobs[0];
  }

  // ==================================================================
  // 7. 카드(CCv2/CCv3/구형식) 정규화
  //    src/ts/characterCards.ts importCharacterCardSpec 의 필드 매핑을 따른다.
  // ==================================================================

  function normalizeGreetings(d) {
    var out = [];
    if (Array.isArray(d.alternate_greetings)) out = d.alternate_greetings.slice();
    else if (Array.isArray(d.alternateGreetings)) out = d.alternateGreetings.slice();
    return out.filter(function (s) {
      return typeof s === 'string';
    });
  }

  function normalizeCard(raw) {
    // CCv2 / CCv3
    if (raw && (raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3') && raw.data) {
      var data = raw.data || {};
      var risu = (data.extensions && data.extensions.risuai) || {};
      return {
        spec: raw.spec,
        data: data,
        name: data.name || '',
        firstMessage: data.first_mes || '',
        alternateGreetings: normalizeGreetings(data),
        description: data.description || '',
        personality: data.personality || '',
        scenario: data.scenario || '',
        exampleMessage: data.mes_example || '',
        systemPrompt: data.system_prompt || '',
        postHistoryInstructions: data.post_history_instructions || '',
        creatorNotes: data.creator_notes || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        creator: data.creator || '',
        characterVersion: data.character_version != null ? String(data.character_version) : '',
        nickname: data.nickname || '',
        // RisuAI 확장
        customScripts: Array.isArray(risu.customScripts) ? risu.customScripts : [],
        triggers: Array.isArray(risu.triggerscript) ? risu.triggerscript : [],
        defaultVariables: risu.defaultVariables || '',
        additionalAssets: Array.isArray(risu.additionalAssets) ? risu.additionalAssets : [],
        backgroundHTML: risu.backgroundHTML || '',
        hideChatIcon: !!risu.hideChatIcon,
        lowLevelAccess: !!risu.lowLevelAccess,
        moduleNamespace: risu.moduleNamespace,
        toggles: risu.toggles || {},
        character_book: data.character_book || null,
        assets: Array.isArray(data.assets) ? data.assets : []
      };
    }

    // 구형식 (TavernAIV1 / RisuAI old)
    if (raw && (raw.char_name || raw.name) && (raw.char_persona || raw.description || raw.char_greeting || raw.first_mes)) {
      return {
        spec: 'legacy',
        data: raw,
        name: raw.char_name || raw.name || '',
        firstMessage: raw.char_greeting || raw.first_mes || '',
        alternateGreetings: normalizeGreetings(raw),
        description: raw.char_persona || raw.description || '',
        personality: raw.personality || '',
        scenario: raw.world_scenario || raw.scenario || '',
        exampleMessage: raw.example_dialogue || raw.mes_example || '',
        systemPrompt: raw.system_prompt || '',
        postHistoryInstructions: raw.post_history_instructions || '',
        creatorNotes: raw.creator_notes || raw.creatorcomment || '',
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        creator: raw.creator || '',
        characterVersion: raw.character_version != null ? String(raw.character_version) : '',
        nickname: '',
        customScripts: Array.isArray(raw.customscript) ? raw.customscript : [],
        triggers: Array.isArray(raw.triggerscript) ? raw.triggerscript : [],
        defaultVariables: raw.defaultVariables || '',
        additionalAssets: Array.isArray(raw.additionalAssets) ? raw.additionalAssets : [],
        backgroundHTML: raw.backgroundHTML || '',
        hideChatIcon: !!raw.hideChatIcon,
        lowLevelAccess: !!raw.lowLevelAccess,
        moduleNamespace: raw.moduleNamespace,
        toggles: {},
        character_book: raw.character_book || null,
        assets: []
      };
    }

    throw new Error('캐릭터 카드 형식이 아닙니다 (spec: chara_card_v2/v3 필요)');
  }

  /** character_book → 간단한 로어 목록 (시뮬레이터에서는 표시용) */
  function summarizeLorebook(book) {
    if (!book || !Array.isArray(book.entries)) return [];
    return book.entries.map(function (e) {
      return {
        keys: Array.isArray(e.keys) ? e.keys : [],
        comment: e.comment || e.name || '',
        content: typeof e.content === 'string' ? e.content : '',
        constant: !!e.constant,
        enabled: e.enabled !== false,
        insertorder: e.insertion_order != null ? e.insertion_order : e.insert_order
      };
    });
  }

  /** 스크립트 배열에서 Lua 훅만 분리 (effect[0].type === 'triggerlua') */
  function splitTriggers(list) {
    var triggers = [];
    var luaTriggers = [];
    (Array.isArray(list) ? list : []).forEach(function (t) {
      if (!t || typeof t !== 'object') return;
      var first = Array.isArray(t.effect) ? t.effect[0] : null;
      if (first && first.type === 'triggerlua') luaTriggers.push(t);
      else triggers.push(t);
    });
    return { triggers: triggers, luaTriggers: luaTriggers };
  }

  function assetNamesOf(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (a) {
      if (!a) return;
      if (typeof a === 'string') {
        out.push(a);
        return;
      }
      var name = Array.isArray(a) ? a[0] : a.name || a.filename || a[0];
      if (name) out.push(String(name));
    });
    return out;
  }

  // ==================================================================
  // 8. 프리셋 (.risup / .risupreset / .json)
  // ==================================================================

  /** database.svelte.ts downloadPreset 이 만든 구조를 푼다 */
  function unwrapPreset(outer) {
    if (!outer || typeof outer !== 'object') throw new Error('프리셋 봉투가 아닙니다');
    if (outer.type !== 'preset') throw new Error("프리셋 봉투의 type 이 'preset' 이 아닙니다: " + outer.type);
    var pv = outer.presetVersion;
    if (pv !== 0 && pv !== 2) {
      // 예전 파일 중 일부는 버전을 생략한다 → 경고만 하고 계속 시도
    }
    var inner = outer.preset != null ? outer.preset : outer.pres;
    if (inner == null) throw new Error('프리셋 본문(preset)이 없습니다');
    return { presetVersion: pv, inner: toBytes(inner) };
  }

  function parsePresetBytes(bytes, opts) {
    var b = toBytes(bytes);
    var warnings = [];
    var format = opts && opts.format ? opts.format : 'risup';

    // 1) 평문 JSON 인지 먼저 확인 (확장자만 risup 인 경우가 있다)
    function tryJson() {
      try {
        var text = utf8(b);
        if (text.charAt(0) === '{' || text.charAt(0) === '[') {
          var j = JSON.parse(text);
          if (j && j.type === 'preset' && (j.preset || j.pres)) {
            return unwrapPreset(j);
          }
          if (j && typeof j === 'object') return { presetVersion: j.presetVersion, direct: j };
        }
      } catch (e) {
        /* JSON 아님 */
      }
      return null;
    }

    function decodeWrapped(wrapped) {
      return decryptBuffer(wrapped.inner, 'risupreset')
        .then(function (plain) {
          return msgpackDecode(plain);
        })
        .catch(function (err) {
          // 복호화 실패 → 암호화 안 된 msgpack 일 수도 있으니 시도
          try {
            var maybe = msgpackDecode(wrapped.inner);
            if (maybe && typeof maybe === 'object' && !(maybe instanceof Uint8Array)) {
              warnings.push('프리셋 본문이 암호화되어 있지 않았습니다 (평문 msgpack 으로 읽음)');
              return maybe;
            }
          } catch (e2) {
            /* 무시 */
          }
          throw err;
        });
    }

    var direct = tryJson();
    if (direct && direct.direct) {
      return Promise.resolve({ preset: direct.direct, format: 'json', warnings: warnings, wrapped: null });
    }
    if (direct && direct.inner) {
      return decodeWrapped(direct).then(function (preset) {
        return { preset: preset, format: 'json', warnings: warnings, wrapped: null };
      });
    }

    // 2) rpack 해제 후 압축 해제 (확장자 .risup 이면 rpack, .risupreset 이면 아님)
    var candidates = [];
    if (format === 'risupreset') {
      candidates.push({ rpack: false, data: b });
      candidates.push({ rpack: true, data: decodeRPack(b) });
    } else {
      candidates.push({ rpack: true, data: decodeRPack(b) });
      candidates.push({ rpack: false, data: b });
    }

    var lastErr = null;
    function tryCandidate(i) {
      if (i >= candidates.length) {
        return Promise.reject(
          lastErr || new Error('프리셋 파일을 해석할 수 없습니다 (rpack/zlib/msgpack 어느 쪽도 실패)')
        );
      }
      var c = candidates[i];
      return inflateAuto(c.data)
        .then(function (inflated) {
          var outer = msgpackDecode(inflated);
          var w = unwrapPreset(outer);
          return decodeWrapped(w).then(function (preset) {
            return {
              preset: preset,
              format: c.rpack ? 'risup' : 'risupreset',
              warnings: warnings,
              wrapped: { presetVersion: w.presetVersion }
            };
          });
        })
        .catch(function (e) {
          lastErr = e;
          return tryCandidate(i + 1);
        });
    }
    return tryCandidate(0);
  }

  function normalizePreset(preset, meta) {
    var warnings = (meta && meta.warnings) || [];
    var regex = Array.isArray(preset.regex) ? preset.regex : [];
    var vars = {};
    var rawVars = preset.templateDefaultVariables;
    if (typeof rawVars === 'string' && rawVars.trim()) {
      try {
        vars = JSON.parse(rawVars);
      } catch (e) {
        warnings.push('templateDefaultVariables 가 JSON 이 아닙니다');
      }
    } else if (rawVars && typeof rawVars === 'object') {
      vars = rawVars;
    }

    if (preset.presetVersion && preset.presetVersion >= 3) {
      warnings.push('NAI 프리셋(presetVersion ' + preset.presetVersion + ')입니다 — 정규식이 없을 수 있습니다');
    }
    if (!regex.length) warnings.push('이 프리셋에는 정규식(regex)이 없습니다');

    return {
      kind: 'preset',
      format: (meta && meta.format) || 'risup',
      title: preset.name || '(이름 없음)',
      subtitle:
        '프리셋 · 정규식 ' +
        regex.length +
        '개' +
        (preset.presetVersion != null ? ' · presetVersion ' + preset.presetVersion : ''),
      regex: regex,
      triggers: [],
      luaTriggers: [],
      lorebook: [],
      assets: [],
      vars: vars,
      preset: preset,
      warnings: warnings
    };
  }

  // ==================================================================
  // 9. 모듈 (.risum 바이너리 / .module · .charx ZIP)
  // ==================================================================

  /** modules.ts readModule — 매직 111, 버전 0, [len][rpack msgpack], 자산, 0 */
  function parseRisum(bytes) {
    var b = toBytes(bytes);
    var pos = 0;
    function readByte() {
      if (pos >= b.length) throw new Error('risum: 예상보다 일찍 끝났습니다');
      return b[pos++];
    }
    function readLen() {
      if (pos + 4 > b.length) throw new Error('risum: 길이 필드가 잘렸습니다');
      var v = u32(b, pos);
      pos += 4;
      return v;
    }
    function readData(n) {
      if (pos + n > b.length) throw new Error('risum: 본문이 잘렸습니다');
      var o = b.subarray(pos, pos + n);
      pos += n;
      return o;
    }

    if (readByte() !== 111) throw new Error('risum 매직 넘버가 111 이 아닙니다');
    if (readByte() !== 0) throw new Error('risum 버전이 0 이 아닙니다 (지원하지 않는 버전)');

    var mainLen = readLen();
    // readModule: JSON.parse(decodeRPack(mainData)) — msgpack 이 아니라 JSON 이다
    var main = decodeRPack(readData(mainLen));
    var parsed;
    try {
      parsed = JSON.parse(utf8(main));
    } catch (e) {
      // 혹시 msgpack 으로 만든 변형이 있으면 시도
      try {
        parsed = msgpackDecode(main);
      } catch (e2) {
        throw new Error('risum 본문이 JSON 도 msgpack 도 아닙니다: ' + e.message);
      }
    }
    if (!parsed || parsed.type !== 'risuModule') throw new Error("risum 본문 type 이 'risuModule' 이 아닙니다");

    var module = parsed.module || {};
    var assetCount = 0;
    while (pos < b.length) {
      var mark = readByte();
      if (mark === 0) break;
      if (mark !== 1) throw new Error('risum 자산 마커가 1 이 아닙니다: ' + mark);
      var len = readLen();
      readData(len); // 자산 본문은 시뮬레이터에서 쓰지 않는다
      assetCount++;
    }

    var warnings = [];
    if (assetCount) warnings.push('내장 자산 ' + assetCount + '개는 읽지 않았습니다 (이름만 사용)');

    return { module: module, warnings: warnings, format: 'risum' };
  }

  /** convertCharacterToModule (interchangeability.ts:55) 의 핵심 부분 */
  function characterToModule(normalized) {
    var lore = summarizeLorebook(normalized.character_book);
    return {
      name: normalized.name,
      description: normalized.creatorNotes,
      lorebook: lore,
      regex: normalized.customScripts,
      trigger: normalized.triggers,
      lowLevelAccess: normalized.lowLevelAccess,
      hideIcon: normalized.hideChatIcon,
      backgroundEmbedding: normalized.backgroundHTML,
      assets: normalized.additionalAssets,
      namespace: normalized.moduleNamespace,
      customModuleToggle: normalized.toggles,
      icon: ''
    };
  }

  function normalizeModule(module, meta) {
    var warnings = (meta && meta.warnings) || [];
    var regex = Array.isArray(module.regex) ? module.regex : [];
    var split = splitTriggers(module.trigger);
    if (module.lowLevelAccess) warnings.push('lowLevelAccess 모듈입니다 (Lua 저수준 API 사용 가능)');
    if (module.mcp && module.mcp.url) warnings.push('MCP 모듈입니다 (시뮬레이터 미지원): ' + module.mcp.url);

    return {
      kind: 'module',
      format: (meta && meta.format) || 'module',
      title: module.name || '(이름 없음)',
      subtitle:
        '모듈 · 정규식 ' +
        regex.length +
        ' · 트리거 ' +
        split.triggers.length +
        (split.luaTriggers.length ? ' · Lua ' + split.luaTriggers.length : ''),
      regex: regex,
      triggers: split.triggers,
      luaTriggers: split.luaTriggers,
      lorebook: Array.isArray(module.lorebook) ? module.lorebook : [],
      assets: assetNamesOf(module.assets),
      vars: {},
      module: module,
      warnings: warnings
    };
  }

  // ==================================================================
  // 10. charx / module ZIP 해석
  // ==================================================================

  function parseCharx(bytes, opts) {
    opts = opts || {};
    var b = toBytes(bytes);
    var warnings = [];
    var zip;
    try {
      zip = readZip(b);
    } catch (e) {
      return Promise.reject(new Error('charx(ZIP) 를 열 수 없습니다: ' + e.message));
    }

    var cardEntry = zip.find('card.json') || zip.findEndsWith('card.json');
    var moduleEntry = zip.find('module.risum') || zip.findEndsWith('module.risum');
    var assetEntries = zip
      .filter(function (e) {
        return !e.isDir && /^assets\//i.test(e.name);
      })
      .map(function (e) {
        return e.name;
      });

    if (!cardEntry && !moduleEntry) {
      return Promise.reject(new Error('charx 안에 card.json 도 module.risum 도 없습니다'));
    }

    var jobs = [];
    jobs.push(cardEntry ? zip.read(cardEntry) : Promise.resolve(null));
    jobs.push(moduleEntry ? zip.read(moduleEntry) : Promise.resolve(null));

    return Promise.all(jobs).then(function (res) {
      var cardBytes = res[0];
      var moduleBytes = res[1];
      var inner = null;
      var innerWarnings = [];

      if (moduleBytes) {
        try {
          inner = parseRisum(moduleBytes);
          innerWarnings = innerWarnings.concat(inner.warnings || []);
        } catch (e) {
          warnings.push('module.risum 해석 실패: ' + e.message);
        }
      }

      // card.json 이 없고 module.risum 만 있는 charx
      if (!cardBytes) {
        if (!inner) return Promise.reject(new Error('charx 안에 읽을 수 있는 카드 데이터가 없습니다'));
        var onlyModule = normalizeModule(inner.module, { format: 'module', warnings: warnings });
        return onlyModule;
      }

      var raw;
      try {
        raw = JSON.parse(utf8(cardBytes));
      } catch (e) {
        return Promise.reject(new Error('card.json 이 JSON 이 아닙니다: ' + e.message));
      }

      var normalized;
      try {
        normalized = normalizeCard(raw);
      } catch (e) {
        if (!inner) return Promise.reject(e);
        warnings.push('card.json 은 카드가 아니어서 모듈만 사용합니다');
        return normalizeModule(inner.module, { format: 'module', warnings: warnings });
      }

      // importCharacterProcess: module.risum 이 있으면 트리거/정규식/로어를 그것으로 덮어쓴다
      if (inner && inner.module) {
        var md = inner.module;
        if (Array.isArray(md.trigger)) normalized.triggers = md.trigger;
        if (Array.isArray(md.regex)) normalized.customScripts = md.regex;
        if (Array.isArray(md.lorebook) && md.lorebook.length) {
          normalized.lorebookOverride = md.lorebook;
        }
        if (md.name) normalized.name = normalized.name || md.name;
        warnings.push('module.risum 을 발견해 정규식/트리거를 그것으로 대체했습니다 (원본 동작)');
      }
      warnings = warnings.concat(innerWarnings);

      // --- 봇 카드로 볼지, 모듈로 볼지 ---
      if (opts.asModule) {
        var asMod = characterToModule(normalized);
        var modWarnings = warnings.slice();
        if (assetEntries.length) {
          modWarnings.push('charx 내 자산 ' + assetEntries.length + '개는 이름만 참조했습니다');
        }
        return normalizeModule(asMod, { format: 'charx', warnings: modWarnings });
      }

      return normalizeCharacter(normalized, {
        format: 'charx',
        warnings: warnings,
        assetEntries: assetEntries,
        lorebookOverride: normalized.lorebookOverride || null
      });
    });
  }

  function normalizeCharacter(n, meta) {
    var warnings = (meta && meta.warnings) || [];
    var split = splitTriggers(n.triggers);
    var lore = meta && meta.lorebookOverride ? meta.lorebookOverride : summarizeLorebook(n.character_book);
    var assets = assetNamesOf(n.additionalAssets);
    if (!assets.length && n.assets && n.assets.length) {
      assets = n.assets
        .map(function (a) {
          return (a && a.name) || '';
        })
        .filter(Boolean);
    }
    if (!assets.length && meta && meta.assetEntries && meta.assetEntries.length) {
      assets = meta.assetEntries
        .filter(function (p) {
          return !/\/icon\//i.test(p);
        })
        .map(function (p) {
          return p.replace(/^assets\//i, '');
        });
    }
    if (!n.firstMessage) warnings.push('퍼스트 메시지가 비어 있습니다');

    var vars = {};
    if (typeof n.defaultVariables === 'string' && n.defaultVariables.trim()) {
      try {
        vars = JSON.parse(n.defaultVariables);
      } catch (e) {
        warnings.push('defaultVariables 가 JSON 이 아닙니다');
      }
    } else if (n.defaultVariables && typeof n.defaultVariables === 'object') {
      vars = n.defaultVariables;
    }

    var subtitleBits = [n.spec === 'chara_card_v3' ? 'CCv3' : n.spec === 'chara_card_v2' ? 'CCv2' : n.spec];
    subtitleBits.push('정규식 ' + n.customScripts.length);
    subtitleBits.push('트리거 ' + split.triggers.length);
    if (split.luaTriggers.length) subtitleBits.push('Lua ' + split.luaTriggers.length);
    if (lore.length) subtitleBits.push('로어 ' + lore.length);

    return {
      kind: 'character',
      format: (meta && meta.format) || 'charx',
      title: n.name || '(이름 없음)',
      subtitle: subtitleBits.join(' · '),
      regex: n.customScripts,
      triggers: split.triggers,
      luaTriggers: split.luaTriggers,
      lorebook: lore,
      assets: assets,
      vars: vars,
      character: {
        name: n.name,
        firstMessage: n.firstMessage,
        alternateGreetings: n.alternateGreetings,
        description: n.description,
        personality: n.personality,
        scenario: n.scenario,
        exampleMessage: n.exampleMessage,
        systemPrompt: n.systemPrompt,
        postHistoryInstructions: n.postHistoryInstructions,
        creatorNotes: n.creatorNotes,
        tags: n.tags,
        creator: n.creator,
        characterVersion: n.characterVersion,
        spec: n.spec,
        nickname: n.nickname,
        backgroundHTML: n.backgroundHTML
      },
      warnings: warnings
    };
  }

  // ==================================================================
  // 11. 공개 API
  // ==================================================================

  function extOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function sniff(bytes, name) {
    var b = toBytes(bytes);
    var ext = extOf(name);
    if (ext === 'risup' || ext === 'risupreset') return 'preset';
    if (ext === 'risum' || ext === 'module') return 'module';
    if (ext === 'charx') return 'charx';
    if (ext === 'png') return 'png';
    if (startsWith(b, SIG_LOC)) return 'zip';
    if (startsWith(b, SIG_PNG)) return 'png';
    if (b.length > 2 && b[0] === 111 && b[1] === 0) return 'risum';
    if (ext === 'json') return 'json';
    return 'unknown';
  }

  /**
   * @param {{name:string, arrayBuffer:()=>Promise<ArrayBuffer>}|{name:string, data:Uint8Array}} file
   * @param {{kind?:'preset'|'character'|'module'}} [opts]  kind 를 주면 charx 를 그쪽으로 해석
   */
  function load(file, opts) {
    opts = opts || {};
    var name = file.name || '(이름 없음)';
    var p =
      file.data != null
        ? Promise.resolve(toBytes(file.data))
        : file.arrayBuffer().then(function (ab) {
            return new Uint8Array(ab);
          });

    var byteLength = 0;
    return p
      .then(function (bytes) {
      byteLength = bytes.length;
      if (!bytes.length) throw new Error('빈 파일입니다');
      var kind = sniff(bytes, name);
      var wanted = opts.kind;

      // .json 은 내용을 보고 판단
      if (kind === 'json') {
        var raw;
        try {
          raw = JSON.parse(utf8(bytes));
        } catch (e) {
          throw new Error('JSON 파싱 실패: ' + e.message);
        }
        if (raw && raw.type === 'risuModule') {
          return finish(normalizeModule(raw, { format: 'json' }));
        }
        if (raw && (raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3' || raw.char_name)) {
          if (wanted === 'module') {
            return finish(normalizeModule(characterToModule(normalizeCard(raw)), { format: 'json' }));
          }
          return finish(normalizeCharacter(normalizeCard(raw), { format: 'json' }));
        }
        if (raw && raw.type === 'preset') {
          return parsePresetBytes(bytes, { format: 'json' }).then(function (r) {
            return finish(normalizePreset(r.preset, r));
          });
        }
        if (raw && raw.type === 'regex' && Array.isArray(raw.data)) {
          return finish(
            normalizeModule(
              { name: raw.name || 'Imported Regex', regex: raw.data, trigger: [], lorebook: [] },
              { format: 'json' }
            )
          );
        }
        if (raw && raw.type === 'risu' && Array.isArray(raw.data)) {
          return finish(
            normalizeModule(
              { name: raw.name || 'Imported Lorebook', lorebook: raw.data, regex: [], trigger: [] },
              { format: 'json' }
            )
          );
        }
        if (raw && Array.isArray(raw.entries)) {
          return finish(
            normalizeModule(
              { name: raw.name || 'Imported Lorebook', lorebook: raw.entries, regex: [], trigger: [] },
              { format: 'json' }
            )
          );
        }
        // 프리셋 평문 JSON (presetTemplate 형태)
        if (raw && (raw.promptTemplate || raw.regex)) {
          return parsePresetBytes(bytes, { format: 'json' }).then(function (r) {
            return finish(normalizePreset(r.preset, r));
          });
        }
        throw new Error('어떤 RisuAI 형식인지 알 수 없는 JSON 입니다');
      }

      if (kind === 'preset') {
        return parsePresetBytes(bytes, { format: extOf(name) || 'risup' }).then(function (r) {
          return finish(normalizePreset(r.preset, r));
        });
      }

      if (kind === 'charx' || kind === 'zip') {
        return parseCharx(bytes, { asModule: wanted === 'module' });
      }

      if (kind === 'png') {
        return readPngCard(bytes).then(function (raw) {
          var n = normalizeCard(raw);
          if (wanted === 'module') {
            return finish(normalizeModule(characterToModule(n), { format: 'png' }));
          }
          return finish(normalizeCharacter(n, { format: 'png' }));
        });
      }

      if (kind === 'risum') {
        var r = parseRisum(bytes);
        return finish(normalizeModule(r.module, { format: 'risum', warnings: r.warnings }));
      }

      if (kind === 'module') {
        // .module 은 사실상 charx(zip). 혹시 risum 이면 그쪽으로.
        if (b0(bytes) === 111) {
          var rr = parseRisum(bytes);
          return finish(normalizeModule(rr.module, { format: 'risum', warnings: rr.warnings }));
        }
        return parseCharx(bytes, { asModule: true });
      }

      throw new Error(
        '지원하지 않는 파일입니다 (' + name + '). 확장자: .risup .risupreset .charx .module .risum .png .json'
      );
      })
      .then(function (entry) {
        if (!entry || typeof entry !== 'object') throw new Error('파서가 결과를 돌려주지 않았습니다');
        entry.fileName = name;
        entry.id = null; // UI 에서 부여
        entry.bytes = byteLength;
        return entry;
      });

    function b0(b) {
      return b[0];
    }

    // 개별 분기에서 이름/길이를 붙이지 않고 마지막 .then 에서 한 번에 처리한다
    function finish(entry) {
      return entry;
    }
  }

  var api = {
    VERSION: VERSION,
    load: load,
    extOf: extOf,
    sniff: sniff,
    // 파서 (테스트용)
    decodeRPack: decodeRPack,
    inflateAuto: inflateAuto,
    msgpackDecode: msgpackDecode,
    decryptBuffer: decryptBuffer,
    encryptBuffer: encryptBuffer,
    readZip: readZip,
    readPngCard: readPngCard,
    parseRisum: parseRisum,
    parseCharx: parseCharx,
    parsePresetBytes: parsePresetBytes,
    normalizeCard: normalizeCard,
    characterToModule: characterToModule,
    splitTriggers: splitTriggers
  };

  root.RisuImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

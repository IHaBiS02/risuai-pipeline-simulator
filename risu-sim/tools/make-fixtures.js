#!/usr/bin/env node
/**
 * make-fixtures.js — 테스트용 RisuAI 파일 생성기
 *
 * 이 스크립트는 **개발용**이다. 실제 RisuAI 가 쓰는 라이브러리(msgpackr, fflate)로
 * 바이트를 만들어서, importer.js 의 디코더가 진짜 파일을 읽는지 검증한다.
 *
 * 준비:
 *   npm init -y
 *   npm i msgpackr@1.10.1 fflate@0.8.3
 *
 * 실행:
 *   node risu-sim/tools/make-fixtures.js
 *
 * 출력: risu-sim/tools/fixtures/*.risup .risupreset .charx .module .risum .png .json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let msgpackr, fflate;
try {
  msgpackr = require('msgpackr/index-no-eval');
  fflate = require('fflate');
} catch (e) {
  console.error('msgpackr / fflate 가 필요합니다.  npm i msgpackr@1.10.1 fflate@0.8.3');
  process.exit(1);
}

const { encode: encodeMsgpack } = msgpackr;

const HERE = __dirname;
const OUT = path.join(HERE, 'fixtures');
const IMPORTER = path.join(HERE, '..', 'importer.js');

// importer.js 에 박혀 있는 rpack 맵을 그대로 재사용한다 (단일 소스).
const src = fs.readFileSync(IMPORTER, 'utf8');
const m = /RPACK_MAP_B64\s*=\s*'([^']+)'/.exec(src);
if (!m) throw new Error('importer.js 에서 RPACK_MAP_B64 를 찾지 못했습니다');
const MAP = Buffer.from(m[1], 'base64');
if (MAP.length !== 512) throw new Error('rpack 맵 길이가 512 가 아닙니다');
const ENCODE_MAP = MAP.subarray(0, 256);

function encodeRPack(bytes) {
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ENCODE_MAP[bytes[i]];
  return out;
}

// src/ts/util.ts encryptBuffer 와 동일: SHA-256(key) + AES-GCM, IV 12바이트 0
async function encryptBuffer(data, keyString) {
  const subtle = globalThis.crypto.subtle;
  const keyArray = await subtle.digest('SHA-256', new TextEncoder().encode(keyString));
  const key = await subtle.importKey('raw', keyArray, 'AES-GCM', false, ['encrypt']);
  const result = await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, data);
  return new Uint8Array(result);
}

// database.svelte.ts downloadPreset 과 동일한 순서
async function makeRisup(preset, { rpack = true } = {}) {
  const outer = encodeMsgpack({
    presetVersion: 2,
    type: 'preset',
    preset: await encryptBuffer(encodeMsgpack(preset), 'risupreset')
  });
  // mtime 고정: 재생성해도 바이트가 같아야 diff 가 안 생긴다 (fflate gzip 은 MTIME 필드를 쓴다)
  const compressed = fflate.compressSync(outer, { mtime: 0 });
  return rpack ? encodeRPack(Buffer.from(compressed)) : Buffer.from(compressed);
}

// modules.ts exportModuleLegacy / readModule 와 동일:
//   main = encodeRPack(JSON.stringify({module, type:'risuModule'}, null, 2))
//   assets = encodeRPack(compressSync(image))
function makeRisum(module, assets = []) {
  const chunks = [];
  const len = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
  };
  const byte = (n) => Buffer.from([n]);

  const mainMsgpack = encodeRPack(
    Buffer.from(JSON.stringify({ module, type: 'risuModule' }, null, 2), 'utf8')
  );

  chunks.push(byte(111), byte(0), len(mainMsgpack.length), Buffer.from(mainMsgpack));
  for (const a of assets) {
    const enc = encodeRPack(Buffer.from(fflate.compressSync(Buffer.from(a), { mtime: 0 })));
    chunks.push(byte(1), len(enc.length), enc);
  }
  chunks.push(byte(0));
  return Buffer.concat(chunks);
}

function makePng(w, h, rgb) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function makeZip(files) {
  // files: { 'path': Buffer|string }
  const input = {};
  for (const [k, v] of Object.entries(files)) input[k] = Buffer.from(v);
  // mtime 고정 (zip 은 엔트리마다 수정 시각을 저장한다)
  return Buffer.from(fflate.zipSync(input, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') }));
}

function makePngWithText(keyword, text) {
  // 1x1 회색 PNG + tEXt 청크
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.from([0x00, 0x80]);
  const idat = zlib.deflateSync(raw);

  const textData = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1')
  ]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', textData),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ------------------------------------------------------------------
// 픽스처 내용
// ------------------------------------------------------------------

const PRESET = {
  name: 'Fixture Preset',
  presetVersion: 2,
  regex: [
    {
      comment: '프리셋: 앞에 배지',
      type: 'editdisplay',
      in: '^([\\s\\S]*)$',
      out: '<div class="pbadge">P</div>\n$1',
      ableFlag: true,
      flag: 'g'
    },
    {
      comment: '프리셋: order 5 (모듈 order 10 보다 늦게)',
      type: 'editdisplay',
      in: 'P</div>',
      out: 'P!</div>',
      ableFlag: true,
      flag: 'g,<order 5>'
    }
  ],
  templateDefaultVariables: '{"hp":"77","toggle_flag":"1"}',
  temperature: 80,
  promptTemplate: [{ type: 'plain', type2: 'main', text: 'You are {{char}}.', role: 'system' }]
};

const BOT_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: 'FixtureBot',
    description: '테스트용 봇입니다. {{char}} 는 조용한 안드로이드.',
    personality: '과묵함',
    scenario: '폐허가 된 연구소',
    first_mes:
      '*{{char}} 가 고개를 든다.*\n\n<span class="hello">안녕, {{user}}.</span>\n\nHP: {{getvar::hp}}',
    alternate_greetings: ['*조용히 손을 흔든다.*', '*눈을 감는다.*'],
    mes_example: '<START>\n{{user}}: 안녕\n{{char}}: ...',
    system_prompt: '',
    post_history_instructions: '',
    creator_notes: '픽스처 봇',
    tags: ['test', 'fixture'],
    creator: 'IHaBiS02',
    character_version: '1.0',
    character_book: {
      name: 'fixture book',
      entries: [
        {
          keys: ['연구소'],
          comment: '연구소 설명',
          content: '연구소는 지하 3층까지 있다.',
          enabled: true,
          insertion_order: 10
        }
      ]
    },
    extensions: {
      risuai: {
        customScripts: [
          {
            comment: '봇: 래퍼 + CSS',
            type: 'editdisplay',
            in: '^([\\s\\S]*)$',
            out: '<style>\n.hello{color:#7fd1ff}\n.pbadge{background:#333;border-radius:999px;padding:0 6px;font-size:10px}\n</style>\n<div class="botwrap">$1</div>',
            ableFlag: true,
            flag: 'g'
          }
        ],
        triggerscript: [
          {
            comment: 'Lua 훅',
            type: '',
            effect: [
              {
                type: 'triggerlua',
                code: "listenEdit('editDisplay', function(id, data, meta)\n  return data .. '\\n\\n<!-- lua -->'\nend)"
              }
            ]
          },
          {
            comment: '표시 트리거',
            type: 'display',
            conditions: [],
            effect: [{ type: 'v2ConsoleLog', source: 'hi', sourceType: 'value', indent: 0 }]
          }
        ],
        defaultVariables: '{"hp":"42"}',
        additionalAssets: [
          ['smile_happy.png', '', 'png'],
          ['angry.png', '', 'png']
        ],
        lowLevelAccess: false
      }
    },
    assets: [{ type: 'icon', name: 'main', uri: 'ccdefault:', ext: 'png' }]
  }
};

const MODULE = {
  name: 'Fixture Module',
  description: '픽스처 모듈',
  id: '00000000-0000-4000-8000-000000000001',
  regex: [
    {
      comment: '모듈: HP 강조',
      type: 'editdisplay',
      in: 'HP: (\\d+)',
      out: 'HP: <b>$1</b>',
      ableFlag: true,
      flag: 'g,<order 10>'
    }
  ],
  trigger: [
    {
      comment: '모듈 트리거',
      type: 'display',
      conditions: [],
      effect: [{ type: 'v2ConsoleLog', source: 'mod', sourceType: 'value', indent: 0 }]
    }
  ],
  lorebook: [
    { key: '연구소', secondkey: '', insertorder: 1, comment: '모듈 로어', content: '모듈 로어 내용', mode: 'constant', alwaysActive: true, selective: false }
  ]
};

// ------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const written = [];

  const write = (name, buf) => {
    fs.writeFileSync(path.join(OUT, name), buf);
    written.push(name + ' (' + buf.length + ' B)');
  };

  write('fixture-preset.risup', await makeRisup(PRESET, { rpack: true }));
  write('fixture-preset-old.risupreset', await makeRisup(PRESET, { rpack: false }));

  // 프리셋 평문 JSON (presetTemplate 형태)
  write('fixture-preset.json', Buffer.from(JSON.stringify(PRESET, null, 2), 'utf8'));

  // charx: card.json + module.risum (실제 exportCharacterCard 와 같은 구성)
  const charxCard = JSON.parse(JSON.stringify(BOT_CARD));
  const charxModule = {
    name: 'FixtureBot Module',
    description: 'Module for FixtureBot',
    id: '00000000-0000-4000-8000-000000000002',
    trigger: charxCard.data.extensions.risuai.triggerscript,
    regex: charxCard.data.extensions.risuai.customScripts,
    lorebook: []
  };
  delete charxCard.data.extensions.risuai.triggerscript;
  delete charxCard.data.extensions.risuai.customScripts;

  write(
    'fixture-bot.charx',
    makeZip({
      'card.json': JSON.stringify(charxCard, null, 4),
      'module.risum': makeRisum(charxModule, [Buffer.from('fake-png')]),
      'assets/icon/main.png': Buffer.from('not-a-real-png')
    })
  );

  // 봇 카드만 있고 module.risum 이 없는 charx (트리거/정규식이 card.json 에 있음)
  write('fixture-bot-nomod.charx', makeZip({ 'card.json': JSON.stringify(BOT_CARD, null, 4) }));

  // charxJpeg 구조: JPEG 바이트 뒤에 ZIP 을 붙인다.
  // characterCards.ts:1324 → CharXWriter.writeJpeg 가 앞에 JPEG 을 먼저 쓴다.
  // RisuAI 의 fflate Unzip 은 이걸 허용하므로 리더도 허용해야 한다.
  const jpegPrefix = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from('\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'binary'),
    Buffer.from('JPEGDATA'.repeat(50), 'binary'),
    Buffer.from([0xff, 0xd9])
  ]);
  write(
    'fixture-charxjpeg.charx',
    Buffer.concat([jpegPrefix, makeZip({ 'card.json': JSON.stringify(BOT_CARD, null, 4) })])
  );

  // module 이 .module 확장자로 나가는 경우 (exportModule 경로)
  const modCharCard = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: MODULE.name,
      description: MODULE.description,
      first_mes: '',
      mes_example: '',
      creator_notes: MODULE.description,
      character_book: { name: 'b', entries: [] },
      extensions: { risuai: { additionalAssets: [], lowLevelAccess: false } },
      assets: [{ type: 'icon', name: 'main', uri: 'ccdefault:', ext: 'png' }]
    }
  };
  write(
    'fixture-module.module',
    makeZip({
      'card.json': JSON.stringify(modCharCard, null, 4),
      'module.risum': makeRisum(MODULE)
    })
  );

  // 레거시 바이너리 모듈
  write('fixture-module.risum', makeRisum(MODULE, [Buffer.from('asset-bytes')]));

  // PNG 봇 카드 (tEXt chara = base64 JSON, CCv2 형식)
  const v2 = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'PngBot',
      description: 'PNG 봇',
      first_mes: '*{{char}} 가 웃는다.*',
      mes_example: '',
      extensions: {
        risuai: {
          customScripts: [
            {
              comment: 'png 봇 css',
              type: 'editdisplay',
              in: '^([\\s\\S]*)$',
              out: '<style>.pngbot{color:#f0f}</style>\n<div class="pngbot">$1</div>',
              ableFlag: true,
              flag: 'g'
            }
          ],
          triggerscript: []
        }
      }
    }
  };
  write('fixture-bot.png', makePngWithText('chara', Buffer.from(JSON.stringify(v2), 'utf8').toString('base64')));

  // UI 카드처럼 {{#when}} + 이미지/CSS 에셋을 쓰는 봇 (실제 화면 재현 검증용)
  const CARDUI_FIRST = [
    '<div class="ui-container">',
    '<div class="parchment-bg"></div>',
    '<button class="fm-title-btn" risu-trigger="open">!!! TEST PARTY !!!</button>',
    '{{#when::{{getvar::revealed}}::is::1}}<div class="revealed">OPENED</div>{{/when}}',
    '{{#when::toggle::cot}}<div class="cot">COT ON</div>{{/when}}',
    '{{#when::toggle::tone::is::1}}<div class="tone1">TONE DARK</div>{{/when}}',
    '{{#when::{{getvar::view}}::isnot::demon}}',
    '{{#when::{{getvar::closed}}::isnot::0}}<div class="fm-sub-ti">Click here to get started</div>',
    '{{/when}}',
    '{{/when}}',
    '{{#when::{{getvar::reveal}}::is::yes}}<div class="fm-cat-grid">{{image::banner}}</div>{{/when}}',
    '</div>'
  ].join('\n');

  const CARDUI_CSS =
    '.ui-container{background:url({{raw::banner}}) no-repeat center;background-size:cover;' +
    'border-radius:12px;padding:20px;color:#fff}' +
    '.fm-title-btn{background:rgba(0,0,0,.45);border:0;color:#fff;font-size:18px;padding:8px 14px}' +
    '.fm-sub-ti{color:#ffe9b0;letter-spacing:.2em;font-size:11px}';

  const cardUi = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'CardUiBot',
      description: 'HTML 카드 UI 봇',
      first_mes: '<style>' + CARDUI_CSS + '</style>\n' + CARDUI_FIRST,
      alternate_greetings: [],
      mes_example: '',
      creator_notes: '',
      character_version: '1.0',
      tags: [],
      creator: '',
      character_book: { name: 'b', entries: [] },
      extensions: {
        risuai: {
          customScripts: [],
          triggerscript: [
            {
              comment: 'open',
              type: 'display',
              conditions: [],
              effect: [{ type: 'v2SetVar', var: 'revealed', operator: '=', value: '1', indent: 0 }]
            }
          ],
          toggles: 'cot=CoT 로그\ntone=톤=select=밝게,어둡게\nnote=메모=text',
          defaultVariables: '{"view":"normal","closed":"1","reveal":"yes"}',
          additionalAssets: [['banner', '', 'png']]
        }
      },
      assets: [
        { type: 'icon', name: 'main', uri: 'embeded://assets/icon/images/main.png', ext: 'png' },
        { type: 'x-risu-asset', name: 'banner', uri: 'embeded://assets/x-risu-asset/images/banner.png', ext: 'png' }
      ],
      group_only_greetings: [],
      nickname: '',
      source: []
    }
  };
  write(
    'fixture-cardui.charx',
    makeZip({
      'card.json': JSON.stringify(cardUi, null, 4),
      'assets/icon/images/main.png': makePng(8, 8, [255, 120, 200]),
      'assets/x-risu-asset/images/banner.png': makePng(16, 8, [200, 160, 90])
    })
  );

  // 모듈 JSON (type: risuModule)
  write('fixture-module.json', Buffer.from(JSON.stringify({ type: 'risuModule', ...MODULE }, null, 2), 'utf8'));

  console.log('생성 완료 →', OUT);
  written.forEach((w) => console.log('  ', w));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

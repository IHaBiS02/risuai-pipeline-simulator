#!/usr/bin/env python3
"""
RisuAI 시뮬레이터용 — OpenAI 호환 임베딩 목(mock) 서버

실제 API 키 없이 동적 에셋 파이프라인을 테스트하기 위한 개발 도구입니다.
문자 3-gram 해싱으로 결정적인 벡터를 만들어, 이름이 비슷한 에셋끼리
코사인 유사도가 높게 나오도록 흉내 냅니다. (실제 모델이 아닙니다)

    python3 tools/mock-embeddings.py 8899
    # 시뮬레이터에서 URL: http://127.0.0.1:8899/v1

지원:
    POST /v1/embeddings   { "input": ["a","b"], "model": "..." }
                       →  { "data": [{"embedding": [...], "index": 0}, ...] }

주의: 프로덕션용이 아닙니다. 시뮬레이터 검증 전용.
"""
import hashlib
import json
import math
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

DIM = 128


def embed(text: str) -> list:
    v = [0.0] * DIM
    t = str(text).lower()
    grams = [t[i:i + 3] for i in range(max(1, len(t) - 2))]
    for g in grams:
        h = hashlib.md5(g.encode("utf-8")).digest()
        idx = int.from_bytes(h[:4], "big") % DIM
        sign = 1.0 if h[4] % 2 == 0 else -1.0
        v[idx] += sign
    n = math.sqrt(sum(x * x for x in v))
    if n == 0:
        return v
    return [x / n for x in v]


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path in ("/health", "/"):
            body = json.dumps({"ok": True, "dim": DIM}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/embeddings"):
            self.send_error(404, "use POST /v1/embeddings")
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._json(400, {"error": {"message": f"bad json: {e}"}})
            return

        inp = payload.get("input")
        if inp is None:
            self._json(400, {"error": {"message": "input is required"}})
            return
        if isinstance(inp, str):
            inp = [inp]
        if not isinstance(inp, list):
            self._json(400, {"error": {"message": "input must be string or array"}})
            return

        data = [{"object": "embedding", "embedding": embed(s), "index": i}
                for i, s in enumerate(inp)]
        self._json(200, {
            "object": "list",
            "data": data,
            "model": payload.get("model") or "mock-trigram-128",
            "usage": {"prompt_tokens": sum(len(str(s)) for s in inp), "total_tokens": 0},
        })

    def _json(self, code: int, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock-embeddings] " + (fmt % args) + "\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print(f"mock embeddings listening on http://127.0.0.1:{port}/v1 (dim={DIM})")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()

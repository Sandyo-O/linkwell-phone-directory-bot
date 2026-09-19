"""Tiny local HTTP sidecar for SenseVoice-small speech recognition.

Runs as a persistent background process (spawned by server.js, same pattern
as the piper.exe subprocess) so the model - and PyTorch's startup cost - is
only paid once, not per request.

Both this process and server.js run on the same machine, so instead of
re-uploading audio bytes over HTTP, the caller writes a WAV file to disk
(server.js already does this for ffmpeg) and just POSTs the path as JSON;
this process reads it directly with funasr, exactly like the interactive
test that verified this model's accuracy/speed.
"""

import json
import re
import sys
import time

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
TAG_PATTERN = re.compile(r"<\|[^|]*\|>")

print("Loading SenseVoice-small model...", flush=True)
_t0 = time.time()
from funasr import AutoModel  # noqa: E402 (import after the print, so the caller sees progress)

model = AutoModel(model="iic/SenseVoiceSmall", trust_remote_code=True, disable_update=True)
print(f"SenseVoice model loaded in {time.time() - _t0:.2f}s", flush=True)


def transcribe(wav_path: str) -> str:
    result = model.generate(input=wav_path, language="zh", use_itn=True)
    text = result[0]["text"] if result else ""
    # funasr tags the output with <|zh|><|NEUTRAL|><|Speech|><|withitn|> etc. -
    # strip those, we only want the actual transcript.
    return TAG_PATTERN.sub("", text).strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # keep stdout to just our own [ready]/error lines

    def do_POST(self):
        if self.path != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            text = transcribe(body["wav_path"])
            payload = json.dumps({"text": text}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:  # noqa: BLE001 - report any failure back, don't crash the server
            print(f"transcribe error: {e}", file=sys.stderr, flush=True)
            self.send_response(500)
            self.end_headers()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[ready] SenseVoice sidecar listening on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()

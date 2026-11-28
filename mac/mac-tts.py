#!/usr/bin/python3
"""
mac-tts: an OpenAI-compatible /v1/audio/speech on top of macOS `say` (default voice: Linh, vi_VN).

  GET  /v1/models          {"object":"list","data":[{"id":"linh",...}]}
  POST /v1/audio/speech    {model, input, voice?, response_format?, speed?} -> audio bytes

`voice` is a macOS voice name (`say -v '?'`); an OpenAI voice name ("alloy") or none means the model's voice.
Listens on 127.0.0.1 only: ai-router reaches it at http://host.docker.internal:<port>/v1 (README, Local models
and voices on the Mac). Needs ffmpeg (`brew install ffmpeg`); the Python is the system one, standard library only.
"""
import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("MAC_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("MAC_TTS_PORT", "8795"))
SAY = os.environ.get("MAC_TTS_SAY", "/usr/bin/say")
FFMPEG = os.environ.get("MAC_TTS_FFMPEG", "/opt/homebrew/bin/ffmpeg")
DEFAULT_VOICE = os.environ.get("MAC_TTS_VOICE", "Linh")
BASE_RATE = 175  # words per minute at speed 1 (say's documented default)
MAX_INPUT = 4096
MAX_BODY = 64 * 1024
TIMEOUT_S = 120
BUSY = threading.BoundedSemaphore(2)

FORMATS = {
    "mp3": ("audio/mpeg", ["-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3"]),
    "wav": ("audio/wav", ["-c:a", "pcm_s16le", "-f", "wav"]),
    "aac": ("audio/aac", ["-c:a", "aac", "-b:a", "128k", "-f", "adts"]),
    "opus": ("audio/ogg", ["-c:a", "libopus", "-b:a", "64k", "-f", "ogg"]),
    "flac": ("audio/flac", ["-c:a", "flac", "-f", "flac"]),
    "pcm": ("audio/pcm", ["-c:a", "pcm_s16le", "-ar", "24000", "-f", "s16le"]),
}


def installed_voices():
    out = subprocess.run([SAY, "-v", "?"], capture_output=True, text=True, timeout=30).stdout
    names = {}
    for line in out.splitlines():
        # "Linh                vi_VN    # Xin chào! ..." ; names may contain spaces and a "(Locale)" suffix
        head = line.split("#", 1)[0].rstrip()
        parts = head.rsplit(None, 1)
        if len(parts) == 2:
            names[parts[0].strip().lower()] = parts[0].strip()
    return names


VOICES = installed_voices()
MODELS = sorted({DEFAULT_VOICE.lower()})


def pick_voice(model, voice):
    for v in (voice, model):
        if isinstance(v, str) and v.strip().lower() in VOICES:
            return VOICES[v.strip().lower()]
    return VOICES.get(DEFAULT_VOICE.lower(), DEFAULT_VOICE)


def synthesize(text, voice, speed, fmt):
    with tempfile.TemporaryDirectory(prefix="mac-tts-") as d:
        src = os.path.join(d, "in.txt")
        aiff = os.path.join(d, "out.aiff")
        with open(src, "w", encoding="utf-8") as f:
            f.write(text)
        cmd = [SAY, "-v", voice, "-f", src, "-o", aiff]
        if speed != 1:
            cmd += ["-r", str(int(BASE_RATE * speed))]
        subprocess.run(cmd, check=True, capture_output=True, timeout=TIMEOUT_S)
        _, codec = FORMATS[fmt]
        enc = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", aiff, "-ac", "1", *codec, "pipe:1"], check=True, capture_output=True, timeout=TIMEOUT_S)
        return enc.stdout


class Handler(BaseHTTPRequestHandler):
    server_version = "mac-tts/1"

    def log_message(self, fmt, *args):  # no request text in the log
        print("%s %s" % (self.command, self.path), flush=True)

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def error(self, status, message, code=None):
        self.send_json(status, {"error": {"message": message, "type": "invalid_request_error" if status < 500 else "api_error", "code": code}})

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            return self.send_json(200, {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "mac-tts"} for m in MODELS]})
        if self.path == "/health":
            return self.send_json(200, {"ok": True})
        self.error(404, "not found", "not_found")

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/audio/speech", "/audio/speech"):
            return self.error(404, "not found", "not_found")
        n = int(self.headers.get("content-length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self.error(400, "body: a JSON object of at most 64 KB")
        try:
            body = json.loads(self.rfile.read(n))
        except ValueError:
            return self.error(400, "body must be JSON")
        if not isinstance(body, dict):
            return self.error(400, "body must be a JSON object")
        text = body.get("input")
        if not isinstance(text, str) or not text.strip():
            return self.error(400, "input: the text to speak")
        if len(text) > MAX_INPUT:
            return self.error(400, "input: at most %d characters" % MAX_INPUT)
        fmt = body.get("response_format") or "mp3"
        if fmt not in FORMATS:
            return self.error(400, "response_format: one of " + ", ".join(FORMATS))
        speed = body.get("speed", 1)
        if not isinstance(speed, (int, float)) or isinstance(speed, bool) or not 0.25 <= speed <= 4:
            return self.error(400, "speed: 0.25 to 4")
        voice = pick_voice(body.get("model"), body.get("voice"))
        if not BUSY.acquire(timeout=60):
            return self.error(429, "busy, try again", "rate_limit")
        try:
            audio = synthesize(text, voice, float(speed), fmt)
        except subprocess.TimeoutExpired:
            return self.error(504, "speech took too long", "timeout")
        except subprocess.CalledProcessError as e:
            return self.error(500, "speech failed: " + (e.stderr or b"").decode("utf-8", "replace")[-300:])
        finally:
            BUSY.release()
        self.send_response(200)
        self.send_header("content-type", FORMATS[fmt][0])
        self.send_header("content-length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


if __name__ == "__main__":
    print("mac-tts on %s:%d, voice %s, models %s" % (HOST, PORT, DEFAULT_VOICE, MODELS), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

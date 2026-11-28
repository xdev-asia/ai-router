"""mac-tts with a fake `say` and `ffmpeg`: runs on any OS. `python3 -m unittest discover -s mac`."""
import importlib.util
import json
import os
import stat
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

FAKE_SAY = """#!/bin/sh
# -v ? lists the voices; otherwise writes its arguments and the text to the -o file.
if [ "$1" = "-v" ] && [ "$2" = "?" ]; then
  printf 'Linh                vi_VN    # Xin chao! Ten toi la Linh.\\n'
  printf 'Samantha            en_US    # Hello! My name is Samantha.\\n'
  printf 'Eddy (English (US)) en_US    # Hello! My name is Eddy.\\n'
  exit 0
fi
out=""; file=""; args="$*"
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift;; -f) file="$2"; shift;; esac
  shift
done
{ echo "$args"; cat "$file"; } > "$out"
"""

FAKE_FFMPEG = """#!/bin/sh
# Answers its arguments and the say output it was given, on stdout.
in=""; prev=""
for a in "$@"; do [ "$prev" = "-i" ] && in="$a"; prev="$a"; done
echo "ffmpeg $*"; cat "$in"
"""

FAILING_SAY = """#!/bin/sh
if [ "$1" = "-v" ] && [ "$2" = "?" ]; then printf 'Linh                vi_VN    # x\\n'; exit 0; fi
echo "voice broke" >&2; exit 1
"""


def script(d, name, body):
    p = os.path.join(d, name)
    with open(p, "w") as f:
        f.write(body)
    os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
    return p


def load(env):
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location("mac_tts", os.path.join(HERE, "mac-tts.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class MacTtsTest(unittest.TestCase):
    def start(self, say=FAKE_SAY):
        self.tmp = tempfile.TemporaryDirectory()
        mod = load({"MAC_TTS_SAY": script(self.tmp.name, "say", say), "MAC_TTS_FFMPEG": script(self.tmp.name, "ffmpeg", FAKE_FFMPEG), "MAC_TTS_VOICE": "Linh"})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def post(self, body, path="/v1/audio/speech"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, headers={"content-type": "application/json", "authorization": "Bearer local"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.headers.get("content-type"), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("content-type"), e.read()

    def test_lists_its_voice_as_a_model(self):
        self.start()
        with urllib.request.urlopen(self.base + "/v1/models") as r:
            self.assertEqual(json.load(r)["data"], [{"id": "linh", "object": "model", "owned_by": "mac-tts"}])

    def test_speaks_the_input_with_linh_as_mp3_by_default(self):
        self.start()
        status, ctype, body = self.post({"model": "linh", "input": "Xin chào", "voice": "alloy"})
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "audio/mpeg")
        text = body.decode()
        self.assertIn("-v Linh -f", text)
        self.assertIn("libmp3lame", text)
        self.assertTrue(text.endswith("Xin chào"), text)
        self.assertNotIn("-r ", text)

    def test_takes_an_installed_macos_voice_by_name_any_case(self):
        self.start()
        _, _, body = self.post({"model": "linh", "input": "Hello", "voice": "samantha"})
        self.assertIn("-v Samantha -f", body.decode())
        _, _, body = self.post({"model": "linh", "input": "Hello", "voice": "Eddy (English (US))"})
        self.assertIn("-v Eddy (English (US)) -f", body.decode())

    def test_speed_and_format(self):
        self.start()
        status, ctype, body = self.post({"model": "linh", "input": "x", "speed": 1.2, "response_format": "wav"})
        self.assertEqual((status, ctype), (200, "audio/wav"))
        self.assertIn("-r 210", body.decode())
        self.assertIn("pcm_s16le", body.decode())

    def test_text_starting_with_a_dash_is_spoken_not_read_as_an_option(self):
        self.start()
        _, _, body = self.post({"model": "linh", "input": "-o /etc/passwd"})
        self.assertTrue(body.decode().endswith("-o /etc/passwd"))

    def test_refuses_bad_requests_in_the_openai_error_shape(self):
        self.start()
        for bad, field in [
            ({"model": "linh"}, "input"),
            ({"model": "linh", "input": "   "}, "input"),
            ({"model": "linh", "input": "x" * 4097}, "input"),
            ({"model": "linh", "input": "x", "response_format": "midi"}, "response_format"),
            ({"model": "linh", "input": "x", "speed": 9}, "speed"),
            ({"model": "linh", "input": "x", "speed": True}, "speed"),
            ([1, 2], "JSON object"),
        ]:
            status, ctype, body = self.post(bad)
            self.assertEqual(status, 400, bad)
            self.assertEqual(ctype, "application/json")
            self.assertIn(field, json.loads(body)["error"]["message"], bad)
        self.assertEqual(self.post(b"not json")[0], 400)
        self.assertEqual(self.post({"input": "x"}, path="/v1/other")[0], 404)

    def test_a_failing_say_is_a_500_with_its_message(self):
        self.start(say=FAILING_SAY)
        status, _, body = self.post({"model": "linh", "input": "x"})
        self.assertEqual(status, 500)
        self.assertIn("voice broke", json.loads(body)["error"]["message"])


if __name__ == "__main__":
    unittest.main()

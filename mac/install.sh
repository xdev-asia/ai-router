#!/bin/sh
# Installs mac-tts and/or Ollama as launchd daemons that run as the user who ran sudo.
#   sudo mac/install.sh            both
#   sudo mac/install.sh mac-tts    only mac-tts (needs: brew install ffmpeg)
#   sudo mac/install.sh ollama     only Ollama  (needs: brew install ollama)
# Run it again after pulling a new mac-tts.py: it copies the file and restarts the daemon.
set -eu
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
user="${SUDO_USER:?run with sudo from the user who will own the daemons}"
home=$(dscl . -read "/Users/$user" NFSHomeDirectory | awk '{print $2}')
here=$(cd "$(dirname "$0")" && pwd)
what="${1:-all}"

daemon() { # <label>
  src="$here/$1.plist" dst="/Library/LaunchDaemons/$1.plist"
  sed -e "s#__USER__#$user#g" -e "s#__HOME__#$home#g" "$src" > "$dst.tmp"
  plutil -lint "$dst.tmp" >/dev/null
  chown root:wheel "$dst.tmp" && chmod 644 "$dst.tmp" && mv "$dst.tmp" "$dst"
  launchctl bootout "system/$1" 2>/dev/null || true
  launchctl bootstrap system "$dst"
  echo "started $1 (log: $home/Library/Logs/${1#asia.xdev.}.log)"
}

case "$what" in all|mac-tts)
  [ -x /opt/homebrew/bin/ffmpeg ] || { echo "mac-tts needs ffmpeg: brew install ffmpeg" >&2; exit 1; }
  install -d -o "$user" -g staff -m 755 "$home/ai-router/mac"
  install -o "$user" -g staff -m 755 "$here/mac-tts.py" "$home/ai-router/mac/mac-tts.py"
  daemon asia.xdev.mac-tts ;;
esac
case "$what" in all|ollama)
  [ -x /opt/homebrew/opt/ollama/bin/ollama ] || { echo "Ollama is not installed: brew install ollama" >&2; exit 1; }
  daemon asia.xdev.ollama ;;
esac
case "$what" in all|mac-tts|ollama) ;; *) echo "usage: sudo $0 [all|mac-tts|ollama]" >&2; exit 1 ;; esac

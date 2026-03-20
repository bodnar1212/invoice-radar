#!/usr/bin/env python3
"""Native messaging host that writes cookie auth files for invoice-radar."""

import json
import os
import struct
import sys

# Auth files are written next to the main project
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack("=I", raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data)

def send_message(msg):
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def main():
    msg = read_message()
    if not msg:
        return

    file_name = msg.get("file")
    content = msg.get("content")

    if not file_name or not content:
        send_message({"error": "missing file or content"})
        return

    # Only allow writing known auth files
    allowed = {"cursor-auth.json", "claude-auth.json"}
    if file_name not in allowed:
        send_message({"error": f"file not allowed: {file_name}"})
        return

    path = os.path.join(PROJECT_DIR, file_name)
    with open(path, "w") as f:
        f.write(content)

    send_message({"ok": True, "path": path})

if __name__ == "__main__":
    main()

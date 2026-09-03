#!/usr/bin/env python3
"""Fake caller-ID modems on virtual serial ports (macOS/Linux, no extra deps).

Opens N pty pairs and prints the slave device paths — put those in
settings.json as modem ports, start the printer server, then type commands
here to simulate incoming calls.

    python3 scripts/fake-modems.py 2

Commands (stdin):
    ring <n> <number>       one call on modem n
    both <number>           same number on every modem at once (dedup test)
    all <numA> <numB> ...   a different number per modem at once
    slow <n> <number>       CID split into chunks (interleaving test)
    raw <n> <text>          send arbitrary text
    quit
"""

import os
import pty
import sys
import threading
import time

# Bellcore MDMF, the shape a Conexant CX93010 emits with AT+VCID=1.
CID = (
    "\r\nRING\r\n"
    "\r\nDATE = 0731\r\nTIME = 1030\r\nNMBR = {number}\r\nNAME = O\r\n"
    "\r\nRING\r\n"
)


def drain(fd, name):
    """Read whatever the printer server writes (AT init, keepalives)."""
    while True:
        try:
            data = os.read(fd, 1024)
        except OSError:
            return
        if not data:
            return
        print(f"  <- {name} got {data!r}", flush=True)


def main():
    # Line-buffered so the port paths show up immediately when piped.
    sys.stdout.reconfigure(line_buffering=True)

    count = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    modems = []

    for i in range(count):
        master, slave = pty.openpty()
        path = os.ttyname(slave)
        modems.append({"fd": master, "name": f"modem{i + 1}", "path": path})
        threading.Thread(
            target=drain, args=(master, f"modem{i + 1}"), daemon=True
        ).start()

    print("Virtual modems ready. Put these in settings.json:\n")
    print("  \"modems\": [")
    print(
        ",\n".join(
            f'    {{ "port": "{m["path"]}", "label": "line{i + 1}" }}'
            for i, m in enumerate(modems)
        )
    )
    print("  ],\n")
    for m in modems:
        print(f"  {m['name']} -> {m['path']}")
    print("\nCommands: ring <n> <num> | both <num> | all <a> <b> | slow <n> <num> | quit")

    def send(idx, text):
        os.write(modems[idx]["fd"], text.encode())
        print(f"  -> {modems[idx]['name']} sent {text!r}", flush=True)

    for line in sys.stdin:
        parts = line.split()
        if not parts:
            continue
        cmd = parts[0]

        if cmd == "quit":
            break

        if cmd == "ring":
            send(int(parts[1]) - 1, CID.format(number=parts[2]))

        elif cmd == "both":
            # Same call on every line: exactly ONE order should reach the BE.
            for i in range(len(modems)):
                send(i, CID.format(number=parts[1]))

        elif cmd == "all":
            # A different call per line, at the same moment: N orders expected.
            for i, number in enumerate(parts[1:]):
                if i < len(modems):
                    send(i, CID.format(number=number))

        elif cmd == "slow":
            idx = int(parts[1]) - 1
            payload = CID.format(number=parts[2])
            for start in range(0, len(payload), 7):
                send(idx, payload[start : start + 7])
                time.sleep(0.05)

        elif cmd == "raw":
            send(int(parts[1]) - 1, " ".join(parts[2:]) + "\r\n")

        else:
            print(f"  ?? unknown command: {cmd}")

    for m in modems:
        os.close(m["fd"])


if __name__ == "__main__":
    main()

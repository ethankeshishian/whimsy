"""A CONNECT-only tunnel on 127.0.0.1 for the AI quality evals.

    python3 whimsy/tools/aievals_proxy.py --allow api.anthropic.com:443 --port-file PATH

The mochitest runner makes any socket to a non-local address a fatal crash,
and the browser also release-asserts that guard whenever it runs in
automation, so a real eval run cannot simply lift it. Instead the test
browser's PAC (head_aievals.js) sends the model's API to this tunnel, which
is a local socket as far as the browser is concerned, and this tunnel opens
the outbound connection itself. Only the exact host:port pairs named with
--allow are tunnelled (anything else gets 403), only CONNECT is served (405
otherwise), and nothing inside the tunnel is read or logged: it is TLS from
the browser to the API, so the key never passes through here in the clear.
The bound port is written to --port-file once the listener is up; the
process runs until it is killed.
"""
import argparse
import select
import socket
import socketserver
import sys
import threading

IDLE_SECONDS = 300


def parse_connect_target(line):
    """'CONNECT host:port HTTP/1.1' -> 'host:port' (lower-cased host), else None."""
    parts = line.split()
    if len(parts) != 3 or parts[0] != "CONNECT":
        return None
    target = parts[1]
    if target.count(":") != 1:
        return None
    host, _, port = target.rpartition(":")
    if not host or not port.isdigit():
        return None
    return f"{host.lower()}:{int(port)}"


def relay(a, b):
    """Copy bytes both ways until one side closes or the tunnel idles."""
    pairs = {a: b, b: a}
    while pairs:
        ready, _, _ = select.select(list(pairs), [], [], IDLE_SECONDS)
        if not ready:
            return
        for src in ready:
            try:
                data = src.recv(65536)
            except OSError:
                return
            if not data:
                return
            try:
                pairs[src].sendall(data)
            except OSError:
                return


class Handler(socketserver.BaseRequestHandler):
    def reply(self, status):
        try:
            self.request.sendall(f"HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".encode())
        except OSError:
            pass

    def handle(self):
        self.request.settimeout(30)
        head = b""
        while b"\r\n\r\n" not in head and len(head) < 8192:
            try:
                chunk = self.request.recv(4096)
            except OSError:
                return
            if not chunk:
                return
            head += chunk
        if b"\r\n\r\n" not in head:
            return self.reply("400 Bad Request")
        first = head.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        if not first.startswith("CONNECT "):
            return self.reply("405 Method Not Allowed")
        target = parse_connect_target(first)
        if target is None:
            return self.reply("400 Bad Request")
        if target not in self.server.allowed:
            self.server.log(f"refused {target}")
            return self.reply("403 Forbidden")
        host, _, port = target.rpartition(":")
        try:
            upstream = socket.create_connection((host, int(port)), timeout=30)
        except OSError as e:
            self.server.log(f"upstream {target} failed: {e.__class__.__name__}")
            return self.reply("502 Bad Gateway")
        with upstream:
            upstream.settimeout(None)
            self.request.settimeout(None)
            try:
                self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            except OSError:
                return
            self.server.log(f"tunnel {target} open")
            relay(self.request, upstream)
            self.server.log(f"tunnel {target} closed")


class Proxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, allowed, quiet=False):
        super().__init__(("127.0.0.1", 0), Handler)
        self.allowed = {a.lower() for a in allowed}
        self.quiet = quiet
        self.lock = threading.Lock()

    def log(self, line):
        if self.quiet:
            return
        with self.lock:
            print(f"aievals_proxy: {line}", flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--allow", action="append", default=[], metavar="HOST:PORT", help="a host:port that may be tunnelled (repeatable)")
    ap.add_argument("--port-file", required=True, help="where to write the bound port once listening")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    for a in args.allow:
        if parse_connect_target(f"CONNECT {a} HTTP/1.1") is None:
            ap.error(f"--allow wants host:port, got {a!r}")
    server = Proxy(args.allow, quiet=args.quiet)
    port = server.server_address[1]
    with open(args.port_file, "w") as f:
        f.write(f"{port}\n")
    server.log(f"listening on 127.0.0.1:{port}, allowing {sorted(server.allowed) or 'nothing'}")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

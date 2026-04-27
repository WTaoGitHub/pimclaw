"""
TCP port bridge — proxies local ports to targets the Docker Desktop VM can't reach.
Add entries to BRIDGES below. Run: python3 docker-port-bridge.py
"""

import socket
import threading
import sys
import signal

BRIDGES: list[dict] = [
    {"listen": 29001, "target_host": "10.1.112.237", "target_port": 29000},
    # Sim MCP (Hisim)
    {"listen": 8721, "target_host": "10.1.112.239", "target_port": 8721},
    # Perf MCP PostgreSQL
    {"listen": 34567, "target_host": "10.1.112.239", "target_port": 34567},
]

LISTEN_HOST = "0.0.0.0"


def pipe(src: socket.socket, dst: socket.socket):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except Exception:
            pass


def handle_client(client_sock: socket.socket, target_host: str, target_port: int):
    target_sock = None
    try:
        target_sock = socket.create_connection((target_host, target_port), timeout=10)
        threading.Thread(target=pipe, args=(client_sock, target_sock), daemon=True).start()
        pipe(target_sock, client_sock)
    finally:
        try:
            client_sock.close()
        except Exception:
            pass
        if target_sock is not None:
            try:
                target_sock.close()
            except Exception:
                pass


def serve(listen_port: int, target_host: str, target_port: int):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LISTEN_HOST, listen_port))
    server.listen()
    print(f"[bridge] 0.0.0.0:{listen_port} → {target_host}:{target_port}")
    while True:
        client_sock, _addr = server.accept()
        threading.Thread(
            target=handle_client, args=(client_sock, target_host, target_port), daemon=True
        ).start()


def main():
    signal.signal(signal.SIGINT, lambda _s, _f: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda _s, _f: sys.exit(0))

    threads = []
    for b in BRIDGES:
        t = threading.Thread(
            target=serve, args=(b["listen"], b["target_host"], b["target_port"]), daemon=True
        )
        t.start()
        threads.append(t)

    print(f"[bridge] {len(BRIDGES)} bridges running, Ctrl+C to stop")
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()

import socket
import threading

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 29001
TARGET_HOST = "10.1.112.237"
TARGET_PORT = 29000


def pipe(src, dst):
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


def handle_client(client_sock):
    target_sock = None
    try:
        target_sock = socket.create_connection((TARGET_HOST, TARGET_PORT), timeout=10)
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


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LISTEN_HOST, LISTEN_PORT))
    server.listen()
    while True:
        client_sock, _addr = server.accept()
        threading.Thread(target=handle_client, args=(client_sock,), daemon=True).start()


if __name__ == "__main__":
    main()

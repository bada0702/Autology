import sys
import os
import socket
import subprocess
import threading
import time
import webbrowser

# PyInstaller 번들 경로 처리
if getattr(sys, 'frozen', False):
    bundle_dir = sys._MEIPASS
    sys.path.insert(0, bundle_dir)
    os.chdir(bundle_dir)


def _port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _start_ollama():
    if _port_open("127.0.0.1", 11434):
        print("[Ollama] Already running.")
        return
    print("[Ollama] Starting ollama serve...")
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    subprocess.Popen(["ollama", "serve"], **kwargs)
    for _ in range(20):
        time.sleep(1)
        if _port_open("127.0.0.1", 11434):
            print("[Ollama] Ready.")
            return
    print("[Ollama] Warning: ollama did not respond within 20 seconds.")


def _open_browser():
    # uvicorn이 뜰 때까지 대기 후 브라우저 오픈
    for _ in range(30):
        time.sleep(1)
        if _port_open("127.0.0.1", 8000):
            webbrowser.open("http://localhost:8000")
            return


from main import app
import uvicorn

if __name__ == "__main__":
    _start_ollama()
    threading.Thread(target=_open_browser, daemon=True).start()
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8000,
        log_level="info",
    )

import os
import sys
import threading
import time
import webbrowser

# PyInstaller 번들 경로 처리
if getattr(sys, 'frozen', False):
    bundle_dir = sys._MEIPASS
    sys.path.insert(0, bundle_dir)
    os.chdir(bundle_dir)

import uvicorn

# main을 명시적으로 import → PyInstaller가 main/ollama_manager/crew/* 의존성을
# 모두 번들에 포함하도록 보장 (문자열 "main:app"만 쓰면 누락될 수 있음).
import main

HOST = "127.0.0.1"
PORT = 8000
URL = f"http://{HOST}:{PORT}"


def _open_browser_when_ready():
    """서버가 응답을 시작하면 기본 브라우저로 앱을 연다."""
    import httpx
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            with httpx.Client(timeout=1.5) as client:
                if client.get(f"{URL}/health").status_code == 200:
                    break
        except Exception:
            pass
        time.sleep(0.5)
    try:
        webbrowser.open(URL)
    except Exception:
        pass


if __name__ == "__main__":
    # 서버 준비되면 브라우저 자동 오픈 (백그라운드 스레드)
    threading.Thread(target=_open_browser_when_ready, daemon=True).start()

    print(f"[Autology] 서버 시작 중... 준비되면 브라우저가 자동으로 열립니다: {URL}")
    # app 객체를 직접 전달 (reload 미사용 → 문자열 경로 불필요, 번들 호환성↑)
    uvicorn.run(
        main.app,
        host=HOST,
        port=PORT,
        log_level="warning",
    )

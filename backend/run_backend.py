import sys
import os
import subprocess
import shutil
import socket
import time
import threading
import webbrowser

# 출력 버퍼링 해제 (로그 실시간 확인용)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(line_buffering=True)

# PyInstaller 번들 경로 처리
if getattr(sys, 'frozen', False):
    bundle_dir = sys._MEIPASS
    sys.path.insert(0, bundle_dir)
    os.chdir(bundle_dir)

import uvicorn

def is_ollama_running():
    try:
        # socket을 이용한 로컬 포트 11434 직접 연결 시도 (프록시의 영향을 받지 않음)
        with socket.create_connection(("127.0.0.1", 11434), timeout=1.0):
            return True
    except Exception:
        return False

def check_and_start_ollama():
    print("[Ollama] Checking Ollama service status...")
    if is_ollama_running():
        print("[Ollama] Ollama is already running.")
        return True

    print("[Ollama] Ollama is not running. Attempting to locate ollama.exe...")
    ollama_path = None
    
    # 1. Local AppData 경로 체크
    local_appdata = os.environ.get("LOCALAPPDATA", "")
    if local_appdata:
        test_path = os.path.join(local_appdata, "Programs", "Ollama", "ollama.exe")
        if os.path.exists(test_path):
            ollama_path = test_path
            
    # 2. PATH에서 검색
    if not ollama_path:
        ollama_path = shutil.which("ollama")

    # 3. Program Files 경로 체크
    if not ollama_path:
        program_files = os.environ.get("ProgramFiles", "C:\\Program Files")
        test_path = os.path.join(program_files, "Ollama", "ollama.exe")
        if os.path.exists(test_path):
            ollama_path = test_path

    if ollama_path:
        print(f"[Ollama] Found ollama.exe at: {ollama_path}")
        print("[Ollama] Launching Ollama in background...")
        try:
            # 창 없이 백그라운드로 실행
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0  # SW_HIDE
            
            subprocess.Popen(
                [ollama_path, "serve"],
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
                startupinfo=startupinfo,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            
            # Ollama가 뜰 때까지 헬스체크 폴링
            print("[Ollama] Waiting for Ollama service to start...")
            for _ in range(10):
                time.sleep(1)
                if is_ollama_running():
                    print("[Ollama] Ollama service started successfully.")
                    return True
            print("[Warning] Ollama command executed but service not responding yet. It might still be starting.")
            return False
        except Exception as e:
            print(f"[Error] Failed to start Ollama: {e}")
            return False
    else:
        print("[Ollama] ollama.exe not found on this system. Please make sure Ollama is installed.")
        return False

def open_browser():
    time.sleep(1.5)  # uvicorn이 완전히 기동되기까지 대기
    print("[Autology] Opening browser at http://127.0.0.1:8000 ...")
    webbrowser.open("http://127.0.0.1:8000")

if __name__ == "__main__":
    # 1. Ollama 구동 체크
    check_and_start_ollama()
    
    # 2. 브라우저 자동 오픈 스레드 구동
    threading.Thread(target=open_browser, daemon=True).start()
    
    # 3. Uvicorn 구동
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        log_level="warning",
    )

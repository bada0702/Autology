"""Ollama lifecycle manager.

데스크톱 exe 실행 시 백엔드와 함께 Ollama 서버가 자동으로 떠 있도록 보장한다.
- 이미 떠 있으면 그대로 사용한다.
- 떠 있지 않고 `ollama` 실행 파일이 PATH에 있으면 `ollama serve`를 백그라운드로 띄운다.
- Ollama 자체가 설치돼 있지 않으면 (다운로드/설치는 하지 않고) 안내 메시지만 남긴다.
"""

import logging
import os
import shutil
import subprocess
import sys
import time
from typing import Optional

import httpx

logger = logging.getLogger("autology.ollama")

OLLAMA_BASE = os.getenv("OLLAMA_BASE", "http://localhost:11434")

# 우리가 직접 띄운 Ollama 프로세스 핸들 (종료 시 정리용)
_spawned: Optional[subprocess.Popen] = None


def is_ollama_up(timeout: float = 2.0) -> bool:
    """Ollama 서버가 응답하는지 확인."""
    try:
        with httpx.Client(timeout=timeout) as client:
            r = client.get(f"{OLLAMA_BASE}/api/tags")
            return r.status_code == 200
    except Exception:
        return False


def _ollama_binary() -> Optional[str]:
    """`ollama` 실행 파일 경로를 찾는다 (PATH + 일반 설치 위치)."""
    found = shutil.which("ollama")
    if found:
        return found

    # PATH에 없을 때 OS별 기본 설치 경로 확인
    candidates = []
    if sys.platform == "win32":
        local = os.getenv("LOCALAPPDATA", "")
        program = os.getenv("ProgramFiles", r"C:\Program Files")
        candidates += [
            os.path.join(local, "Programs", "Ollama", "ollama.exe"),
            os.path.join(program, "Ollama", "ollama.exe"),
        ]
    elif sys.platform == "darwin":
        candidates += [
            "/usr/local/bin/ollama",
            "/opt/homebrew/bin/ollama",
            "/Applications/Ollama.app/Contents/Resources/ollama",
        ]
    else:  # linux
        candidates += ["/usr/local/bin/ollama", "/usr/bin/ollama"]

    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def ollama_installed() -> bool:
    """Ollama 실행 파일이 시스템에 설치돼 있는지 여부."""
    return _ollama_binary() is not None


def _spawn_ollama(binary: str) -> Optional[subprocess.Popen]:
    """`ollama serve`를 콘솔 창 없이 백그라운드로 실행."""
    kwargs = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        # 새 콘솔 창이 뜨지 않도록
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        # 부모(백엔드)와 프로세스 그룹을 분리해 좀비/시그널 전파 방지
        kwargs["start_new_session"] = True

    try:
        return subprocess.Popen([binary, "serve"], **kwargs)
    except Exception as exc:
        logger.warning("Ollama 실행 실패: %s", exc)
        return None


def ensure_ollama_running(wait_seconds: int = 25) -> bool:
    """Ollama가 떠 있도록 보장. 성공하면 True.

    이미 떠 있으면 즉시 반환. 아니면 설치된 바이너리를 찾아 `ollama serve`를
    백그라운드로 띄우고 준비될 때까지 (최대 wait_seconds) 폴링한다.
    """
    global _spawned

    if is_ollama_up():
        logger.info("Ollama 이미 실행 중 (%s)", OLLAMA_BASE)
        return True

    binary = _ollama_binary()
    if not binary:
        logger.warning(
            "Ollama가 설치돼 있지 않습니다. https://ollama.com/download 에서 설치 후 "
            "다시 실행하세요. (모델 예: `ollama pull gemma2`)"
        )
        return False

    logger.info("Ollama 서버 기동 중... (%s serve)", binary)
    _spawned = _spawn_ollama(binary)
    if _spawned is None:
        return False

    # 준비될 때까지 폴링
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if is_ollama_up():
            logger.info("Ollama 서버 준비 완료 (%s)", OLLAMA_BASE)
            return True
        time.sleep(1.0)

    logger.warning("Ollama 서버가 %d초 내에 응답하지 않았습니다.", wait_seconds)
    return False


def shutdown_ollama() -> None:
    """우리가 직접 띄운 Ollama 프로세스만 종료 (기존에 떠 있던 건 건드리지 않음)."""
    global _spawned
    if _spawned is not None and _spawned.poll() is None:
        try:
            _spawned.terminate()
        except Exception:
            pass
    _spawned = None

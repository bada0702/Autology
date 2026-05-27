"""Search tools with graceful fallback when API keys are missing."""

import os
import httpx
from typing import Optional

def search_web(query: str, num_results: int = 5) -> str:
    """Try Tavily → Serper → Wikipedia in order."""
    tavily_key = os.getenv("TAVILY_API_KEY")
    serper_key = os.getenv("SERPER_API_KEY")

    if tavily_key:
        result = _tavily(query, tavily_key, num_results)
        if result:
            return result

    if serper_key:
        result = _serper(query, serper_key, num_results)
        if result:
            return result

    return _wikipedia(query)


def _tavily(query: str, api_key: str, k: int) -> Optional[str]:
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.post(
                "https://api.tavily.com/search",
                json={"api_key": api_key, "query": query, "max_results": k},
            )
            resp.raise_for_status()
            items = resp.json().get("results", [])
            return "\n\n".join(f"[{r['title']}]\n{r['content']}" for r in items[:k])
    except Exception:
        return None


def _serper(query: str, api_key: str, k: int) -> Optional[str]:
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.post(
                "https://google.serper.dev/search",
                headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
                json={"q": query, "num": k},
            )
            resp.raise_for_status()
            items = resp.json().get("organic", [])
            return "\n\n".join(f"[{r['title']}]\n{r.get('snippet','')}" for r in items[:k])
    except Exception:
        return None


def _wikipedia(query: str) -> str:
    """Wikipedia search → summary, 20s timeout per request, ko → en fallback."""
    headers = {"User-Agent": "Autology/1.0 (ontology builder; https://github.com/bada0702/Autology)"}
    for lang in ("ko", "en"):
        try:
            with httpx.Client(timeout=20, headers=headers, follow_redirects=True) as client:
                # 1) 검색 API로 정확한 제목 찾기
                search_resp = client.get(
                    f"https://{lang}.wikipedia.org/w/api.php",
                    params={
                        "action": "query", "list": "search",
                        "srsearch": query, "srlimit": 1, "format": "json",
                    },
                )
                if search_resp.status_code != 200:
                    continue
                results = search_resp.json().get("query", {}).get("search", [])
                if not results:
                    continue
                title = results[0]["title"]

                # 2) 제목으로 요약 가져오기
                summary_resp = client.get(
                    f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}",
                )
                if summary_resp.status_code == 200:
                    extract = summary_resp.json().get("extract", "")
                    if extract:
                        return f"[{title}]\n{extract[:3000]}"
        except Exception:
            pass
    return f"No web search results available for: {query}"

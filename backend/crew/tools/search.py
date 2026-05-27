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
    try:
        import wikipediaapi
        wiki = wikipediaapi.Wikipedia("Autology/1.0 (ontology builder)", "en")
        page = wiki.page(query)
        if page.exists():
            return page.summary[:3000]
        # Try Korean
        wiki_ko = wikipediaapi.Wikipedia("Autology/1.0 (ontology builder)", "ko")
        page_ko = wiki_ko.page(query)
        if page_ko.exists():
            return page_ko.summary[:3000]
    except Exception:
        pass
    return f"No web search results available for: {query}"

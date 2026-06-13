"""Long-term memory store for agent correction patterns.

Persists to backend/data/agent_memory.json so patterns survive restarts.
"""

import json
import os
import time
import uuid
from typing import List, Optional

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "agent_memory.json")


class MemoryStore:
    def __init__(self):
        self._data: dict = {"patterns": []}
        self._load()

    def _load(self):
        try:
            if os.path.exists(DATA_PATH):
                with open(DATA_PATH, "r", encoding="utf-8") as f:
                    self._data = json.load(f)
        except Exception:
            self._data = {"patterns": []}

    def _save(self):
        os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
        with open(DATA_PATH, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2)

    def get_patterns(self, domain: Optional[str] = None) -> List[dict]:
        patterns = self._data.get("patterns", [])
        if domain:
            d = domain.lower()
            patterns = [p for p in patterns if d in p.get("domain", "").lower() or not p.get("domain")]
        return sorted(patterns, key=lambda p: p.get("count", 0), reverse=True)

    def add_pattern(self, domain: str, original: str, corrected: str, note: str = "") -> dict:
        # Deduplicate: if same (domain, original, corrected) exists, increment count
        for p in self._data["patterns"]:
            if (p.get("domain", "").lower() == domain.lower()
                    and p.get("original") == original
                    and p.get("corrected") == corrected):
                p["count"] = p.get("count", 1) + 1
                p["last_used"] = time.strftime("%Y-%m-%d")
                self._save()
                return p

        pattern = {
            "id": str(uuid.uuid4())[:8],
            "domain": domain,
            "original": original,
            "corrected": corrected,
            "note": note,
            "count": 1,
            "created_at": time.strftime("%Y-%m-%d"),
            "last_used": time.strftime("%Y-%m-%d"),
        }
        self._data["patterns"].append(pattern)
        self._save()
        return pattern

    def delete_pattern(self, pattern_id: str) -> bool:
        before = len(self._data["patterns"])
        self._data["patterns"] = [p for p in self._data["patterns"] if p["id"] != pattern_id]
        changed = len(self._data["patterns"]) < before
        if changed:
            self._save()
        return changed

    def increment_pattern(self, pattern_id: str) -> Optional[dict]:
        for p in self._data["patterns"]:
            if p["id"] == pattern_id:
                p["count"] = p.get("count", 1) + 1
                p["last_used"] = time.strftime("%Y-%m-%d")
                self._save()
                return p
        return None

    def build_prompt_context(self, domain: str) -> str:
        """Build memory injection text for the Relation Agent prompt."""
        patterns = self.get_patterns(domain)
        if not patterns:
            return ""
        lines = ["[장기 기억: 이전에 수정된 관계 패턴]"]
        for p in patterns[:8]:
            note = f" ({p['note']})" if p.get("note") else ""
            lines.append(f"  • '{p['original']}' → '{p['corrected']}' (도메인: {p['domain']}, 사용 {p['count']}회){note}")
        lines.append("위 패턴에 해당하는 관계가 있으면 수정된 관계를 우선 사용하세요.")
        return "\n".join(lines)


# Global singleton
memory_store = MemoryStore()

from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from enum import Enum
import time

class AgentStatus(str, Enum):
    pending  = "pending"
    running  = "running"
    done     = "done"
    error    = "error"

class AgentProgress(BaseModel):
    name: str
    emoji: str
    status: AgentStatus = AgentStatus.pending
    message: str = ""
    output_preview: str = ""

class JobStatus(str, Enum):
    pending   = "pending"
    running   = "running"
    completed = "completed"
    failed    = "failed"

class Job(BaseModel):
    id: str
    topic: str
    options: Dict[str, Any] = Field(default_factory=dict)
    status: JobStatus = JobStatus.pending
    created_at: float = Field(default_factory=time.time)
    agents: List[AgentProgress] = Field(default_factory=lambda: [
        AgentProgress(name="Research Agent",    emoji="🔍"),
        AgentProgress(name="Extraction Agent",  emoji="🧠"),
        AgentProgress(name="Relation Agent",    emoji="🔗"),
        AgentProgress(name="Validation Agent",  emoji="✅"),
        AgentProgress(name="Editor Agent",      emoji="✏️"),
    ])
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

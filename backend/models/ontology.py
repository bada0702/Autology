from pydantic import BaseModel, Field
from typing import List, Optional

class NodeProperty(BaseModel):
    key: str
    value: str

class OntologyNode(BaseModel):
    id: str
    label: str
    type: str = "Class"   # Class | Instance | Literal
    x: float = 200
    y: float = 200
    properties: List[NodeProperty] = Field(default_factory=list)
    description: str = ""

class OntologyEdge(BaseModel):
    id: str
    source: str
    target: str
    label: str = ""
    style: str = "solid"
    inferred: bool = False

class OntologyGraph(BaseModel):
    nodes: List[OntologyNode] = Field(default_factory=list)
    edges: List[OntologyEdge] = Field(default_factory=list)

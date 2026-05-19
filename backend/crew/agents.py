"""CrewAI Agent definitions for ontology extraction pipeline."""

from crewai import Agent
from langchain_ollama import ChatOllama
import os

OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:31b-cloud")
OLLAMA_BASE  = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

def _llm():
    return ChatOllama(model=OLLAMA_MODEL, base_url=OLLAMA_BASE, temperature=0.2)

def make_research_agent() -> Agent:
    return Agent(
        role="Research Agent",
        goal="Collect comprehensive information about a given topic from the web.",
        backstory=(
            "You are an expert researcher skilled at finding structured knowledge "
            "about any topic. You gather facts, definitions, and relationships "
            "from multiple sources."
        ),
        llm=_llm(),
        verbose=True,
        allow_delegation=False,
    )

def make_extraction_agent() -> Agent:
    return Agent(
        role="Extraction Agent",
        goal="Extract entities (Class, Instance, Literal) from raw research text.",
        backstory=(
            "You are an ontology engineer who specializes in named entity recognition "
            "and semantic classification. You categorize concepts into Class, Instance, "
            "and Literal types according to ontology standards."
        ),
        llm=_llm(),
        verbose=True,
        allow_delegation=False,
    )

def make_relation_agent() -> Agent:
    return Agent(
        role="Relation Agent",
        goal="Identify semantic relationships between extracted entities.",
        backstory=(
            "You are an expert in knowledge representation and ontology design. "
            "You analyze entity pairs and determine meaningful relationships like "
            "is-a, part-of, has-value, related-to."
        ),
        llm=_llm(),
        verbose=True,
        allow_delegation=False,
    )

def make_validation_agent() -> Agent:
    return Agent(
        role="Validation Agent",
        goal="Validate the ontology graph for consistency and completeness.",
        backstory=(
            "You are a quality assurance specialist for ontologies. You check for "
            "circular dependencies, missing relationships, contradictions, and ensure "
            "the graph is well-formed."
        ),
        llm=_llm(),
        verbose=True,
        allow_delegation=False,
    )

def make_editor_agent() -> Agent:
    return Agent(
        role="Editor Agent",
        goal="Produce the final clean ontology JSON in Autology format.",
        backstory=(
            "You are a senior ontology editor who produces clean, well-structured "
            "JSON output. You apply validation feedback, normalize labels, and "
            "generate the final graph ready for the Autology canvas."
        ),
        llm=_llm(),
        verbose=True,
        allow_delegation=False,
    )

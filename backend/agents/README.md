# AnimalAgent agent design

This project now exposes the agent workflow as explicit backend code instead of keeping it implicit inside one chat function.

## Multi-agent collaboration

- Router/Planner: decides whether the latest request needs retrieval.
- Tool-Using Researcher: calls the registered web search tool and normalizes citable sources.
- Layered Memory Manager: builds separated context layers before the writer model runs.
- Writer: generates the final answer from managed context.
- Critic: checks citation/source consistency after generation.

The runtime entry points are `planAndResearch` and `finalizeAgentRun` in `animalAgentOrchestrator.js`.

## Layered context

`backend/context/layeredContext.js` builds five layers:

- `persona`: stable animal-science system prompt.
- `long_term_summary`: compact summary of older turns.
- `evidence`: search result or search-skip/failure state.
- `runtime`: planner intent, confidence, and agent trace.
- `short_term_history`: recent conversation turns within a character budget.

This keeps token growth predictable and makes each context source auditable.

## Agent patterns represented

- Router pattern: request intent routes the flow to search or direct answer.
- Tool-use pattern: researcher agent uses `toolRegistry` instead of hard-coded search logic.
- Memory pattern: context is separated into long-term, short-term, evidence, and runtime layers.
- Reflection/Critic pattern: generated answers are reviewed for citation consistency.
- Orchestrator pattern: `chatService` coordinates agents while preserving existing API behavior.

`GET /api/agents` returns the current pattern catalog for demos or interview walkthroughs.

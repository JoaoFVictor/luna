# Example Agent Context

This file demonstrates `context.files` for agent-owned reference material.

Workflow authors must run `collect_context`, include this agent in the
`input.agents` list, and pass `context: $.steps.context` to the agent node for
this content to be promoted into runtime instructions.

Keep reusable guidance here. Keep workflow-specific data in workflow input.

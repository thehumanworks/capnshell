---
name: "call-advisor"
description: "**Do not use this skill in a cloud run without codex installed!** When running in an environment with codex installed, use this skill when you are faced with a task that is complex or where you are aware that your confidence on the subject is low or benefits from an expert opinion. Do not use for simple tasks or tasks you have high-confidence in the subject/domain/correctness."
---

# Advisor

TRIGGERS:
[ ] - You have identified low-confidence or a task that is complex (multi-step, complex codebase, complex domain...)
[ ] - The user has asked you to call the '/advisor'

INPUTS:

- `prompt`: your question to the advisor
- `context`: detailed, as-much-as-needed context about the problem you are faced with (user query, specific files in the project, web research...)

ACTION:

- call './scripts/astra.py --prompt <prompt> [--context <context>]' to use astra as the advisor. `astra.py` is a self-contained 'uv' script that can be executed directly from the shell. For long text in puts, prefer to use heredocs and creating the PROMPT and CONTEXT variables ahead of time.
- after the advice is given, proceed with the task.

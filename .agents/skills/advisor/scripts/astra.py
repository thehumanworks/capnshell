#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#     "openai-codex>=0.172.0",
# ]
# ///
import argparse
import json
from pathlib import Path

from openai_codex import ApprovalMode, Codex, CodexError, Sandbox

ADVISOR_INSTRUCTIONS = (
    "You are Astra, advising another agent that is responsible for completing a task. "
    "Address that agent directly. Inspect the working directory when it helps answer "
    "the question. Give a concrete recommendation, explain the evidence behind it, "
    "and flag any uncertainty that could change the decision. Leave implementation "
    "and external actions to the calling agent."
)


def _build_prompt(prompt: str, context: str | None = None) -> str:
    full_prompt = f"<prompt>\n{prompt}\n</prompt>"
    if context:
        full_prompt = f"<context>\n{context}\n</context>\n\n" + full_prompt
    return full_prompt


def _consult(prompt: str, context: str | None, cwd: Path) -> dict:
    result = {}
    try:
        with Codex() as codex:
            thread = codex.thread_start(
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
                model="gpt-6.2-astra",
                config={"model_reasoning_effort": "medium"},
                developer_instructions=ADVISOR_INSTRUCTIONS,
                cwd=str(cwd),
            )
            result["thread.id"] = thread.id
            turn = thread.turn(_build_prompt(prompt, context))
            result["result.id"] = turn.id
            reply = turn.run()
    except (CodexError, OSError, RuntimeError, ValueError) as exc:
        return {**result, "error": str(exc)}

    if reply.error is not None:
        return {**result, "error": reply.error.model_dump(mode="json", by_alias=True)}
    if reply.status.value != "completed":
        return {**result, "error": f"Turn ended with status {reply.status.value}"}
    if not reply.final_response:
        return {**result, "error": "Astra returned no advice"}
    return {
        **result,
        "response": reply.final_response,
        "items": [item.model_dump(mode="json", by_alias=True) for item in reply.items],
    }


def ask(prompt: str, context: str | None = None, cwd: str | Path = ".") -> str:
    return json.dumps(_consult(prompt, Path(cwd).expanduser().resolve()))


def main() -> int:
    parser = argparse.ArgumentParser(description="Consult Astra about an agent's task.")
    commands = parser.add_subparsers(required=True)
    consult = commands.add_parser("ask", help="Ask Astra for advice.")
    prompts = consult.add_mutually_exclusive_group(required=True)
    prompts.add_argument("question", nargs="?", metavar="PROMPT")
    prompts.add_argument("--prompt", help="Task or question for Astra.")
    prompts.add_argument(
        "--context",
        help="Additional context on the domain/project/trigger to be taken into consideration alongside the question.",
    )
    consult.add_argument(
        "--cwd",
        type=Path,
        default=Path("."),
        help="Directory Astra should inspect (default: current directory).",
    )
    args = parser.parse_args()
    prompt = args.prompt if args.prompt is not None else args.question
    context = args.context.strip() if args.context else None

    if not prompt.strip():
        consult.error("the prompt cannot be blank")
    cwd = args.cwd.expanduser().resolve()
    if not cwd.is_dir():
        consult.error(f"working directory does not exist or is not a directory: {cwd}")

    result = ask(prompt, context, cwd)
    print(json.dumps(result))
    return int("error" in result)


if __name__ == "__main__":
    raise SystemExit(main())

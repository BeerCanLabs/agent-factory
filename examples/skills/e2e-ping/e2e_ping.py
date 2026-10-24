"""A fixture skill: one tool, `e2e_ping_code`, that returns a fixed code (see skill.yaml)."""

CODE = "PING-OK-7c1f4e92"


def _code(arguments: dict, context: dict) -> str:
    return CODE


def tools() -> list[dict]:
    return [
        {
            "name": "e2e_ping_code",
            "description": "Returns the e2e check code. Call it when asked for the check code; it takes no arguments.",
            "parameters": {"type": "object", "properties": {}},
            "handler": _code,
        }
    ]

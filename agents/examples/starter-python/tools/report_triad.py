#!/usr/bin/env python3
"""
Triad & Governance Report Generator — BeerCanLabs Standard.

Generates the canonical Skill ↔ System ↔ Secret ↔ HITL/Hold report table
for an agent cartridge using only the Python standard library.
"""

import sys
from pathlib import Path
from typing import Any, Dict, List


def parse_yaml_value(val: str) -> Any:
    """Parse scalar YAML value."""
    val = val.strip()
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        return val[1:-1]
    if val.lower() == "true":
        return True
    if val.lower() == "false":
        return False
    if val.isdigit():
        return int(val)
    return val


def parse_cartridge_yaml(text: str) -> dict:
    """Standard-library parser for cartridge.yaml manifests."""
    result = {}
    current_key = None
    current_list = None
    current_item = None

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(line) - len(line.lstrip())

        # Top-level key
        if indent == 0 and ":" in stripped:
            k, v = stripped.split(":", 1)
            k = k.strip()
            v = v.strip()
            current_key = k
            current_list = None
            current_item = None
            if v:
                result[k] = parse_yaml_value(v)
            else:
                result[k] = {}
            continue

        # List item under current section
        if stripped.startswith("- "):
            item_content = stripped[2:].strip()
            if not isinstance(result.get(current_key), list):
                result[current_key] = []
            current_list = result[current_key]

            if ":" in item_content:
                ik, iv = item_content.split(":", 1)
                current_item = {ik.strip(): parse_yaml_value(iv)}
                current_list.append(current_item)
            else:
                current_item = parse_yaml_value(item_content)
                current_list.append(current_item)
            continue

        # Continuation / property of current_item in a list
        if current_item is not None and isinstance(current_item, dict) and ":" in stripped:
            pk, pv = stripped.split(":", 1)
            current_item[pk.strip()] = parse_yaml_value(pv)
            continue

        # Nested dict under top-level key
        if current_key and isinstance(result.get(current_key), dict) and ":" in stripped:
            nk, nv = stripped.split(":", 1)
            result[current_key][nk.strip()] = parse_yaml_value(nv)
            continue

    return result


def format_hold(hold_val: Any) -> str:
    """Format hold/HITL value for human-readable display."""
    if not hold_val or hold_val == "none":
        return "Autonomous"
    if hold_val == "required":
        return "**Required**"
    return f"**Required** ({hold_val})"


def format_injection(injection: Any, route: Any = None) -> str:
    """Format injection/auth mechanism."""
    if injection == "gatekeeper-egress" or not injection:
        return f"Gatekeeper-Egress Route (`{route}`)" if route else "Gatekeeper-Egress Route"
    if injection == "gatekeeper-ingress":
        return "Gatekeeper-Ingress Trigger"
    if injection == "keymaster":
        return f"Keymaster Connection (`{route}`)" if route else "Keymaster Connection"
    if injection == "container":
        return "Container Environment"
    if injection == "none":
        return "None (Public / No Auth)"
    return str(injection)


def generate_triad_report(cartridge_dir: Path | str = ".") -> str:
    """Read cartridge.yaml and generate markdown triad report."""
    cartridge_path = Path(cartridge_dir) / "cartridge.yaml"
    if not cartridge_path.exists():
        raise FileNotFoundError(f"Cartridge manifest not found at {cartridge_path}")

    with open(cartridge_path, "r", encoding="utf-8") as f:
        data = parse_cartridge_yaml(f.read())

    agent_id = data.get("id", "unknown")
    agent_name = data.get("name", agent_id.capitalize())
    agent_role = data.get("role", "Unspecified Role")

    skills_raw = data.get("skills", [])
    rows: List[Dict[str, str]] = []

    for skill in skills_raw:
        if isinstance(skill, str):
            skill_id = skill
            skill_name = skill
            desc = ""
            system = "Unspecified"
            secret = "Unspecified"
            hold = "Autonomous"
            injection = "Gatekeeper-Egress Route"
        elif isinstance(skill, dict):
            skill_id = skill.get("id", "")
            skill_name = skill.get("name") or skill_id
            desc = skill.get("description", "")
            system = skill.get("system") or "Unspecified (compact format)"
            secret = skill.get("secretRef") or "None"
            hold = format_hold(skill.get("hold", "none"))
            injection = format_injection(skill.get("injection"), skill.get("route"))
        else:
            continue

        rows.append({
            "skill": f"`{skill_id}`",
            "system": system,
            "secret": f"`{secret}`" if secret != "None" and not secret.startswith("Unspecified") else secret,
            "hold": hold,
            "injection": injection,
            "purpose": desc or skill_name,
        })

    lines = [
        f"# Triad & Governance Report: {agent_name} (`{agent_id}`)",
        f"> **Role:** {agent_role}  ",
        f"> **Source:** `cartridge.yaml`",
        "",
        "| Skill | System | Secret (Requirement) | HITL / Hold | Auth Mechanism / Injection | Purpose |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
    ]

    for r in rows:
        lines.append(f"| {r['skill']} | {r['system']} | {r['secret']} | {r['hold']} | {r['injection']} | {r['purpose']} |")

    return "\n".join(lines)


def main():
    target_dir = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else "."
    try:
        report = generate_triad_report(target_dir)
        print(report)
    except Exception as e:
        print(f"Error generating report: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

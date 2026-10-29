"""Extract literal classic notebook module mappings without executing JavaScript."""

from __future__ import annotations

import esprima


def _key(node: dict) -> str | None:
    if node.get("type") == "Identifier":
        return node.get("name")
    if node.get("type") == "Literal" and isinstance(node.get("value"), str):
        return node["value"]
    return None


def _properties(node: dict) -> dict[str, dict]:
    if node.get("type") != "ObjectExpression":
        return {}
    result = {}
    for prop in node.get("properties", []):
        key = _key(prop.get("key", {}))
        if key is None or prop.get("computed") or key in result:
            return {}
        result[key] = prop.get("value", {})
    return result


def _callee(node: dict) -> list[str]:
    if node.get("type") == "Identifier":
        return [node["name"]]
    if node.get("type") != "MemberExpression":
        return []
    if node.get("computed") and node.get("property", {}).get("type") != "Literal":
        return []
    key = _key(node.get("property", {}))
    return [*_callee(node.get("object", {})), key] if key else []


def classic_mappings(source: str) -> dict[str, str]:
    """Extract literal requirejs map candidates without executing the extension."""
    try:
        root = esprima.parseScript(source).toDict()
    except (esprima.Error, RecursionError, TypeError, ValueError):
        return {}
    result: dict[str, str] = {}
    stack = [root]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(node)
        elif isinstance(node, dict):
            if node.get("type") == "CallExpression" and _callee(node.get("callee", {})) in (
                ["requirejs", "config"],
                ["window", "requirejs", "config"],
                ["require", "config"],
                ["window", "require", "config"],
            ):
                args = node.get("arguments", [])
                config = _properties(args[0]) if len(args) == 1 else {}
                maps = _properties(config.get("map", {}))
                entries = _properties(maps.get("*", {}))
                for key, value in entries.items():
                    path = _key(value) if value.get("type") == "Literal" else None
                    if path is None or key in result:
                        return {}
                    result[key] = path
            stack.extend(node.values())
    if len({value.removesuffix(".js") for value in result.values()}) != len(result):
        return {}
    return result

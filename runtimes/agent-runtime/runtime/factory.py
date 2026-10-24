"""The runtime's only way out: the factory's own API and the gatekeeper-egress. Standard library only (no provider SDK, S1)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


class FactoryError(Exception):
    def __init__(self, status: int, body: Any):
        super().__init__(f"factory answered {status}: {body}")
        self.status = status
        self.body = body


class Factory:
    def __init__(self, env: dict[str, str] | None = None):
        env = dict(os.environ if env is None else env)
        self.url = (env.get("FACTORY_URL") or "").rstrip("/")
        self.run_id = env.get("FACTORY_RUN_ID") or ""
        self.token = env.get("FACTORY_RUN_TOKEN") or ""
        self.model_base = (env.get("FACTORY_MODEL_BASE_URL") or "").rstrip("/")
        self.discord_base = (env.get("DISCORD_BASE_URL") or "").rstrip("/")
        self.model = env.get("FACTORY_MODEL") or ""

    def _call(self, method: str, url: str, body: Any = None, timeout: float = 300) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "replace")
            try:
                parsed: Any = json.loads(raw)
            except ValueError:
                parsed = raw
            raise FactoryError(err.code, parsed) from None

    def config(self) -> dict:
        """The agent's configuration as the factory holds it now (soul, memory settings, adopted skills)."""
        return self._call("GET", f"{self.url}/api/v1/runs/{self.run_id}/agent-config", timeout=30)

    def input(self) -> dict:
        got = self._call("GET", f"{self.url}/api/v1/runs/{self.run_id}/input", timeout=30)
        payload = (got or {}).get("input")
        return payload if isinstance(payload, dict) else {"message": payload} if payload else {}

    def complete(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        """One model call through the factory model API (M1). The factory decides which model answers (M2)."""
        body: dict[str, Any] = {"messages": messages, "max_tokens": 2048}
        if self.model:
            body["model"] = self.model
        if tools:
            body["tools"] = tools
        out = self._call("POST", f"{self.model_base}/chat/completions", body)
        return out["choices"][0]["message"]

    def reply_console(self, turn_id: str, content: str) -> None:
        self._call("POST", f"{self.url}/api/v1/runs/{self.run_id}/reply", {"turnId": turn_id, "content": content}, timeout=30)

    def reply_discord(self, channel_id: str, content: str) -> None:
        base = self.discord_base or "https://discord.com/api/v10"
        self._call("POST", f"{base}/channels/{channel_id}/messages", {"content": content[:1900]}, timeout=30)

    def next_message(self, wait_ms: int) -> dict | None:
        got = self._call("GET", f"{self.url}/api/v1/runs/{self.run_id}/mailbox?timeout={wait_ms}", timeout=wait_ms / 1000 + 15)
        return (got or {}).get("message")

    def heartbeat(self) -> None:
        try:
            self._call("POST", f"{self.url}/api/v1/runs/{self.run_id}/heartbeat", {}, timeout=10)
        except Exception:
            pass

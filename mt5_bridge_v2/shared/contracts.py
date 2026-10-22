from __future__ import annotations
from typing import Any, TypedDict

class Heartbeat(TypedDict):
    agentId: str
    state: str
    environment: str
    terminalConnected: bool
    accountConnected: bool
    executionReady: bool
    brokerSymbol: str | None
    lastErrorCode: str | None
    sentAt: str

class Command(TypedDict, total=False):
    id: str
    idempotencyKey: str
    kind: str
    environment: str
    expiresAt: str
    payload: dict[str, Any]

class CommandResult(TypedDict):
    commandId: str
    idempotencyKey: str
    state: str
    code: str
    details: dict[str, Any]
    completedAt: str

"""Workflow persistence adapters.

The workflow mutates a single logical state object inside a repository transaction.
That deliberately keeps all reservation/capacity invariants in one place.  The
Firestore adapter stores the small hackathon state in one transaction document;
the in-memory adapter has identical semantics for credential-free tests.
"""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from threading import RLock
from typing import Any, Protocol, TypeVar


T = TypeVar("T")


def empty_state() -> dict[str, Any]:
    return {
        "offers": {},
        "recipients": {},
        "reservations": {},
        "notifications": {},
        "access_tokens": {},
        "command_receipts": {},
        "events": {},
    }


class WorkflowRepository(Protocol):
    def transact(self, operation: Callable[[dict[str, Any]], T]) -> T: ...

    def snapshot(self) -> dict[str, Any]: ...

    def ping(self) -> bool: ...


@dataclass
class InMemoryWorkflowRepository:
    """Thread-safe transaction adapter used by local runs and unit tests."""

    initial_state: dict[str, Any] | None = None
    _lock: RLock = field(default_factory=RLock, init=False, repr=False)
    _state: dict[str, Any] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._state = deepcopy(self.initial_state or empty_state())

    def transact(self, operation: Callable[[dict[str, Any]], T]) -> T:
        with self._lock:
            working = deepcopy(self._state)
            result = operation(working)
            self._state = working
            return deepcopy(result)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._state)

    def ping(self) -> bool:
        return True


class FirestoreWorkflowRepository:
    """Firestore transaction adapter for the bounded demo workflow.

    A single state document is intentional for this first release: every claim,
    capacity counter, receipt, and notification is committed atomically, including
    across Cloud Run instances.  It is suitable for the bounded hackathon demo and
    keeps the repository interface ready for a later collection-per-entity adapter.
    """

    def __init__(
        self,
        *,
        project: str | None = None,
        database: str = "(default)",
        collection: str = "workflow_internal",
    ) -> None:
        try:
            from google.cloud import firestore
        except ImportError as exc:  # pragma: no cover - cloud-only dependency
            raise RuntimeError("google-cloud-firestore is required") from exc
        self._firestore = firestore
        self._client = firestore.Client(project=project, database=database)
        self._document = self._client.collection(collection).document("state")

    def transact(self, operation: Callable[[dict[str, Any]], T]) -> T:
        transaction = self._client.transaction()

        @self._firestore.transactional
        def run(txn: Any) -> T:
            snapshot = self._document.get(transaction=txn)
            state = snapshot.to_dict() if snapshot.exists else empty_state()
            state = deepcopy(state or empty_state())
            result = operation(state)
            txn.set(self._document, state)
            return result

        return deepcopy(run(transaction))

    def snapshot(self) -> dict[str, Any]:
        snapshot = self._document.get()
        return deepcopy(snapshot.to_dict() if snapshot.exists else empty_state())

    def ping(self) -> bool:
        # A document read is both credential- and dependency-aware but does not
        # mutate production state.
        self._document.get(field_paths=[])
        return True


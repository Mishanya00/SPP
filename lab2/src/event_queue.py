import heapq
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass(order=True)
class Event:
    time: float
    priority: int = field(compare=True)
    event_type: str = field(compare=False)
    data: Any = field(compare=False, default=None)
    event_id: int = field(compare=True, default=0)


class EventQueue:
    def __init__(self):
        self._heap = []
        self._counter = 0

    def schedule(self, time: float, event_type: str, data: Any = None, priority: int = 10) -> None:
        self._counter += 1
        event = Event(time=time, priority=priority, event_type=event_type, data=data, event_id=self._counter)
        heapq.heappush(self._heap, event)

    def pop_next(self) -> Optional[Event]:
        if not self._heap:
            return None
        return heapq.heappop(self._heap)

    def peek_next_time(self) -> Optional[float]:
        if not self._heap:
            return None
        return self._heap[0].time

    def is_empty(self) -> bool:
        return len(self._heap) == 0

    def __len__(self) -> int:
        return len(self._heap)

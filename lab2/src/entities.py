from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, List


class ItemStatus(str, Enum):
    IN_SYSTEM = "in_system"
    COMPLETED = "completed"
    SCRAPPED = "scrapped"


@dataclass
class Item:
    item_id: int
    arrival_time: float
    defect_count: int = 0
    current_station_idx: int = 0
    status: ItemStatus = ItemStatus.IN_SYSTEM
    completion_time: Optional[float] = None

    total_inspection_time: float = 0.0
    total_repair_time: float = 0.0
    total_wait_inspection: float = 0.0
    total_wait_repair: float = 0.0

    entered_queue_time: Optional[float] = None
    entered_repair_queue_time: Optional[float] = None

    @property
    def total_time_in_system(self) -> float:
        if self.completion_time is not None:
            return self.completion_time - self.arrival_time
        return 0.0


@dataclass
class InspectionStation:
    station_id: int
    name: str
    is_busy: bool = False
    current_item: Optional[Item] = None
    queue: List[Item] = field(default_factory=list)
    total_inspections: int = 0
    defects_detected: int = 0

    @property
    def queue_length(self) -> int:
        return len(self.queue)


@dataclass
class RepairStation:
    name: str = "Repair Station"
    is_busy: bool = False
    current_item: Optional[Item] = None
    queue: List[Item] = field(default_factory=list)
    total_repairs_started: int = 0
    total_repairs_finished: int = 0
    total_scrapped_items: int = 0

    @property
    def queue_length(self) -> int:
        return len(self.queue)

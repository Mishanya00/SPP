from enum import Enum
import random
from typing import List, Optional, Dict, Any

from src.config import SimulationConfig
from src.entities import Item, InspectionStation, RepairStation, ItemStatus
from src.event_queue import EventQueue
from src.statistics import StatisticsCollector


class EventType(str, Enum):
    ARRIVAL = "ARRIVAL"
    END_INSPECTION = "END_INSPECTION"
    END_REPAIR = "END_REPAIR"
    SIMULATION_CUTOFF = "SIMULATION_CUTOFF"


class SimulationModel:
    def __init__(self, config: SimulationConfig):
        self.config = config
        self.rng = random.Random(config.rng_seed)
        self.events = EventQueue()
        self.collector = StatisticsCollector()

        self.current_time = 0.0
        self.item_counter = 0

        self.stations: List[InspectionStation] = [
            InspectionStation(station_id=i, name=s.name)
            for i, s in enumerate(config.stations)
        ]
        self.repair_station = RepairStation()
        self.active_items: Dict[int, Item] = {}

    def _sample_arrival_interval(self) -> float:
        return self.rng.expovariate(1.0 / self.config.mean_arrival_interval)

    def _sample_inspection_time(self, station_idx: int) -> float:
        cfg = self.config.stations[station_idx]
        val = self.rng.normalvariate(cfg.mean_service_time, cfg.std_service_time)
        return max(val, cfg.min_service_time)

    def _sample_defect(self, station_idx: int) -> bool:
        return self.rng.random() < self.config.stations[station_idx].defect_probability

    def _sample_repair_time(self) -> float:
        val = self.rng.normalvariate(self.config.repair_mean_time, self.config.repair_std_time)
        return max(val, self.config.repair_min_time)

    def _log(self, message: str) -> None:
        if self.config.trace:
            print(f"[t={self.current_time:8.2f} min] {message}")

    def _update_continuous_statistics(self) -> None:
        rep_q = len(self.repair_station.queue)
        rep_busy = 1.0 if self.repair_station.is_busy else 0.0
        st_q = sum(len(s.queue) for s in self.stations)
        st_busy = sum(1.0 for s in self.stations if s.is_busy)
        total_items = len(self.active_items)

        self.collector.repair_queue_len.update(rep_q, self.current_time)
        self.collector.repair_utilization.update(rep_busy, self.current_time)
        self.collector.stations_queue_len.update(st_q, self.current_time)
        self.collector.stations_busy_count.update(st_busy, self.current_time)
        self.collector.total_items_in_system.update(total_items, self.current_time)

    def initialize(self) -> None:
        self.current_time = 0.0
        self.item_counter = 0

        for _ in range(self.config.initial_items_count):
            self.item_counter += 1
            item = Item(item_id=self.item_counter, arrival_time=0.0)
            self.active_items[item.item_id] = item
            self._route_to_station(item, 0)

        first_t = self._sample_arrival_interval()
        if first_t < self.config.simulation_time:
            self.events.schedule(time=first_t, event_type=EventType.ARRIVAL, priority=1)

        self.events.schedule(time=self.config.simulation_time, event_type=EventType.SIMULATION_CUTOFF, priority=100)
        self._update_continuous_statistics()
        self._log("SIMULATION INITIALIZED.")

    def run(self) -> Dict[str, Any]:
        self.initialize()

        while not self.events.is_empty():
            event = self.events.pop_next()
            if event is None:
                break

            self.current_time = event.time
            self._update_continuous_statistics()

            if not self._dispatch_event(event):
                break

        self.collector.finalize(self.current_time)
        self._log(f"SIMULATION FINISHED at t={self.current_time:.2f} min.")
        return self.collector.summary()

    def _dispatch_event(self, event) -> bool:
        if event.event_type == EventType.ARRIVAL:
            self._handle_arrival()
        elif event.event_type == EventType.END_INSPECTION:
            self._handle_end_inspection(event.data)
        elif event.event_type == EventType.END_REPAIR:
            self._handle_end_repair(event.data)
        elif event.event_type == EventType.SIMULATION_CUTOFF:
            if not self.config.with_clearance:
                self._log("Simulation cutoff reached (no clearance). Halting.")
                return False
            self._log("Simulation cutoff reached. Processing in-flight items (clearance mode).")
        return True

    def _handle_arrival(self) -> None:
        self.item_counter += 1
        item = Item(item_id=self.item_counter, arrival_time=self.current_time)
        self.active_items[item.item_id] = item
        self.collector.total_arrivals += 1
        self._log(f"ARRIVAL: Item #{item.item_id} entered system.")

        next_t = self.current_time + self._sample_arrival_interval()
        if next_t < self.config.simulation_time:
            self.events.schedule(time=next_t, event_type=EventType.ARRIVAL, priority=1)

        self._route_to_station(item, 0)

    def _handle_end_inspection(self, data: Dict[str, Any]) -> None:
        station_idx = data["station_idx"]
        item = self.active_items.get(data["item_id"])
        station = self.stations[station_idx]

        if item is None:
            return

        station.total_inspections += 1
        if self._sample_defect(station_idx):
            self._process_defect(item, station)
        else:
            self._process_inspection_passed(item, station_idx)

        self._start_next_in_station_queue(station)
        self._update_continuous_statistics()

    def _handle_end_repair(self, data: Dict[str, Any]) -> None:
        item = self.active_items.get(data["item_id"])

        if item is not None:
            self.repair_station.total_repairs_finished += 1
            self.collector.total_repairs += 1
            self._log(f"REPAIR_END: Item #{item.item_id} repair finished -> routed back to Station 1.")
            self._route_to_station(item, 0)

        self._start_next_in_repair_queue()
        self._update_continuous_statistics()

    def _process_defect(self, item: Item, station: InspectionStation) -> None:
        station.defects_detected += 1
        if item.defect_count == 0:
            item.defect_count = 1
            self._log(f"DEFECT_FOUND: Item #{item.item_id} failed {station.name} (defect #1) -> routed to Repair.")
            self._route_to_repair(item)
        else:
            item.defect_count += 1
            self._scrap_item(item, station)

    def _process_inspection_passed(self, item: Item, station_idx: int) -> None:
        station = self.stations[station_idx]
        self._log(f"INSPECT_PASS: Item #{item.item_id} passed {station.name}.")

        if station_idx < len(self.stations) - 1:
            self._route_to_station(item, station_idx + 1)
        else:
            self._complete_item(item)

    def _complete_item(self, item: Item) -> None:
        item.status = ItemStatus.COMPLETED
        item.completion_time = self.current_time
        self.collector.total_good_produced += 1
        self.collector.time_in_system.record(item.total_time_in_system, self.current_time)
        del self.active_items[item.item_id]
        self._log(f"COMPLETED: Item #{item.item_id} successfully finished all tests -> GOOD PRODUCT.")

    def _scrap_item(self, item: Item, station: InspectionStation) -> None:
        item.status = ItemStatus.SCRAPPED
        item.completion_time = self.current_time
        self.collector.total_scrapped += 1
        self.collector.time_in_system.record(item.total_time_in_system, self.current_time)
        del self.active_items[item.item_id]
        self._log(f"SCRAPPED: Item #{item.item_id} failed {station.name} (defect #{item.defect_count}) -> SCRAPPED.")

    def _route_to_station(self, item: Item, station_idx: int) -> None:
        station = self.stations[station_idx]
        item.current_station_idx = station_idx

        if not station.is_busy:
            self._start_station_service(item, station)
        else:
            item.entered_queue_time = self.current_time
            station.queue.append(item)
            self._log(f"INSPECT_QUEUE: Item #{item.item_id} joined queue at {station.name} (queue_len={len(station.queue)}).")
        self._update_continuous_statistics()

    def _start_station_service(self, item: Item, station: InspectionStation) -> None:
        station.is_busy = True
        station.current_item = item
        duration = self._sample_inspection_time(station.station_id)
        item.total_inspection_time += duration
        self.events.schedule(
            time=self.current_time + duration,
            event_type=EventType.END_INSPECTION,
            data={"station_idx": station.station_id, "item_id": item.item_id},
            priority=5
        )
        self._log(f"INSPECT_START: Item #{item.item_id} started test at {station.name} (duration={duration:.2f}m).")

    def _start_next_in_station_queue(self, station: InspectionStation) -> None:
        if station.queue:
            next_item = station.queue.pop(0)
            if next_item.entered_queue_time is not None:
                wait_time = self.current_time - next_item.entered_queue_time
                next_item.total_wait_inspection += wait_time
                self.collector.wait_time_stations.record(wait_time, self.current_time)
                next_item.entered_queue_time = None
            self._start_station_service(next_item, station)
        else:
            station.is_busy = False
            station.current_item = None

    def _route_to_repair(self, item: Item) -> None:
        if not self.repair_station.is_busy:
            self._start_repair_service(item)
        else:
            item.entered_repair_queue_time = self.current_time
            self.repair_station.queue.append(item)
            self._log(f"REPAIR_QUEUE: Item #{item.item_id} joined repair queue (queue_len={len(self.repair_station.queue)}).")
        self._update_continuous_statistics()

    def _start_repair_service(self, item: Item) -> None:
        self.repair_station.is_busy = True
        self.repair_station.current_item = item
        self.repair_station.total_repairs_started += 1
        duration = self._sample_repair_time()
        item.total_repair_time += duration
        self.events.schedule(
            time=self.current_time + duration,
            event_type=EventType.END_REPAIR,
            data={"item_id": item.item_id},
            priority=4
        )
        self._log(f"REPAIR_START: Item #{item.item_id} started repair (duration={duration:.2f}m).")

    def _start_next_in_repair_queue(self) -> None:
        if self.repair_station.queue:
            next_item = self.repair_station.queue.pop(0)
            if next_item.entered_repair_queue_time is not None:
                wait_t = self.current_time - next_item.entered_repair_queue_time
                next_item.total_wait_repair += wait_t
                self.collector.wait_time_repair.record(wait_t, self.current_time)
                next_item.entered_repair_queue_time = None
            self._start_repair_service(next_item)
        else:
            self.repair_station.is_busy = False
            self.repair_station.current_item = None

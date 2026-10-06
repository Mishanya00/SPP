from typing import List, Dict, Any, Tuple
from dataclasses import dataclass, field
import numpy as np


@dataclass
class TimePoint:
    time: float
    instant_value: float
    cumulative_average: float


class ContinuousStatistic:
    def __init__(self, name: str, initial_value: float = 0.0):
        self.name = name
        self.current_value = initial_value
        self.last_update_time = 0.0
        self.time_integral = 0.0
        self.history: List[TimePoint] = [TimePoint(0.0, initial_value, initial_value)]

    def update(self, new_value: float, current_time: float) -> None:
        dt = current_time - self.last_update_time
        if dt > 0:
            self.time_integral += self.current_value * dt
            cum_avg = self.time_integral / current_time if current_time > 0 else 0.0
            self.history.append(TimePoint(current_time, self.current_value, cum_avg))
        
        self.current_value = new_value
        self.last_update_time = current_time

    def finalize(self, total_time: float) -> None:
        if total_time > self.last_update_time:
            dt = total_time - self.last_update_time
            self.time_integral += self.current_value * dt
            self.last_update_time = total_time
            cum_avg = self.time_integral / total_time if total_time > 0 else 0.0
            self.history.append(TimePoint(total_time, self.current_value, cum_avg))

    @property
    def mean(self) -> float:
        if self.last_update_time > 0:
            return self.time_integral / self.last_update_time
        return self.current_value


class DiscreteStatistic:
    def __init__(self, name: str):
        self.name = name
        self.observations: List[float] = []
        self.timestamps: List[float] = []
        self.running_means: List[float] = []
        self._sum = 0.0

    def record(self, value: float, current_time: float) -> None:
        self.observations.append(value)
        self.timestamps.append(current_time)
        self._sum += value
        self.running_means.append(self._sum / len(self.observations))

    @property
    def count(self) -> int:
        return len(self.observations)

    @property
    def mean(self) -> float:
        return self._sum / len(self.observations) if self.observations else 0.0

    @property
    def std(self) -> float:
        return float(np.std(self.observations)) if len(self.observations) > 1 else 0.0


class StatisticsCollector:
    def __init__(self):
        self.repair_queue_len = ContinuousStatistic("repair_queue_len")
        self.repair_utilization = ContinuousStatistic("repair_utilization")
        self.stations_queue_len = ContinuousStatistic("stations_queue_len")
        self.stations_busy_count = ContinuousStatistic("stations_busy_count")
        self.total_items_in_system = ContinuousStatistic("total_items_in_system")

        self.time_in_system = DiscreteStatistic("time_in_system")
        self.wait_time_repair = DiscreteStatistic("wait_time_repair")
        self.wait_time_stations = DiscreteStatistic("wait_time_stations")

        self.total_arrivals = 0
        self.total_good_produced = 0
        self.total_scrapped = 0
        self.total_repairs = 0
        self.simulation_end_time = 0.0

    def finalize(self, current_time: float) -> None:
        self.simulation_end_time = current_time
        self.repair_queue_len.finalize(current_time)
        self.repair_utilization.finalize(current_time)
        self.stations_queue_len.finalize(current_time)
        self.stations_busy_count.finalize(current_time)
        self.total_items_in_system.finalize(current_time)

    def summary(self) -> Dict[str, Any]:
        finished = self.total_good_produced + self.total_scrapped
        scrap_rate = (self.total_scrapped / finished) if finished > 0 else 0.0
        
        return {
            "final": {
                "simulation_time": self.simulation_end_time,
            },
            "additive": {
                "total_arrivals": self.total_arrivals,
                "total_good_produced": self.total_good_produced,
                "total_scrapped": self.total_scrapped,
                "total_repairs": self.total_repairs,
            },
            "discrete": {
                "mean_time_in_system": self.time_in_system.mean,
                "std_time_in_system": self.time_in_system.std,
                "mean_wait_repair": self.wait_time_repair.mean,
                "mean_wait_stations": self.wait_time_stations.mean,
                "scrap_rate": scrap_rate,
            },
            "continuous": {
                "mean_repair_queue_len": self.repair_queue_len.mean,
                "mean_repair_utilization": self.repair_utilization.mean,
                "mean_stations_queue_len": self.stations_queue_len.mean,
                "mean_stations_busy": self.stations_busy_count.mean,
                "mean_items_in_system": self.total_items_in_system.mean,
            }
        }

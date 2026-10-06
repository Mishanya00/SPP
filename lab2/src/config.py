"""
Simulation configuration and parameter dataclasses.
"""

from dataclasses import dataclass, field
from typing import List, Dict, Any
import json


@dataclass
class StationConfig:
    name: str
    mean_service_time: float
    std_service_time: float
    min_service_time: float
    defect_probability: float


@dataclass
class SimulationConfig:
    # Run parameters
    simulation_time: float = 480.0  # Total simulation time (minutes, e.g. 8h shift)
    with_clearance: bool = True     # Service remaining items after simulation_time
    rng_seed: int = 42              # Single RNG seed
    initial_items_count: int = 0    # Items present at start
    trace: bool = False             # Verbose execution trace

    # Arrival parameters
    mean_arrival_interval: float = 10.0  # Exponential arrival mean (minutes)

    # Inspection stations (1, 2, 3)
    stations: List[StationConfig] = field(default_factory=lambda: [
        StationConfig(
            name="Station 1",
            mean_service_time=4.0,
            std_service_time=1.0,
            min_service_time=0.5,
            defect_probability=0.08
        ),
        StationConfig(
            name="Station 2",
            mean_service_time=5.0,
            std_service_time=1.0,
            min_service_time=0.5,
            defect_probability=0.07
        ),
        StationConfig(
            name="Station 3",
            mean_service_time=4.5,
            std_service_time=1.0,
            min_service_time=0.5,
            defect_probability=0.05
        )
    ])

    # Repair station parameters
    repair_mean_time: float = 8.0
    repair_std_time: float = 2.0
    repair_min_time: float = 1.0

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SimulationConfig":
        stations_data = data.pop("stations", None)
        config = cls(**data)
        if stations_data:
            config.stations = [StationConfig(**s) for s in stations_data]
        return config

    @classmethod
    def from_file(cls, filepath: str) -> "SimulationConfig":
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        return cls.from_dict(data)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "simulation_time": self.simulation_time,
            "with_clearance": self.with_clearance,
            "rng_seed": self.rng_seed,
            "initial_items_count": self.initial_items_count,
            "trace": self.trace,
            "mean_arrival_interval": self.mean_arrival_interval,
            "repair_mean_time": self.repair_mean_time,
            "repair_std_time": self.repair_std_time,
            "repair_min_time": self.repair_min_time,
            "stations": [s.__dict__ for s in self.stations]
        }

    def save_to_file(self, filepath: str) -> None:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=4)

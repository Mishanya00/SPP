"""
Automated verification unit tests for the simulation model logic (LR22).
"""

import unittest
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.config import SimulationConfig, StationConfig
from src.simulation import SimulationModel


class TestSimulationVerification(unittest.TestCase):
    def test_reproducibility(self):
        """Verifies that runs with the same RNG seed yield identical results."""
        cfg1 = SimulationConfig(simulation_time=200.0, rng_seed=12345, trace=False)
        m1 = SimulationModel(cfg1)
        res1 = m1.run()

        cfg2 = SimulationConfig(simulation_time=200.0, rng_seed=12345, trace=False)
        m2 = SimulationModel(cfg2)
        res2 = m2.run()

        self.assertEqual(res1["additive"]["total_arrivals"], res2["additive"]["total_arrivals"])
        self.assertEqual(res1["additive"]["total_good_produced"], res2["additive"]["total_good_produced"])
        self.assertEqual(res1["additive"]["total_scrapped"], res2["additive"]["total_scrapped"])
        self.assertAlmostEqual(res1["discrete"]["mean_time_in_system"], res2["discrete"]["mean_time_in_system"], places=5)

    def test_zero_defect_rate(self):
        """Verifies that if defect probability is zero, zero items are repaired or scrapped."""
        stations = [
            StationConfig("Station 1", 3.0, 0.5, 0.5, defect_probability=0.0),
            StationConfig("Station 2", 3.0, 0.5, 0.5, defect_probability=0.0),
            StationConfig("Station 3", 3.0, 0.5, 0.5, defect_probability=0.0),
        ]
        cfg = SimulationConfig(
            simulation_time=300.0,
            rng_seed=42,
            stations=stations,
            with_clearance=True,
            trace=False
        )
        m = SimulationModel(cfg)
        res = m.run()

        self.assertEqual(res["additive"]["total_repairs"], 0)
        self.assertEqual(res["additive"]["total_scrapped"], 0)
        self.assertEqual(res["additive"]["total_arrivals"], res["additive"]["total_good_produced"])
        self.assertEqual(res["discrete"]["scrap_rate"], 0.0)

    def test_full_defect_rate(self):
        """Verifies that if defect probability is 100%, all items are repaired once and scrapped upon re-test."""
        stations = [
            StationConfig("Station 1", 2.0, 0.2, 0.5, defect_probability=1.0),
            StationConfig("Station 2", 2.0, 0.2, 0.5, defect_probability=1.0),
            StationConfig("Station 3", 2.0, 0.2, 0.5, defect_probability=1.0),
        ]
        cfg = SimulationConfig(
            simulation_time=150.0,
            rng_seed=42,
            stations=stations,
            with_clearance=True,
            trace=False
        )
        m = SimulationModel(cfg)
        res = m.run()

        # All processed items must be scrapped, none can be good
        self.assertEqual(res["additive"]["total_good_produced"], 0)
        self.assertEqual(res["additive"]["total_arrivals"], res["additive"]["total_scrapped"])
        self.assertEqual(res["additive"]["total_repairs"], res["additive"]["total_arrivals"])
        self.assertEqual(res["discrete"]["scrap_rate"], 1.0)

    def test_flow_conservation(self):
        """Verifies conservation of mass: Arrivals = Completed + Scrapped in clearance mode."""
        cfg = SimulationConfig(simulation_time=300.0, rng_seed=999, with_clearance=True, trace=False)
        m = SimulationModel(cfg)
        res = m.run()

        total_in = res["additive"]["total_arrivals"]
        total_out = res["additive"]["total_good_produced"] + res["additive"]["total_scrapped"]
        self.assertEqual(total_in, total_out)


if __name__ == "__main__":
    unittest.main()

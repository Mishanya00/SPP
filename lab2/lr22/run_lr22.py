"""
Execution script for Laboratory Work 2.2 (LR22): Verification and Sensitivity Analysis.
Runs multiple replications, tracks response dynamics over time, performs parameter sweeps,
and renders high-resolution verification charts.
"""

import sys
import os
import json
from typing import List, Dict, Any
import numpy as np
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.config import SimulationConfig, StationConfig
from src.simulation import SimulationModel


# Configure plot styling
plt.rcParams['font.sans-serif'] = 'DejaVu Sans'
plt.rcParams['axes.edgecolor'] = '#CCCCCC'
plt.rcParams['axes.linewidth'] = 0.8


def run_dynamics_experiment(plots_dir: str) -> Dict[str, Any]:
    """Runs multiple replications and plots individual realizations + cumulative averages."""
    seeds = [101, 202, 303, 404, 505]
    sim_time = 600.0

    print("Running Dynamics Experiment (Replications & Cumulative Averages)...")
    replications_data = []

    for s in seeds:
        cfg = SimulationConfig(simulation_time=sim_time, rng_seed=s, with_clearance=False, trace=False)
        model = SimulationModel(cfg)
        model.run()
        replications_data.append({
            "seed": s,
            "queue_history": model.collector.stations_queue_len.history,
            "util_history": model.collector.repair_utilization.history,
            "sys_times": model.collector.time_in_system.observations,
            "sys_timestamps": model.collector.time_in_system.timestamps,
            "sys_running_means": model.collector.time_in_system.running_means
        })

    # Plot 1: Stations Queue Length Dynamics
    fig, ax = plt.subplots(figsize=(9, 5), dpi=200)
    for idx, rep in enumerate(replications_data):
        times = [pt.time for pt in rep["queue_history"]]
        vals = [pt.instant_value for pt in rep["queue_history"]]
        ax.step(times, vals, where="post", alpha=0.25, label=f"Прогон {idx+1} (мгновенная)", linewidth=0.8)

    # Plot cumulative mean of Run 1
    times_r1 = [pt.time for pt in replications_data[0]["queue_history"]]
    cum_r1 = [pt.cumulative_average for pt in replications_data[0]["queue_history"]]
    ax.plot(times_r1, cum_r1, color="#E67E22", linewidth=2.0, label="Накопленное среднее (Прогон 1)")

    # Ensemble mean across all runs
    grid_times_q = np.linspace(10, sim_time, 200)
    interp_q = []
    for rep in replications_data:
        times = [pt.time for pt in rep["queue_history"]]
        cums = [pt.cumulative_average for pt in rep["queue_history"]]
        interp_q.append(np.interp(grid_times_q, times, cums))
    ensemble_q = np.mean(interp_q, axis=0)
    ax.plot(grid_times_q, ensemble_q, color="#1F4E79", linewidth=2.8, label="Ансамблевое среднее (5 прогонов)")

    ax.set_title("Динамика длины очереди к станциям контроля L_q,st(t) в модельном времени", fontsize=12, fontweight="bold", pad=12)
    ax.set_xlabel("Модельное время (минуты)", fontsize=10)
    ax.set_ylabel("Длина очереди к станциям (изделий)", fontsize=10)
    ax.grid(True, linestyle="--", alpha=0.5)
    ax.legend(loc="upper right", framealpha=0.9, fontsize=8.5)
    fig.tight_layout()
    plot1_path = os.path.join(plots_dir, "dynamics_queue_len.png")
    fig.savefig(plot1_path)
    plt.close(fig)

    # Plot 2: Repairer Utilization Dynamics
    fig, ax = plt.subplots(figsize=(9, 5), dpi=200)
    for idx, rep in enumerate(replications_data):
        times = [pt.time for pt in rep["util_history"]]
        cums = [pt.cumulative_average for pt in rep["util_history"]]
        ax.plot(times, cums, alpha=0.5, linewidth=1.2, label=f"Run {idx+1} cum. mean")

    # Overall ensemble mean curve across common time points
    grid_times = np.linspace(10, sim_time, 200)
    interp_vals = []
    for rep in replications_data:
        times = [pt.time for pt in rep["util_history"]]
        cums = [pt.cumulative_average for pt in rep["util_history"]]
        interp_vals.append(np.interp(grid_times, times, cums))
    ensemble_mean = np.mean(interp_vals, axis=0)

    ax.plot(grid_times, ensemble_mean, color="#1F4E79", linewidth=2.8, label="Ансамблевое среднее (5 прогонов)")
    ax.set_title("Стабилизация коэффициента загрузки наладчика K_rep(t)", fontsize=12, fontweight="bold", pad=12)
    ax.set_xlabel("Модельное время (минуты)", fontsize=10)
    ax.set_ylabel("Коэффициент загрузки K_rep", fontsize=10)
    ax.grid(True, linestyle="--", alpha=0.5)
    ax.legend(loc="upper right", framealpha=0.9, fontsize=8.5)
    fig.tight_layout()
    plot2_path = os.path.join(plots_dir, "dynamics_repair_utilization.png")
    fig.savefig(plot2_path)
    plt.close(fig)

    # Plot 3: Time in System Dynamics (Discrete response)
    fig, ax = plt.subplots(figsize=(9, 5), dpi=200)
    for idx, rep in enumerate(replications_data):
        if rep["sys_timestamps"]:
            ax.plot(rep["sys_timestamps"], rep["sys_running_means"], alpha=0.5, linewidth=1.2, label=f"Run {idx+1}")
    ax.set_title("Стабилизация среднего времени пребывания изделия в системе T_sys(t)", fontsize=12, fontweight="bold", pad=12)
    ax.set_xlabel("Модельное время (минуты)", fontsize=10)
    ax.set_ylabel("Накопленное среднее T_sys (минуты)", fontsize=10)
    ax.grid(True, linestyle="--", alpha=0.5)
    ax.legend(loc="upper right", framealpha=0.9, fontsize=8.5)
    fig.tight_layout()
    plot3_path = os.path.join(plots_dir, "dynamics_time_in_system.png")
    fig.savefig(plot3_path)
    plt.close(fig)

    return {
        "plot_queue": plot1_path,
        "plot_util": plot2_path,
        "plot_time": plot3_path
    }


def run_sensitivity_experiments(plots_dir: str) -> Dict[str, Any]:
    """Runs parameter sweeps to evaluate model response dependencies on inputs."""
    print("Running Sensitivity Experiments (Parameter Sweeps)...")

    # Experiment A: Arrival interval sweep (Traffic intensity)
    intervals = [5.0, 6.0, 7.0, 8.0, 10.0, 12.0, 15.0, 18.0]
    mean_sys_times = []
    mean_st_queues = []
    mean_rep_queues = []
    mean_rep_utils = []

    for T_arr in intervals:
        sub_sys_t = []
        sub_st_q = []
        sub_rep_q = []
        sub_rep_u = []
        for s in [10, 20, 30]:
            cfg = SimulationConfig(simulation_time=480.0, mean_arrival_interval=T_arr, rng_seed=s)
            res = SimulationModel(cfg).run()
            sub_sys_t.append(res["discrete"]["mean_time_in_system"])
            sub_st_q.append(res["continuous"]["mean_stations_queue_len"])
            sub_rep_q.append(res["continuous"]["mean_repair_queue_len"])
            sub_rep_u.append(res["continuous"]["mean_repair_utilization"])
        mean_sys_times.append(float(np.mean(sub_sys_t)))
        mean_st_queues.append(float(np.mean(sub_st_q)))
        mean_rep_queues.append(float(np.mean(sub_rep_q)))
        mean_rep_utils.append(float(np.mean(sub_rep_u)))

    fig, ax1 = plt.subplots(figsize=(9, 5), dpi=200)
    ax2 = ax1.twinx()

    line1 = ax1.plot(intervals, mean_sys_times, marker="o", color="#2E86C1", linewidth=2, label="Время в системе T_sys (мин)")
    line2 = ax1.plot(intervals, mean_st_queues, marker="s", color="#E67E22", linewidth=2, label="Очередь к станциям L_q,st")
    line3 = ax2.plot(intervals, mean_rep_utils, marker="^", color="#27AE60", linewidth=2, linestyle="--", label="Загрузка наладчика K_rep")

    ax1.set_title("Зависимость откликов от интервала между поступлениями T_arr", fontsize=12, fontweight="bold", pad=12)
    ax1.set_xlabel("Средний интервал поступления T_arr (мин, чем меньше — тем выше нагрузка)", fontsize=10)
    ax1.set_ylabel("Время (мин) / Длина очереди (изд.)", fontsize=10)
    ax2.set_ylabel("Коэффициент загрузки K_rep", fontsize=10, color="#27AE60")
    ax1.grid(True, linestyle="--", alpha=0.5)

    lines = line1 + line2 + line3
    labels = [l.get_label() for l in lines]
    ax1.legend(lines, labels, loc="upper right", framealpha=0.9, fontsize=8.5)
    fig.tight_layout()
    plot_arr_path = os.path.join(plots_dir, "variation_arrival_rate.png")
    fig.savefig(plot_arr_path)
    plt.close(fig)

    # Experiment B: Defect probability sweep
    defect_factors = [0.02, 0.05, 0.08, 0.12, 0.16, 0.20, 0.25]
    scrap_rates = []
    repair_utils = []
    repair_queues = []

    for p in defect_factors:
        sub_scrap = []
        sub_util = []
        sub_q = []
        for s in [10, 20, 30]:
            stations = [
                StationConfig("S1", 4.0, 1.0, 0.5, defect_probability=p),
                StationConfig("S2", 5.0, 1.0, 0.5, defect_probability=p),
                StationConfig("S3", 4.5, 1.0, 0.5, defect_probability=p),
            ]
            cfg = SimulationConfig(simulation_time=480.0, stations=stations, rng_seed=s)
            res = SimulationModel(cfg).run()
            sub_scrap.append(res["discrete"]["scrap_rate"] * 100)
            sub_util.append(res["continuous"]["mean_repair_utilization"])
            sub_q.append(res["continuous"]["mean_repair_queue_len"])
        scrap_rates.append(float(np.mean(sub_scrap)))
        repair_utils.append(float(np.mean(sub_util)))
        repair_queues.append(float(np.mean(sub_q)))

    fig, ax1 = plt.subplots(figsize=(9, 5), dpi=200)
    ax2 = ax1.twinx()

    l1 = ax1.plot([p * 100 for p in defect_factors], scrap_rates, marker="o", color="#C0392B", linewidth=2.2, label="Доля брака P_scrap (%)")
    l2 = ax2.plot([p * 100 for p in defect_factors], repair_utils, marker="s", color="#8E44AD", linewidth=2.2, linestyle="--", label="Загрузка наладчика K_rep")
    l3 = ax2.plot([p * 100 for p in defect_factors], repair_queues, marker="^", color="#D35400", linewidth=1.8, linestyle=":", label="Очередь наладки L_q,rep")

    ax1.set_title("Зависимость брака и нагрузки наладчика от вероятности дефекта p_defect", fontsize=12, fontweight="bold", pad=12)
    ax1.set_xlabel("Вероятность брака на станциях p_defect (%)", fontsize=10)
    ax1.set_ylabel("Доля окончательного брака (%)", fontsize=10, color="#C0392B")
    ax2.set_ylabel("Загрузка K_rep / Длина очереди L_q,rep", fontsize=10)
    ax1.grid(True, linestyle="--", alpha=0.5)

    all_l = l1 + l2 + l3
    all_lbl = [l.get_label() for l in all_l]
    ax1.legend(all_l, all_lbl, loc="upper left", framealpha=0.9, fontsize=8.5)
    fig.tight_layout()
    plot_defect_path = os.path.join(plots_dir, "variation_defect_prob.png")
    fig.savefig(plot_defect_path)
    plt.close(fig)

    # Experiment C: Repair time sweep
    repair_times = [4.0, 6.0, 8.0, 10.0, 13.0, 16.0, 20.0]
    wait_rep_times = []
    q_rep_lens = []

    for t_rep in repair_times:
        sub_w = []
        sub_q = []
        for s in [10, 20, 30]:
            cfg = SimulationConfig(simulation_time=480.0, repair_mean_time=t_rep, rng_seed=s)
            res = SimulationModel(cfg).run()
            sub_w.append(res["discrete"]["mean_wait_repair"])
            sub_q.append(res["continuous"]["mean_repair_queue_len"])
        wait_rep_times.append(float(np.mean(sub_w)))
        q_rep_lens.append(float(np.mean(sub_q)))

    fig, ax = plt.subplots(figsize=(9, 5), dpi=200)
    ax.plot(repair_times, wait_rep_times, marker="o", color="#16A085", linewidth=2.2, label="Время ожидания наладки W_rep (мин)")
    ax.plot(repair_times, q_rep_lens, marker="s", color="#D35400", linewidth=2.2, label="Средняя длина очереди L_q,rep (изд.)")
    ax.set_title("Влияние длительности наладки T_repair на образование очереди к наладчику", fontsize=12, fontweight="bold", pad=12)
    ax.set_xlabel("Среднее время наладки изделия T_repair (мин)", fontsize=10)
    ax.set_ylabel("Показатели участка наладки", fontsize=10)
    ax.grid(True, linestyle="--", alpha=0.5)
    ax.legend(loc="upper left", framealpha=0.9, fontsize=9)
    fig.tight_layout()
    plot_repair_path = os.path.join(plots_dir, "variation_repair_time.png")
    fig.savefig(plot_repair_path)
    plt.close(fig)

    sweep_data = {
        "arrival_sweep": {"intervals": intervals, "time_in_sys": mean_sys_times, "st_queues": mean_st_queues, "rep_utils": mean_rep_utils},
        "defect_sweep": {"probs": defect_factors, "scrap_rates": scrap_rates, "rep_utils": repair_utils, "rep_queues": repair_queues},
        "repair_sweep": {"times": repair_times, "wait_times": wait_rep_times, "queue_lens": q_rep_lens}
    }

    return {
        "plot_arr": plot_arr_path,
        "plot_defect": plot_defect_path,
        "plot_repair": plot_repair_path,
        "sweep_data": sweep_data
    }


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    plots_dir = os.path.join(root, "lr22", "plots")
    os.makedirs(plots_dir, exist_ok=True)

    print("=" * 70)
    print("ЛАБОРАТОРНАЯ РАБОТА №2.2 (LR22) — ВЕРИФИКАЦИЯ И АНАЛИЗ ЧУВСТВИТЕЛЬНОСТИ")
    print("=" * 70)

    dyn_res = run_dynamics_experiment(plots_dir)
    sens_res = run_sensitivity_experiments(plots_dir)

    # Save summary json
    summary_path = os.path.join(root, "lr22", "verification_data.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(sens_res["sweep_data"], f, indent=2)

    print("=" * 70)
    print("Верификационные эксперименты успешно завершены.")
    print(f"Графики сохранены в директории: {plots_dir}")
    print(f"Данные параметрических свипов: {summary_path}")
    print("=" * 70)


if __name__ == "__main__":
    main()

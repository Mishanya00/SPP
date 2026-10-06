import sys
import os
import json
import argparse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.config import SimulationConfig
from src.simulation import SimulationModel


def main():
    parser = argparse.ArgumentParser(description="Run LR21 Simulation with Tracing and Responses.")
    parser.add_argument("--config", type=str, default=None, help="Path to config JSON file")
    parser.add_argument("--time", type=float, default=480.0, help="Simulation duration (min)")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed")
    parser.add_argument("--trace", action="store_true", default=True, help="Enable tracing")
    parser.add_argument("--no-trace", dest="trace", action="store_false", help="Disable tracing")
    parser.add_argument("--output-json", type=str, default="lr21/run_results.json", help="Path to save results JSON")
    parser.add_argument("--trace-log", type=str, default="lr21/trace.log", help="Path to save trace log")
    args = parser.parse_args()

    if args.config and os.path.exists(args.config):
        config = SimulationConfig.from_file(args.config)
    else:
        root_cfg = os.path.join(os.path.dirname(__file__), "..", "config.json")
        if os.path.exists(root_cfg):
            config = SimulationConfig.from_file(root_cfg)
        else:
            config = SimulationConfig()

    config.simulation_time = args.time
    config.rng_seed = args.seed
    config.trace = args.trace

    trace_lines = []
    
    class TeeLogger:
        def __init__(self, original_stdout, log_list):
            self.stdout = original_stdout
            self.log_list = log_list

        def write(self, msg):
            self.stdout.write(msg)
            self.log_list.append(msg)

        def flush(self):
            self.stdout.flush()

    orig_stdout = sys.stdout
    sys.stdout = TeeLogger(orig_stdout, trace_lines)

    print("=" * 70)
    print("ЛАБОРАТОРНАЯ РАБОТА №2.1 (LR21) — КОНТРОЛЬНЫЙ ПРОГОН МОДЕЛИ")
    print("Вариант №1: Станция технического контроля")
    print(f"Параметры: Время={config.simulation_time} мин, Seed={config.rng_seed}, Трассировка={config.trace}")
    print("=" * 70)

    model = SimulationModel(config)
    results = model.run()

    sys.stdout = orig_stdout

    # Save trace log
    os.makedirs(os.path.dirname(os.path.abspath(args.trace_log)), exist_ok=True)
    with open(args.trace_log, "w", encoding="utf-8") as f:
        f.writelines(trace_lines)

    # Save results JSON
    os.makedirs(os.path.dirname(os.path.abspath(args.output_json)), exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    print("\n" + "=" * 70)
    print("СВОДНАЯ ТАБЛИЦА ОТКЛИКОВ МОДЕЛИ (LR21)")
    print("=" * 70)
    print("1. ФИНАЛЬНЫЕ ОТКЛИКИ:")
    print(f"   - Фактическое время завершения прогона (T_fin): {results['final']['simulation_time']:.2f} мин")
    print("\n2. АДДИТИВНЫЕ ОТКЛИКИ:")
    print(f"   - Всего поступило изделий (N_arr):             {results['additive']['total_arrivals']}")
    print(f"   - Успешно выпущено годных (N_good):            {results['additive']['total_good_produced']}")
    print(f"   - Окончательно забраковано (N_scrap):          {results['additive']['total_scrapped']}")
    print(f"   - Всего выполнено наладок (N_repairs):         {results['additive']['total_repairs']}")
    print("\n3. ДИСКРЕТНЫЕ ВО ВРЕМЕНИ ОТКЛИКИ:")
    print(f"   - Среднее время пребывания в системе (T_sys):  {results['discrete']['mean_time_in_system']:.2f} мин (std={results['discrete']['std_time_in_system']:.2f})")
    print(f"   - Среднее время ожидания на станциях (W_st):   {results['discrete']['mean_wait_stations']:.2f} мин")
    print(f"   - Среднее время ожидания наладки (W_rep):      {results['discrete']['mean_wait_repair']:.2f} мин")
    print(f"   - Доля окончательного брака (P_scrap):         {results['discrete']['scrap_rate'] * 100:.2f}%")
    print("\n4. НЕПРЕРЫВНЫЕ ВО ВРЕМЕНИ ОТКЛИКИ:")
    print(f"   - Средняя длина очереди на наладку (L_q,rep):  {results['continuous']['mean_repair_queue_len']:.3f} изд.")
    print(f"   - Коэффициент загрузки наладчика (K_rep):      {results['continuous']['mean_repair_utilization']:.3f} ({results['continuous']['mean_repair_utilization']*100:.1f}%)")
    print(f"   - Средняя очередь к станциям контроля (L_q,st):{results['continuous']['mean_stations_queue_len']:.3f} изд.")
    print(f"   - Среднее число занятых станций (K_st):        {results['continuous']['mean_stations_busy']:.3f} из 3")
    print(f"   - Среднее число изделий в системе (N_sys):     {results['continuous']['mean_items_in_system']:.3f} изд.")
    print("=" * 70)
    print(f"Результаты сохранены в: {args.output_json}")
    print(f"Полный журнал трассировки сохранен в: {args.trace_log}")


if __name__ == "__main__":
    main()

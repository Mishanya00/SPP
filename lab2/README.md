# Лабораторная работа №2 по курсу САИ (Вариант №1)
## «Создание и верификация имитационной модели станции технического контроля»

---

## 📁 Структура проекта

```text
lab2/
├── .venv/                         # Виртуальное окружение Python
├── config.json                    # Конфигурационный файл с исходными данными
├── requirements.txt               # Зависимости проекта
├── METHOD_GUIDE.md                # 📘 Подробная методичка «на пальцах» и шпаргалка для защиты
│
├── src/                           # 🧠 Ядро имитационной модели
│   ├── __init__.py
│   ├── config.py                  # Классы конфигурации и параметров
│   ├── entities.py                # Сущности (Item, InspectionStation, RepairStation)
│   ├── event_queue.py             # Календарь событий (Future Event List на heapq)
│   ├── statistics.py              # Сборщик откликов (дискретных и непрерывных)
│   └── simulation.py              # Квазипараллельный движок (Event Scheduling)
│
├── lr21/                          # 🥇 ЧАСТЬ 1: Оценка LR21
│   ├── run_lr21.py                # Запуск контрольного прогона с трассировкой
│   ├── REPORT_LR21.md             # 📄 ОТЧЕТ LR21 в формате Markdown
│   ├── report_lr21.docx           # 📄 ОТЧЕТ LR21 в формате Word (docx)
│   ├── run_results.json           # Результаты прогона в JSON
│   └── trace.log                  # Полный лог трассировки событий
│
└── lr22/                          # 🥈 ЧАСТЬ 2: Оценка LR22 (Верификация)
    ├── run_lr22.py                # Запуск экспериментов и построение графиков
    ├── tests_verification.py      # Автоматические тесты верификации
    ├── REPORT_LR22.md             # 📄 ОТЧЕТ LR22 в формате Markdown (с графиками)
    ├── report_lr22.docx           # 📄 ОТЧЕТ LR22 в формате Word (с графиками)
    ├── verification_data.json     # Данные параметрических экспериментов
    └── plots/                     # 📊 Графики верификации в высоком разрешении
        ├── dynamics_queue_len.png
        ├── dynamics_repair_utilization.png
        ├── dynamics_time_in_system.png
        ├── variation_arrival_rate.png
        ├── variation_defect_prob.png
        └── variation_repair_time.png
```

---

## 🚀 Быстрый запуск

Из каталога `lab2` создайте виртуальное окружение и установите зависимости:
```bash
cd lab2
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Если вы уже находитесь в каталоге `lab2`, пропустите `cd lab2`. При следующих запусках
достаточно выполнить `source .venv/bin/activate`. Команда `python -m pip` без
активации использует системный Python и на Debian/Ubuntu может вызвать ошибку
`externally-managed-environment`. Без активации используйте
`.venv/bin/python -m pip install -r requirements.txt`.

### Запуск Части 1 (LR21):
```bash
# Запустить контрольный прогон с подробной трассировкой
python lr21/run_lr21.py --time 480 --seed 42
```

### Запуск Части 2 (LR22: Верификация):
```bash
# 1. Запустить серию повторных прогонов и генерацию графиков
python lr22/run_lr22.py

# 2. Запустить верификационные юнит-тесты
python lr22/tests_verification.py
```

---

## 📄 Отчеты для сдачи

- **Для LR21:** Отчет [`lr21/REPORT_LR21.md`](lr21/REPORT_LR21.md) (или Word-версия [`lr21/report_lr21.docx`](lr21/report_lr21.docx)).
- **Для LR22:** Отчет [`lr22/REPORT_LR22.md`](lr22/REPORT_LR22.md) (или Word-версия со встроенными графиками [`lr22/report_lr22.docx`](lr22/report_lr22.docx)).

---

## 💡 Методическое пособие
Перед защитой обязательно прочитайте файл **[METHOD_GUIDE.md](METHOD_GUIDE.md)**!  
В нем «на пальцах» объяснена вся теория: квазипараллелизм, почему запрещен шаг $\Delta t$, как рассчитываются непрерывные и дискретные отклики, а также даны готовые ответы на 10 типовых вопросов преподавателя.

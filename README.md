# SPP

University coursework projects: `lab1`, `lab2`, and `Autobot`.
See each project's README for its setup instructions.

## Pre-commit checks

Install [pre-commit](https://pre-commit.com/#install) and enable the Git hook
once per clone, from the repository root:

```sh
pipx install pre-commit
pre-commit install
```

Before each commit, pre-commit checks staged files for merge conflict markers
and validates YAML and JSON syntax. Ruff also lints staged Python files.
The first run downloads the hook dependencies.

To check all tracked files manually:

```sh
pre-commit run --all-files
```

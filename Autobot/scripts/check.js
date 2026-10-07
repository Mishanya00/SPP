import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
for (const directory of ['server', 'public', 'scripts', 'tests']) {
  for (const file of await readdir(directory)) {
    if (file.endsWith('.js')) await exec(process.execPath, ['--check', `${directory}/${file}`]);
  }
}
for (const file of await readdir('runner')) {
  if (file.endsWith('.py')) await exec('python3', ['-c', 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))', `runner/${file}`]);
}
console.log('Проверка синтаксиса JavaScript и Python пройдена.');

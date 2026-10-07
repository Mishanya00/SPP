import logging
import os
import re
import runpy
import sys


class RedactedStream:
    def __init__(self, stream):
        self.stream = stream
        self.pending = ''

    def write(self, text):
        self.pending += text
        while '\n' in self.pending:
            line, self.pending = self.pending.split('\n', 1)
            self.emit(line + '\n')
        if len(self.pending) > 65536:
            self.pending = ''
            self.emit('[Oversized log line omitted]\n')
        return len(text)

    def emit(self, text):
        for name in ('BOT_TOKEN', 'DEEPSEEK_API_KEY'):
            secret = os.environ.get(name, '')
            if secret:
                text = text.replace(secret, '[REDACTED]')
        text = re.sub(r'\d{5,}:[A-Za-z0-9_-]+', '[REDACTED]', text)
        self.stream.write(text)
        self.stream.flush()

    def flush(self):
        self.stream.flush()

    def finish(self):
        if self.pending:
            self.emit(self.pending)
            self.pending = ''

    def isatty(self):
        return False


sys.stdout = RedactedStream(sys.stdout)
sys.stderr = RedactedStream(sys.stderr)
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s', stream=sys.stderr)
logging.info('Starting bot /app/main.py')
try:
    runpy.run_path('/app/main.py', run_name='__main__')
except BaseException:
    logging.exception('Bot process exited')
    raise SystemExit(1)
finally:
    sys.stdout.finish()
    sys.stderr.finish()

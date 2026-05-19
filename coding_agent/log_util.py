import datetime
import sys
from pathlib import Path


class Logger:
    def __init__(self, prefix: str, log_file: str) -> None:
        self.prefix = prefix
        self.log_file = log_file
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)

    def log(self, message: str) -> None:
        timestamp = datetime.datetime.now().isoformat()
        line = f"[{timestamp}] [{self.prefix}] {message}"
        print(line, file=sys.stderr)
        with open(self.log_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")


logger: Logger | None = None


def setup_logger(prefix: str, log_file: str) -> Logger:
    global logger
    logger = Logger(prefix, log_file)
    return logger


def log(message: str) -> None:
    if logger is not None:
        logger.log(message)
    else:
        print(message, file=sys.stderr)

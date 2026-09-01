#!/usr/bin/env python3

from pathlib import Path
import subprocess


def main() -> None:
    script = Path(__file__).with_name("start")
    subprocess.run(["bash", str(script)], check=True)


if __name__ == "__main__":
    main()

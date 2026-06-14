"""Enable `python -m tithon ...` (a robust alternative to the `tithon` console
script when it isn't on PATH — e.g. inside a VSCode remote/tunnel extension host).
"""
from .cli import main

if __name__ == "__main__":
    main()

"""CLI errors shared without importing command implementations or dependencies."""


class CliError(RuntimeError):
    """User-facing command failure."""

    def __init__(self, message: str, *, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class CliUsageError(CliError):
    """Invalid command-line combination not expressible through argparse."""

    def __init__(self, message: str) -> None:
        super().__init__(message, exit_code=2)

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Resolve project root path
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.data import SessionValidationError
from app.service import PunchModelService


# Default data and artifact directories
DATA_DIR = ROOT_DIR / "data"
ARTIFACT_DIR = ROOT_DIR / "artifacts" / "current"


def build_service() -> PunchModelService:
    # Construct service with default paths
    return PunchModelService(data_dir=DATA_DIR, artifact_dir=ARTIFACT_DIR)


def main() -> int:
    # Parse CLI arguments and dispatch
    parser = argparse.ArgumentParser(description="PerfectPunch model CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Analyze a single uploaded ZIP
    analyse_parser = subparsers.add_parser("analyze", help="Analyse a single ZIP upload")
    analyse_parser.add_argument("--zip-path", required=True, help="Path to the uploaded ZIP file")
    analyse_parser.add_argument("--session-date", default=None, help="Optional session date override")

    # Info and train subcommands
    subparsers.add_parser("info", help="Read the current model information")
    subparsers.add_parser("train", help="Retrain the current model artefacts")

    args = parser.parse_args()
    service = build_service()

    # Route to the matching action
    if args.command == "analyze":
        payload = Path(args.zip_path).read_bytes()
        result = service.analyse_zip(payload, session_date_override=args.session_date)
    elif args.command == "info":
        result = service.model_info()
    else:
        result = service.train()

    # Emit JSON result on stdout
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SessionValidationError as exc:
        # Validation errors get exit code 2
        json.dump({"error": str(exc)}, sys.stdout)
        sys.stdout.write("\n")
        raise SystemExit(2) from exc
    except Exception as exc:  # pragma: no cover
        # Catch-all for unexpected errors
        json.dump({"error": str(exc)}, sys.stdout)
        sys.stdout.write("\n")
        raise SystemExit(1) from exc

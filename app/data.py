from __future__ import annotations

import csv
import io
import math
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np


SAMPLE_RATE_HZ = 100
SAMPLE_INTERVAL_SEC = 1.0 / SAMPLE_RATE_HZ
WINDOW_BEFORE_SEC = 0.25
WINDOW_AFTER_SEC = 0.45
WINDOW_SIZE = int(round((WINDOW_BEFORE_SEC + WINDOW_AFTER_SEC) * SAMPLE_RATE_HZ)) + 1
REFRACTORY_SEC = 0.6
MIN_EVENT_GAP_SEC = 0.35
LABEL_SUFFIX_RE = re.compile(r"\d+$")
RECORDING_TIME_FIELD = "recording time"

REQUIRED_FILES: dict[str, tuple[str, ...]] = {
    "Accelerometer.csv": ("seconds_elapsed", "x", "y", "z"),
    "Gyroscope.csv": ("seconds_elapsed", "x", "y", "z"),
    "Orientation.csv": ("seconds_elapsed", "yaw", "pitch", "roll"),
}


class SessionValidationError(ValueError):
    pass


@dataclass(slots=True)
class SessionData:
    source_name: str
    session_date: str | None
    time: np.ndarray
    channels: np.ndarray

    @property
    def duration_sec(self) -> float:
        if self.time.size == 0:
            return 0.0
        return float(self.time[-1] - self.time[0])


def derive_label_from_name(name: str) -> str:
    stem = name.split("-20", 1)[0]
    stem = LABEL_SUFFIX_RE.sub("", stem)
    normalized = stem.strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        raise SessionValidationError(f"Cannot derive label from session name: {name}")
    return normalized


def validate_session_dir(session_dir: Path) -> None:
    if not session_dir.exists() or not session_dir.is_dir():
        raise SessionValidationError(f"Session directory not found: {session_dir}")
    for filename, required_headers in REQUIRED_FILES.items():
        path = session_dir / filename
        if not path.exists():
            raise SessionValidationError(f"Missing required file: {filename}")
        with path.open(newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                raise SessionValidationError(f"Empty CSV file: {filename}")
            missing_headers = [header for header in required_headers if header not in reader.fieldnames]
            if missing_headers:
                raise SessionValidationError(
                    f"CSV file {filename} is missing headers: {', '.join(missing_headers)}"
                )


def _read_csv_columns(path: Path, columns: tuple[str, ...]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    values = {column: [] for column in columns}
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            for column in columns:
                values[column].append(float(row[column]))
    time = np.asarray(values.pop("seconds_elapsed"), dtype=np.float32)
    if time.size < WINDOW_SIZE:
        raise SessionValidationError(f"Not enough samples in {path.name}: {time.size}")
    arrays = {column: np.asarray(series, dtype=np.float32) for column, series in values.items()}
    return time, arrays


def _interp_column(grid: np.ndarray, time: np.ndarray, values: np.ndarray, *, unwrap: bool = False) -> np.ndarray:
    series = np.unwrap(values.astype(np.float64)) if unwrap else values.astype(np.float64)
    return np.interp(grid, time, series).astype(np.float32)


def _parse_metadata_recording_time(session_dir: Path) -> str | None:
    metadata_path = session_dir / "Metadata.csv"
    if not metadata_path.exists():
        return None
    with metadata_path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        first_row = next(reader, None)
    if not first_row:
        return None
    return first_row.get(RECORDING_TIME_FIELD) or None


def load_session(session_dir: Path, source_name: str | None = None) -> SessionData:
    validate_session_dir(session_dir)
    acc_time, acc_data = _read_csv_columns(session_dir / "Accelerometer.csv", REQUIRED_FILES["Accelerometer.csv"])
    gyr_time, gyr_data = _read_csv_columns(session_dir / "Gyroscope.csv", REQUIRED_FILES["Gyroscope.csv"])
    ori_time, ori_data = _read_csv_columns(session_dir / "Orientation.csv", REQUIRED_FILES["Orientation.csv"])

    start_sec = max(float(acc_time[0]), float(gyr_time[0]), float(ori_time[0]))
    end_sec = min(float(acc_time[-1]), float(gyr_time[-1]), float(ori_time[-1]))
    if end_sec - start_sec < WINDOW_BEFORE_SEC + WINDOW_AFTER_SEC + 1.0:
        raise SessionValidationError("Session is too short after sensor alignment.")

    sample_count = int(math.floor((end_sec - start_sec) * SAMPLE_RATE_HZ)) + 1
    grid = start_sec + np.arange(sample_count, dtype=np.float32) * SAMPLE_INTERVAL_SEC

    acc_x = _interp_column(grid, acc_time, acc_data["x"])
    acc_y = _interp_column(grid, acc_time, acc_data["y"])
    acc_z = _interp_column(grid, acc_time, acc_data["z"])
    gyr_x = _interp_column(grid, gyr_time, gyr_data["x"])
    gyr_y = _interp_column(grid, gyr_time, gyr_data["y"])
    gyr_z = _interp_column(grid, gyr_time, gyr_data["z"])
    yaw = _interp_column(grid, ori_time, ori_data["yaw"], unwrap=True)
    pitch = _interp_column(grid, ori_time, ori_data["pitch"], unwrap=True)
    roll = _interp_column(grid, ori_time, ori_data["roll"], unwrap=True)

    acc_mag = np.linalg.norm(np.column_stack((acc_x, acc_y, acc_z)), axis=1).astype(np.float32)
    gyr_mag = np.linalg.norm(np.column_stack((gyr_x, gyr_y, gyr_z)), axis=1).astype(np.float32)
    channels = np.column_stack(
        (acc_x, acc_y, acc_z, gyr_x, gyr_y, gyr_z, yaw, pitch, roll, acc_mag, gyr_mag)
    ).astype(np.float32)

    return SessionData(
        source_name=source_name or session_dir.name,
        session_date=_parse_metadata_recording_time(session_dir),
        time=grid,
        channels=channels,
    )


def load_training_sessions(data_dir: Path) -> list[tuple[str, SessionData]]:
    sessions: list[tuple[str, SessionData]] = []
    for session_dir in sorted(path for path in data_dir.iterdir() if path.is_dir()):
        label = derive_label_from_name(session_dir.name)
        sessions.append((label, load_session(session_dir)))
    if not sessions:
        raise SessionValidationError(f"No training sessions found under {data_dir}")
    return sessions


def _locate_session_root(base_dir: Path) -> Path:
    entries = [entry for entry in base_dir.iterdir() if not entry.name.startswith("__MACOSX")]
    if not entries:
        raise SessionValidationError("Uploaded ZIP is empty.")
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return base_dir


def extract_single_session_zip(payload: bytes, destination_dir: Path) -> Path:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for member in archive.infolist():
            member_path = Path(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise SessionValidationError("ZIP contains an unsafe path.")
        archive.extractall(destination_dir)
    session_root = _locate_session_root(destination_dir)
    validate_session_dir(session_root)
    return session_root


def load_session_from_zip_bytes(payload: bytes) -> SessionData:
    with TemporaryDirectory() as tmp_dir:
        session_root = extract_single_session_zip(payload, Path(tmp_dir))
        return load_session(session_root, source_name=session_root.name)

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np

from app.data import SessionValidationError, derive_label_from_name, load_session, validate_session_dir
from app.service import PunchModelService, TrainConfig


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"


def test_derive_label_from_name() -> None:
    assert derive_label_from_name("jab1-2026-04-14_09-16-53") == "jab"
    assert derive_label_from_name("right_hook2-2026-04-15_16-41-32") == "right_hook"


def test_validate_session_dir_rejects_missing_headers(tmp_path: Path) -> None:
    session_dir = tmp_path / "broken"
    session_dir.mkdir()
    for name in ("Accelerometer.csv", "Gyroscope.csv", "Orientation.csv"):
        with (session_dir / name).open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["seconds_elapsed", "x"])
            writer.writerow([0.0, 1.0])
    with (session_dir / "Orientation.csv").open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["seconds_elapsed", "yaw"])
        writer.writerow([0.0, 1.0])

    try:
        validate_session_dir(session_dir)
    except SessionValidationError as exc:
        assert "missing headers" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("validate_session_dir should reject missing headers")


def test_load_session_aligns_to_100hz_grid() -> None:
    session_dir = DATA_DIR / "jab1-2026-04-14_09-16-53"
    session = load_session(session_dir)

    assert session.channels.shape[1] == 11
    assert session.time.ndim == 1
    assert np.isclose(np.diff(session.time[:100]).mean(), 0.01, atol=1e-4)


def test_detect_event_indices_returns_sorted_peaks(tmp_path: Path) -> None:
    service = PunchModelService(DATA_DIR, tmp_path / "artifacts")
    session = load_session(DATA_DIR / "cross1-2026-04-14_09-58-23")

    peaks = service._detect_event_indices(session)

    assert peaks
    assert peaks == sorted(peaks)
    assert min(np.diff(peaks[:20])) >= 55


def test_artifacts_reload_after_training(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    service = PunchModelService(DATA_DIR, artifact_dir)
    config = TrainConfig(max_epochs=1, early_stopping_patience=1, max_folds=1, positive_cap_per_session=10, final_epoch_cap=1)
    info = service.train(config)

    assert info["trained"] is True

    reloaded = PunchModelService(DATA_DIR, artifact_dir)
    assert reloaded.model_info()["trained"] is True


def test_prediction_uses_top_punch_label_without_confidence_gate(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    service = PunchModelService(DATA_DIR, artifact_dir)
    config = TrainConfig(max_epochs=1, early_stopping_patience=1, max_folds=1, positive_cap_per_session=10, final_epoch_cap=1)
    service.train(config)
    assert service.bundle is not None

    session = load_session(DATA_DIR / "jab1-2026-04-14_09-16-53")
    probability = np.zeros(len(service.bundle.index_to_label), dtype=np.float32)
    probability[service.bundle.label_to_index["jab"]] = 0.7
    probability[service.bundle.label_to_index["cross"]] = 0.2
    result = service._prediction_from_probabilities(session, 200, probability)

    assert result["label"] == "jab"
    assert "status" not in result


def test_background_prediction_becomes_uncertain(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    service = PunchModelService(DATA_DIR, artifact_dir)
    config = TrainConfig(max_epochs=1, early_stopping_patience=1, max_folds=1, positive_cap_per_session=10, final_epoch_cap=1)
    service.train(config)
    assert service.bundle is not None

    session = load_session(DATA_DIR / "jab1-2026-04-14_09-16-53")
    probability = np.zeros(len(service.bundle.index_to_label), dtype=np.float32)
    probability[service.bundle.label_to_index["background"]] = 0.9
    probability[service.bundle.label_to_index["jab"]] = 0.1
    result = service._prediction_from_probabilities(session, 200, probability)

    assert result["label"] == "uncertain"
    assert "status" not in result

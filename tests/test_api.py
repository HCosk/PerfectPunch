from __future__ import annotations

import io
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.service import PunchModelService, TrainConfig


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"


def _build_session_zip(session_dir: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path in session_dir.iterdir():
            if path.is_file():
                archive.write(path, arcname=path.name)
    return buffer.getvalue()


def test_model_and_analyse_endpoints(monkeypatch, tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    service = PunchModelService(DATA_DIR, artifact_dir)
    tiny_config = TrainConfig(max_epochs=1, early_stopping_patience=1, max_folds=1, positive_cap_per_session=8, final_epoch_cap=1)
    service.train(tiny_config)

    monkeypatch.setattr(main, "service", service)

    client = TestClient(main.app)
    model_response = client.get("/api/model")
    assert model_response.status_code == 200
    assert model_response.json()["trained"] is True
    assert client.post("/api/train").status_code == 404

    session_dir = DATA_DIR / "jab1-2026-04-14_09-16-53"
    files = {"file": ("jab.zip", _build_session_zip(session_dir), "application/zip")}
    analyze_response = client.post("/api/analyse", files=files)

    assert analyze_response.status_code == 200
    payload = analyze_response.json()
    assert payload["session_date"] == "2026-04-14_09-16-53"
    assert payload["duration_sec"] > 1000
    assert isinstance(payload["events"], list)

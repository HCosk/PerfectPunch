from __future__ import annotations

import json
import math
import random
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import numpy as np
import torch
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score
from sklearn.model_selection import LeaveOneGroupOut
from torch import nn
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

from .data import (
    MIN_EVENT_GAP_SEC,
    REFRACTORY_SEC,
    SAMPLE_INTERVAL_SEC,
    WINDOW_AFTER_SEC,
    WINDOW_BEFORE_SEC,
    WINDOW_SIZE,
    SessionData,
    SessionValidationError,
    extract_single_session_zip,
    load_session,
    load_training_sessions,
)
from .modeling import ModelArtifacts, PunchCNN, get_best_device


# Sentinel label for non-punch windows
BACKGROUND_LABEL = "background"


@dataclass(slots=True)
class TrainConfig:
    # Hyperparameters for training runs
    max_epochs: int = 40
    batch_size: int = 128
    learning_rate: float = 1e-3
    early_stopping_patience: int = 8
    positive_cap_per_session: int | None = None
    background_ratio: float = 0.35
    max_folds: int | None = None
    seed: int = 42
    final_epoch_cap: int | None = None


@dataclass(slots=True)
class WindowSample:
    # One labelled training window
    window: np.ndarray
    label: str
    session_name: str
    time_sec: float


class WindowDataset(Dataset):
    # PyTorch dataset of fixed windows
    def __init__(
        self,
        windows: np.ndarray,
        labels: np.ndarray,
        *,
        augment: bool = False,
        seed: int = 42,
    ) -> None:
        self.windows = windows.astype(np.float32)
        self.labels = labels.astype(np.int64)
        self.augment = augment
        self.rng = np.random.default_rng(seed)

    def __len__(self) -> int:
        # Number of available samples
        return int(self.labels.shape[0])

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        # Fetch a single training pair
        window = self.windows[index]
        if self.augment:
            window = self._augment(window)
        # Transpose to channel-first layout
        features = torch.from_numpy(window.transpose(1, 0))
        target = torch.tensor(self.labels[index], dtype=torch.long)
        return features, target

    def _augment(self, window: np.ndarray) -> np.ndarray:
        # Light augmentation for robustness
        augmented = window.copy()
        # Random scaling factor
        scale = float(self.rng.uniform(0.95, 1.05))
        augmented *= scale
        # Random small time shift
        shift = int(self.rng.integers(-3, 4))
        if shift:
            augmented = np.roll(augmented, shift=shift, axis=0)
        # Add small Gaussian noise
        noise = self.rng.normal(0.0, 0.01, size=augmented.shape).astype(np.float32)
        augmented += noise
        return augmented


class PunchModelService:
    # Trains and serves the punch model
    def __init__(self, data_dir: Path, artifact_dir: Path) -> None:
        self.data_dir = data_dir
        self.artifact_dir = artifact_dir
        self.device = get_best_device()
        self.bundle: ModelArtifacts | None = None
        self.model: PunchCNN | None = None
        # Lazy-load any prior artefacts
        self._load_artifacts_if_present()

    def model_info(self) -> dict[str, Any]:
        # Public summary of model state
        if not self.bundle:
            return {
                "trained": False,
                "model_version": None,
                "device": str(self.device),
                "metrics": None,
                "labels": [],
            }
        return {
            "trained": True,
            "model_version": self.bundle.model_version,
            "device": str(self.device),
            "metrics": self.bundle.metrics,
            "labels": [self.bundle.index_to_label[index] for index in sorted(self.bundle.index_to_label)],
            "thresholds": self.bundle.thresholds,
        }

    def train(self, config: TrainConfig | None = None) -> dict[str, Any]:
        # Train new model artefacts end-to-end
        config = config or TrainConfig()
        # Seed all random sources
        random.seed(config.seed)
        np.random.seed(config.seed)
        torch.manual_seed(config.seed)

        # Load training data and build windows
        sessions = load_training_sessions(self.data_dir)
        samples = self._build_training_samples(sessions, config)
        if not samples:
            raise SessionValidationError("No training windows were extracted from the source data.")

        # Build label mapping with background first
        label_names = sorted({sample.label for sample in samples})
        if BACKGROUND_LABEL not in label_names:
            label_names = [BACKGROUND_LABEL, *label_names]
        else:
            label_names = [BACKGROUND_LABEL, *[label for label in label_names if label != BACKGROUND_LABEL]]
        label_to_index = {label: index for index, label in enumerate(label_names)}
        index_to_label = {index: label for label, index in label_to_index.items()}

        # Buffers for cross-validation results
        fold_predictions: list[int] = []
        fold_truths: list[int] = []
        background_probs: list[float] = []
        punch_probs: list[float] = []
        punch_margins: list[float] = []
        best_epochs: list[int] = []

        # Leave-one-session-out cross-validation
        groups = np.asarray([sample.session_name for sample in samples])
        logo = LeaveOneGroupOut()
        fold_count = 0
        unique_groups = list(dict.fromkeys(groups.tolist()))
        for train_indices, valid_indices in logo.split(np.zeros(len(samples)), groups=groups):
            if config.max_folds and fold_count >= config.max_folds:
                break
            fold_count += 1
            # Split samples for this fold
            train_samples = [samples[index] for index in train_indices]
            valid_samples = [samples[index] for index in valid_indices]
            fold_result = self._train_fold(train_samples, valid_samples, label_to_index, config, seed=config.seed + fold_count)
            best_epochs.append(fold_result["best_epoch"])
            predictions = fold_result["predictions"]
            truths = fold_result["truths"]
            probabilities = fold_result["probabilities"]
            fold_predictions.extend(predictions.tolist())
            fold_truths.extend(truths.tolist())
            # Collect probability stats for thresholds
            for truth, probability in zip(truths, probabilities, strict=True):
                sorted_probs = np.sort(probability)
                top_prob = float(sorted_probs[-1])
                margin = top_prob - float(sorted_probs[-2]) if probability.size > 1 else top_prob
                if truth == label_to_index[BACKGROUND_LABEL]:
                    background_probs.append(top_prob)
                else:
                    punch_probs.append(top_prob)
                    punch_margins.append(margin)

        # Aggregate cross-validation metrics
        truth_labels = [index_to_label[index] for index in fold_truths]
        predicted_labels = [index_to_label[index] for index in fold_predictions]
        macro_f1 = float(f1_score(truth_labels, predicted_labels, average="macro"))
        accuracy = float(accuracy_score(truth_labels, predicted_labels))
        # Restrict metrics to true punches
        punch_mask = [label != BACKGROUND_LABEL for label in truth_labels]
        punch_truths = [truth_labels[index] for index, keep in enumerate(punch_mask) if keep]
        punch_predictions = [predicted_labels[index] for index, keep in enumerate(punch_mask) if keep]
        punch_macro_f1 = float(f1_score(punch_truths, punch_predictions, average="macro"))
        punch_accuracy = float(accuracy_score(punch_truths, punch_predictions))
        matrix_labels = [label for label in label_names]
        matrix = confusion_matrix(truth_labels, predicted_labels, labels=matrix_labels).tolist()

        # Tune thresholds and refit on full data
        thresholds = self._derive_thresholds(background_probs, punch_probs, punch_margins)
        final_windows, final_targets, channel_mean, channel_std = self._prepare_numpy(samples, label_to_index, fit_stats=True)
        final_model = self._fit_model(
            final_windows,
            final_targets,
            label_count=len(label_to_index),
            device=self.device,
            config=config,
            seed=config.seed,
            validation_windows=None,
            validation_targets=None,
            expected_epochs=self._select_final_epoch_count(best_epochs, config),
        )

        # Persist artefacts to disk
        model_version = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
        metrics = {
            "folds": fold_count,
            "sessions": unique_groups,
            "window_count": len(samples),
            "class_counts": Counter(sample.label for sample in samples),
            "accuracy": accuracy,
            "macro_f1": macro_f1,
            "punch_accuracy": punch_accuracy,
            "punch_macro_f1": punch_macro_f1,
            "gate_passed": punch_accuracy >= 0.76 and punch_macro_f1 >= 0.78,
            "confusion_matrix_labels": matrix_labels,
            "confusion_matrix": matrix,
            "trained_at": datetime.now(UTC).isoformat(),
            "best_epoch_median": int(np.median(best_epochs)) if best_epochs else 1,
        }
        self._save_artifacts(
            model=final_model,
            label_to_index=label_to_index,
            channel_mean=channel_mean,
            channel_std=channel_std,
            thresholds=thresholds,
            metrics=metrics,
            model_version=model_version,
        )
        # Reload artefacts into service
        self._load_artifacts_if_present()
        return self.model_info()

    def analyse_zip(self, payload: bytes, session_date_override: str | None = None) -> dict[str, Any]:
        # Run inference over an uploaded session
        if not self.bundle or not self.model:
            raise SessionValidationError("The ready model artefact is missing.")
        # Extract and load session from ZIP
        with TemporaryDirectory() as tmp_dir:
            session_root = extract_single_session_zip(payload, Path(tmp_dir))
            session = load_session(session_root, source_name=session_root.name)
        session_date = session_date_override or session.session_date or datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        # Detect candidate event peaks
        event_indices = self._detect_event_indices(session)
        normalized_windows: list[np.ndarray] = []
        valid_centres: list[int] = []
        # Build classifier inputs around peaks
        for index in event_indices:
            window = self._extract_window(session.channels, index)
            if window is None:
                continue
            normalized_windows.append(self._normalize_window(window))
            valid_centres.append(index)

        # Batch inference for all candidates
        predictions: list[dict[str, Any]] = []
        if normalized_windows:
            batch = torch.from_numpy(np.asarray(normalized_windows, dtype=np.float32).transpose(0, 2, 1)).to(self.device)
            with torch.no_grad():
                logits = self.model(batch)
                probabilities = torch.softmax(logits, dim=1).cpu().numpy()
            for centre_index, probability in zip(valid_centres, probabilities, strict=True):
                predictions.append(self._prediction_from_probabilities(session, centre_index, probability))

        # Merge close duplicate predictions
        merged_events = self._merge_predictions(predictions)
        summary_counts = Counter(event["label"] for event in merged_events)
        return {
            "session_date": session_date,
            "duration_sec": round(session.duration_sec, 3),
            "model_version": self.bundle.model_version,
            "summary_counts": dict(summary_counts),
            "events": self._public_events(merged_events),
        }

    def analyze_zip(self, payload: bytes, session_date_override: str | None = None) -> dict[str, Any]:
        # American spelling alias
        return self.analyse_zip(payload, session_date_override=session_date_override)

    def _load_artifacts_if_present(self) -> None:
        # Restore previously trained artefacts if any
        model_path = self.artifact_dir / "model.pt"
        label_map_path = self.artifact_dir / "label_map.json"
        normalization_path = self.artifact_dir / "normalization.json"
        thresholds_path = self.artifact_dir / "thresholds.json"
        metrics_path = self.artifact_dir / "metrics.json"
        # Bail out if anything missing
        if not all(path.exists() for path in (model_path, label_map_path, normalization_path, thresholds_path, metrics_path)):
            self.bundle = None
            self.model = None
            return
        # Read all artefact files
        label_to_index = json.loads(label_map_path.read_text())
        normalization = json.loads(normalization_path.read_text())
        thresholds = json.loads(thresholds_path.read_text())
        metrics = json.loads(metrics_path.read_text())
        checkpoint = torch.load(model_path, map_location="cpu")
        index_to_label = {int(index): label for label, index in label_to_index.items()}
        # Build model and load weights
        model = PunchCNN(input_channels=len(normalization["mean"]), class_count=len(label_to_index))
        model.load_state_dict(checkpoint["model_state"])
        model.to(self.device)
        model.eval()
        # Cache bundle and model handles
        self.bundle = ModelArtifacts(
            model_state=checkpoint["model_state"],
            label_to_index={label: int(index) for label, index in label_to_index.items()},
            index_to_label=index_to_label,
            channel_mean=[float(value) for value in normalization["mean"]],
            channel_std=[float(value) for value in normalization["std"]],
            thresholds={key: float(value) for key, value in thresholds.items()},
            metrics=metrics,
            model_version=str(checkpoint["model_version"]),
        )
        self.model = model

    def _save_artifacts(
        self,
        *,
        model: PunchCNN,
        label_to_index: dict[str, int],
        channel_mean: np.ndarray,
        channel_std: np.ndarray,
        thresholds: dict[str, float],
        metrics: dict[str, Any],
        model_version: str,
    ) -> None:
        # Persist model and JSON sidecars
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        torch.save({"model_state": model.state_dict(), "model_version": model_version}, self.artifact_dir / "model.pt")
        (self.artifact_dir / "label_map.json").write_text(json.dumps(label_to_index, indent=2, sort_keys=True))
        (self.artifact_dir / "normalization.json").write_text(
            json.dumps({"mean": channel_mean.tolist(), "std": channel_std.tolist()}, indent=2)
        )
        (self.artifact_dir / "thresholds.json").write_text(json.dumps(thresholds, indent=2, sort_keys=True))
        (self.artifact_dir / "metrics.json").write_text(json.dumps(metrics, indent=2, sort_keys=True))

    def _build_training_samples(
        self,
        sessions: list[tuple[str, SessionData]],
        config: TrainConfig,
    ) -> list[WindowSample]:
        # Build positive and background windows
        rng = random.Random(config.seed)
        samples: list[WindowSample] = []
        for label, session in sessions:
            # Detect punch events in session
            event_indices = self._detect_event_indices(session)
            if config.positive_cap_per_session is not None and len(event_indices) > config.positive_cap_per_session:
                event_indices = sorted(rng.sample(event_indices, config.positive_cap_per_session))
            positive_times: list[float] = []
            # Add a window per detected punch
            for index in event_indices:
                window = self._extract_window(session.channels, index)
                if window is None:
                    continue
                positive_times.append(float(session.time[index]))
                samples.append(
                    WindowSample(window=window, label=label, session_name=session.source_name, time_sec=float(session.time[index]))
                )
            # Sample background windows for balance
            background_count = max(1, int(len(positive_times) * config.background_ratio))
            for index in self._sample_background_indices(session, event_indices, background_count, rng):
                window = self._extract_window(session.channels, index)
                if window is None:
                    continue
                samples.append(
                    WindowSample(
                        window=window,
                        label=BACKGROUND_LABEL,
                        session_name=session.source_name,
                        time_sec=float(session.time[index]),
                    )
                )
        return samples

    def _detect_event_indices(self, session: SessionData) -> list[int]:
        # Energy-based punch peak detection
        channels = session.channels
        acc_mag = channels[:, 9]
        gyro_mag = channels[:, 10]
        jerk = np.abs(np.gradient(acc_mag, SAMPLE_INTERVAL_SEC)).astype(np.float32)

        # Robust z-score per signal
        acc_score = self._robust_zscore(acc_mag)
        gyro_score = self._robust_zscore(gyro_mag)
        jerk_score = self._robust_zscore(jerk)
        # Weighted energy and smoothing
        energy = 0.45 * acc_score + 0.30 * jerk_score + 0.25 * gyro_score
        smooth_energy = np.convolve(energy, np.ones(5, dtype=np.float32) / 5.0, mode="same")

        # Adaptive threshold from spread
        baseline = float(np.median(smooth_energy))
        spread = float(np.median(np.abs(smooth_energy - baseline))) or 1.0
        threshold = baseline + 2.3 * spread
        refractory_steps = int(round(REFRACTORY_SEC / SAMPLE_INTERVAL_SEC))

        # Pick peaks with refractory window
        peaks: list[int] = []
        last_peak = -refractory_steps
        for index in range(1, len(smooth_energy) - 1):
            if smooth_energy[index] < threshold:
                continue
            # Local maximum check
            if smooth_energy[index] < smooth_energy[index - 1] or smooth_energy[index] < smooth_energy[index + 1]:
                continue
            # Enforce minimum gap between peaks
            if index - last_peak < refractory_steps:
                if smooth_energy[index] > smooth_energy[last_peak]:
                    peaks[-1] = index
                    last_peak = index
                continue
            peaks.append(index)
            last_peak = index
        return peaks

    def _sample_background_indices(
        self,
        session: SessionData,
        peak_indices: list[int],
        count: int,
        rng: random.Random,
    ) -> list[int]:
        # Pick low-energy non-peak frames
        if count <= 0:
            return []
        acc_mag = session.channels[:, 9]
        gyro_mag = session.channels[:, 10]
        jerk = np.abs(np.gradient(acc_mag, SAMPLE_INTERVAL_SEC)).astype(np.float32)
        energy = 0.45 * self._robust_zscore(acc_mag) + 0.30 * self._robust_zscore(jerk) + 0.25 * self._robust_zscore(gyro_mag)
        # Below-median energy cutoff
        low_energy_cutoff = float(np.percentile(energy, 45))
        exclusion_radius = int(round(0.9 / SAMPLE_INTERVAL_SEC))
        start_index = int(round(WINDOW_BEFORE_SEC / SAMPLE_INTERVAL_SEC))
        end_index = len(energy) - int(round(WINDOW_AFTER_SEC / SAMPLE_INTERVAL_SEC)) - 1

        # Mask out regions near peaks
        mask = np.ones(len(energy), dtype=bool)
        for peak_index in peak_indices:
            left = max(0, peak_index - exclusion_radius)
            right = min(len(mask), peak_index + exclusion_radius)
            mask[left:right] = False
        candidates = [index for index in range(start_index, end_index) if mask[index] and energy[index] <= low_energy_cutoff]
        if not candidates:
            return []
        if len(candidates) <= count:
            return sorted(candidates)
        # Random subsample from candidates
        return sorted(rng.sample(candidates, count))

    def _extract_window(self, channels: np.ndarray, centre_index: int) -> np.ndarray | None:
        # Slice fixed window around centre
        before_steps = int(round(WINDOW_BEFORE_SEC / SAMPLE_INTERVAL_SEC))
        after_steps = int(round(WINDOW_AFTER_SEC / SAMPLE_INTERVAL_SEC))
        start = centre_index - before_steps
        end = centre_index + after_steps + 1
        if start < 0 or end > len(channels):
            return None
        window = channels[start:end]
        if window.shape[0] != WINDOW_SIZE:
            return None
        # Subtract initial frame for stability
        relative = window.astype(np.float32).copy()
        relative -= relative[0:1]
        return relative

    def _prepare_numpy(
        self,
        samples: list[WindowSample],
        label_to_index: dict[str, int],
        *,
        fit_stats: bool,
        mean: np.ndarray | None = None,
        std: np.ndarray | None = None,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        # Stack samples and apply normalization
        windows = np.stack([sample.window for sample in samples], axis=0).astype(np.float32)
        targets = np.asarray([label_to_index[sample.label] for sample in samples], dtype=np.int64)
        if fit_stats:
            # Compute new normalization stats
            mean = windows.mean(axis=(0, 1))
            std = windows.std(axis=(0, 1))
            std = np.where(std < 1e-6, 1.0, std)
        assert mean is not None
        assert std is not None
        normalized = (windows - mean.reshape(1, 1, -1)) / std.reshape(1, 1, -1)
        return normalized, targets, mean.astype(np.float32), std.astype(np.float32)

    def _train_fold(
        self,
        train_samples: list[WindowSample],
        valid_samples: list[WindowSample],
        label_to_index: dict[str, int],
        config: TrainConfig,
        *,
        seed: int,
    ) -> dict[str, Any]:
        # Train and score one CV fold
        train_windows, train_targets, mean, std = self._prepare_numpy(train_samples, label_to_index, fit_stats=True)
        valid_windows, valid_targets, _, _ = self._prepare_numpy(
            valid_samples, label_to_index, fit_stats=False, mean=mean, std=std
        )
        model = self._fit_model(
            train_windows,
            train_targets,
            label_count=len(label_to_index),
            device=self.device,
            config=config,
            seed=seed,
            validation_windows=valid_windows,
            validation_targets=valid_targets,
            expected_epochs=None,
        )
        # Score the held-out validation set
        model.eval()
        valid_dataset = WindowDataset(valid_windows, valid_targets, augment=False, seed=seed)
        valid_loader = DataLoader(valid_dataset, batch_size=config.batch_size, shuffle=False)
        probabilities: list[np.ndarray] = []
        predictions: list[int] = []
        truths: list[int] = []
        with torch.no_grad():
            for features, targets in valid_loader:
                features = features.to(self.device)
                logits = model(features)
                batch_probabilities = torch.softmax(logits, dim=1).cpu().numpy()
                probabilities.extend(batch_probabilities)
                predictions.extend(batch_probabilities.argmax(axis=1).tolist())
                truths.extend(targets.numpy().tolist())
        return {
            "predictions": np.asarray(predictions, dtype=np.int64),
            "truths": np.asarray(truths, dtype=np.int64),
            "probabilities": np.asarray(probabilities, dtype=np.float32),
            "best_epoch": int(getattr(model, "_best_epoch", 1)),
        }

    def _fit_model(
        self,
        train_windows: np.ndarray,
        train_targets: np.ndarray,
        *,
        label_count: int,
        device: torch.device,
        config: TrainConfig,
        seed: int,
        validation_windows: np.ndarray | None,
        validation_targets: np.ndarray | None,
        expected_epochs: int | None,
    ) -> PunchCNN:
        # Train CNN with class-balanced sampling
        torch.manual_seed(seed)
        model = PunchCNN(input_channels=train_windows.shape[2], class_count=label_count).to(device)
        # Class weights from inverse frequency
        class_counts = np.bincount(train_targets, minlength=label_count).astype(np.float32)
        class_weights = class_counts.sum() / np.maximum(class_counts, 1.0)
        train_dataset = WindowDataset(train_windows, train_targets, augment=True, seed=seed)
        # Weighted sampler oversamples minority classes
        sample_weights = class_weights[train_targets]
        sampler = WeightedRandomSampler(
            weights=torch.as_tensor(sample_weights, dtype=torch.double),
            num_samples=len(train_targets),
            replacement=True,
        )
        train_loader = DataLoader(train_dataset, batch_size=config.batch_size, sampler=sampler)
        # Loss and optimiser setup
        weight_tensor = torch.tensor(class_weights, dtype=torch.float32, device=device)
        criterion = nn.CrossEntropyLoss(weight=weight_tensor)
        optimizer = torch.optim.AdamW(model.parameters(), lr=config.learning_rate)

        # Best-state tracking for early stopping
        best_state: dict[str, torch.Tensor] | None = None
        best_metric = -float("inf")
        epochs_without_improvement = 0
        epoch_limit = expected_epochs or config.max_epochs

        # Optional validation loader
        if validation_windows is not None and validation_targets is not None:
            valid_dataset = WindowDataset(validation_windows, validation_targets, augment=False, seed=seed)
            valid_loader = DataLoader(valid_dataset, batch_size=config.batch_size, shuffle=False)
        else:
            valid_loader = None

        # Epoch loop with early stopping
        for epoch in range(1, epoch_limit + 1):
            model.train()
            for features, targets in train_loader:
                features = features.to(device)
                targets = targets.to(device)
                optimizer.zero_grad(set_to_none=True)
                logits = model(features)
                loss = criterion(logits, targets)
                loss.backward()
                optimizer.step()

            # Without validation, keep latest weights
            if valid_loader is None:
                best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
                best_metric = float(epoch)
                setattr(model, "_best_epoch", epoch)
                continue

            # Track best validation score
            metric = self._evaluate_loader(model, valid_loader, device)
            if metric > best_metric:
                best_metric = metric
                best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
                epochs_without_improvement = 0
                setattr(model, "_best_epoch", epoch)
            else:
                epochs_without_improvement += 1
                if epochs_without_improvement >= config.early_stopping_patience:
                    break

        # Restore best checkpoint weights
        assert best_state is not None
        model.load_state_dict(best_state)
        model.to(device)
        return model

    def _evaluate_loader(self, model: PunchCNN, loader: DataLoader, device: torch.device) -> float:
        # Compute macro F1 on a loader
        model.eval()
        probabilities: list[np.ndarray] = []
        truths: list[int] = []
        with torch.no_grad():
            for features, targets in loader:
                logits = model(features.to(device))
                batch_probabilities = torch.softmax(logits, dim=1).cpu().numpy()
                probabilities.extend(batch_probabilities)
                truths.extend(targets.numpy().tolist())
        predictions = np.argmax(np.asarray(probabilities), axis=1)
        return float(f1_score(truths, predictions, average="macro"))

    def _normalize_window(self, window: np.ndarray) -> np.ndarray:
        # Apply stored mean and std
        assert self.bundle is not None
        mean = np.asarray(self.bundle.channel_mean, dtype=np.float32)
        std = np.asarray(self.bundle.channel_std, dtype=np.float32)
        return ((window - mean.reshape(1, -1)) / std.reshape(1, -1)).astype(np.float32)

    def _prediction_from_probabilities(
        self,
        session: SessionData,
        centre_index: int,
        probability: np.ndarray,
    ) -> dict[str, Any]:
        # Build event dict from probabilities
        assert self.bundle is not None
        sorted_indices = np.argsort(probability)
        top_index = int(sorted_indices[-1])
        top_prob = float(probability[top_index])
        predicted_label = self.bundle.index_to_label[top_index]
        return {
            "time_sec": round(float(session.time[centre_index]), 3),
            # Background maps to uncertain output
            "label": "uncertain" if predicted_label == BACKGROUND_LABEL else predicted_label,
            "confidence": round(top_prob, 4),
        }

    def _public_events(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Strip non-public fields
        return [
            {
                "time_sec": event["time_sec"],
                "label": event["label"],
            }
            for event in events
        ]

    def _merge_predictions(self, predictions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Collapse duplicates within the gap
        if not predictions:
            return []
        merged: list[dict[str, Any]] = [predictions[0]]
        for prediction in predictions[1:]:
            last = merged[-1]
            # Same label very close together
            if prediction["time_sec"] - last["time_sec"] <= MIN_EVENT_GAP_SEC and prediction["label"] == last["label"]:
                if prediction["confidence"] > last["confidence"]:
                    merged[-1] = prediction
                continue
            # One side uncertain near another
            if prediction["time_sec"] - last["time_sec"] <= MIN_EVENT_GAP_SEC and "uncertain" in {prediction["label"], last["label"]}:
                if prediction["confidence"] > last["confidence"]:
                    merged[-1] = prediction
                continue
            merged.append(prediction)
        return merged

    def _derive_thresholds(
        self,
        background_probs: list[float],
        punch_probs: list[float],
        punch_margins: list[float],
    ) -> dict[str, float]:
        # Pick confidence and margin gates
        min_confidence = 0.55
        if background_probs and punch_probs:
            # Midpoint between distributions
            min_confidence = float(
                np.clip((np.percentile(background_probs, 90) + np.percentile(punch_probs, 15)) / 2.0, 0.45, 0.85)
            )
        min_margin = 0.08
        if punch_margins:
            # Conservative low percentile of margins
            min_margin = float(np.clip(np.percentile(punch_margins, 10), 0.05, 0.25))
        return {"min_confidence": round(min_confidence, 4), "min_margin": round(min_margin, 4)}

    def _select_final_epoch_count(self, best_epochs: list[int], config: TrainConfig) -> int:
        # Choose epochs for final model
        if config.final_epoch_cap:
            return config.final_epoch_cap
        if not best_epochs:
            return min(config.max_epochs, 12)
        # Median of fold best-epochs
        return int(max(4, min(config.max_epochs, round(float(np.median(best_epochs))))))

    @staticmethod
    def _robust_zscore(values: np.ndarray) -> np.ndarray:
        # Outlier-resistant standardisation
        median = np.median(values)
        mad = np.median(np.abs(values - median))
        # Fallback to std when MAD tiny
        scale = 1.4826 * mad if mad > 1e-6 else float(np.std(values) or 1.0)
        return ((values - median) / scale).astype(np.float32)

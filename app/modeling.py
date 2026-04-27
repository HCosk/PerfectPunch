from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn


def get_best_device() -> torch.device:
    # Prefer Apple MPS over CPU
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class PunchCNN(nn.Module):
    # 1D CNN punch classifier
    def __init__(self, input_channels: int, class_count: int) -> None:
        super().__init__()
        # Three conv blocks for feature extraction
        self.encoder = nn.Sequential(
            nn.Conv1d(input_channels, 32, kernel_size=5, padding=2),
            nn.BatchNorm1d(32),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.MaxPool1d(2),
            nn.Conv1d(32, 64, kernel_size=5, padding=2),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.MaxPool1d(2),
            nn.Conv1d(64, 128, kernel_size=3, padding=1),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.Dropout(0.2),
        )
        # Pool and project to logits
        self.head = nn.Sequential(
            nn.AdaptiveAvgPool1d(1),
            nn.Flatten(),
            nn.Linear(128, class_count),
        )

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        # Encode then classify
        encoded = self.encoder(inputs)
        return self.head(encoded)


@dataclass(slots=True)
class ModelArtifacts:
    # Bundle of trained model artefacts
    model_state: dict
    label_to_index: dict[str, int]
    index_to_label: dict[int, str]
    channel_mean: list[float]
    channel_std: list[float]
    thresholds: dict[str, float]
    metrics: dict
    model_version: str

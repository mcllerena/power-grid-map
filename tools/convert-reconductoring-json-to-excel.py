#!/usr/bin/env python3
"""Convert US reconductoring projects JSON into an Excel workbook."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT_DIR / "reference" / "us_reconductoring_projects.json"
DEFAULT_OUTPUT = ROOT_DIR / "reference" / "us_reconductoring_projects.xlsx"
DEFAULT_GENERATED_DIR = ROOT_DIR / "webmap" / "data" / "reconductoring-us"

PREFERRED_COLUMNS = [
    "Project Name",
    "SUB_1",
    "SUB_2",
    "Utility",
    "Project Type",
    "Voltage (kV)",
    "Distance (mi)",
    "Rating",
    "Cost ($ M)",
    "Status",
    "Planned Year",
    "Description",
]

SHEET_NAME_BY_ISO = {
    "caiso": "CAISO",
    "iso-ne": "ISO-NE",
    "miso": "MISO",
    "nyiso": "NYISO",
    "pjm": "PJM",
    "spp": "SPP",
    "ercot": "ERCOT",
    "westconnect": "WestConnect",
    "northerngrid": "NorthernGrid",
    "sertp": "SERTP",
    "frcc": "FRCC",
}

ISO_WRITE_ORDER = [
    "caiso",
    "iso-ne",
    "miso",
    "nyiso",
    "pjm",
    "spp",
    "ercot",
    "westconnect",
    "northerngrid",
    "sertp",
    "frcc",
]


def normalize_cell(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def collect_columns(rows: list[dict[str, Any]]) -> list[str]:
    seen = set()
    columns = []
    for column in PREFERRED_COLUMNS:
        if any(column in row for row in rows):
            columns.append(column)
            seen.add(column)
    for row in rows:
        for key in row:
            column = str(key).strip()
            if column and column not in seen:
                columns.append(column)
                seen.add(column)
    return columns


def build_dataframe(rows: list[dict[str, Any]]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    columns = collect_columns(rows)
    normalized_rows = [
        {column: normalize_cell(row.get(column, "")) for column in columns}
        for row in rows
    ]
    return pd.DataFrame(normalized_rows, columns=columns)


def load_generated_rows(generated_dir: Path, iso_key: str) -> list[dict[str, Any]]:
    generated_path = generated_dir / f"{iso_key}.json"
    if not generated_path.exists():
        return []

    payload = json.loads(generated_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return []

    features = [
        *(payload.get("existingFeatures") or []),
        *(payload.get("newLineFeatures") or []),
    ]
    rows = []
    seen_pairs = set()
    for feature in features:
        properties = feature.get("properties", {}) if isinstance(feature, dict) else {}
        sub_1 = normalize_cell(properties.get("SUB_1"))
        sub_2 = normalize_cell(properties.get("SUB_2"))
        if not sub_1 or not sub_2:
            continue
        pair_key = tuple(sorted((sub_1.upper(), sub_2.upper())))
        if pair_key in seen_pairs:
            continue
        seen_pairs.add(pair_key)
        rows.append(
            {
                "Project Name": f"{sub_1} - {sub_2} reconductoring",
                "SUB_1": sub_1,
                "SUB_2": sub_2,
                "ISO/RTO": properties.get("iso_region", iso_key),
                "Project Type": properties.get("project_type", "Existing reconductoring"),
                "Voltage (kV)": properties.get("reconductoring_voltage", ""),
            }
        )
    return rows


def sanitize_sheet_name(name: str, used: set[str]) -> str:
    cleaned = re.sub(r"[\\/*?:\[\]]", "_", name).strip() or "Sheet"
    cleaned = cleaned[:31]
    if cleaned not in used:
        used.add(cleaned)
        return cleaned
    suffix = 2
    while True:
        candidate = f"{cleaned[:28]}_{suffix}"
        if candidate not in used:
            used.add(candidate)
            return candidate
        suffix += 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert reconductoring JSON to XLSX sheets by ISO.")
    parser.add_argument("--input", dest="input_path", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", dest="output_path", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--generated-dir",
        dest="generated_dir",
        type=Path,
        default=DEFAULT_GENERATED_DIR,
        help="Generated map data directory used for empty ISO sheets.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.input_path.exists():
        raise FileNotFoundError(f"Input file not found: {args.input_path}")

    payload = json.loads(args.input_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Expected top-level JSON object mapping ISO keys to project arrays")

    args.output_path.parent.mkdir(parents=True, exist_ok=True)
    write_keys = [key for key in ISO_WRITE_ORDER if key in payload]
    write_keys.extend(key for key in payload if key not in write_keys)
    used_sheet_names: set[str] = set()
    sheets_written = 0

    with pd.ExcelWriter(args.output_path, engine="openpyxl") as writer:
        for iso_key in write_keys:
            rows = payload.get(iso_key)
            if not isinstance(rows, list):
                continue
            dict_rows = [row for row in rows if isinstance(row, dict)]
            if not dict_rows:
                dict_rows = load_generated_rows(args.generated_dir, iso_key)
            sheet_name = sanitize_sheet_name(
                SHEET_NAME_BY_ISO.get(iso_key, str(iso_key).strip() or "Unknown"),
                used_sheet_names,
            )
            build_dataframe(dict_rows).to_excel(writer, sheet_name=sheet_name, index=False)
            sheets_written += 1
            print(f"{sheet_name}: {len(dict_rows)} row(s)")

        if sheets_written == 0:
            pd.DataFrame([{"Message": "No ISO project rows found in input JSON."}]).to_excel(
                writer, sheet_name="Reconductoring", index=False
            )
            sheets_written = 1

    print(f"Wrote {args.output_path} with {sheets_written} sheet(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

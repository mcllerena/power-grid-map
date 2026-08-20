"""Merge CAISO PTO approved-project sheets into the CAISO map inventory."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path("/Users/mvelasqu/Downloads/approved-projects-transmission-planning-process-jan-2025.xlsx")
DESTINATION = ROOT / "reference" / "us_reconductoring_projects.xlsx"
ENDPOINT_MAPPINGS = ROOT / "reference" / "caiso-inferred-endpoints.json"

BASE_COLUMNS = [
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
    "ISO/RTO",
    "Transmission Plan Approved",
    "In-Service Year at Plan Approval",
    "Expected In-Service 2020-2021 Plan",
    "Expected In-Service Oct 2023 TDF",
    "Expected In-Service Jan 2024 TDF",
    "Expected In-Service July 2024 TDF",
    "Expected In-Service Jan 2025 TDF",
    "Expected CPUC Filing",
    "Expected Construction Start",
    "Found On DB",
]

SOURCE_COLUMN_MAP = {
    "Transmission Plan Approved": "Transmission Plan Approved",
    "In-service Year at Approval in Transmission Plan": "In-Service Year at Plan Approval",
    "In-service Date at Approval in Transmission Plan": "In-Service Year at Plan Approval",
    "Expected In-Service Date\n2020-2021 Transmission Plan": "Expected In-Service 2020-2021 Plan",
    "Expected In-Service Year (2020-2021 Transmission Plan)": "Expected In-Service 2020-2021 Plan",
    "Expected In-Service\nOct 2023 TDF": "Expected In-Service Oct 2023 TDF",
    "Expected In-Service Oct 2023 TDF": "Expected In-Service Oct 2023 TDF",
    "Expected In-Service Jan 2024 TDF": "Expected In-Service Jan 2024 TDF",
    "Expected In-Service July 2024 TDF": "Expected In-Service July 2024 TDF",
    "Expected In-Service Jan 2025 TDF": "Expected In-Service Jan 2025 TDF",
    "Expected CPUC Filing": "Expected CPUC Filing",
    "Expected CPUC Permit Application Filing": "Expected CPUC Filing",
    "Expected Const start": "Expected Construction Start",
    "Expected Construction Start": "Expected Construction Start",
}

def clean_header(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\n", " ").strip())


NORMALIZED_SOURCE_COLUMN_MAP = {
    clean_header(source_name): destination_name
    for source_name, destination_name in SOURCE_COLUMN_MAP.items()
}


def clean_value(value: Any) -> Any:
    if pd.isna(value):
        return ""
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return str(value).strip()


def normalize_project_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def load_endpoint_mappings() -> dict[str, dict[str, str]]:
    if not ENDPOINT_MAPPINGS.exists():
        return {}
    import json

    payload = json.loads(ENDPOINT_MAPPINGS.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def classify_project(project: str) -> str:
    text = project.lower()
    if re.search(r"reconduct|rebuild|rerate|re-rate", text):
        return "Line Reconductoring / Rebuild"
    if re.search(r"line|circuit|transmission", text):
        return "Transmission Line Upgrade"
    if re.search(r"transformer", text):
        return "Transformer Upgrade"
    if re.search(r"substation|switchrack|bus |breaker|reactor|capacitor", text):
        return "Substation / Equipment Upgrade"
    if re.search(r"upgrade|reinforcement|reconfiguration|method of service", text):
        return "Transmission Upgrade"
    return "Transmission Planning Project"


def is_non_reconductoring_equipment_project(project_type: Any) -> bool:
    return bool(
        re.search(
            r"transformer|substation|equipment|transmission planning project",
            str(project_type or ""),
            flags=re.IGNORECASE,
        )
    )


def choose_planned_year(row: dict[str, Any]) -> Any:
    candidates = [
        row.get("Expected In-Service Jan 2025 TDF"),
        row.get("Expected In-Service July 2024 TDF"),
        row.get("Expected In-Service Oct 2023 TDF"),
        row.get("Expected In-Service 2020-2021 Plan"),
        row.get("In-Service Year at Plan Approval"),
    ]
    for value in candidates:
        match = re.search(r"(?:19|20)\d{2}", str(value or ""))
        if match:
            return int(match.group(0))
    return ""


def standardize_source_row(record: dict[str, Any], sheet: str, row_number: int) -> dict[str, Any]:
    cleaned = {clean_header(key): clean_value(value) for key, value in record.items()}
    project = str(cleaned.get("Project", "")).strip()
    standardized = {column: "" for column in BASE_COLUMNS}
    standardized.update(
        {
            "Project Name": project,
            "Utility": cleaned.get("PTO", ""),
            "Project Type": classify_project(project),
            "Status": cleaned.get("Project Status", ""),
            "Planned Year": choose_planned_year(standardized),
            "Description": cleaned.get("Notes", ""),
            "ISO/RTO": "CAISO",
            "Found On DB": False,
            "Source Owner Sheet": sheet,
            "Source Row": row_number,
            "Source Project": project,
        }
    )
    for source_column, value in cleaned.items():
        if source_column in {"Project", "PTO"}:
            continue
        standardized[f"Source - {source_column}"] = value
    for source_name, value in cleaned.items():
        destination_name = NORMALIZED_SOURCE_COLUMN_MAP.get(source_name)
        if destination_name and value:
            standardized[destination_name] = value
    standardized["Planned Year"] = choose_planned_year(standardized)
    return standardized


def main() -> None:
    if not SOURCE.exists():
        raise FileNotFoundError(SOURCE)
    current = pd.ExcelFile(DESTINATION)
    existing_frames = {sheet: pd.read_excel(DESTINATION, sheet_name=sheet).fillna("") for sheet in current.sheet_names}
    caiso = existing_frames.get("CAISO", pd.DataFrame(columns=BASE_COLUMNS))

    source_book = pd.ExcelFile(SOURCE)
    endpoint_mappings = load_endpoint_mappings()
    additions = []
    for sheet in source_book.sheet_names:
        frame = pd.read_excel(SOURCE, sheet_name=sheet).fillna("")
        for index, record in frame.iterrows():
            project = clean_value(record.get("Project", ""))
            if not project:
                continue
            standardized = standardize_source_row(record.to_dict(), sheet, int(index) + 2)
            endpoint = endpoint_mappings.get(normalize_project_name(project))
            if endpoint and endpoint.get("SUB_1") and endpoint.get("SUB_2"):
                standardized["SUB_1"] = endpoint["SUB_1"]
                standardized["SUB_2"] = endpoint["SUB_2"]
                standardized["Found On DB"] = True
            if not is_non_reconductoring_equipment_project(standardized["Project Type"]):
                additions.append(standardized)

    before_filter_count = len(caiso)
    caiso = caiso[
        ~caiso["Project Type"].map(is_non_reconductoring_equipment_project)
    ].copy()
    imported_mask = caiso.get("Source Owner Sheet", "").astype(str).str.strip().ne("")
    caiso.loc[imported_mask, ["SUB_1", "SUB_2"]] = ""
    caiso.loc[imported_mask, "Found On DB"] = False
    mapped_by_project = {
        normalize_project_name(row["Project Name"]): row
        for row in additions
        if row.get("SUB_1") and row.get("SUB_2")
    }
    for index, row in caiso.loc[imported_mask].iterrows():
        mapped = mapped_by_project.get(normalize_project_name(row.get("Project Name", "")))
        if mapped:
            caiso.loc[index, "SUB_1"] = mapped["SUB_1"]
            caiso.loc[index, "SUB_2"] = mapped["SUB_2"]
            caiso.loc[index, "Found On DB"] = True
    existing_names = {normalize_project_name(value) for value in caiso.get("Project Name", []) if str(value).strip()}
    unique_additions = []
    for row in additions:
        key = normalize_project_name(row["Project Name"])
        if key in existing_names:
            continue
        existing_names.add(key)
        unique_additions.append(row)

    all_source_columns = sorted(
        {
            column
            for row in additions
            for column in row
            if column.startswith("Source - ")
        }
    )
    all_columns = list(caiso.columns)
    for column in BASE_COLUMNS + ["Source Owner Sheet", "Source Row", "Source Project"]:
        if column not in all_columns:
            all_columns.append(column)
    for column in all_source_columns:
        if column not in all_columns:
            all_columns.append(column)
    merged = pd.concat([caiso, pd.DataFrame(unique_additions)], ignore_index=True).reindex(columns=all_columns).fillna("")

    with pd.ExcelWriter(DESTINATION, engine="openpyxl") as writer:
        for sheet, frame in existing_frames.items():
            if sheet == "CAISO":
                merged.to_excel(writer, sheet_name=sheet, index=False)
            else:
                frame.to_excel(writer, sheet_name=sheet, index=False)

    print(f"Existing CAISO rows before equipment filter: {before_filter_count}")
    print(f"Existing CAISO rows after equipment filter: {len(caiso)}")
    print(f"Source project rows: {len(additions)}")
    print(f"New CAISO rows added: {len(unique_additions)}")
    print(f"Final CAISO rows: {len(merged)}")
    print("Added by owner sheet:")
    print(pd.Series([row["Source Owner Sheet"] for row in unique_additions]).value_counts().sort_index().to_string())


if __name__ == "__main__":
    main()
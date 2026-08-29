"""Import SPP transmission expansion projects from the 2024 and 2026 appendices."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "geoinfo" / "us-data" / "recond_gets_files_by_iso" / "SPP"
DESTINATION = ROOT / "reference" / "us_reconductoring_projects.xlsx"
SOURCE_FILES = (
    SOURCE_DIR / "2024 spp transmission expansion plan project list.xlsx",
    SOURCE_DIR / "2026 SPP Transmission Expansion Plan Report Appendix 1.xlsx",
)

PROJECT_TERMS = re.compile(
    r"\b(?:line|rebuild|reconductor|reconductoring|upgrade|upgrades|rerat|rating|transmission|circuit|voltage conversion|interconnect|reconfiguration|replacement|replace)\b",
    re.IGNORECASE,
)
CONDUCTOR_PATTERN = re.compile(r"\b(ACCC|ACCR|ACSS(?:/TW)?|ACSR(?:/TW)?|ACAR|AAC|AAAC)\b", re.IGNORECASE)


def clean(value: Any) -> str:
    if pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\n", " ")).strip()


def normalize(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", clean(value).upper())


def value(value: Any) -> Any:
    if pd.isna(value):
        return ""
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return clean(value)


def first(record: dict[str, Any], *names: str) -> Any:
    for name in names:
        if clean(record.get(name, "")):
            return record[name]
    return ""


def classify(project: str, upgrade: str, description: str, action: str) -> str:
    text = f"{project} {upgrade} {description} {action}".lower()
    if re.search(r"reconduct|re-conductor", text):
        return "Line Reconductoring"
    if re.search(r"\brebuild|replacement|replace|pole replacement|tower replacement", text):
        return "Transmission Line Rebuild / Replacement"
    if re.search(r"\bnew\b|construct|interconnect", text):
        return "Transmission Line Build"
    if re.search(r"upgrade|rerat|rating|voltage conversion|reconfiguration|remediation|repair", text):
        return "Transmission Line Upgrade"
    return "Transmission Line Project"


def conductor_type(values: list[str]) -> str:
    found: list[str] = []
    for text in values:
        for match in CONDUCTOR_PATTERN.findall(str(text)):
            token = match.upper()
            if token not in found:
                found.append(token)
    return ", ".join(found)


def is_qualifying(record: dict[str, Any]) -> bool:
    project = clean(first(record, "Project Name", "Upgrade Name"))
    description = clean(first(record, "Project Description/ Comments", "Project Description / Comments"))
    rebuild_length = clean(record.get("Number of Rebuild/Reconductor", ""))
    return bool(PROJECT_TERMS.search(f"{project} {description}") or rebuild_length)


def make_row(record: dict[str, Any], source_file: Path, source_row: int) -> dict[str, Any]:
    cleaned = {str(key).strip(): value(raw) for key, raw in record.items() if str(key).strip() and not str(key).startswith("Unnamed")}
    project = clean(first(cleaned, "Project Name", "Upgrade Name"))
    upgrade = clean(cleaned.get("Upgrade Name", ""))
    description = clean(first(cleaned, "Project Description/ Comments", "Project Description / Comments"))
    sub_1 = clean(first(cleaned, "SUB_1", "From Bus Name")).upper()
    sub_2 = clean(first(cleaned, "SUB_2", "To Bus Name")).upper()
    planned = clean(first(cleaned, "Project Owner Indicated In-Service Date", "In-Service Date"))
    row: dict[str, Any] = {
        "Project Name": project,
        "SUB_1": sub_1,
        "SUB_2": sub_2,
        "Voltage (kV)": first(cleaned, "Voltages (kV)", "Voltage (kV)"),
        "ISO/RTO": "SPP",
        "Utility": clean(first(cleaned, "ProjectOwner", "Project Owner")),
        "Distance (mi)": cleaned.get("Number of Rebuild/Reconductor", ""),
        "Status": cleaned.get("Project Status", ""),
        "Planned Year": planned[:4] if planned[:4].isdigit() else "",
        "Description": description,
        "SPP NTC ID": first(cleaned, "NTC_ID", "NTC ID"),
        "PID": first(cleaned, "PID", "Project ID"),
        "UID": first(cleaned, "UID", "Upgrade ID"),
        "State(s)": cleaned.get("State(s)", ""),
        "Upgrade Name": upgrade,
        "Project Type (SPP)": cleaned.get("Project Type", ""),
        "Project Owner Indicated In-Service Date": planned,
        "RTO Determined Need Date": cleaned.get("RTO Determined Need Date", ""),
        "Letter of Notification Date": first(cleaned, "Letter of Notification to Construct Issue Date", "Letter of Notification Date"),
        "Source Study": cleaned.get("Source Study", ""),
        "Baseline Cost Estimate": cleaned.get("Baseline Cost Estimate", ""),
        "Baseline Cost Estimate Year": cleaned.get("Baseline Cost Estimate Year", ""),
        "Baseline Cost Estimate with Escalation": cleaned.get("Baseline Cost Estimate with Escalation", ""),
        "Current Cost Estimate": cleaned.get("Current Cost Estimate", ""),
        "From Bus Number": cleaned.get("From Bus Number", ""),
        "To Bus Number": cleaned.get("To Bus Number", ""),
        "Number of Rebuild/Reconductor": cleaned.get("Number of Rebuild/Reconductor", ""),
        "Number of New": cleaned.get("Number of New", ""),
        "Number of Voltage Conversion": cleaned.get("Number of Voltage Conversion", ""),
        "Final Cost": cleaned.get("Final Cost", ""),
        "Project Status": cleaned.get("Project Status", ""),
        "Project Description/ Comments": description,
        "Found On DB": bool(sub_1 and sub_2),
        "Conductor Type": conductor_type(list(cleaned.values())),
        "Matched Terminals": ", ".join(part for part in (sub_1, sub_2) if part),
        "Endpoint Match Info": "" if sub_1 and sub_2 else "One or both curated bus-name endpoints are missing.",
        "Source": f"{source_file.relative_to(ROOT)}, source row {source_row}",
        "Source Owner Sheet": "Sheet1",
        "Source Row": source_row,
        "Source Project": project,
        "Project Category": classify(project, upgrade, description, clean(cleaned.get("Project Status", ""))),
    }
    for key, raw in cleaned.items():
        row[f"Source - {key}"] = raw
    return row


def main() -> None:
    additions: list[dict[str, Any]] = []
    for source_file in SOURCE_FILES:
        book = pd.ExcelFile(source_file)
        source = pd.read_excel(source_file, sheet_name=book.sheet_names[0], skiprows=13).fillna("")
        for index, record in source.iterrows():
            data = record.to_dict()
            if is_qualifying(data) and clean(first(data, "Project Name", "Upgrade Name")):
                additions.append(make_row(data, source_file, int(index) + 15))

    book = pd.ExcelFile(DESTINATION)
    frames = {sheet: pd.read_excel(DESTINATION, sheet_name=sheet).fillna("") for sheet in book.sheet_names}
    spp = frames["SPP"]
    if "Source" in spp:
        source_names = tuple(path.name for path in SOURCE_FILES)
        spp = spp[~spp["Source"].astype(str).map(lambda item: any(name in item for name in source_names))].copy()

    existing = {normalize(item) for item in spp.get("Project Name", []) if clean(item)}
    unique: list[dict[str, Any]] = []
    for row in additions:
        key = normalize(row["Project Name"])
        if key not in existing:
            existing.add(key)
            unique.append(row)

    columns = list(spp.columns)
    for row in additions:
        for column in row:
            if column not in columns:
                columns.append(column)
    merged = pd.concat([spp, pd.DataFrame(unique)], ignore_index=True).reindex(columns=columns).fillna("")
    with pd.ExcelWriter(DESTINATION, engine="openpyxl") as writer:
        for sheet, frame in frames.items():
            (merged if sheet == "SPP" else frame).to_excel(writer, sheet_name=sheet, index=False)

    print(f"Source rows selected: {len(additions)}")
    print(f"New SPP rows added: {len(unique)}")
    print(f"Rows with endpoints: {sum(bool(row['SUB_1'] and row['SUB_2']) for row in unique)}")
    print(f"Rows with conductor type: {sum(bool(row['Conductor Type']) for row in unique)}")
    print(f"Final SPP rows: {len(merged)}")


if __name__ == "__main__":
    main()

"""Import relevant projects from the 2024 SPP transmission expansion list."""

from pathlib import Path
import re

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path("/Users/mvelasqu/Downloads/2024 spp transmission expansion plan project list.xlsx")
RECONDUCTORING_WORKBOOK = ROOT / "reference" / "us_reconductoring_projects.xlsx"
GETS_WORKBOOK = ROOT / "reference" / "us_gets_projects.xlsx"
SUBSTATIONS = ROOT / "geoinfo" / "us-data" / "Substations.csv"

GETS_TERMS = re.compile(
    r"reactor|series|svc|statcom|compensation|capacitor|phase[ -]shifting|dynamic voltage|condenser",
    re.IGNORECASE,
)
FACILITY_TERMS = re.compile(r"rebuild|reconductor|terminal upgrade", re.IGNORECASE)


def text(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def number(value: object) -> object:
    value = text(value)
    return value if value else ""


def normalize_name(value: object) -> str:
    return re.sub(r"[^A-Z0-9]+", "", text(value).upper())


def source_row_text(row: pd.Series) -> str:
    return " ".join(text(value) for value in row.tolist())


def project_label(row: pd.Series) -> str:
    project = text(row.get("Project Name", "")) or text(row.get("Upgrade Name", ""))
    upgrade = text(row.get("Upgrade Name", ""))
    return f"{project} - {upgrade}" if upgrade and upgrade.casefold() not in project.casefold() else project


def endpoint_from_bus(value: object) -> str:
    return text(value)


def derive_endpoints(row: pd.Series) -> tuple[str, str]:
    sub1 = endpoint_from_bus(row.get("SUB_1", "")) or endpoint_from_bus(row.get("From Bus Name", ""))
    sub2 = endpoint_from_bus(row.get("SUB_2", "")) or endpoint_from_bus(row.get("To Bus Name", ""))
    upgrade = text(row.get("Upgrade Name", "")) or text(row.get("Project Name", ""))
    if sub1 and sub2:
        return sub1, sub2

    # SPP frequently leaves the bus columns empty. The upgrade name still
    # contains the facility endpoints before its voltage and work suffix.
    endpoint_text = re.split(r"\s+\d+(?:\.\d+)?(?:/\d+(?:\.\d+)?)?\s*kV\b", upgrade, maxsplit=1, flags=re.IGNORECASE)[0]
    endpoint_text = re.sub(r"^(?:Line|Sub|Multi|XFR)\s*[-:]\s*", "", endpoint_text, flags=re.IGNORECASE)
    endpoint_text = re.sub(r"\s+(?:Ckt|Circuit)\b.*$", "", endpoint_text, flags=re.IGNORECASE)
    endpoint_text = re.sub(r"\s+(?:line\s+)?(?:reconductoring|reconductor|rebuild|terminal upgrades?)\b.*$", "", endpoint_text, flags=re.IGNORECASE)
    endpoint_text = re.sub(r"^WAPA\s+", "", endpoint_text, flags=re.IGNORECASE)
    endpoint_text = endpoint_text.strip(" -")
    parts = [part.strip(" -") for part in re.split(r"\s*-\s*", endpoint_text) if part.strip(" -")]
    if not sub1 and parts:
        sub1 = parts[0]
    if not sub2 and len(parts) > 1:
        sub2 = parts[1]
    project_type = text(row.get("Project Type", ""))
    if not sub1 and endpoint_text and "terminal" in project_type.casefold():
        sub1 = endpoint_text
    return sub1, sub2


def equipment_endpoint(row: pd.Series) -> str:
    bus = endpoint_from_bus(row.get("From Bus Name", ""))
    if bus:
        return bus
    name = text(row.get("Upgrade Name", ""))
    name = re.sub(r"^(?:Device|Sub|Multi)\s*[-:]\s*", "", name, flags=re.IGNORECASE)
    name = re.split(r"\s+\d+(?:\.\d+)?\s*kV\b", name, maxsplit=1, flags=re.IGNORECASE)[0]
    name = re.sub(r"\s+(?:capacitor bank|capacitive reactive power support|capacitive reactive support|line reactor|reactor|switched shunt)\b.*$", "", name, flags=re.IGNORECASE)
    return name.strip(" -")


def load_substation_names() -> set[str]:
    frame = pd.read_csv(SUBSTATIONS, encoding="utf-8-sig", low_memory=False).fillna("")
    return {normalize_name(value) for value in frame.get("NAME", []) if normalize_name(value)}


def make_reconductoring_row(row: pd.Series, substation_names: set[str], source_index: int) -> dict[str, object]:
    sub1, sub2 = derive_endpoints(row)
    matched = [name for name in (sub1, sub2) if normalize_name(name) in substation_names]
    project_name = project_label(row)
    project_type = "Terminal Upgrade" if "terminal upgrade" in source_row_text(row).lower() else "Line Reconductoring"
    status = text(row.get("Project Status", ""))
    date = text(row.get("Project Owner Indicated In-Service Date", ""))
    year = date[:4] if date[:4].isdigit() else ""
    output = {
        "Project Name": project_name,
        "SUB_1": sub1,
        "SUB_2": sub2,
        "Project Type": project_type,
        "Voltage (kV)": number(row.get("Voltages (kV)", "")),
        "ISO/RTO": "SPP",
        "Utility": text(row.get("ProjectOwner", "")),
        "Distance (mi)": number(row.get("Number of Rebuild/Reconductor", "")),
        "Status": status,
        "Planned Year": year,
        "Description": text(row.get("Project Description/ Comments", "")),
        "SPP NTC ID": number(row.get("NTC_ID", "")),
        "PID": number(row.get("PID", "")),
        "UID": number(row.get("UID", "")),
        "State(s)": text(row.get("State(s)", "")),
        "Upgrade Name": text(row.get("Upgrade Name", "")),
        "Project Type (SPP)": text(row.get("Project Type", "")),
        "Project Owner Indicated In-Service Date": date,
        "RTO Determined Need Date": text(row.get("RTO Determined Need Date", "")),
        "Letter of Notification Date": text(row.get("Letter of Notification to Construct Issue Date", "")),
        "Source Study": text(row.get("Source Study", "")),
        "Baseline Cost Estimate": number(row.get("Baseline Cost Estimate", "")),
        "Baseline Cost Estimate Year": number(row.get("Baseline Cost Estimate Year", "")),
        "Baseline Cost Estimate with Escalation": number(row.get("Baseline Cost Estimate with Escalation", "")),
        "Current Cost Estimate": number(row.get("Current Cost Estimate", "")),
        "From Bus Number": number(row.get("From Bus Number", "")),
        "To Bus Number": number(row.get("To Bus Number", "")),
        "Number of Rebuild/Reconductor": number(row.get("Number of Rebuild/Reconductor", "")),
        "Number of New": number(row.get("Number of New", "")),
        "Number of Voltage Conversion": number(row.get("Number of Voltage Conversion", "")),
        "Final Cost": number(row.get("Final Cost", "")),
        "Project Status": text(row.get("Project Status", "")),
        "Project Description/ Comments": text(row.get("Project Description/ Comments", "")),
        "Found On DB": len(matched) == 2,
        "Conductor Type": "",
        "Matched Terminals": ", ".join(matched),
        "Endpoint Match Info": "" if len(matched) == 2 else f"Matched {len(matched)} of 2 terminals in the substation database: {', '.join(matched) or 'none'}.",
        "Source": f"2024 SPP Transmission Expansion Plan project list, source row {source_index + 15}",
        "EPRI Case URL": "",
    }
    return output


def make_gets_row(row: pd.Series, source_index: int) -> dict[str, object]:
    endpoint = equipment_endpoint(row)
    date = text(row.get("Project Owner Indicated In-Service Date", ""))
    return {
        "Project Name": project_label(row),
        "Type": "SPP GETS - " + text(row.get("Upgrade Name", "")),
        "TP Approved": text(row.get("Source Study", "")),
        "In service Date\n(planned or\nachieved)": date,
        "SUB_1": endpoint,
        "SUB_2": "",
        "Utility": text(row.get("ProjectOwner", "")),
        "Status": text(row.get("Project Status", "")),
        "Neighboring Communities": text(row.get("State(s)", "")),
        "Description": text(row.get("Project Description/ Comments", "")),
        "Project Timeline": date,
        "CPUC Status": "",
        "Contact Information": "",
        "Maps & Resources": "",
        "Source": f"2024 SPP Transmission Expansion Plan project list, source row {source_index + 15}",
        "ISO/RTO": "SPP",
        "NTC ID": number(row.get("NTC_ID", "")),
        "PID": number(row.get("PID", "")),
        "UID": number(row.get("UID", "")),
        "Upgrade Name": text(row.get("Upgrade Name", "")),
        "Project Type (SPP)": text(row.get("Project Type", "")),
        "Voltage (kV)": number(row.get("Voltages (kV)", "")),
        "Current Cost Estimate": number(row.get("Current Cost Estimate", "")),
        "Found On DB": False,
        "Endpoint Match Info": f"SPP equipment location parsed as {endpoint}." if endpoint else "No substation endpoint was identified in the source record.",
    }


def merge_sheet(workbook: Path, sheet: str, rows: list[dict[str, object]]) -> None:
    book = pd.ExcelFile(workbook)
    frames = {name: pd.read_excel(workbook, sheet_name=name).fillna("") for name in book.sheet_names}
    frame = frames.get(sheet, pd.DataFrame())
    if "SUB_2" not in frame.columns and "Unnamed: 1" in frame.columns:
        frame = frame.rename(columns={"Unnamed: 1": "SUB_2"})
    if sheet == "SPP":
        if "SUB_1" not in frame.columns:
            frame["SUB_1"] = ""
        if "SUB_2" not in frame.columns:
            frame["SUB_2"] = ""
        for index, existing in frame.iterrows():
            sub1, sub2 = derive_endpoints(existing)
            if sub1 and not text(existing.get("SUB_1", "")):
                frame.at[index, "SUB_1"] = sub1
            if sub2 and not text(existing.get("SUB_2", "")):
                frame.at[index, "SUB_2"] = sub2
    source_prefix = "2024 SPP Transmission Expansion Plan project list"
    if not frame.empty and "Source" in frame.columns:
        frame = frame[~frame["Source"].astype(str).str.startswith(source_prefix)].copy()
    for row in rows:
        project_name = row["Project Name"]
        frame = frame[frame.get("Project Name", pd.Series(dtype=str)).astype(str).ne(str(project_name))]
        for column in row:
            if column not in frame.columns:
                frame[column] = ""
        frame = pd.concat([frame, pd.DataFrame([row]).reindex(columns=frame.columns)], ignore_index=True)
    if sheet == "SPP":
        ordered = [column for column in ("Project Name", "SUB_1", "SUB_2") if column in frame.columns]
        frame = frame[ordered + [column for column in frame.columns if column not in ordered]]
    frames[sheet] = frame
    with pd.ExcelWriter(workbook, engine="openpyxl") as writer:
        for name, value in frames.items():
            value.to_excel(writer, sheet_name=name, index=False)


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing source workbook: {SOURCE}")
    source = pd.read_excel(SOURCE, skiprows=13).fillna("")
    substation_names = load_substation_names()
    recon_rows = []
    gets_rows = []
    for index, row in source.iterrows():
        contents = source_row_text(row)
        relevant_contents = " ".join(text(row.get(column, "")) for column in ("Project Name", "Upgrade Name", "Project Description/ Comments"))
        is_gets = bool(GETS_TERMS.search(relevant_contents))
        is_facility = bool(FACILITY_TERMS.search(contents)) or text(row.get("Number of Rebuild/Reconductor", ""))
        if is_gets:
            gets_rows.append(make_gets_row(row, index))
        elif is_facility:
            recon_rows.append(make_reconductoring_row(row, substation_names, index))
    merge_sheet(RECONDUCTORING_WORKBOOK, "SPP", recon_rows)
    merge_sheet(GETS_WORKBOOK, "SPP", gets_rows)
    print(f"Imported {len(recon_rows)} SPP transmission projects and {len(gets_rows)} SPP GETS projects")


if __name__ == "__main__":
    main()
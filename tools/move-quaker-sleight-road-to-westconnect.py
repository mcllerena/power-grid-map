"""Move the Quaker-Sleight Road project to the WestConnect sheet."""

from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "reference" / "us_reconductoring_projects.xlsx"
PROJECT_NAME = "Quaker-Sleight Road #13 Rebuild Line Reconductoring"


def main() -> None:
    book = pd.ExcelFile(WORKBOOK)
    frames = {
        sheet: pd.read_excel(WORKBOOK, sheet_name=sheet).fillna("")
        for sheet in book.sheet_names
    }
    nyiso = frames["NYISO"]
    matches = nyiso[nyiso["Project Name"].astype(str).eq(PROJECT_NAME)].copy()
    westconnect = frames["WestConnect"]
    existing_westconnect = westconnect[westconnect["Project Name"].astype(str).eq(PROJECT_NAME)].copy()
    if matches.empty and existing_westconnect.empty:
        raise SystemExit(f"Project not found in NYISO or WestConnect: {PROJECT_NAME}")
    project = (matches if not matches.empty else existing_westconnect).iloc[0].to_dict()
    nyiso = nyiso[~nyiso["Project Name"].astype(str).eq(PROJECT_NAME)].copy()
    project.update(
        {
            "ISO/RTO": "WestConnect",
            "Found On DB": False,
            "Matched Terminals": "QUAKER",
            "Endpoint Match Info": "Only 1 of 2 terminals found in the database: QUAKER. SLEIGHT ROAD was not matched to the transmission database.",
            "Conductor Type": "1590 ACSS 54/19",
            "Source": "SPP project record corrected to WestConnect by geographic endpoint match",
        }
    )

    if "Project Name" not in westconnect.columns:
        westconnect["Project Name"] = ""
    westconnect = westconnect[~westconnect["Project Name"].astype(str).eq(PROJECT_NAME)].copy()
    for column in project:
        if column not in westconnect.columns:
            westconnect[column] = ""
    project_row = {column: project.get(column, "") for column in westconnect.columns}
    westconnect = pd.concat([westconnect, pd.DataFrame([project_row])], ignore_index=True)

    frames["NYISO"] = nyiso
    frames["WestConnect"] = westconnect
    with pd.ExcelWriter(WORKBOOK, engine="openpyxl") as writer:
        for sheet, frame in frames.items():
            frame.to_excel(writer, sheet_name=sheet, index=False)
    print("Moved Quaker-Sleight Road project from NYISO to WestConnect")


if __name__ == "__main__":
    main()
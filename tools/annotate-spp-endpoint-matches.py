"""Add endpoint match audit information to SPP reconductoring rows."""

from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "reference" / "us_reconductoring_projects.xlsx"
PROJECT_NAME = "Roadrunner - Red Bluff 115 kV Reconductor (220766) Line Reconductoring"


def main() -> None:
    book = pd.ExcelFile(WORKBOOK)
    frames = {
        sheet: pd.read_excel(WORKBOOK, sheet_name=sheet).fillna("")
        for sheet in book.sheet_names
    }
    spp = frames["SPP"]
    if "Endpoint Match Info" not in spp.columns:
        spp["Endpoint Match Info"] = ""
    if "Matched Terminals" not in spp.columns:
        spp["Matched Terminals"] = ""
    mask = spp["Project Name"].astype(str).eq(PROJECT_NAME)
    spp.loc[mask, "Matched Terminals"] = "RED BLUFF"
    spp.loc[mask, "Endpoint Match Info"] = (
        "Only one of 2 terminals was found in the database: RED BLUFF. "
        "ROADRUNNER was not matched to the SPP transmission database."
    )
    frames["SPP"] = spp

    with pd.ExcelWriter(WORKBOOK, engine="openpyxl") as writer:
        for sheet, frame in frames.items():
            frame.to_excel(writer, sheet_name=sheet, index=False)

    print("SPP endpoint match info updated")


if __name__ == "__main__":
    main()
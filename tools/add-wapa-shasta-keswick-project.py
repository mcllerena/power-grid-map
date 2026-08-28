"""Add the WAPA Shasta-Keswick ACCR reconductoring project to the SPP sheet."""

from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "reference" / "us_reconductoring_projects.xlsx"

PROJECT = {
    "Project Name": "WAPA Shasta-Keswick 230 kV transmission line reconductoring with 795-T16 ACCR",
    "SUB_1": "SHASTA",
    "SUB_2": "KESWICK",
    "Project Type": "Line Reconductoring",
    "Conductor Type": "795-T16 ACCR",
    "Voltage (kV)": 230,
    "ISO/RTO": "SPP",
    "Utility": "Western Area Power Administration (WAPA)",
    "Distance (mi)": "",
    "Status": "In-Service",
    "Planned Year": "2013-2014",
    "Description": (
        "WAPA reconductored the Shasta and Keswick substations and the associated 230 kV transmission facilities "
        "with 795-T16 ACCR conductor during 2013-2014. The work addressed N-2 overload risk: loss of both "
        "Shasta-Cottonwood 230 kV lines could overload the Shasta-Keswick 230 kV line. The ACCR conductor provides "
        "over 2,000 amps, allowing each bay to carry the full 710 MW output of the Shasta power plant. "
        "The diameter-equivalent conductor met the existing sag without increasing tension and avoided major "
        "structure replacement. ACCR was used for jack-bus and drop-down jumpers; 1590 AAC connected the high-"
        "temperature strain bus to terminals not rated for high-temperature operation."
    ),
    "State(s)": "CA",
    "Upgrade Name": "Shasta-Keswick 230 kV ACCR reconductoring",
    "Source Study": "WAPA ACCR project case study",
    "Found On DB": True,
}


def main() -> None:
    book = pd.ExcelFile(WORKBOOK)
    frames = {
        sheet: pd.read_excel(WORKBOOK, sheet_name=sheet).fillna("")
        for sheet in book.sheet_names
    }
    spp = frames["SPP"]
    key = PROJECT["Project Name"].casefold()
    spp = spp[spp["Project Name"].astype(str).str.casefold().ne(key)].copy()
    if "Conductor Type" not in spp.columns:
        spp["Conductor Type"] = ""
    for column in spp.columns:
        PROJECT.setdefault(column, "")
    spp = pd.concat([spp, pd.DataFrame([PROJECT]).reindex(columns=spp.columns)], ignore_index=True)
    frames["SPP"] = spp

    with pd.ExcelWriter(WORKBOOK, engine="openpyxl") as writer:
        for sheet, frame in frames.items():
            frame.to_excel(writer, sheet_name=sheet, index=False)

    print(f"SPP rows: {len(spp)}")
    print(spp.tail(1).to_string(index=False))


if __name__ == "__main__":
    main()

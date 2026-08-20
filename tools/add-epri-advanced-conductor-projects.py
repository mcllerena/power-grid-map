"""Add the EPRI advanced-conductor case studies to their ISO/RTO sheets."""

from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "reference" / "us_reconductoring_projects.xlsx"
EPRI_BASE = "https://msites.epri.com/rd/research/024056/advanced-conductor-experience/"

PROJECTS = [
    {
        "sheet": "SPP",
        "Project Name": "Arkansas Electric Cooperative Corporation ACCR case study",
        "Utility": "Arkansas Electric Cooperative Corporation (AECC)",
        "Project Type": "Line Reconductoring",
        "Conductor Type": "ACCR",
        "ISO/RTO": "SPP",
        "Status": "Completed case study",
        "Description": "AECC completed the Thomas B. Fitzhugh Generating Station at Ozark; the EPRI case documents its ACCR advanced-conductor experience.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "arkansas-electric-cooperative-corporation-accr",
        "Endpoint Match Info": "EPRI page does not identify a defensible transmission terminal pair.",
    },
    {
        "sheet": "MISO",
        "Project Name": "Entergy Ninemile-Napoleon 230 kV ACCR reconductoring",
        "SUB_1": "NINEMILE",
        "SUB_2": "NAPOLEON",
        "Utility": "Entergy New Orleans, LLC",
        "Project Type": "Line Reconductoring",
        "Conductor Type": "ACCR",
        "Voltage (kV)": 230,
        "ISO/RTO": "MISO",
        "Status": "Completed case study",
        "Description": "Entergy upgraded the Ninemile to Napoleon 230 kV line feeding the warehouse and central business district of New Orleans.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "entergy-accr",
    },
    {
        "sheet": "MISO",
        "Project Name": "Entergy Ninemile-Derbigny 230 kV ACCR reconductoring",
        "SUB_1": "NINEMILE",
        "SUB_2": "DERBIGNY",
        "Utility": "Entergy New Orleans, LLC",
        "Project Type": "Line Reconductoring",
        "Conductor Type": "ACCR",
        "Voltage (kV)": 230,
        "ISO/RTO": "MISO",
        "Status": "Completed case study",
        "Description": "Entergy upgraded the Ninemile to Derbigny 230 kV line serving the New Orleans Superdome.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "entergy-accr",
    },
    {
        "sheet": "ERCOT",
        "Project Name": "Lower Colorado River Authority 138 kV ACCR case study",
        "Utility": "Lower Colorado River Authority (LCRA)",
        "Project Type": "Line Reconductoring",
        "Conductor Type": "ACCR",
        "Voltage (kV)": 138,
        "ISO/RTO": "ERCOT",
        "Status": "Completed case study",
        "Description": "LCRA upgraded a dual-circuit 138 kV lattice-tower line, originally built in the late 1930s with 203.2 ACSR Brahma and previously reconductored with 795 ACSR Condor.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "lower-colorado-river-authority-accr",
        "Endpoint Match Info": "EPRI page does not identify a defensible transmission terminal pair.",
    },
    {
        "sheet": "ERCOT",
        "Project Name": "CenterPoint Energy 345 kV ACSS case study",
        "Utility": "CenterPoint Energy",
        "Project Type": "New transmission line and reconductoring case study",
        "Conductor Type": "ACSS",
        "Voltage (kV)": 345,
        "ISO/RTO": "ERCOT",
        "Status": "Completed case study",
        "Description": "CenterPoint Energy of Houston used an extended-capability ACSS conductor for a 2800 MVA, 345 kV line on existing towers and partially on new right of way.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "centerpoint-energy-acss",
        "Endpoint Match Info": "EPRI page does not identify a defensible transmission terminal pair.",
    },
    {
        "sheet": "PJM",
        "Project Name": "American Electric Power ACCC advanced-conductor applications",
        "Utility": "American Electric Power (AEP)",
        "Project Type": "Line Reconductoring",
        "Conductor Type": "ACCC",
        "ISO/RTO": "PJM",
        "Status": "Completed case study portfolio",
        "Description": "AEP documented advanced-conductor applications over 10 years on 138-345 kV projects, primarily increasing capacity into existing load areas where new rights of way were constrained.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "american-electric-power-accc",
        "Endpoint Match Info": "EPRI page describes multiple AEP projects and does not identify one terminal pair for this portfolio record.",
    },
    {
        "sheet": "WestConnect",
        "Project Name": "Cheyenne Light Fuel and Power 115 kV ACCC with E3X reconductoring",
        "Utility": "Cheyenne Light, Fuel and Power Transmission (Black Hills Energy)",
        "Project Type": "Line Reconductoring",
        "Conductor Type": "1026-kcmil Drake ACCC with E3X",
        "Voltage (kV)": 115,
        "ISO/RTO": "WestConnect",
        "Status": "Completed case study",
        "Description": "A new double-circuit 115 kV line near Cheyenne, Wyoming was reconductored after unexpected load growth; the selected ACCC option was projected to carry 1843 amps after substation upgrades.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "cheyenne-light-fuel-and-power-transmission-accc-e3x",
        "Endpoint Match Info": "EPRI page identifies the Cheyenne area but does not identify the two terminal substations.",
    },
    {
        "sheet": "WestConnect",
        "Project Name": "Nevada Power 220 kV ACCC case study",
        "Utility": "Nevada Power (NV Energy)",
        "Project Type": "Line Reconductoring",
        "Conductor Type": "ACCC",
        "Voltage (kV)": 220,
        "ISO/RTO": "WestConnect",
        "Status": "Completed case study",
        "Description": "Nevada Power, doing business as NV Energy, identified a 220 kV transmission line for an advanced-conductor upgrade.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "nevada-power-accc",
        "Endpoint Match Info": "EPRI page does not identify a defensible transmission terminal pair.",
    },
    {
        "sheet": "ERCOT",
        "Project Name": "Cross Timbers 345 kV ACSS and ACCR transmission case study",
        "Utility": "Cross Timbers Transmission (CTT)",
        "Project Type": "New transmission line",
        "Conductor Type": "ACSS and ACCR",
        "Voltage (kV)": 345,
        "Distance (mi)": 235,
        "ISO/RTO": "ERCOT",
        "Status": "Completed case study",
        "Description": "Cross Timbers Transmission designed, built, and operated 235 miles of double-circuit 345 kV CREZ transmission lines, a substation, and a series-compensation station.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "cross-timbers-acss-and-accr",
        "Endpoint Match Info": "EPRI page does not identify a defensible terminal pair for the 235-mile portfolio record.",
    },
    {
        "sheet": "CAISO",
        "Project Name": "Southern California Edison Eisenhower-Thornhill ACCC reconductoring",
        "SUB_1": "EISENHOWER",
        "SUB_2": "THORNHILL",
        "Utility": "Southern California Edison (SCE)",
        "Project Type": "Line Reconductoring",
        "Conductor Type": "ACCC",
        "ISO/RTO": "CAISO",
        "Status": "Completed case study",
        "Description": "SCE reconductored the Eisenhower-Thornhill line near Palm Springs Airport to address load growth and thermal sag limitations while retaining existing structures.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "southern-california-edison-accc",
    },
    {
        "sheet": "NorthernGrid",
        "Project Name": "AVISTA ACSS with E3X case study",
        "Utility": "AVISTA",
        "Project Type": "Line Reconductoring",
        "Conductor Type": "ACSS with E3X",
        "ISO/RTO": "NorthernGrid",
        "Status": "Completed case study",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "avista-acss-with-e3x",
        "Endpoint Match Info": "EPRI page does not identify a defensible transmission terminal pair.",
    },
    {
        "sheet": "WestConnect",
        "Project Name": "Arizona Public Service Cactus-Altadena 69 kV ACCS C7 line",
        "SUB_1": "CACTUS",
        "SUB_2": "ALTADENA",
        "Utility": "Arizona Public Service (APS)",
        "Project Type": "New transmission line",
        "Conductor Type": "ACCS C7",
        "Voltage (kV)": 69,
        "Distance (mi)": 3.2,
        "ISO/RTO": "WestConnect",
        "Map SUB_1 Coordinates": "-111.885158,33.583494",
        "Map SUB_2 Coordinates": "-111.838963,33.591156",
        "Status": "Planned/new line case study",
        "Description": "APS planned a new 69 kV line connecting the Cactus and Altadena substations in Scottsdale, approximately 3.2 miles along Shea Boulevard.",
        "Source": "EPRI Advanced Conductor Experience",
        "EPRI Case URL": EPRI_BASE + "arizona-public-service-accs-c7-conductor",
    },
]


def main() -> None:
    book = pd.ExcelFile(WORKBOOK)
    frames = {sheet: pd.read_excel(WORKBOOK, sheet_name=sheet).fillna("") for sheet in book.sheet_names}
    for project in PROJECTS:
        sheet = project["sheet"]
        frame = frames[sheet]
        name = project["Project Name"].casefold()
        if "Project Name" not in frame.columns:
            frame["Project Name"] = ""
        frame = frame[frame["Project Name"].astype(str).str.casefold().ne(name)].copy()
        for column in project:
            if column != "sheet" and column not in frame.columns:
                frame[column] = ""
        row = {column: project.get(column, "") for column in frame.columns}
        frame = pd.concat([frame, pd.DataFrame([row])], ignore_index=True)
        frames[sheet] = frame

    with pd.ExcelWriter(WORKBOOK, engine="openpyxl") as writer:
        for sheet, frame in frames.items():
            frame.to_excel(writer, sheet_name=sheet, index=False)
    print(f"Added or refreshed {len(PROJECTS)} EPRI project records")


if __name__ == "__main__":
    main()
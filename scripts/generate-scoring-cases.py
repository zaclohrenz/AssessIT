#!/usr/bin/env python3
"""
Regenerates tests/scoring-cases.csv from the ORIGINAL reference spreadsheet.

Every expected number in that CSV is computed by the spreadsheet's own Excel
formulas (via the `formulas` package), not by AssessIT's code. That makes the CSV an
independent oracle: if someone changes src/engine.ts and the numbers drift, CI fails.

Maintainers only. Needs the reference workbook, which isn't distributed with the repo:
    python3 -m venv .venv && .venv/bin/pip install formulas
    .venv/bin/python scripts/generate-scoring-cases.py path/to/reference.xlsx

You can also add rows to the CSV by hand. Work the numbers out with SCORING.md.
"""

import csv
import json
import random
import sys
import warnings
from pathlib import Path

import formulas

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parent.parent
POLICY = json.loads((ROOT / "src/policy/default-policy.json").read_text())
FACTORS = POLICY["factors"]
IDS = [f["id"] for f in FACTORS]
# Workbook layout: factor rows start at row 23 on both the Input and Weights tabs.
ROW = {fid: 23 + i for i, fid in enumerate(IDS)}

OUT = {  # Weights tab cells the test compares against
    "likelihood": "D65",
    "impact": "D68",
    "preference_multiplier": "D71",
    "mitigation_credit": "D74",
    "score": "D76",
    "band": "D78",
    "decision": "D86",
}


def options(fid):
    return [o["label"] for o in next(f for f in FACTORS if f["id"] == fid)["options"]]


def lowest(fid):
    f = next(f for f in FACTORS if f["id"] == fid)
    return min(f["options"], key=lambda o: o["points"])["label"]


def highest(fid):
    f = next(f for f in FACTORS if f["id"] == fid)
    return max(f["options"], key=lambda o: o["points"])["label"]


BASE = {fid: lowest(fid) for fid in IDS}
WORST = {fid: (highest(fid) if not fid.startswith("M") else "No") for fid in IDS}
REFERENCE = {  # the worked example from the original spreadsheet
    "L1": "No", "L2": "Yes", "L3": "Yes", "L4": "No", "L5": "No", "L6": "No", "L7": "Not rated",
    "L8": "No", "L9": "Yes", "L10": "Yes", "L11": "No", "L12": "No", "I1": "Acceptable", "I2": "No",
    "I3": "Confidential", "I4": "No", "I5": "Multiple teams", "I6": "Admin or write access", "I7": "No",
    "P1": "No", "P2": "No", "P3": "No", "M1": "No", "M2": "No", "M3": "Yes", "M4": "No", "M5": "No",
}


def case(name, base=BASE, **changes):
    unknown = set(changes) - set(IDS)
    assert not unknown, f"{name}: unknown factor IDs {unknown}"
    a = dict(base)
    a.update(changes)
    return name, a


CASES = [
    case("all lowest-risk answers"),
    case("all worst answers / no mitigations", WORST),
    case("all worst answers / every mitigation (credit capped at 25%)", WORST,
         M1="Yes", M2="Yes", M3="Yes", M4="Yes", M5="Yes"),
    case("original spreadsheet worked example", REFERENCE),
    case("required question blank -> Incomplete", REFERENCE, L1=""),
    case("two required blanks -> Incomplete", REFERENCE, I3="", P2=""),
    case("optional questions blank still decides", BASE,
         **{k: "" for k in ["L8", "L9", "L10", "L11", "L12", "I5", "I6", "I7", "M1", "M2", "M3", "M4", "M5"]}),
    case("likelihood only / impact zero -> score 0", BASE, L1="Yes", L2="Yes", L3="Yes", L7="0-25"),
    case("4 x 7 = 28 just under Low", BASE, L2="Yes", L3="Yes", I2="Yes", I3="Sensitive", I6="Read-only integration"),
    case("5 x 6 = 30 just into Low", BASE, L2="Yes", L3="Yes", L4="Yes", I2="Yes", I3="Sensitive"),
    case("7 x 8 = 56 top of Low", BASE, L2="Yes", L3="Yes", L5="Yes", L1="Yes",
         I2="Yes", I3="Sensitive", I5="Organization-wide"),
    case("6 x 10 = 60 into Moderate -> Denied", BASE, L2="Yes", L3="Yes", L5="Yes",
         I2="Yes", I3="Sensitive", I5="Organization-wide", I6="Admin or write access"),
    case("60 cut 5% by SSO+SCIM = 57 -> Approved with Conditions", BASE, L2="Yes", L3="Yes", L5="Yes",
         I2="Yes", I3="Sensitive", I5="Organization-wide", I6="Admin or write access", M3="Yes"),
    case("9 x 10 = 90 High", BASE, L2="Yes", L3="Yes", L5="Yes", L10="Yes", L1="Yes",
         I2="Yes", I3="Sensitive", I5="Organization-wide", I6="Admin or write access"),
    case("9 x 13 = 117 Critical", BASE, L2="Yes", L3="Yes", L5="Yes", L10="Yes", L1="Yes",
         I2="Yes", I3="Sensitive", I4="Yes", I5="Organization-wide", I6="Admin or write access"),
    case("one org preference: x1.5", REFERENCE, P1="Yes"),
    case("two org preferences: x2.0", REFERENCE, P1="Yes", P3="Yes"),
    case("all org preferences: x2.5", REFERENCE, P1="Yes", P2="Yes", P3="Yes"),
    case("security rating Not rated scores like 26-50", BASE, L7="Not rated", L2="Yes", I3="Internal"),
    case("security rating 0-25 is worst", BASE, L7="0-25", L2="Yes", I3="Internal"),
    case("AI sub-processors Unknown scores like Yes", BASE, L9="Unknown", L2="Yes", I3="Internal"),
    case("mitigations raw 15% (under cap)", REFERENCE, M1="Yes"),
    case("mitigations raw 40% capped at 25%", REFERENCE, M1="Yes", M2="Yes", M4="Yes", M5="Yes"),
    case("severity Catastrophic + critical process", BASE, L2="Yes", I1="Catastrophic", I2="Yes"),
    case("severity Unacceptable", BASE, L2="Yes", I1="Unacceptable"),
]

rng = random.Random(20261120)  # fixed seed: the CSV must be reproducible
for i in range(1, 21):
    a = {fid: rng.choice(options(fid)) for fid in IDS}
    if i % 7 == 0:  # sprinkle some unanswered optional questions
        for fid in rng.sample([f["id"] for f in FACTORS if not f["required"]], 3):
            a[fid] = ""
    CASES.append((f"random #{i} (seed 20261120)", a))


def main(workbook):
    xl = formulas.ExcelModel().loads(workbook).finish()

    def key(sheet, cell):
        return next(k for k in xl.dsp.data_nodes if k.upper().endswith(f"{sheet}'!{cell}"))

    in_keys = {fid: key("INPUT", f"D{ROW[fid]}") for fid in IDS}
    out_keys = {name: key("WEIGHTS", cell) for name, cell in OUT.items()}

    path = ROOT / "tests/scoring-cases.csv"
    with path.open("w", newline="") as fh:
        fh.write("# Golden scoring cases. Expected values were computed by the ORIGINAL reference spreadsheet's\n")
        fh.write("# formulas (scripts/generate-scoring-cases.py), not by AssessIT. Blank answer = unanswered.\n")
        fh.write("# Add rows by hand if you like; see SCORING.md for how to work out the numbers.\n")
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["case", *IDS, *OUT.keys()])
        for name, answers in CASES:
            assert "," not in name, f"keep case names comma-free for readability: {name}"
            sol = xl.calculate(inputs={in_keys[f]: answers[f] for f in IDS}, outputs=list(out_keys.values()))
            vals = {n: sol[k].value[0][0] for n, k in out_keys.items()}
            row = [name, *[answers[f] for f in IDS]]
            for n in OUT:
                v = vals[n]
                row.append(f"{float(v):.4f}".rstrip("0").rstrip(".") if not isinstance(v, str) else v)
            w.writerow(row)
    print(f"wrote {len(CASES)} cases to {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main(sys.argv[1])

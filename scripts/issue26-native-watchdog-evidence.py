"""Temporary native CI evidence driver; runs only hermetic integration fixtures."""
import hashlib
import json
import math
import pathlib
import platform
import re
import statistics
import subprocess
import sys
import time


def counts_for(output):
    rows = re.findall(r"^test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored;", output, re.M)
    if not rows:
        return None
    state, passed, failed, ignored = rows[-1]
    return {"state": state, "passed": int(passed), "failed": int(failed), "ignored": int(ignored)}


def valid_counts(counts, expected):
    return counts is not None and counts["state"] == "ok" and counts["failed"] == 0 and counts["passed"] == expected


def main(argv):
    base, changed, evidence = (pathlib.Path(arg).resolve() for arg in argv)
    roots = {"base": base, "changed": changed}
    binaries, listings, records = {}, {}, []
    summary = {"host": platform.uname()._asdict(), "warmup_pairs": 2, "sample_pairs": 10, "cases": {}, "complete": False}

    def save():
        (evidence / "invocations.json").write_text(json.dumps(records, indent=2) + "\n")
        (evidence / "paired-summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    def invoke(side, args, label, expected):
        start = time.perf_counter()
        try:
            result = subprocess.run([str(binaries[side]), *args], cwd=roots[side], capture_output=True, timeout=90)
        except subprocess.TimeoutExpired as error:
            output = (error.stdout or b"") + (error.stderr or b"")
            records.append({"side": side, "label": label, "timeout": True, "elapsed_ms": (time.perf_counter()-start)*1000, "success": False})
            (evidence / f"{side}-{label}.log").write_bytes(output)
            summary["stop_reason"] = "invocation-timeout-owned-cleanup-unverified"
            save()
            raise RuntimeError("Native fixture exceeded outer observation bound; remaining comparison not run") from None
        output = (result.stdout + result.stderr).decode("utf-8", "backslashreplace")
        counts = counts_for(output)
        log = f"{side}-{label}.log"
        (evidence / log).write_text(output)
        row = {"side": side, "label": label, "args": args, "exit": result.returncode, "elapsed_ms": (time.perf_counter()-start)*1000, "counts": counts, "success": result.returncode == 0 and valid_counts(counts, expected), "log": log}
        records.append(row)
        save()
        return row

    for side in roots:
        rows = [json.loads(line) for line in (evidence / f"{side}-build.jsonl").read_text().splitlines()]
        artifacts = [row for row in rows if row.get("reason") == "compiler-artifact" and row.get("target", {}).get("name") == "turn_delivery_recovery" and row.get("executable")]
        if len(artifacts) != 1:
            raise RuntimeError(f"Expected one integration artifact for {side}")
        binary = pathlib.Path(artifacts[0]["executable"]).resolve()
        if not binary.is_file() or not binary.is_relative_to(roots[side]):
            raise RuntimeError(f"Artifact ownership invalid for {side}")
        binaries[side] = binary
        listed = subprocess.run([str(binary), "--list"], cwd=roots[side], capture_output=True, check=True, timeout=30).stdout.decode()
        (evidence / f"{side}-enumeration.txt").write_text(listed)
        listings[side] = {line.removesuffix(": test") for line in listed.splitlines() if line.endswith(": test")}
        ignored = subprocess.run([str(binary), "--list", "--ignored"], cwd=roots[side], capture_output=True, check=True, timeout=30).stdout.decode()
        (evidence / f"{side}-ignored-enumeration.txt").write_text(ignored)
        ignored_names = {line.removesuffix(": test") for line in ignored.splitlines() if line.endswith(": test")}
        summary[side] = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "enumerated": len(listings[side]), "ignored": len(ignored_names), "active": len(listings[side] - ignored_names)}
    if binaries["base"] == binaries["changed"]:
        raise RuntimeError("Baseline and changed artifact must be separate")

    common = ["child_deadline_kills_and_reaps_a_stalled_child_and_reports_timeout", "child_deadline_returns_complete_output_on_normal_exit"]
    if platform.system() == "Linux":
        common.append("child_deadline_bounds_output_collection_when_a_descendant_escapes")
    required = {"watchdog_tests::child_watchdog_parent_sigkill_cleans_child_and_grandchild", "watchdog_tests::child_watchdog_parent_sigint_cleans_child_and_grandchild", "watchdog_tests::child_watchdog_normal_exit_cleans_a_descendant_holding_output"}
    if not required.issubset(listings["changed"]) or any(not all(name in listings[side] for side in roots) for name in common):
        raise RuntimeError("Required native/common test absent")
    for name in common:
        for iteration in range(12):
            order = ["base", "changed"] if iteration % 2 == 0 else ["changed", "base"]
            for side in order:
                invoke(side, ["--exact", name, "--nocapture"], f"{name}-pair-{iteration}", 1)
        values = {}
        for side in roots:
            rows = [r for r in records if r["side"] == side and r["label"].startswith(name + "-pair-")][2:]
            samples = [r["elapsed_ms"] for r in rows if r["success"]]
            values[side] = {"observed": len(rows), "failures": sum(not r["success"] for r in rows), "successful_samples_ms": samples, "median_ms": statistics.median(samples) if samples else None, "p95_ms": sorted(samples)[math.ceil(.95*len(samples))-1] if samples else None}
        summary["cases"][name] = values
        if all(values[side]["median_ms"] is not None for side in roots):
            values["median_delta_ms"] = values["changed"]["median_ms"] - values["base"]["median_ms"]
            values["p95_delta_ms"] = values["changed"]["p95_ms"] - values["base"]["p95_ms"]
            values["median_relative_delta"] = values["median_delta_ms"] / values["base"]["median_ms"] if values["base"]["median_ms"] > 0 else None
        save()
    watchdog_count = sum("child_watchdog_" in name for name in listings["changed"])
    ignored_watchdog = subprocess.run([str(binaries["changed"]), "child_watchdog_", "--list", "--ignored"], capture_output=True, check=True, timeout=30).stdout.decode()
    watchdog_count -= sum(line.endswith(": test") for line in ignored_watchdog.splitlines())
    if watchdog_count < 1:
        raise RuntimeError("Empty active watchdog filter")
    summary["watchdog"] = invoke("changed", ["child_watchdog_", "--nocapture"], "native-watchdog", watchdog_count)
    summary["full_target"] = {side: invoke(side, [], "full-recovery", summary[side]["active"]) for side in roots}
    summary["complete"] = True
    summary["success"] = all(row["success"] for row in records)
    summary["comparison_note"] = "Both separately built native artifacts finish compilation before observation. Identical common cases alternate order; two warmup pairs excluded from latency statistics. Failures retained, not filtered into success. Full targets have different inventories. No acceptance threshold is invented."
    save()
    return 0 if summary["success"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

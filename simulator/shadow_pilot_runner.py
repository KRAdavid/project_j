"""폐쇄형 GABA Shadow Pilot의 모든 필수 시나리오를 실행하고 판정한다."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from gaba_beta_simulator import GabaBetaSimulator, SimulationConfig


ROOT = Path(__file__).resolve().parent.parent
PLAN_PATH = ROOT / "ops" / "shadow-pilot-plan.json"


def validate_pilot_plan(plan: dict) -> dict:
    """참가자 접근 전에 폐쇄형 Shadow Pilot 설정을 fail-closed로 검증한다."""
    violations: list[str] = []
    participants = plan.get("participants", [])
    scenarios = plan.get("scenarios", [])
    stop_rules = plan.get("stopRules", [])
    evidence = plan.get("evidenceToCapture", [])
    participant_ids = [item.get("participantId") for item in participants]
    participant_roles = {item.get("role") for item in participants}
    scenario_ids = [item.get("id") for item in scenarios]
    required_evidence = {
        "simulation_run_id",
        "participant_role",
        "spec_id",
        "lot_id",
        "order_id",
        "trade_id",
        "pretrade_checks",
        "state_transition_log",
        "blocked_events",
        "scenario_block_reason",
        "invalid_lot_trade_count",
        "human_decision_id",
    }

    if plan.get("mode") != "CLOSED_SIMULATION":
        violations.append("mode must be CLOSED_SIMULATION")
    if any(plan.get(flag) is not False for flag in (
        "realTransactionsEnabled",
        "realMoneyEnabled",
        "externalNotificationsEnabled",
    )):
        violations.append("real transactions, money, and external notifications must remain disabled")
    if plan.get("humanPrincipal") != "H-01":
        violations.append("humanPrincipal must be H-01")
    if plan.get("requiredApproval") != "H-01_APPROVAL_BEFORE_PARTICIPANT_ACCESS":
        violations.append("participant access must require H-01 approval")
    if len(participants) < 3 or not {"BUYER", "SUPPLIER", "OBSERVER"}.issubset(participant_roles):
        violations.append("BUYER, SUPPLIER, and OBSERVER participants are required")
    if any(not item.get("participantId") or not item.get("organization") for item in participants):
        violations.append("every participant requires an id and organization")
    if len(participant_ids) != len(set(participant_ids)):
        violations.append("participant ids must be unique")
    if len(scenarios) < 7 or len(scenario_ids) != len(set(scenario_ids)):
        violations.append("at least seven uniquely identified scenarios are required")
    if len(stop_rules) < 5:
        violations.append("at least five stop rules are required")
    if not required_evidence.issubset(set(evidence)):
        violations.append("required evidence fields are incomplete")

    return {
        "passed": not violations,
        "violations": violations,
        "participant_access_enabled": False,
        "required_approval": plan.get("requiredApproval"),
        "checks": {
            "closed_simulation_mode": plan.get("mode") == "CLOSED_SIMULATION",
            "real_side_effects_disabled": not any(plan.get(flag) is not False for flag in (
                "realTransactionsEnabled",
                "realMoneyEnabled",
                "externalNotificationsEnabled",
            )),
            "human_gate_configured": plan.get("humanPrincipal") == "H-01"
            and plan.get("requiredApproval") == "H-01_APPROVAL_BEFORE_PARTICIPANT_ACCESS",
            "participants_complete": len(participants) >= 3
            and {"BUYER", "SUPPLIER", "OBSERVER"}.issubset(participant_roles)
            and len(participant_ids) == len(set(participant_ids)),
            "scenario_matrix_complete": len(scenarios) >= 7
            and len(scenario_ids) == len(set(scenario_ids)),
            "stop_rules_present": len(stop_rules) >= 5,
            "evidence_contract_complete": required_evidence.issubset(set(evidence)),
        },
    }


def evaluate_scenario(scenario: dict, seed: int = 20260908) -> dict:
    simulator_scenario = scenario["simulatorScenario"]
    config = SimulationConfig(
        days=90,
        orders_per_day=8,
        scenario=simulator_scenario,
        seed=seed,
    )
    result = GabaBetaSimulator(config).run()
    metrics = result.metrics
    expected = scenario["expected"]
    scenario_block_reason = {
        "document_expiry": "DOCUMENT_INVALID",
        "inventory_mismatch": "INVENTORY_NOT_VERIFIED",
        "seller_verification_failure": "SUPPLIER_NOT_VERIFIED",
    }.get(simulator_scenario)
    scenario_blocked_events = [
        event for event in result.blocked_events
        if scenario_block_reason and event.get("reason") == scenario_block_reason
    ]
    invalid_lot_dates = {
        (event.get("lot_id"), event.get("day"))
        for event in scenario_blocked_events
        if event.get("lot_id") and event.get("day") is not None
    }
    scenario_invalid_lot_trade_count = sum(
        (trade.lot_id, trade.day) in invalid_lot_dates
        for trade in result.trades
    )
    checks = {
        "pretrade_verification_rate": metrics["pretrade_verification_rate"] == 1.0,
        "duplicate_trade_count": metrics["duplicate_trade_count"] == 0,
        "expected_outcome": True,
    }
    if expected == "TRADE_CONFIRMED":
        checks["expected_outcome"] = metrics["completed_trade_count"] > 0
    elif expected == "BLOCKED_BEFORE_TRADE":
        checks["scenario_blocked_event_count"] = len(scenario_blocked_events) > 0
        checks["invalid_lot_trade_count"] = scenario_invalid_lot_trade_count == 0
        checks["expected_outcome"] = checks["scenario_blocked_event_count"] and checks["invalid_lot_trade_count"]
    elif expected == "PARTIAL_FILL_TRACEABLE":
        checks["expected_outcome"] = metrics["partial_fill_event_count"] > 0
    elif expected == "DISPUTED_AFTER_DELIVERY":
        checks["expected_outcome"] = metrics["disputed_trade_count"] > 0
    elif expected == "SETTLEMENT_HOLD":
        checks["expected_outcome"] = metrics["settlement_hold_count"] > 0
    passed = all(checks.values())
    return {
        "scenario_id": scenario["id"],
        "name": scenario["name"],
        "simulator_scenario": simulator_scenario,
        "expected": expected,
        "scenario_block_reason": scenario_block_reason,
        "scenario_blocked_event_count": len(scenario_blocked_events),
        "scenario_invalid_lot_trade_count": scenario_invalid_lot_trade_count,
        "passed": passed,
        "checks": checks,
        "simulation_run_id": result.simulation_run_id,
        "metrics": {
            **metrics,
            "scenario_blocked_event_count": len(scenario_blocked_events),
            "scenario_invalid_lot_trade_count": scenario_invalid_lot_trade_count,
        },
    }


def run_shadow_pilot(seed: int = 20260908) -> dict:
    plan = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
    preflight = validate_pilot_plan(plan)
    if not preflight["passed"]:
        return {
            "schema_version": "SHADOW-PILOT-RUN-0.2",
            "shadow_pilot_id": plan.get("pilotId"),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "mode": plan.get("mode"),
            "real_transactions_enabled": plan.get("realTransactionsEnabled"),
            "real_money_enabled": plan.get("realMoneyEnabled"),
            "external_notifications_enabled": plan.get("externalNotificationsEnabled"),
            "human_principal": plan.get("humanPrincipal"),
            "participant_access_enabled": False,
            "preflight": preflight,
            "decision": "STOP_INCIDENT",
            "scenario_count": 0,
            "passed_scenario_count": 0,
            "results": [],
            "guardrail": "Shadow Pilot 사전 게이트 실패 시 참가자 접근과 시나리오 실행을 모두 차단한다.",
        }
    results = [evaluate_scenario(scenario, seed=seed + index) for index, scenario in enumerate(plan["scenarios"])]
    passed = all(result["passed"] for result in results)
    return {
        "schema_version": "SHADOW-PILOT-RUN-0.2",
        "shadow_pilot_id": plan["pilotId"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": plan["mode"],
        "real_transactions_enabled": plan["realTransactionsEnabled"],
        "real_money_enabled": plan["realMoneyEnabled"],
        "external_notifications_enabled": plan["externalNotificationsEnabled"],
        "human_principal": plan["humanPrincipal"],
        "participant_access_enabled": False,
        "preflight": preflight,
        "decision": "PASS_REVIEW_REQUIRED" if passed else "STOP_INCIDENT",
        "scenario_count": len(results),
        "passed_scenario_count": sum(result["passed"] for result in results),
        "results": results,
        "guardrail": "시나리오 PASS는 참가자 접근 승인이나 실거래 허가를 의미하지 않는다.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="GABA 폐쇄형 Shadow Pilot 실행기")
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--output", type=Path, default=ROOT / "ops" / "latest-shadow-pilot.json")
    args = parser.parse_args()
    report = run_shadow_pilot(seed=args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"decision": report["decision"], "scenario_count": report["scenario_count"], "passed": report["passed_scenario_count"]}, ensure_ascii=False))
    if report["decision"] == "STOP_INCIDENT":
        raise SystemExit(1)


if __name__ == "__main__":
    main()

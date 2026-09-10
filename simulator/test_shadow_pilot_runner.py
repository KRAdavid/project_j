import unittest

from shadow_pilot_runner import run_shadow_pilot, validate_pilot_plan


class ShadowPilotRunnerTests(unittest.TestCase):
    def test_all_closed_pilot_scenarios_pass_their_expected_outcome(self):
        report = run_shadow_pilot(seed=20260908)
        self.assertEqual(report["decision"], "PASS_REVIEW_REQUIRED")
        self.assertEqual(report["scenario_count"], 7)
        self.assertEqual(report["passed_scenario_count"], 7)
        self.assertFalse(report["real_transactions_enabled"])
        self.assertFalse(report["real_money_enabled"])
        self.assertFalse(report["participant_access_enabled"])
        self.assertTrue(report["preflight"]["passed"])
        self.assertTrue(all(report["preflight"]["checks"].values()))
        self.assertTrue(all(item["checks"]["pretrade_verification_rate"] for item in report["results"]))
        self.assertTrue(all(item["checks"]["duplicate_trade_count"] for item in report["results"]))
        blocked = [item for item in report["results"] if item["expected"] == "BLOCKED_BEFORE_TRADE"]
        self.assertTrue(all(item["checks"]["scenario_blocked_event_count"] for item in blocked))
        self.assertTrue(all(item["checks"]["invalid_lot_trade_count"] for item in blocked))
        self.assertTrue(all(item["metrics"]["scenario_invalid_lot_trade_count"] == 0 for item in blocked))

    def test_invalid_plan_fails_closed_before_scenarios_run(self):
        report = validate_pilot_plan({
            "mode": "OPEN_SIMULATION",
            "realTransactionsEnabled": True,
            "realMoneyEnabled": True,
            "externalNotificationsEnabled": True,
            "humanPrincipal": "AI-01",
            "requiredApproval": "NONE",
            "participants": [],
            "scenarios": [],
            "stopRules": [],
            "evidenceToCapture": [],
        })
        self.assertFalse(report["passed"])
        self.assertFalse(report["participant_access_enabled"])
        self.assertGreaterEqual(len(report["violations"]), 5)


if __name__ == "__main__":
    unittest.main()

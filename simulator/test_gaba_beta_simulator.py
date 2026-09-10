import unittest

from gaba_beta_simulator import GabaBetaSimulator, SimulationConfig, run_many


class GabaBetaSimulatorTests(unittest.TestCase):
    def test_normal_run_has_completed_trades_and_no_duplicate_trade_keys(self):
        result = GabaBetaSimulator(SimulationConfig(days=30, orders_per_day=5, seed=7)).run()
        self.assertGreater(result.metrics["trade_count"], 0)
        self.assertGreater(result.metrics["completed_trade_count"], 0)
        self.assertEqual(result.metrics["duplicate_trade_count"], 0)
        self.assertEqual(result.metrics["pretrade_verification_rate"], 1.0)

    def test_document_expiry_is_blocked_before_trade(self):
        result = GabaBetaSimulator(
            SimulationConfig(days=45, orders_per_day=8, scenario="document_expiry", seed=7)
        ).run()
        reasons = {event.get("reason") for event in result.blocked_events}
        self.assertIn("DOCUMENT_INVALID", reasons)
        self.assertEqual(result.metrics["pretrade_verification_rate"], 1.0)

    def test_quality_failure_is_post_delivery_dispute_not_pretrade_failure(self):
        result = GabaBetaSimulator(
            SimulationConfig(days=65, orders_per_day=8, scenario="quality_mismatch", seed=7)
        ).run()
        self.assertGreater(result.metrics["disputed_trade_count"], 0)
        self.assertEqual(result.metrics["pretrade_verification_rate"], 1.0)

    def test_supplier_outage_reduces_completion(self):
        normal = GabaBetaSimulator(SimulationConfig(days=40, orders_per_day=8, seed=7)).run()
        outage = GabaBetaSimulator(
            SimulationConfig(days=40, orders_per_day=8, scenario="supplier_outage", seed=7)
        ).run()
        self.assertLessEqual(
            outage.metrics["completed_trade_rate"], normal.metrics["completed_trade_rate"]
        )

    def test_monte_carlo_summary_is_reproducible_shape(self):
        summary = run_many(SimulationConfig(days=10, orders_per_day=4, seed=11), runs=3)
        self.assertEqual(summary["runs"], 3)
        self.assertGreaterEqual(summary["completed_trade_rate_min"], 0)
        self.assertLessEqual(summary["completed_trade_rate_max"], 1)
        self.assertEqual(summary["duplicate_trade_count_total"], 0)


if __name__ == "__main__":
    unittest.main()

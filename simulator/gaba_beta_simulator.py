"""GABA 원료 거래소 베타 시뮬레이터.

실제 거래·결제·AI API를 호출하지 않는 결정론적 베이스라인이다.
핵심 검증 대상:
  스펙 확정 -> 평균가격 -> 구매주문 -> 사전검증 -> 판매자 체결
  -> 납품/검수 -> 정산

실제 데이터와 구분하기 위해 모든 결과에 simulation_run_id를 부여한다.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import statistics
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Iterable


SPEC_ID = "GABA-SIM-001"
BASE_PRICE = 38_500.0


@dataclass(frozen=True)
class GabaSpec:
    spec_id: str = SPEC_ID
    name: str = "GABA"
    form: str = "powder"
    grade: str = "food-grade-simulation"
    purity: str = "SIMULATED"
    origin: str = "SIMULATED"
    unit: str = "kg"


@dataclass
class SellerLot:
    seller_id: str
    lot_id: str
    spec_id: str
    available_qty: int
    ask_price: float
    delivery_days: int
    document_valid: bool = True
    inventory_verified: bool = True
    supplier_verified: bool = True
    quality_verified: bool = True
    max_daily_supply: int = 1_000


@dataclass
class BuyerProfile:
    buyer_id: str
    monthly_demand: int
    max_price: float
    preferred_delivery_days: int
    repeat_probability: float


@dataclass
class BuyerOrder:
    order_id: str
    buyer_id: str
    spec_id: str
    bid_price: float
    requested_qty: int
    delivery_days: int
    valid_for_days: int
    partial_fill_allowed: bool = True


@dataclass
class Trade:
    trade_id: str
    order_id: str
    buyer_id: str
    seller_id: str
    lot_id: str
    spec_id: str
    price: float
    qty: int
    day: int
    pretrade_verified: bool
    delivery_ok: bool
    quality_ok: bool
    settlement_ok: bool
    status: str
    block_reason: str | None = None


@dataclass
class SimulationConfig:
    days: int = 90
    buyers: int = 10
    sellers: int = 20
    initial_lots_per_seller: int = 2
    orders_per_day: int = 8
    seed: int = 42
    scenario: str = "normal"


@dataclass
class SimulationResult:
    simulation_run_id: str
    scenario: str
    config: dict
    metrics: dict
    trades: list[Trade] = field(default_factory=list)
    price_series: list[dict] = field(default_factory=list)
    blocked_events: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "simulation_run_id": self.simulation_run_id,
            "scenario": self.scenario,
            "config": self.config,
            "metrics": self.metrics,
            "trades": [asdict(t) for t in self.trades],
            "price_series": self.price_series,
            "blocked_events": self.blocked_events,
        }


class GabaBetaSimulator:
    """가상 구매자·판매자와 거래소 규칙을 실행하는 시뮬레이터."""

    def __init__(self, config: SimulationConfig):
        self.config = config
        self.rng = random.Random(config.seed)
        self.spec = GabaSpec()
        self.buyers = self._make_buyers()
        self.lots = self._make_lots()
        self.trades: list[Trade] = []
        self.price_series: list[dict] = []
        self.blocked_events: list[dict] = []
        self._order_counter = 0

    def _make_buyers(self) -> list[BuyerProfile]:
        return [
            BuyerProfile(
                buyer_id=f"BUYER-{i:02d}",
                monthly_demand=self.rng.randint(60, 220),
                max_price=BASE_PRICE * self.rng.uniform(0.97, 1.08),
                preferred_delivery_days=self.rng.randint(5, 18),
                repeat_probability=self.rng.uniform(0.25, 0.75),
            )
            for i in range(1, self.config.buyers + 1)
        ]

    def _make_lots(self) -> list[SellerLot]:
        lots: list[SellerLot] = []
        for seller_index in range(1, self.config.sellers + 1):
            for lot_index in range(1, self.config.initial_lots_per_seller + 1):
                price = BASE_PRICE * self.rng.uniform(0.94, 1.07)
                lots.append(
                    SellerLot(
                        seller_id=f"SELLER-{seller_index:02d}",
                        lot_id=f"LOT-{seller_index:02d}-{lot_index:02d}",
                        spec_id=SPEC_ID,
                        available_qty=self.rng.randint(80, 450),
                        ask_price=round(price, 2),
                        delivery_days=self.rng.randint(3, 20),
                        max_daily_supply=self.rng.randint(80, 400),
                    )
                )
        return lots

    def _scenario_price_factor(self, day: int) -> float:
        factor = 1.0 + 0.015 * math.sin(day / 8.0)
        scenario = self.config.scenario
        if scenario == "demand_surge" and 25 <= day <= 40:
            factor += 0.12
        if scenario == "price_spike" and 45 <= day <= 50:
            factor += 0.25
        if scenario == "price_drop" and 55 <= day <= 62:
            factor -= 0.18
        noise = self.rng.gauss(0, 0.008)
        return max(0.5, factor + noise)

    def _reference_price(self) -> float:
        completed = [
            t.price * t.qty
            for t in self.trades
            if t.status == "COMPLETED" and t.spec_id == SPEC_ID
        ]
        quantity = [t.qty for t in self.trades if t.status == "COMPLETED" and t.spec_id == SPEC_ID]
        if not quantity:
            return BASE_PRICE
        return sum(completed) / sum(quantity)

    def _make_order(self, buyer: BuyerProfile, day: int, reference_price: float) -> BuyerOrder:
        self._order_counter += 1
        surge = 1.0
        if self.config.scenario == "demand_surge" and 25 <= day <= 40:
            surge = 1.3
        requested_qty = max(10, int(buyer.monthly_demand / 20 * surge * self.rng.uniform(0.7, 1.4)))
        bid = min(buyer.max_price, reference_price * self.rng.uniform(0.96, 1.04))
        return BuyerOrder(
            order_id=f"ORDER-{self._order_counter:05d}",
            buyer_id=buyer.buyer_id,
            spec_id=SPEC_ID,
            bid_price=round(bid, 2),
            requested_qty=requested_qty,
            delivery_days=buyer.preferred_delivery_days,
            valid_for_days=self.rng.choice([1, 2, 3]),
            partial_fill_allowed=True,
        )

    def _apply_scenario_to_lots(self, day: int) -> None:
        scenario = self.config.scenario
        for lot in self.lots:
            lot.document_valid = True
            lot.inventory_verified = True
            lot.supplier_verified = True
            lot.quality_verified = True
            if scenario == "supplier_outage" and 20 <= day <= 35 and lot.seller_id in {"SELLER-01", "SELLER-02", "SELLER-03"}:
                lot.available_qty = 0
            if scenario == "document_expiry" and 30 <= day <= 45 and lot.lot_id.endswith("-02"):
                lot.document_valid = False
            if scenario == "inventory_mismatch" and 40 <= day <= 55 and lot.lot_id.endswith("-01"):
                lot.inventory_verified = False
            # A quality mismatch is intentionally detected after delivery.
            # Pre-trade evidence can be valid while the delivered material
            # still fails the contract specification during inspection.
            if scenario == "seller_verification_failure" and 15 <= day <= 25 and lot.seller_id == "SELLER-04":
                lot.supplier_verified = False

    def _pretrade_gate(self, order: BuyerOrder, lot: SellerLot, day: int) -> tuple[bool, str | None]:
        checks = [
            (lot.spec_id == order.spec_id, "SPEC_MISMATCH"),
            (lot.supplier_verified, "SUPPLIER_NOT_VERIFIED"),
            (lot.document_valid, "DOCUMENT_INVALID"),
            (lot.inventory_verified, "INVENTORY_NOT_VERIFIED"),
            (lot.quality_verified, "QUALITY_NOT_VERIFIED"),
            (lot.available_qty > 0, "NO_AVAILABLE_INVENTORY"),
            (lot.delivery_days <= order.delivery_days, "DELIVERY_NOT_FEASIBLE"),
            (lot.ask_price <= order.bid_price, "PRICE_NOT_ACCEPTABLE"),
        ]
        for passed, reason in checks:
            if not passed:
                return False, reason
        return True, None

    def _eligible_lots(self, order: BuyerOrder, day: int) -> list[SellerLot]:
        candidates: list[SellerLot] = []
        for lot in self.lots:
            passed, reason = self._pretrade_gate(order, lot, day)
            if passed:
                candidates.append(lot)
            else:
                self.blocked_events.append(
                    {"day": day, "order_id": order.order_id, "lot_id": lot.lot_id, "reason": reason}
                )
        return sorted(candidates, key=lambda lot: (lot.ask_price, lot.delivery_days, lot.seller_id))

    def _execute_order(self, order: BuyerOrder, day: int) -> None:
        remaining = order.requested_qty
        for lot in self._eligible_lots(order, day):
            if remaining <= 0:
                break
            qty = min(remaining, lot.available_qty, lot.max_daily_supply)
            if qty <= 0:
                continue
            lot.available_qty -= qty
            remaining -= qty
            trade = Trade(
                trade_id=f"TRADE-{len(self.trades) + 1:05d}",
                order_id=order.order_id,
                buyer_id=order.buyer_id,
                seller_id=lot.seller_id,
                lot_id=lot.lot_id,
                spec_id=order.spec_id,
                price=lot.ask_price,
                qty=qty,
                day=day,
                pretrade_verified=True,
                delivery_ok=True,
                quality_ok=True,
                settlement_ok=True,
                status="COMPLETED",
            )
            self.trades.append(trade)
            self._fulfill_trade(trade, lot, day)
            if not order.partial_fill_allowed and remaining > 0:
                break

        if remaining > 0:
            self.blocked_events.append(
                {"day": day, "order_id": order.order_id, "reason": "PARTIALLY_OR_NOT_FILLED", "remaining_qty": remaining}
            )

    def _fulfill_trade(self, trade: Trade, lot: SellerLot, day: int) -> None:
        scenario = self.config.scenario
        # SELLER-07 remains active in the deterministic pilot seed, ensuring
        # the scenario actually reaches delivery and exercises the delay path.
        if scenario == "delivery_delay" and 35 <= day <= 50 and lot.seller_id == "SELLER-07":
            trade.delivery_ok = False
        if scenario == "quality_mismatch" and 50 <= day <= 65 and lot.lot_id.endswith("-02"):
            trade.quality_ok = False
        if scenario == "settlement_error" and 60 <= day <= 75 and trade.trade_id.endswith(("3", "7")):
            trade.settlement_ok = False
        if not trade.delivery_ok:
            trade.status = "DISPUTED"
            trade.block_reason = "DELIVERY_DELAY"
        elif not trade.quality_ok:
            trade.status = "DISPUTED"
            trade.block_reason = "POST_DELIVERY_QUALITY_MISMATCH"
        elif not trade.settlement_ok:
            trade.status = "SETTLEMENT_HOLD"
            trade.block_reason = "SETTLEMENT_RECONCILIATION_ERROR"

    def run(self) -> SimulationResult:
        run_id = f"SIM-{uuid.uuid4().hex[:10].upper()}"
        for day in range(1, self.config.days + 1):
            self._apply_scenario_to_lots(day)
            factor = self._scenario_price_factor(day)
            reference = self._reference_price() * factor
            self.price_series.append(
                {
                    "day": day,
                    "date": (date.today() + timedelta(days=day - 1)).isoformat(),
                    "spec_id": SPEC_ID,
                    "reference_price": round(reference, 2),
                    "data_status": "SIMULATED",
                }
            )
            buyers = self.rng.sample(self.buyers, k=min(len(self.buyers), self.config.orders_per_day))
            for buyer in buyers:
                self._execute_order(self._make_order(buyer, day, reference), day)

        metrics = self._metrics()
        return SimulationResult(
            simulation_run_id=run_id,
            scenario=self.config.scenario,
            config=asdict(self.config),
            metrics=metrics,
            trades=self.trades,
            price_series=self.price_series,
            blocked_events=self.blocked_events,
        )

    def _metrics(self) -> dict:
        total = len(self.trades)
        completed = sum(t.status == "COMPLETED" for t in self.trades)
        disputed = sum(t.status == "DISPUTED" for t in self.trades)
        settlement_holds = sum(t.status == "SETTLEMENT_HOLD" for t in self.trades)
        pretrade_verified = sum(t.pretrade_verified for t in self.trades)
        delivery_ok = sum(t.delivery_ok for t in self.trades)
        quality_ok = sum(t.quality_ok for t in self.trades)
        settlement_ok = sum(t.settlement_ok for t in self.trades)
        observed_prices = [t.price for t in self.trades]
        blocked = len(self.blocked_events)
        return {
            "trade_count": total,
            "completed_trade_count": completed,
            "completed_trade_rate": round(completed / total, 4) if total else 0.0,
            "disputed_trade_count": disputed,
            "settlement_hold_count": settlement_holds,
            "pretrade_verification_rate": round(pretrade_verified / total, 4) if total else 0.0,
            "delivery_success_rate": round(delivery_ok / total, 4) if total else 0.0,
            "quality_success_rate": round(quality_ok / total, 4) if total else 0.0,
            "settlement_success_rate": round(settlement_ok / total, 4) if total else 0.0,
            "blocked_event_count": blocked,
            "partial_fill_event_count": sum(event.get("reason") == "PARTIALLY_OR_NOT_FILLED" for event in self.blocked_events),
            "duplicate_trade_count": self._duplicate_trade_count(),
            "avg_completed_price": round(statistics.mean(observed_prices), 2) if observed_prices else None,
            "total_completed_qty": sum(t.qty for t in self.trades if t.status == "COMPLETED"),
            "price_observation_count": len(observed_prices),
        }

    def _duplicate_trade_count(self) -> int:
        keys = [(t.buyer_id, t.seller_id, t.lot_id, t.day) for t in self.trades]
        return len(keys) - len(set(keys))


def run_many(config: SimulationConfig, runs: int) -> dict:
    results = []
    for offset in range(runs):
        run_config = SimulationConfig(**{**asdict(config), "seed": config.seed + offset})
        results.append(GabaBetaSimulator(run_config).run())
    metrics = [result.metrics for result in results]
    completed_rates = [m["completed_trade_rate"] for m in metrics]
    return {
        "scenario": config.scenario,
        "runs": runs,
        "completed_trade_rate_mean": round(statistics.mean(completed_rates), 4),
        "completed_trade_rate_min": round(min(completed_rates), 4),
        "completed_trade_rate_max": round(max(completed_rates), 4),
        "duplicate_trade_count_total": sum(m["duplicate_trade_count"] for m in metrics),
        "pretrade_verification_rate_min": min(m["pretrade_verification_rate"] for m in metrics),
        "quality_success_rate_min": min(m["quality_success_rate"] for m in metrics),
        "settlement_success_rate_min": min(m["settlement_success_rate"] for m in metrics),
    }


def write_result(result: SimulationResult, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")


def write_trade_csv(result: SimulationResult, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    fields = list(asdict(result.trades[0]).keys()) if result.trades else list(asdict(Trade("", "", "", "", "", "", 0, 0, 0, False, False, False, False, "")).keys())
    with output.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(asdict(trade) for trade in result.trades)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="GABA 원료 거래소 베타 시뮬레이터")
    parser.add_argument("--scenario", default="normal", choices=[
        "normal", "demand_surge", "supplier_outage", "document_expiry",
        "inventory_mismatch", "quality_mismatch", "delivery_delay",
        "settlement_error", "price_spike", "price_drop", "seller_verification_failure",
    ])
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--orders-per-day", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--output", type=Path, default=Path("simulation_output/gaba_result.json"))
    parser.add_argument("--csv", type=Path, default=None)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    config = SimulationConfig(
        days=args.days,
        orders_per_day=args.orders_per_day,
        seed=args.seed,
        scenario=args.scenario,
    )
    if args.runs > 1:
        summary = run_many(config, args.runs)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return

    result = GabaBetaSimulator(config).run()
    write_result(result, args.output)
    if args.csv:
        write_trade_csv(result, args.csv)
    print(json.dumps({"simulation_run_id": result.simulation_run_id, **result.metrics}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

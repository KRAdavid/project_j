# Raw Material OS · GABA public beta

A runnable B2B physical raw-material trading beta for GABA.

The product flow is:

1. Resolve a material name into a standardized Material Master record.
2. Confirm the required specification through a guided questionnaire.
3. Expose only verified lots with valid evidence and available inventory.
4. Submit a buyer price and quantity, then let an eligible supplier accept or reject.
5. Preserve the trade snapshot and continue through delivery and inspection.

This repository is a simulation and engineering beta. It does not execute real payments, contracts, or capital-market products. Production use requires independent legal, security, infrastructure, supplier-verification, and operational review.

## Run

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm start:beta
```

Open http://127.0.0.1:4173/ and select the buyer/supplier simulation view.

## Safety boundary

AI components may analyze and prepare actions, but final trade, contract, payment, dispute, and production decisions remain human-gated. Prices and trends are published only when the configured evidence and approval policy allows them.


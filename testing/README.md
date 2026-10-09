# BOARDLINK test suite and evidence (September 30, 2026)

## Unit tests (Jest)
    npm install
    npm start                # in one terminal (MySQL + Meilisearch running, seed data loaded)
    npm test                 # in another terminal
The tests sign in as the seed accounts with the password in TEST_PASSWORD
(default Test@2026!). Set the seed users' password to that value first, or
set TEST_PASSWORD to yours. Result on Sep 30: 61 / 61 passed (54 first-round tests + 7 regression tests)
(first run 52 / 54 — see evidence/unit_first_run_*.log).

## Stress tests (stress/)
    cd testing/stress && npm init -y && npm install autocannon@7
    node p1_login.js | p2_retrieval.js | p3_upload.js | p4_sustained.js
Set TRUST_PROXY=1 in .env so each simulated user gets its own address.
p3_upload.js needs a ~1 MB scanned PDF named scan_1mb.pdf beside it.

## Security scan (OWASP ZAP 2.16.1)
Start xff_proxy.js (forwards :3100 -> :3000), sign in through :3100, paste the
boardlink.sid cookie into zap_plan.yaml, then:
    zap.sh -cmd -autorun zap_plan.yaml

## evidence/
Raw outputs used in Chapter 4: Jest logs, the four stress-test JSON results,
the memory samples of the 30-minute run, and the ZAP HTML/JSON report.

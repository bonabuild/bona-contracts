# BONA — contracts

The smart contracts behind [BonaBuild](https://bonabuild.org), and the
tests that prove what they can and cannot do.

**This repository is not the software library.** BonaBuild's business
applications live in their own repositories. What is here is the token
layer: the contract that holds the supply, the contracts that hold it in
vesting, and the contract that will hold buyers' money during a sale
round.

---

## Deployed on Base (chain ID 8453)

| Contract | Address | |
|---|---|---|
| **BonaToken** | `0xC0833296346D7a699949B5DF547279b1641Ea2cd` | [source ↗](https://basescan.org/address/0xC0833296346D7a699949B5DF547279b1641Ea2cd#code) |
| TeamVesting | `0xEf05C6Ce1C47118d411a3C1D8FEcC128dcF87229` | [source ↗](https://basescan.org/address/0xEf05C6Ce1C47118d411a3C1D8FEcC128dcF87229#code) |
| RoundVesting | `0xdaAFEFfBA13f0573609575Ee028621C812eD5976` | [source ↗](https://basescan.org/address/0xdaAFEFfBA13f0573609575Ee028621C812eD5976#code) |
| RequestBacking | `0xbFB03dfb3cC04C95ff4a92F4866F1D9396F4b7E4` | [source ↗](https://basescan.org/address/0xbFB03dfb3cC04C95ff4a92F4866F1D9396F4b7E4#code) |

The entire supply — 100,000,000 BONA, fixed — is held by the project
multisig at
[`0x6410…801B`](https://basescan.org/address/0x6410d637abcD92f3B68A8a2c285581b5551A801B),
which requires 2 of 4 published signers for any movement. No single key
can move anything.

`SaleRound.sol` is written and tested but **not deployed**. One is
deployed per funded round.

### There is one BONA contract

**`0xC0833296346D7a699949B5DF547279b1641Ea2cd` on Base. Nothing else is
BONA.**

This code is MIT, so anyone may copy it and deploy their own token — and
sooner or later someone will. That is what the licence permits and it
takes nothing from this project. But a copy is a *different contract at a
different address*: it has no connection to BonaBuild, no claim on this
treasury, no weight in this governance, and no relationship to the supply
above. It is a new and unrelated token that happens to share a name.

Before you touch anything calling itself BONA, check its address against
this README **and** against [bonabuild.org](https://bonabuild.org). If
the two ever disagree, trust neither and open an issue here.

We will never announce a new contract address on social media alone, and
we will never ask you to send funds to an address that is not published
in both places at once.

---

## The claims, and where to check them

Every line below is checkable without trusting us. That is the point of
publishing this repository at all.

| Claim | How to check it yourself |
|---|---|
| Supply is fixed at 100,000,000 | `contracts/BonaToken.sol` — the constructor mints once. There is no other mint path |
| There is **no** mint function | `npm test` — `BonaToken.test.js` inspects the *compiled ABI* and fails if one appears |
| There is no owner, pause, or blacklist | Same test file, same method |
| Vesting cannot be clawed back | `test/TeamVesting.test.js`, `test/RoundVesting.test.js` — no revoke path exists to test |
| Backers can always withdraw | `test/RequestBacking.test.js` — withdrawal is asserted in every request state |
| Round refunds need nobody's permission | `test/SaleRound.test.js` — `markFailed()` is called by an unrelated address |
| The deployed bytecode matches this source | Basescan "source ↗" links above — verified, byte for byte |

The convention this project holds itself to: **every safety claim made on
the website has a test here.** If a test is deleted, the claim it backs
must be deleted in the same commit.

### Run the tests

```bash
npm install
npm test          # 187 tests
```

No configuration, no keys, no network needed. Tests run against a local
chain.

---

## ⚠️ Not audited

These contracts have **not been through a professional external audit.**
They are deployed on mainnet and hold real value.

This is stated here, on the website, and in `SECURITY.md`, and it is the
most important sentence in this repository. What was done instead — 186
tests, a 22-step lifecycle rehearsal on Base Sepolia, an internal
adversarial review with findings and fixes — is described in
[`docs/audit-status.md`](docs/audit-status.md). None of it replaces an
audit.

**Review of `SaleRound.sol` is especially welcome.** It is the contract
that will hold buyers' money, and it is not deployed yet — findings are
still free to act on. See [`SECURITY.md`](SECURITY.md).

---

## What is in here

```
contracts/    5 contracts + mocks used only by tests
test/         187 tests — the claim registry described above
scripts/      deploy, seat assignment, cost measurement,
              and the 22-step round rehearsal
docs/         design reasoning and audit status
```

## Licence

MIT — see [`LICENSE`](LICENSE). Read it, fork it, audit it, reuse it.

Other BonaBuild repositories carry different licences by design:
self-hosted applications are AGPL-3.0 with full source; desktop and
mobile applications are free but **closed** under the BonaBuild Freeware
Licence. Those are free software in price, not in the open-source sense,
and this project does not describe them as open source.

---

## BONA is not an investment

BONA funds development and directs what gets built next. It is not a
share, it carries no claim on revenue, and it comes with no promise of
return. There is no buy-back and no price floor — not as policy, but as
a rule this project does not break.

If you ever pay for BONA: **you may lose the entire amount you pay.**

Project, model and governance: **[bonabuild.org](https://bonabuild.org)**

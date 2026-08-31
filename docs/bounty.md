# Bug bounty

**What a finding is worth is decided here, before it is found.**

That is the entire point of publishing a schedule. If the amount were
settled after a report arrived, the party negotiating it would be the one
with an interest in calling the bug smaller than it is. This page removes
that conversation.

---

## Read this before the table

**Payment is in BONA, and BONA has no market.** There is no exchange
listing, no liquidity pool, and no way to sell it today. A bounty paid now
is a governance token that vests nothing and trades nowhere. If that is
not worth your time, it is entirely reasonable to say so — and reporting
anyway, for nothing, is also welcome. We would rather know.

**No liquidity is promised, and no date is given for any.** A pool is
seeded from sale proceeds once there is enough to make one that is not
cosmetic. That is a plan, not a commitment, and nothing here should be
read as one.

**These contracts are not audited.** See
[`audit-status.md`](audit-status.md). That is the reason this programme
exists rather than a reason to expect it to be quiet.

---

## The schedule

| Severity | What it means | Reward |
|---|---|---:|
| **Critical** | Funds can be taken, or permanently lost. A buyer pays and cannot claim. Supply can be created | **500,000 BONA** |
| **High** | Funds locked with no path out. A privileged action reaches something the docs say it cannot. The sale can be made to accept payment without granting | **200,000 BONA** |
| **Medium** | Accounting is wrong but recoverable. A guard can be bypassed without reaching funds. State can be corrupted in a way that needs intervention | **50,000 BONA** |
| **Low** | A revert where a clean failure was intended, gas griefing, a bound that does not bind | **10,000 BONA** |
| **Application** | A reproducible defect in a BonaBuild application, verified by the team | **5,000 BONA** |
| **Documentation** | A published claim the code does not support | **2,500 BONA** |

At the published sale price of 1 USDC = 100 BONA, the top band is $5,000
of notional value. The paragraph above about liquidity applies to that
number as much as to any other.

### Why the top band is what it is

**It tracks what is actually at risk.** The sale holds one instalment at a
time — 500,000 BONA as this is written, and the amount is public at
[`DirectSale`](https://basescan.org/address/0xc552c1eE35629d29e9A7d73b1deb14cfea433881).
Paying a critical finding roughly what a critical finding could have cost
is the proportion that makes sense for a project this size.

When the instalment rises, this table rises with it, and the change is
made here before it is relied on. A schedule that stayed flat while the
exposure grew would be a schedule that quietly got worse.

---

## Scope

**In scope, and read first:**

| Contract | Address | Why |
|---|---|---|
| `DirectSale` | `0xc552c1eE35629d29e9A7d73b1deb14cfea433881` | Takes buyers' money |
| `SaleVesting` | `0x51f748210D3d6D409f95325e2F9ef9C5Ea590F41` | Holds buyers' tokens |

**Also in scope:** `BonaToken`, `TeamVesting`, `RequestBacking`, everything
in `scripts/`, and the website at bonabuild.org where a defect could
mislead someone about an address, a price or a risk.

A script that prints wrong multisig calldata is a real vulnerability, not
a convenience bug, and is paid as one.

**Out of scope:** the Base sequencer, RPC providers, Snapshot, USDC, wallet
extensions, and anything already listed as known and accepted in
[`../SECURITY.md`](../SECURITY.md). Reports that restate a documented
weakness are not findings; reports that add a **concrete exploit path** to
one are, and are paid at whatever severity the path earns.

---

## How severity is decided

By what an attacker gains, not by how clever the bug is.

The judgement is ours, and that is an obvious weakness in a page written
by us, so two things bound it:

1. **The reasoning is published with the payment** — the finding, the
   band, and why. If a decision looks self-serving, it is on the record
   looking that way.
2. **Ties go up, not down.** Where a finding sits between two bands, it is
   paid at the higher one. A rule that resolved doubt in our favour would
   make every borderline case a negotiation, which is what the schedule
   exists to prevent.

If a reporter disagrees, they are free to publish our reasoning alongside
theirs. That is the correction mechanism, and it works.

---

## Rules

**One report per issue, first by timestamp.** Duplicates of an already
reported finding are not paid. If two reports arrive close together, the
earlier email wins, and both are told.

**Report privately if it can move funds.** Email
**security@bonabuild.org**. Anything that cannot — a wrong number, a
broken claim, a document that contradicts a contract — is better as a
public issue.

**Give us a window before publishing.** Not because disclosure is
unwelcome, but because a live bug should be closed before it is
advertised. We publish the finding and the fix ourselves either way.

**Safe harbour**, as stated in [`../SECURITY.md`](../SECURITY.md): no legal
action against anyone acting in good faith — testing against the addresses
above or your own fork, not exfiltrating data, not disrupting other users.

**We do not pay for:** automated scanner output with no exploit path,
theoretical issues with no impact, missing best practices that cost
nothing here, or anything requiring a compromised private key to begin
with.

---

## What gets published

Every payment: what was found, which band, what was paid, and the
transaction hash — in [`contributors.md`](contributors.md), which exists
already and is empty, so the format was fixed before there was anything to
present favourably. Credit by name or handle, or anonymity — the reporter
chooses, and the choice is respected in the write-up.

Findings are published whether or not they were exploited, and whether or
not they make us look careless.

---

## When this changes

This file is the schedule. Not a blog post, not an announcement, not a
message in a channel — a change that is not here has not happened.

The amounts move when the instalment at risk moves, and they move here
first. Anyone who reported under an older version is paid under whichever
version is better for them.

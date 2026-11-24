# makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun · rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/RieryBuild/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun · reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/RieryBuild/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b): a selective paper-trading bot for pump.fun bonding curves, run on a 6-hour replay and ranked by net PnL.

## Strategy

Buy once per coin, only when the crowd has already shown up: real SOL
reserves at or above 5 SOL, price at least 2% above the create price, at
least 45 distinct buyers, buys at least 65% of the coin's trades, and at
least 10 new distinct buyers in the last 300 slots. Buy size is 0.06 SOL
capped at 95% of the 1%-of-real-reserve order cap. Exit on a fixed +20%
take-profit, a −10% stop-loss, or a 2400-slot hold timeout. At most 5 open
positions, at most 2 buys per batch, one trade per coin.

Why this shape: the dev data shows a 2-slot fill latency buys the top of a
burst spike (a latency-free entry averages +7.6% per trade; delayed 2 slots
it averages −0.4%), and round-trip fees of ~1.25% per side plus 105,000
lamports per order punish frequent trading — the dev leaderboard's top
entries all sit near 65 fills while 450+ fills lose half a SOL. Breadth is
the filter that survives the latency: broad coins win ~40% of round trips
at +20%/−10% exits with a ~2% max drawdown on the dev window.

## Run it

Node 22, standard library only, no dependencies, no network. The program
speaks agent-fun/replay/v2 on stdin/stdout (hello, batch…, done → one reply
per batch) and is fully deterministic: no clock, no unseeded randomness, so
two runs produce byte-identical action logs.

## Files

- `main.ts` — the entrypoint.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the entry's payout wallet.

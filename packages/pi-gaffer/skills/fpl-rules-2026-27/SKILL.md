---
name: fpl-rules-2026-27
description: Fantasy Premier League rules for 2026/27 in words - squad and formation, budget and selling prices, free transfers and hits, the eight chips and their windows, captaincy, bench and automatic substitutions, scoring including defensive contributions. Read when a rule is in question or the validator rejects a plan.
---

# FPL rules, 2026/27

The authority is the code and the data: `gaffer_lib.rules` reads the season's parameters from the snapshot's `bootstrap-static.json` (`game_settings`, `element_types`, `chips`, `game_config.scoring`), and the validator applies them. This page says what they mean. If this page and the validator disagree, the validator is right; to see a value, read it:

```python
from gaffer_lib import rules, snapshot
r = rules.Rules.from_bootstrap(snapshot.Snapshot("<snapshot path>").bootstrap)
```

## Squad

- 15 players: 2 goalkeepers, 5 defenders, 5 midfielders, 3 forwards.
- At most 3 from one club.
- Budget: what you can spend is your bank plus the **selling** prices of the players you sell, not their current prices.
- Selling price: if a player has risen since you bought him, you keep half the rise, rounded down to £0.1m. If he has fallen, you take the whole fall. Selling prices aren't public: Gaffer derives them from the transfer history and says so.

## Starting XI, bench and automatic substitutions

- 11 start: exactly 1 goalkeeper, at least 3 defenders, at least 2 midfielders, at least 1 forward.
- The bench is ordered: the substitute goalkeeper, then outfield 1, 2, 3.
- A starter who plays no minutes is replaced by the first bench player in order who played and whose inclusion leaves a legal formation. A goalkeeper is only replaced by the goalkeeper.
- Captain scores double. If the captain plays no minutes, the vice-captain scores double instead.

## Transfers

- One free transfer each GW. Unused ones roll over, up to 5 in the bank.
- Each transfer beyond the free ones costs 4 points (a "hit").
- Free transfers and transfers already made for the next GW aren't public: Gaffer derives the count, and the user can correct it with `/team <id> --ft N --pending "OUT>IN"`.

## Chips

- Wildcard, Free Hit, Bench Boost, Triple Captain: one of each in the first half (through GW19) and one of each in the second (from GW20). Eight in all.
- One chip per GW. A first-half chip not played by the GW19 deadline is lost.
- Wildcard: unlimited free transfers that GW, permanent. Free Hit: unlimited free transfers for one GW, then the squad reverts. Both leave the free-transfer count as it was.
- Bench Boost: all 15 score. Triple Captain: the captain scores triple.
- A Free Hit can't be played in consecutive GWs, including GW19 then GW20.
- No Assistant Manager chip this season.

## Scoring

Read from `game_config.scoring`: appearance (more for 60 minutes), goals by position, assists, clean sheets by position, saves, goals conceded, cards, own goals, penalties, bonus. Defensive contributions add points to a defender, midfielder or forward who reaches his position's threshold in a match. `gaffer_lib.rules.Scoring` reproduces FPL's points exactly on every finished GW this season.

## Blank and double gameweeks

A club with no fixture in a GW blanks; one with two has a double. Gaffer counts fixtures per club from the snapshot every time and flags any within the horizon.

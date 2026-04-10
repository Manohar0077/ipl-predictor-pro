# Cricbuzz Unofficial APIs

All endpoints used in this project — no official documentation exists. These are reverse-engineered from cricbuzz.com browser traffic. They work as of IPL 2025 but may break if Cricbuzz changes their internal API contract.

No API key is required. All three endpoints are free.

---

## Authentication

All endpoints require browser-like headers to avoid 403s:

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
Accept: application/json
Accept-Language: en-US,en;q=0.9
Referer: https://www.cricbuzz.com/
Origin: https://www.cricbuzz.com
```

---

## Endpoint 1 — Live Matches

**Name:** Live Match List

**Description:** Returns all currently live cricket matches worldwide, grouped by match type (International, Domestic, etc.). Used to poll real-time scores and discover Cricbuzz match IDs for active IPL games.

### Request

```bash
curl -X GET "https://www.cricbuzz.com/api/cricket-match/live" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  -H "Accept: application/json" \
  -H "Accept-Language: en-US,en;q=0.9" \
  -H "Referer: https://www.cricbuzz.com/" \
  -H "Origin: https://www.cricbuzz.com"
```

### Response

```json
{
  "typeMatches": [
    {
      "matchType": "Domestic",
      "seriesMatches": [
        {
          "seriesAdWrapper": {
            "seriesId": 9241,
            "seriesName": "Indian Premier League 2025",
            "matches": [
              {
                "matchInfo": {
                  "matchId": 112456,
                  "seriesId": 9241,
                  "seriesName": "Indian Premier League 2025",
                  "matchDesc": "1st Match",
                  "matchFormat": "T20",
                  "startDate": "1743772200000",
                  "endDate": "1743793800000",
                  "state": "In Progress",
                  "status": "MI opt to bat",
                  "team1": {
                    "teamId": 5,
                    "teamName": "Mumbai Indians",
                    "teamSName": "MI",
                    "imageId": 172116
                  },
                  "team2": {
                    "teamId": 2,
                    "teamName": "Chennai Super Kings",
                    "teamSName": "CSK",
                    "imageId": 172115
                  },
                  "venueId": 24,
                  "venueName": "Wankhede Stadium, Mumbai",
                  "tossResults": {
                    "tossWinnerId": 2,
                    "tossWinnerName": "Chennai Super Kings",
                    "decision": "bowl"
                  }
                },
                "matchScore": {
                  "team1Score": {
                    "inngs1": {
                      "inningsId": 1,
                      "runs": 182,
                      "wickets": 5,
                      "overs": 20.0,
                      "target": null
                    }
                  },
                  "team2Score": {
                    "inngs1": {
                      "inningsId": 2,
                      "runs": 143,
                      "wickets": 6,
                      "overs": 16.3,
                      "target": 183
                    }
                  }
                }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

### Key Fields

| Field | Type | Description |
|---|---|---|
| `matchInfo.matchId` | number | Cricbuzz internal match ID — used in the commentary endpoint |
| `matchInfo.state` | string | `"In Progress"`, `"Complete"`, `"Upcoming"` |
| `matchInfo.status` | string | Human-readable status, e.g. `"MI won by 20 runs"` |
| `matchInfo.startDate` | string | Unix timestamp in milliseconds |
| `matchInfo.team1.teamName` | string | Full team name, e.g. `"Mumbai Indians"` |
| `matchInfo.team1.teamSName` | string | Short name, e.g. `"MI"` |
| `matchInfo.tossResults.tossWinnerName` | string | Full team name of toss winner |
| `matchInfo.tossResults.decision` | string | `"bat"` or `"bowl"` |
| `matchScore.team1Score.inngs1.runs` | number | Runs scored |
| `matchScore.team1Score.inngs1.wickets` | number | Wickets fallen |
| `matchScore.team1Score.inngs1.overs` | number | Overs completed |

---

## Endpoint 2 — Recent Matches

**Name:** Recent Match List

**Description:** Returns recently completed matches. Structurally identical to the live endpoint. Used alongside Endpoint 1 to detect match results — a finished match disappears from `/live` before the result is fully propagated, so both endpoints are merged and deduplicated.

### Request

```bash
curl -X GET "https://www.cricbuzz.com/api/cricket-match/recent" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  -H "Accept: application/json" \
  -H "Accept-Language: en-US,en;q=0.9" \
  -H "Referer: https://www.cricbuzz.com/" \
  -H "Origin: https://www.cricbuzz.com"
```

### Response

Same structure as Endpoint 1. The `matchInfo.state` will be `"Complete"` and `matchInfo.status` contains the result string.

```json
{
  "typeMatches": [
    {
      "matchType": "Domestic",
      "seriesMatches": [
        {
          "seriesAdWrapper": {
            "matches": [
              {
                "matchInfo": {
                  "matchId": 112455,
                  "state": "Complete",
                  "status": "Royal Challengers Bengaluru won by 7 wickets",
                  "team1": { "teamName": "Kolkata Knight Riders", "teamSName": "KKR" },
                  "team2": { "teamName": "Royal Challengers Bengaluru", "teamSName": "RCB" },
                  "tossResults": {
                    "tossWinnerName": "Kolkata Knight Riders",
                    "decision": "bat"
                  }
                },
                "matchScore": {
                  "team1Score": {
                    "inngs1": { "runs": 151, "wickets": 8, "overs": 20.0 }
                  },
                  "team2Score": {
                    "inngs1": { "runs": 155, "wickets": 3, "overs": 17.4 }
                  }
                }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

### Key Fields

| Field | Description |
|---|---|
| `matchInfo.state = "Complete"` | Signals the match has finished |
| `matchInfo.status` | Result string — parsed to extract winner, e.g. `"RCB won by 7 wickets"` |

---

## Endpoint 3 — Ball-by-Ball Commentary

**Name:** Full Commentary

**Description:** Returns ball-by-ball commentary for a specific match, including a live mini-scorecard with current score, run rates, and target. The `{matchId}` is the Cricbuzz internal ID obtained from Endpoints 1 or 2. Page `1` always returns the most recent over first.

### Request

```bash
curl -X GET "https://www.cricbuzz.com/api/cricket-match/{matchId}/full-commentary/1" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  -H "Accept: application/json" \
  -H "Accept-Language: en-US,en;q=0.9" \
  -H "Referer: https://www.cricbuzz.com/" \
  -H "Origin: https://www.cricbuzz.com"
```

**Example:**

```bash
curl -X GET "https://www.cricbuzz.com/api/cricket-match/112456/full-commentary/1" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  -H "Accept: application/json" \
  -H "Referer: https://www.cricbuzz.com/"
```

### Response

```json
{
  "miniscore": {
    "batTeam": {
      "teamSName": "CSK",
      "score": 143,
      "wickets": 6,
      "overs": 16.3
    },
    "currentRunRate": 8.67,
    "requiredRunRate": 11.43,
    "target": 183,
    "remBalls": 21
  },
  "commentary": [
    {
      "ballNbr": 3,
      "oversNum": 16,
      "runsScored": 1,
      "event": "RUNS",
      "commText": "Bumrah to Jadeja, driven through covers for a single.",
      "batsmanStriker": {
        "batName": "Ravindra Jadeja",
        "batRuns": 34,
        "batBalls": 22
      },
      "bowlerStriker": {
        "bowlName": "Jasprit Bumrah",
        "bowlWkts": 2,
        "bowlRuns": 28
      }
    },
    {
      "overSeparator": {
        "overNum": 15,
        "score": 128,
        "wickets": 5,
        "runs": 9
      }
    },
    {
      "ballNbr": 6,
      "oversNum": 15,
      "runsScored": 0,
      "event": "WICKET",
      "commText": "Pandya to Dhoni, caught behind! Dhoni departs for 18.",
      "batsmanStriker": {
        "batName": "MS Dhoni",
        "batRuns": 18,
        "batBalls": 14
      },
      "bowlerStriker": {
        "bowlName": "Hardik Pandya",
        "bowlWkts": 1,
        "bowlRuns": 34
      }
    }
  ]
}
```

### Key Fields

| Field | Type | Description |
|---|---|---|
| `miniscore.batTeam.teamSName` | string | Short name of the batting team |
| `miniscore.batTeam.score` | number | Current batting score |
| `miniscore.batTeam.wickets` | number | Wickets fallen |
| `miniscore.batTeam.overs` | number | Overs completed |
| `miniscore.currentRunRate` | number | Current run rate (CRR) |
| `miniscore.requiredRunRate` | number | Required run rate (RRR) — 2nd innings only |
| `miniscore.target` | number | Target score — 2nd innings only |
| `miniscore.remBalls` | number | Balls remaining in the innings |
| `commentary[].ballNbr` | number | Ball number within the over (1–6) |
| `commentary[].oversNum` | number | Over number (0-indexed from start of innings) |
| `commentary[].runsScored` | number | Runs scored off this ball |
| `commentary[].event` | string | `"RUNS"`, `"WICKET"`, `"WIDE"`, `"NO_BALL"`, `"SIX"`, `"FOUR"` |
| `commentary[].commText` | string | Human-readable commentary text |
| `commentary[].batsmanStriker` | object | Striker's name (`batName`), runs (`batRuns`), balls (`batBalls`) |
| `commentary[].bowlerStriker` | object | Bowler's name (`bowlName`), wickets (`bowlWkts`), runs (`bowlRuns`) |
| `commentary[].overSeparator` | object | End-of-over summary — not a ball delivery; contains `overNum`, `score`, `wickets`, `runs` |

---

## Notes

### How Cricbuzz match IDs are discovered

The app does not hardcode Cricbuzz match IDs. On each poll of `/live` and `/recent`, matches are fuzzy-matched by team names and date against the local IPL schedule. When a match is found, `matchInfo.matchId` is stored in memory and used for commentary polling.

### Why both /live and /recent are fetched together

A finished match drops out of `/live` immediately but lingers in `/recent` for several hours. Fetching both and deduplicating by `matchId` ensures results are caught reliably regardless of timing.

### Rate limiting

No documented rate limits. In practice, polling every 30 seconds (live scores) and every 60 seconds (commentary) has been stable without throttling.

### State detection for completed matches

The `matchInfo.state` field transitions: `Upcoming` → `In Progress` → `Complete`. The app also checks `matchInfo.status` for strings like `"won by"` or `"Match abandoned"` as a secondary signal, since `state` sometimes lags behind.

### Winner parsing from the status string

The `status` field is plain English, e.g. `"Royal Challengers Bengaluru won by 7 wickets"`. The app extracts the winner by scanning for a known team name or abbreviation in the string.

### Static team logo URLs (CDN)

Team logos are loaded directly from Cricbuzz's static image CDN — no API call needed:

```
https://static.cricbuzz.com/a/img/v1/152x152/i1/c172115/chennai-super-kings.jpg
https://static.cricbuzz.com/a/img/v1/152x152/i1/c172116/mumbai-indians.jpg
https://static.cricbuzz.com/a/img/v1/152x152/i1/c172117/royal-challengers-bengaluru.jpg
https://static.cricbuzz.com/a/img/v1/152x152/i1/c172129/kolkata-knight-riders.jpg
https://static.cricbuzz.com/a/img/v1/152x152/i1/c172126/delhi-capitals.jpg
https://static.cricbuzz.com/a/img/v1/152x152/i1/c172127/punjab-kings.jpg
https://static.cricbuzz.com/a/img/v1/152x152/i1/c172128/rajasthan-royals.jpg
https://static.cricbuzz.com/a/img/v1/152x152/i1/c172114/sunrisers-hyderabad.jpg
https://static.cricbuzz.com/a/img/v1/152x152/i1/c270559/gujarat-titans.jpg
https://static.cricbuzz.com/a/img/v1/152x152/i1/c270560/lucknow-super-giants.jpg
```

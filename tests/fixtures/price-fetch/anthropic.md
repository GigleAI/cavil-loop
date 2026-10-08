# Pricing

## Model pricing

The following table shows pricing for all Claude models:

| Model                                                       | Base input tokens     | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens          |
| :---------------------------------------------------------- | :-------------------- | :-------------- | :-------------- | :----------------------- | :--------------------- |
| Claude Test 9                                               | $3 / MTok             | $3.75 / MTok    | $6 / MTok       | $0.15 / MTok<sup>1</sup> | $15 / MTok             |
| Claude Opus 5                                               | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $25 / MTok             |
| Claude Clash 9                                              | $3 / MTok             | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok             | $15 / MTok             |
| Claude Lone 9 ([limited availability](https://example.com)) | $3 / MTok             | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok             | $15 / MTok             |
| Claude Split 9 (for prompts up to 100,000 tokens)           | $1 / MTok             | $1.25 / MTok    | $2 / MTok       | $0.10 / MTok             | $5 / MTok              |
| Claude Split 9 (for prompts over 100,000 tokens)            | $2 / MTok             | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok             | $10 / MTok             |
| Claude Bad 9                                                | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $1 / MTok              |
| Claude Zero 9                                               | $3 / MTok             | $3.75 / MTok    | $6 / MTok       | $0 / MTok                | $15 / MTok             |
| Claude Partial 9                                            | $2 / MTok             | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok             | $10 / MTok             |

*<sup>1 Cache hits on Claude Test 9 are priced at 0.05x the base input price.</sup>*

### Fast mode pricing

| Model           | Input      | Output     |
| --------------- | ---------- | ---------- |
| Claude Test 9   | $30 / MTok | $150 / MTok |

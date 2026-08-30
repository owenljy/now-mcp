# Eval Metrics

> **Agentic vs non-agentic — this matters.** If you're using Auto Chat (code-based eval runner), you must use **agentic metrics only**. Non-agentic metrics (Faithfulness, Correctness, Correctness w/ Golden) use `{{grounded_prompt}}`/`{{generated_response}}` variables that Auto Chat never populates — they produce garbage scores (all zeros). The `/sn-eval-runner-builder` skill checks for this automatically.

## Agentic metrics (use with Auto Chat)

| Metric | What it scores |
|---|---|
| Tool performance evaluation | Whether the agent selected appropriate tools |
| Tool calling evaluation | Whether tool calls used correct parameters |
| Overall task completeness evaluation | Whether the agent achieved the stated objective |
| Plan evaluation (optional) | Quality of the agent's execution plan |

> **Verify metric names on your instance.** Names come from `sys_one_extend_capability` and may vary across platform versions. The eval runner's `_resolveMetrics()` function will warn if a name isn't found.

## Non-agentic metrics (UI wizard only, not Auto Chat)

| Metric | What it scores |
|---|---|
| Faithfulness | Response is grounded in retrieved context |
| Correctness | Response correctly answers the question |
| Correctness with Golden Response | Response matches the expected answer style and reasoning in the linked `ground_truth` record |

Golden responses aren't a 1:1 match against real-time data — they educate the LLM judge on what a correct answer looks like: the shape, the reasoning, the level of detail. An agent response with different current data that follows the same structure will still score well.

## GT-based agentic metrics (require `ground_truth` record linked on each dataset row)

| Metric | What it scores |
|---|---|
| Tool calling correctness (GT) | Whether the agent called the right tools with the right parameters, judged against a structured `ground_truth` record |
| Tool choice accuracy (GT) | Whether the agent selected the expected tool at each step |
| Output alignment (GT) | Whether the agent's output matches expected values defined in `ground_truth.output_evaluations` |

> **Requires:** Each `aia_artifact_dataset` row must have a linked `ground_truth` record, and the eval runner must include a `groundtruthsysid` attribute mapping with `attributeId: '21ffd174ff3362109903ffffffffff24'`, `mandatory: true`, and template `'{{aia_artifact_dataset.ground_truth}}'`. See `/sn-aia-dataset-builder` Pattern C for setup. Missing any of these three causes GT metrics to silently score `NA` while Auto Chat reports success.

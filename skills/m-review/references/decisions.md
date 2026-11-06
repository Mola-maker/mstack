# Decisions

- The reviewer tier (`sonnet` floor, `opus` when the diff is large or touches auth, crypto, or a destructive change) governs the main pass. Principle 6 is met by a different context, not by forcing another vendor. A different model family is required for the candidate-patch verifier in `m-dispatch`, and for the refuter when that family is actually available. If only one family is installed, say so and continue with a different context — do not block the review.
- File-count tiers use the two thresholds from the spec (under 5, over 20). The 5–20 band has no named model in the sources, so it stays on the sonnet floor instead of inventing a third model.
- m-review does not edit or merge, but it does end with `APPROVE` or `REQUEST CHANGES`. `REQUEST CHANGES` (any confirmed in-scope finding, or any axis `issues`) is the rejected review the caller gates on. Unconfirmed and Cleared do not block. "Advisory, never gate" left callers with no pass/fail.

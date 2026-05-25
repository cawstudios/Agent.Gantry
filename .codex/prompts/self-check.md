# Self-Check Prompt

Before handoff, answer these items precisely:

1. What changed?
2. Which acceptance criteria does this satisfy?
3. Which direct automated test proves each changed behavior?
4. If this is a bug fix, where is the regression test? If none was added, why was it not technically feasible?
5. Which edge cases did you check?
6. For each edge case, was it tested, covered by an existing test, or explicitly not applicable?
7. What bug check did you run on bad inputs, empty data, failure paths, lifecycle behavior, and backward compatibility?
8. If the plan required a Surface Impact Matrix, did the implementation match each surface classification?
9. If this was replacement or no-legacy work, what cleanup search did you run and what matches remain by design?
10. What is still risky?
11. Which files should reviewers inspect first?

If anything is missing, fix it before declaring the task done.

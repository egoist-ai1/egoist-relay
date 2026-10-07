# Hook selection proposal

Production hook remains unchanged. Exact preimage SHA256: b580e52dea5cff87f30acaf74199e69162aa0598122bcccbf3c27b8ae9752806. Scope: only non-editing handleFileSelect selection.

Actual malformed owned PNG input: unhandled async Event; next valid photo selection succeeds, 0 sends. Proposed branch catches individual decode failures, revokes only their created URLs, preserves valid sibling selections, shows existing localized generic feedback, and retains existing attachment state if all inputs fail.

Parent review is required after automatic review rejected the combined action for an additional hook and broad replacements. This is an unapplied atomic proposal, not an accepted patch. Appending, editing and quality rebuild rejection branches remain outside this proposal.

# Runtime Notes

- Live provider text deltas may contain only whitespace or leading whitespace.
  Runtime streaming must preserve those deltas until the channel stream buffer
  formats the complete visible text.

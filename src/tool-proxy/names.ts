/**
 * Muse namespaces an MCP tool as `mcp__<server>__<tool>` (and shows it dotted),
 * so a name is matched back to the tool bb declared.
 */
export function stripMcpPrefix(tool: string): string {
  const match = /^mcp__[^_]+(?:_[^_]+)*?__(?<name>.+)$/u.exec(tool);
  if (match?.groups?.name !== undefined) {
    return match.groups.name;
  }
  const dotted = /^mcp__[A-Za-z0-9_]+\.(?<name>.+)$/u.exec(tool);
  return dotted?.groups?.name ?? tool;
}

/**
 * A proxy call may carry Muse's namespaced form or the name bb declared.
 * Either is accepted; anything else is undeclared.
 */
export function toolIsDeclared(
  tool: string,
  allowedTools: ReadonlySet<string> | readonly string[],
): boolean {
  const allowed =
    allowedTools instanceof Set ? allowedTools : new Set(allowedTools);
  return allowed.has(tool) || allowed.has(stripMcpPrefix(tool));
}

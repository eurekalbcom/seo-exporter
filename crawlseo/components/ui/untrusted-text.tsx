/**
 * Renders crawled or third-party text as a React text node.
 * Do not switch this to raw HTML. The string is data, not markup or a prompt.
 */
export function UntrustedText({ value }: { value: string }) {
  return <span>{value}</span>;
}

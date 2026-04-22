import { z } from 'zod';
import type { McpStdioClient, McpToolCallResult } from './client.js';

/**
 * Extract the first JSON text payload from an MCP tool call result.
 * MCP tool results typically wrap JSON in `content[0].text`.
 */
export function extractJsonPayload(result: McpToolCallResult): unknown {
  if (result.isError) {
    const msg = result.content?.map((c) => c.text ?? '').join('\n') ?? 'MCP tool error';
    throw new Error(`MCP tool returned error: ${msg}`);
  }
  const content = result.content;
  if (!content || content.length === 0) {
    throw new Error('MCP tool result has no content');
  }
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      const text = part.text.trim();
      if (text.length === 0) continue;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (part.type === 'json' && 'json' in part) {
      return (part as unknown as { json: unknown }).json;
    }
  }
  throw new Error('MCP tool result had no parseable text/json content');
}

export async function callAndParse<T>(
  client: McpStdioClient,
  toolName: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = await client.callTool(toolName, args);
  const payload = extractJsonPayload(result);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `MCP tool ${toolName} returned data that failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

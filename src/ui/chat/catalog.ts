import { openApiSpec } from '../tools.js';
import type { ChatTool } from './types.js';

export type ChatOperation = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Converts the application's established operation catalog into LLM tool definitions.
 * There is one schema source for both the Chat service and the external OpenAPI adapter, preventing drift.
 */
export function chatToolCatalog(execute: ChatOperation): ChatTool[] {
  const spec = openApiSpec('http://local.invalid/tools');
  const paths = spec.paths as Record<string, Record<string, OperationObject>>;
  const tools: ChatTool[] = [];
  for (const operations of Object.values(paths)) {
    for (const operation of Object.values(operations)) {
      if (!operation.operationId) continue;
      const name = operation.operationId;
      tools.push({
        definition: {
          name,
          description: operation.summary ?? '',
          inputSchema: inputSchema(operation),
        },
        execute: (args, signal) => execute(name, args, signal),
      });
    }
  }
  return tools;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  parameters?: Array<{ name: string; description?: string; required?: boolean; schema?: JsonSchema }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonSchema }> };
}

function inputSchema(operation: OperationObject): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const parameter of operation.parameters ?? []) {
    properties[parameter.name] = { ...(parameter.schema ?? { type: 'string' }), description: parameter.description };
    if (parameter.required) required.add(parameter.name);
  }
  const body = operation.requestBody?.content?.['application/json']?.schema;
  if (body) {
    Object.assign(properties, body.properties ?? {});
    for (const key of body.required ?? []) required.add(key);
  }
  return { type: 'object', properties, required: [...required] };
}
